import { describe, expect, it } from "vitest";
import {
  DEFAULT_DURLO_LIMITS,
  Durlo,
  SerializationError,
  StorageLimitError,
  ValidationError,
  calculateRetryDelay,
  deserialize,
  jsonByteSize,
  normalizeBackoff,
  normalizeRetryPolicy,
  parseDuration,
  serialize,
  serializeError
} from "@durlo/core";
import type {
  CreateRunInput,
  DurloAdapter,
  JsonValue,
  RunRecord,
  StepStatus,
  TransactionalDurloAdapter
} from "@durlo/core";

function validationAdapter(): DurloAdapter & { created: CreateRunInput[] } {
  const created: CreateRunInput[] = [];
  const transactional: TransactionalDurloAdapter = {
    createRun: async (input) => {
      created.push(input);
      return pendingRecord(input);
    },
    createRuns: async (inputs) => {
      created.push(...inputs);
      return inputs.map(pendingRecord);
    }
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused test adapter operation");
  };
  return {
    created,
    ...transactional,
    getRun: async () => null,
    getRunDetails: async () => null,
    getBacklogHealth: async ({ appId }) => ({
      appId,
      checkedAt: new Date(),
      runs: {
        active: 0,
        pending: 0,
        ready: 0,
        delayed: 0,
        running: 0,
        sleeping: 0,
        expiredLeases: 0,
        oldestReadyAt: null,
        oldestReadyCreatedAt: null,
        readyLagMs: 0
      },
      timers: { pending: 0, due: 0, oldestDueAt: null, lagMs: 0 }
    }),
    listRuns: async () => [],
    cancelRun: unused,
    retryRun: unused,
    cleanupRuns: async () => ({ deletedRuns: 0, deletedRunIds: [], limitReached: false }),
    claimRuns: async () => [],
    findUnavailableRuns: async () => [],
    extendRunLease: async () => false,
    completeRun: async () => undefined,
    failRun: async () => undefined,
    releaseRun: async () => false,
    getStep: async () => null,
    startStep: unused,
    completeStep: async () => undefined,
    failStep: async () => undefined,
    getTimer: async () => null,
    sleepRun: unused,
    fireDueTimers: async () => []
  };
}

function pendingRecord(input: CreateRunInput): RunRecord {
  const now = new Date();
  return {
    ...input,
    status: "pending",
    output: null,
    error: null,
    attemptCount: 0,
    lockedBy: null,
    leaseToken: null,
    lockedUntil: null,
    stalledCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelledAt: null
  };
}

describe("duration and id boundaries", () => {
  it("publishes every durable workflow step status", () => {
    const statuses = [
      "pending",
      "running",
      "completed",
      "failed",
      "stalled",
      "timed_out",
      "cancelled"
    ] satisfies StepStatus[];

    expect(statuses).toEqual([
      "pending",
      "running",
      "completed",
      "failed",
      "stalled",
      "timed_out",
      "cancelled"
    ]);
  });

  it("accepts exact duration forms and rejects non-finite, negative, or partial matches", () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(12.5)).toBe(12.5);
    expect(parseDuration("1.25s")).toBe(1_250);
    expect(parseDuration(" 2 m ")).toBe(120_000);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseDuration(value)).toThrow("finite, non-negative");
    }
    for (const value of ["x1s", "1sx", "1", "-1s", "1w", "1..2s"]) {
      expect(() => parseDuration(value)).toThrow("must use ms, s, m, h, or d");
    }
  });

  it("accepts 255-character ids and rejects empty, non-string, and 256-character ids", () => {
    const adapter = validationAdapter();
    expect(() => new Durlo({ id: "x".repeat(255), adapter })).not.toThrow();
    expect(() => new Durlo({ id: "x".repeat(256), adapter })).toThrow("at most 255");
    expect(() => new Durlo({ id: "   ", adapter })).toThrow("non-empty");
    expect(() => new Durlo({ id: 42 as unknown as string, adapter })).toThrow("non-empty");

    const durlo = new Durlo({ id: "id-tests", adapter });
    expect(() => durlo.task({ id: "t".repeat(255), run: async () => undefined })).not.toThrow();
    expect(() => durlo.task({ id: "t".repeat(256), run: async () => undefined })).toThrow(
      "at most 255"
    );
  });
});

describe("retry decision boundaries", () => {
  it("normalizes defaults, fixed policies, exponential defaults, and optional caps", () => {
    expect(normalizeRetryPolicy(undefined)).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000, factor: 2, jitter: 0.2 }
    });
    expect(normalizeRetryPolicy({ attempts: 1 })).toMatchObject({ attempts: 1 });
    expect(normalizeRetryPolicy({ attempts: 100 })).toMatchObject({ attempts: 100 });
    expect(normalizeBackoff({ type: "fixed", delay: "2s", jitter: 1 })).toEqual({
      type: "fixed",
      delay: 2_000,
      jitter: 1
    });
    expect(normalizeBackoff({ type: "exponential", delay: 100 })).toEqual({
      type: "exponential",
      delay: 100,
      factor: 2,
      jitter: 0
    });
    expect(normalizeBackoff({ type: "exponential", delay: 100, factor: 3, maxDelay: 500 })).toEqual(
      { type: "exponential", delay: 100, factor: 3, maxDelay: 500, jitter: 0 }
    );
  });

  it("rejects every attempts and backoff boundary outside the contract", () => {
    for (const attempts of [0, 101, 1.5, Number.NaN]) {
      expect(() => normalizeRetryPolicy({ attempts })).toThrow("integer from 1 to 100");
    }
    for (const jitter of [-0.01, 1.01, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeBackoff({ type: "fixed", delay: 1, jitter })).toThrow("jitter");
    }
    for (const factor of [0.99, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeBackoff({ type: "exponential", delay: 1, factor })).toThrow("factor");
    }
    expect(() => normalizeBackoff({ type: "exponential", delay: 1, maxDelay: "invalid" })).toThrow(
      "maximum backoff delay"
    );
  });

  it("calculates fixed, exponential, capped, and deterministic jitter delays", () => {
    const fixed = { type: "fixed" as const, delay: 100, jitter: 0 };
    expect(calculateRetryDelay(fixed, 1, () => 0)).toBe(100);
    expect(calculateRetryDelay(fixed, 99, () => 1)).toBe(100);

    const exponential = {
      type: "exponential" as const,
      delay: 100,
      factor: 3,
      maxDelay: 500,
      jitter: 0
    };
    expect(calculateRetryDelay(exponential, 1, () => 0.5)).toBe(100);
    expect(calculateRetryDelay(exponential, 2, () => 0.5)).toBe(300);
    expect(calculateRetryDelay(exponential, 3, () => 0.5)).toBe(500);

    const jittered = { type: "fixed" as const, delay: 100, jitter: 0.2 };
    expect(calculateRetryDelay(jittered, 1, () => 0)).toBe(80);
    expect(calculateRetryDelay(jittered, 1, () => 0.5)).toBe(100);
    expect(calculateRetryDelay(jittered, 1, () => 1)).toBe(120);
  });
});

describe("run option boundaries", () => {
  it("accepts inclusive limits and rejects every invalid option family", async () => {
    const adapter = validationAdapter();
    const task = new Durlo({ id: "option-tests", adapter }).task({
      id: "option-task",
      run: async () => undefined
    });
    await expect(
      task.enqueue({}, { priority: -1_000, attempts: 1, idempotencyKey: "a".repeat(2_048) })
    ).resolves.toBeDefined();
    await expect(task.enqueue({}, { priority: 1_000, attempts: 100 })).resolves.toBeDefined();

    const invalidOptions = [
      { priority: -1_001 },
      { priority: 1_001 },
      { priority: 1.5 },
      { idempotencyKey: "x".repeat(2_049) },
      { delay: -1 },
      { timeout: Number.POSITIVE_INFINITY },
      { runAt: "not-a-date" },
      { attempts: 1.5 },
      { backoff: { type: "fixed" as const, delay: "invalid" } },
      { backoff: { type: "fixed" as const, delay: 1, jitter: -1 } },
      { backoff: { type: "exponential" as const, delay: 1, factor: 0 } }
    ];
    for (const options of invalidOptions) {
      await expect(task.enqueue({}, options)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe("serialization boundaries", () => {
  it("rejects each unsupported primitive, non-finite number, and invalid date with its path", () => {
    expect(() => serialize({ nested: Number.NaN })).toThrow("value.nested contains a non-finite");
    expect(() => serialize(Number.POSITIVE_INFINITY)).toThrow(SerializationError);
    expect(() => serialize(new Date("invalid"))).toThrow("invalid Date");
    expect(() => serialize(undefined)).toThrow("unsupported undefined");
    expect(() => serialize(1n)).toThrow("unsupported bigint");
    expect(() => serialize(() => undefined)).toThrow("unsupported function");
    expect(() => serialize(Symbol("value"))).toThrow("unsupported symbol");
  });

  it("supports repeated references, null prototypes, nested dates, and serialized Errors", () => {
    const shared = { value: 1 };
    expect(deserialize(serialize({ first: shared, second: shared }))).toEqual({
      first: { value: 1 },
      second: { value: 1 }
    });
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      value: true
    });
    expect(deserialize(serialize(nullPrototype))).toEqual({ value: true });
    const error = new Error("boom", { cause: { code: 42 } });
    expect(deserialize(serialize(error))).toMatchObject({
      name: "Error",
      message: "boom",
      cause: { code: 42 }
    });
    expect(deserialize(serialize({ when: new Date("2026-01-02T03:04:05.000Z") }))).toEqual({
      when: new Date("2026-01-02T03:04:05.000Z")
    });
    expect(deserialize({ "$durlo.date": "2026-01-02T03:04:05.000Z", extra: 1 })).toEqual({
      "$durlo.date": "2026-01-02T03:04:05.000Z",
      extra: 1
    });
  });

  it("round-trips metadata-looking objects, reserved keys, and dates through JSON normalization", () => {
    const literal = JSON.parse(
      '{"$durlo.date":"2026-01-02T03:04:05.000Z","$durlo":["date","literal"],"__proto__":{"polluted":true},"constructor":"constructor","prototype":"prototype","":"empty","a.b":"dotted","💾":"unicode"}'
    ) as Record<string, unknown>;
    const value = {
      literal,
      nested: [literal, { value: new Date("2026-01-02T03:04:05.000Z") }]
    };

    const normalized = JSON.parse(JSON.stringify(serialize(value)));
    const decoded = deserialize(normalized) as typeof value;

    expect(decoded).toEqual({
      literal,
      nested: [literal, { value: new Date("2026-01-02T03:04:05.000Z") }]
    });
    expect(Object.prototype.hasOwnProperty.call(decoded.literal, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(decoded.literal)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(deserialize({ "$durlo.date": "2026-01-02T03:04:05.000Z" })).toEqual(
      new Date("2026-01-02T03:04:05.000Z")
    );
  });

  it("uses versioned date and object envelopes and rejects malformed envelopes as literals", () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    expect(serialize(date)).toEqual({ $durlo: [2, "date", date.toISOString()] });
    expect(serialize({ value: 1 })).toEqual({
      $durlo: [2, "object", [["value", 1]]]
    });

    const malformed = [
      { $durlo: [2, "date"] },
      { $durlo: [1, "date", date.toISOString()] },
      { $durlo: [2, "date", 42] },
      { $durlo: [2, "unknown", "value"] },
      { $durlo: [2, "object", "value"] },
      { $durlo: [2, "object", [["missing-value"]]] },
      { $durlo: [2, "object", [[42, "value"]]] },
      { $durlo: [2, "date", date.toISOString()], extra: true }
    ] as JsonValue[];
    for (const value of malformed) expect(deserialize(value)).toEqual(value);

    const decoded = deserialize({
      $durlo: [
        2,
        "object",
        [
          ["__proto__", { polluted: true }],
          ["constructor", "constructor"]
        ]
      ]
    } as JsonValue) as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(decoded, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(deserialize(date as unknown as JsonValue)).toBe(date);
  });

  it("keeps array paths and conditional Error fields precise", () => {
    expect(() => serialize([{ nested: Number.NaN }])).toThrow(
      "value[0].nested contains a non-finite"
    );
    const withStack = new Error("with stack");
    expect(serializeError(withStack)).toMatchObject({
      name: "Error",
      message: "with stack",
      stack: withStack.stack
    });
    expect(serializeError(withStack)).not.toHaveProperty("cause");
  });

  it.each([
    ["null", null],
    ["string", "text"],
    ["number", 42.5],
    ["boolean", true],
    ["empty array", []],
    ["nested array", [1, { value: "two" }, [false]]],
    ["empty object", {}]
  ])("round-trips each JSON shape: %s", (_name, value) => {
    expect(deserialize(JSON.parse(JSON.stringify(serialize(value))))).toEqual(value);
  });

  it("measures limits against the collision-safe encoded representation", async () => {
    const adapter = validationAdapter();
    const durlo = new Durlo({ id: "encoded-limit", adapter, limits: { maxInputBytes: 3 } });
    const task = durlo.task({ id: "encoded-limit-task", run: async () => undefined });

    expect(JSON.stringify({})).toHaveLength(2);
    expect(jsonByteSize(serialize({}))).toBeGreaterThan(3);
    await expect(task.enqueue({})).rejects.toMatchObject({
      name: "StorageLimitError",
      limitName: "maxInputBytes"
    });
    expect(adapter.created).toHaveLength(0);
  });

  it("preserves Error details and safely falls back for unsupported causes", () => {
    const withoutStack = new Error("without stack", { cause: 1n });
    delete withoutStack.stack;
    expect(serializeError(withoutStack)).toEqual({
      name: "Error",
      message: "without stack",
      cause: "1"
    });
    expect(serializeError("plain failure")).toEqual({
      name: "Error",
      message: "plain failure",
      cause: "plain failure"
    });
    expect(serializeError({ circular: undefined })).toEqual({
      name: "Error",
      message: "Unknown error",
      cause: "[object Object]"
    });
  });
});

describe("storage limit boundaries", () => {
  it("publishes defaults and validates every configurable limit", () => {
    expect(DEFAULT_DURLO_LIMITS).toEqual({
      maxInputBytes: 1_048_576,
      maxOutputBytes: 1_048_576,
      maxErrorBytes: 65_536,
      maxBatchItems: 1_000,
      maxBatchBytes: 10_485_760,
      maxStepResultBytes: 1_048_576,
      maxWorkflowSteps: 1_000
    });
    const adapter = validationAdapter();
    for (const limits of [
      { maxInputBytes: 0 },
      { maxOutputBytes: 1.5 },
      { maxErrorBytes: 127 },
      { maxBatchItems: Number.MAX_SAFE_INTEGER + 1 },
      { maxBatchBytes: -1 },
      { maxStepResultBytes: Number.NaN },
      { maxWorkflowSteps: 0 }
    ]) {
      expect(() => new Durlo({ id: "limit-tests", adapter, limits })).toThrow(ValidationError);
    }
  });

  it("measures serialized UTF-8 input before persistence", async () => {
    const input = { value: "é" };
    const bytes = jsonByteSize(serialize(input));
    const acceptedAdapter = validationAdapter();
    const accepted = new Durlo({
      id: "input-limit-accepted",
      adapter: acceptedAdapter,
      limits: { maxInputBytes: bytes }
    }).task({ id: "input", run: async () => undefined });
    await expect(accepted.enqueue(input)).resolves.toBeDefined();

    const rejectedAdapter = validationAdapter();
    const rejected = new Durlo({
      id: "input-limit-rejected",
      adapter: rejectedAdapter,
      limits: { maxInputBytes: bytes - 1 }
    }).task({ id: "input", run: async () => undefined });
    await expect(rejected.enqueue(input)).rejects.toMatchObject({
      name: "StorageLimitError",
      limitName: "maxInputBytes",
      actual: bytes,
      limit: bytes - 1
    });
    expect(rejectedAdapter.created).toHaveLength(0);
  });

  it("bounds batch item count and aggregate serialized input bytes atomically", async () => {
    const adapter = validationAdapter();
    const task = new Durlo({
      id: "batch-limit-tests",
      adapter,
      limits: { maxBatchItems: 2, maxBatchBytes: jsonByteSize([1, 2]) }
    }).task({ id: "batch", run: async (input: number) => input });

    await expect(task.batchEnqueue([1, 2])).resolves.toHaveLength(2);
    await expect(task.batchEnqueue([1, 2, 3])).rejects.toBeInstanceOf(StorageLimitError);
    await expect(task.batchEnqueue([1, 20])).rejects.toMatchObject({
      limitName: "maxBatchBytes"
    });
    expect(adapter.created).toHaveLength(2);
  });
});
