import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  Durlo,
  SerializationError,
  ValidationError,
  calculateRetryDelay,
  deserialize,
  normalizeBackoff,
  normalizeRetryPolicy,
  parseDuration,
  serialize,
  serializeError
} from "@durlo/core";
import type {
  CreateRunInput,
  DurloAdapter,
  RunRecord,
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
    cancelRun: unused,
    retryRun: unused,
    claimRuns: async () => [],
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
    fireDueTimers: async () => [],
    withTransaction: () => transactional
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
    expect(normalizeRetryPolicy(undefined)).toEqual(DEFAULT_RETRY_POLICY);
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
    expect(serialize({ first: shared, second: shared })).toEqual({
      first: { value: 1 },
      second: { value: 1 }
    });
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      value: true
    });
    expect(serialize(nullPrototype)).toEqual({ value: true });
    const error = new Error("boom", { cause: { code: 42 } });
    expect(serialize(error)).toMatchObject({ name: "Error", message: "boom", cause: { code: 42 } });
    expect(deserialize(serialize({ when: new Date("2026-01-02T03:04:05.000Z") }))).toEqual({
      when: new Date("2026-01-02T03:04:05.000Z")
    });
    expect(deserialize({ "$durlo.date": "2026-01-02T03:04:05.000Z", extra: 1 })).toEqual({
      "$durlo.date": "2026-01-02T03:04:05.000Z",
      extra: 1
    });
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
