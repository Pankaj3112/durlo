import { describe, expect, it, vi } from "vitest";
import {
  Durlo,
  SerializationError,
  ValidationError,
  calculateRetryDelay,
  deserialize,
  normalizeRetryPolicy,
  parseDuration,
  serialize
} from "@durlo/core";
import type {
  CreateRunInput,
  DurloAdapter,
  RunRecord,
  StoredRunDetails,
  TransactionalDurloAdapter
} from "@durlo/core";

function recordFromInput(input: CreateRunInput): RunRecord {
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

function createAdapter(): DurloAdapter & {
  created: CreateRunInput[];
  transactionClient?: unknown;
} {
  const created: CreateRunInput[] = [];
  const transactional: TransactionalDurloAdapter = {
    createRun: async (input) => {
      created.push(input);
      return recordFromInput(input);
    },
    createRuns: async (inputs) => {
      created.push(...inputs);
      return inputs.map(recordFromInput);
    }
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
    cancelRun: async () => {
      throw new Error("not implemented by test adapter");
    },
    retryRun: async () => {
      throw new Error("not implemented by test adapter");
    },
    cleanupRuns: async () => ({ deletedRuns: 0, deletedRunIds: [], limitReached: false }),
    claimRuns: async () => [],
    findUnavailableRuns: async () => [],
    extendRunLease: async () => false,
    completeRun: async () => undefined,
    failRun: async () => undefined,
    releaseRun: async () => false,
    getStep: async () => null,
    startStep: async () => {
      throw new Error("not implemented by test adapter");
    },
    completeStep: async () => undefined,
    failStep: async () => undefined,
    getTimer: async () => null,
    sleepRun: async () => {
      throw new Error("not implemented by test adapter");
    },
    fireDueTimers: async () => [],
    withTransaction(client) {
      this.transactionClient = client;
      return transactional;
    }
  };
}

describe("Durlo core API", () => {
  it("defines and enqueues tasks with normalized durable options", async () => {
    const adapter = createAdapter();
    const durlo = new Durlo({ id: "test-app", adapter, defaultRetry: { attempts: 4 } });
    const task = durlo.task<{ email: string }, { sent: boolean }>({
      id: "send-email",
      version: "2026-07",
      retry: { backoff: { type: "fixed", delay: "5s" } },
      run: async () => ({ sent: true })
    });

    const handle = await task.enqueue(
      { email: "a@example.com" },
      { delay: "10s", attempts: 2, idempotencyKey: "email:1", priority: 10 }
    );

    expect(handle).toMatchObject({
      kind: "task",
      resourceId: "send-email",
      resourceVersion: "2026-07",
      status: "pending"
    });
    expect(adapter.created[0]).toMatchObject({
      appId: "test-app",
      resourceVersion: "2026-07",
      maxAttempts: 2,
      idempotencyKey: "email:1",
      priority: 10,
      input: { email: "a@example.com" },
      options: {
        retry: { attempts: 2, backoff: { type: "fixed", delay: 5_000, jitter: 0 } },
        limits: {
          maxOutputBytes: 1_048_576,
          maxErrorBytes: 65_536,
          maxStepResultBytes: 1_048_576,
          maxWorkflowSteps: 1_000
        }
      }
    });
    expect(adapter.created[0]!.scheduledAt.getTime()).toBeGreaterThan(Date.now() + 9_000);
  });

  it("defines workflows and validates Standard Schema inputs", async () => {
    const adapter = createAdapter();
    const validate = vi.fn((value: unknown) =>
      typeof value === "object" && value !== null && "userId" in value
        ? { value: value as { userId: string } }
        : { issues: [{ message: "userId is required" }] }
    );
    const durlo = new Durlo({ id: "test-app", adapter });
    const workflow = durlo.workflow({
      id: "onboarding",
      schema: { "~standard": { version: 1, vendor: "test", validate } },
      run: async () => undefined
    });

    await expect(workflow.start({ userId: "user_1" })).resolves.toMatchObject({ kind: "workflow" });
    await expect(workflow.start({} as { userId: string })).rejects.toThrow("userId is required");
    expect(validate).toHaveBeenCalledTimes(2);
    expect(workflow.version).toBe("1");
  });

  it("atomically prepares batches and rejects duplicate in-batch idempotency keys", async () => {
    const adapter = createAdapter();
    const task = new Durlo({ id: "test-app", adapter }).task({
      id: "batch-task",
      run: async (input: number) => input
    });

    const handles = await task.batchEnqueue([1, { input: 2, options: { idempotencyKey: "two" } }]);
    expect(handles).toHaveLength(2);
    await expect(
      task.batchEnqueue([
        { input: 1, options: { idempotencyKey: "duplicate" } },
        { input: 2, options: { idempotencyKey: "duplicate" } }
      ])
    ).rejects.toThrow("duplicate idempotency keys");
  });

  it("binds enqueue and start to caller-owned transactions", async () => {
    const adapter = createAdapter();
    const durlo = new Durlo({ id: "test-app", adapter });
    const task = durlo.task({ id: "task", run: async (input: string) => input });
    const workflow = durlo.workflow({ id: "workflow", run: async () => undefined });
    const client = { query: vi.fn() };

    await durlo.tx(client).enqueue(task, "input");
    await durlo.tx(client).start(workflow, { value: true });
    await durlo.tx(client).batchEnqueue(task, ["one", "two"]);

    expect(adapter.transactionClient).toBe(client);
    expect(adapter.created.map(({ kind }) => kind)).toEqual(["task", "workflow", "task", "task"]);
  });

  it("validates definitions and run options before persistence", async () => {
    const adapter = createAdapter();
    const durlo = new Durlo({ id: "test-app", adapter });
    const task = durlo.task({ id: "task", run: async () => undefined });

    expect(() => durlo.task({ id: "task", run: async () => undefined })).toThrow("already defined");
    await expect(task.enqueue({}, { delay: "1s", runAt: new Date() })).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(task.enqueue({}, { attempts: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(task.enqueue({}, { priority: 1001 })).rejects.toBeInstanceOf(ValidationError);
    await expect(task.enqueue({}, { idempotencyKey: "" })).rejects.toBeInstanceOf(ValidationError);
    expect(adapter.created).toHaveLength(0);
  });

  it("allows explicit compatibility versions and rejects ambiguous version strings", () => {
    const adapter = createAdapter();
    const durlo = new Durlo({ id: "test-app", adapter });
    const v1 = durlo.task({ id: "versioned", version: "1", run: async () => undefined });
    const v2 = durlo.task({ id: "versioned", version: "2", run: async () => undefined });

    expect([v1.version, v2.version]).toEqual(["1", "2"]);
    expect(() =>
      durlo.task({ id: "empty-version", version: "", run: async () => undefined })
    ).toThrow(ValidationError);
    expect(() =>
      durlo.workflow({ id: "spaced-version", version: " 2", run: async () => undefined })
    ).toThrow("without surrounding whitespace");
    expect(() =>
      durlo.task({ id: "long-version", version: "v".repeat(129), run: async () => undefined })
    ).toThrow("at most 128");
  });

  it("passes the owning app id to every public run control", async () => {
    const adapter = createAdapter();
    const getRun = vi.spyOn(adapter, "getRun").mockResolvedValue(null);
    const getRunDetails = vi.spyOn(adapter, "getRunDetails").mockResolvedValue(null);
    const getBacklogHealth = vi.spyOn(adapter, "getBacklogHealth");
    const cancelRun = vi
      .spyOn(adapter, "cancelRun")
      .mockRejectedValue(new Error("cancel not implemented"));
    const retryRun = vi
      .spyOn(adapter, "retryRun")
      .mockRejectedValue(new Error("retry not implemented"));
    const cleanupRuns = vi.spyOn(adapter, "cleanupRuns");
    const durlo = new Durlo({ id: "scoped-app", adapter });

    await expect(durlo.runs.get("run-1")).resolves.toBeNull();
    await expect(durlo.runs.getDetails("run-1")).resolves.toBeNull();
    await expect(durlo.runs.getBacklogHealth()).resolves.toMatchObject({ appId: "scoped-app" });
    await expect(durlo.runs.cancel("run-1")).rejects.toThrow("cancel not implemented");
    await expect(durlo.runs.retry("run-1")).rejects.toThrow("retry not implemented");
    await expect(
      durlo.runs.cleanup({ olderThan: "30d", statuses: ["completed"], limit: 25 })
    ).resolves.toMatchObject({ deletedRuns: 0 });

    const expected = { appId: "scoped-app", runId: "run-1" };
    expect(getRun).toHaveBeenCalledWith(expected);
    expect(getRunDetails).toHaveBeenCalledWith(expected);
    expect(getBacklogHealth).toHaveBeenCalledWith({ appId: "scoped-app" });
    expect(cancelRun).toHaveBeenCalledWith(expected);
    expect(retryRun).toHaveBeenCalledWith(expected);
    expect(cleanupRuns).toHaveBeenCalledWith({
      appId: "scoped-app",
      olderThan: 30 * 86_400_000,
      statuses: ["completed"],
      limit: 25
    });
  });

  it("builds a chronological timeline and durable failure diagnostics", async () => {
    const adapter = createAdapter();
    const run = recordFromInput({
      id: "run-stalled",
      appId: "details-app",
      kind: "workflow",
      resourceId: "onboarding",
      resourceVersion: "1",
      input: { userId: "user-1" },
      options: {},
      idempotencyKey: null,
      priority: 0,
      scheduledAt: new Date("2026-07-16T09:02:00.000Z"),
      maxAttempts: 3
    });
    run.createdAt = new Date("2026-07-16T09:00:00.000Z");
    run.updatedAt = new Date("2026-07-16T09:01:00.000Z");
    run.attemptCount = 1;
    run.stalledCount = 1;
    const stored = {
      run,
      steps: [],
      attempts: [
        {
          id: "attempt-1",
          runId: run.id,
          stepId: null,
          kind: "run",
          attemptNumber: 1,
          status: "stalled",
          workerId: "worker-1",
          error: { name: "StalledError", message: "worker lease expired" },
          startedAt: new Date("2026-07-16T09:00:10.000Z"),
          completedAt: new Date("2026-07-16T09:01:00.000Z")
        }
      ],
      timers: [],
      checkedAt: new Date("2026-07-16T09:01:30.000Z")
    } satisfies StoredRunDetails;
    vi.spyOn(adapter, "getRunDetails").mockResolvedValue(stored);
    const durlo = new Durlo({ id: "details-app", adapter });

    const details = await durlo.runs.getDetails(run.id);

    expect(details?.run.input).toEqual({ userId: "user-1" });
    expect(details?.timeline.map(({ type }) => type)).toEqual([
      "run_created",
      "run_attempt_started",
      "run_attempt_stalled",
      "run_retry_scheduled"
    ]);
    expect(details?.diagnostics).toEqual({
      failureCount: 1,
      failedAttempts: 0,
      timedOutAttempts: 0,
      stalledAttempts: 1,
      retryCount: 1,
      leaseLossCount: 1,
      hasExpiredLease: false,
      timerLagMs: 0
    });
  });

  it("normalizes app-scoped run listing and returns an opaque keyset cursor", async () => {
    const adapter = createAdapter();
    const newer = recordFromInput({
      id: "run-z",
      appId: "scoped-app",
      kind: "task",
      resourceId: "email",
      resourceVersion: "2",
      input: {},
      options: {},
      idempotencyKey: null,
      priority: 0,
      scheduledAt: new Date("2026-07-16T10:00:00.000Z"),
      maxAttempts: 3
    });
    newer.createdAt = new Date("2026-07-16T10:00:00.000Z");
    const older = { ...newer, id: "run-a" };
    const listRuns = vi.spyOn(adapter, "listRuns").mockResolvedValue([newer, older]);
    const durlo = new Durlo({ id: "scoped-app", adapter });

    const first = await durlo.runs.list({
      limit: 1,
      statuses: ["pending"],
      kinds: ["task"],
      resourceId: "email",
      resourceVersion: "2",
      createdAfter: "2026-07-01",
      createdBefore: new Date("2026-08-01")
    });

    expect(first.runs).toEqual([newer]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(listRuns).toHaveBeenCalledWith({
      appId: "scoped-app",
      limit: 2,
      cursor: null,
      statuses: ["pending"],
      kinds: ["task"],
      resourceId: "email",
      resourceVersion: "2",
      createdAfter: new Date("2026-07-01"),
      createdBefore: new Date("2026-08-01")
    });

    listRuns.mockResolvedValue([]);
    await durlo.runs.list({ cursor: first.nextCursor! });
    expect(listRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appId: "scoped-app",
        limit: 51,
        cursor: { createdAt: newer.createdAt, id: newer.id }
      })
    );
  });

  it("rejects invalid run listing options before storage", async () => {
    const adapter = createAdapter();
    const listRuns = vi.spyOn(adapter, "listRuns");
    const durlo = new Durlo({ id: "list-app", adapter });
    const invalid = [
      { limit: 0 },
      { limit: 201 },
      { cursor: "not-a-cursor" },
      { statuses: ["pending", "pending"] },
      { statuses: ["unknown"] },
      { kinds: ["task", "task"] },
      { kinds: ["event"] },
      { resourceId: "" },
      { resourceVersion: " version" },
      { createdAfter: "invalid" },
      { createdAfter: "2026-08-01", createdBefore: "2026-07-01" }
    ];

    for (const options of invalid) {
      await expect(
        durlo.runs.list(options as Parameters<typeof durlo.runs.list>[0])
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(listRuns).not.toHaveBeenCalled();
  });

  it("validates bounded retention cleanup options before calling storage", async () => {
    const adapter = createAdapter();
    const cleanupRuns = vi.spyOn(adapter, "cleanupRuns");
    const durlo = new Durlo({ id: "cleanup-app", adapter });

    for (const options of [
      { olderThan: 0 },
      { olderThan: "1d", limit: 0 },
      { olderThan: "1d", limit: 10_001 },
      { olderThan: "1d", statuses: [] },
      { olderThan: "1d", statuses: ["completed", "completed"] },
      { olderThan: "1d", statuses: ["pending"] }
    ]) {
      await expect(
        durlo.runs.cleanup(options as Parameters<typeof durlo.runs.cleanup>[0])
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(cleanupRuns).not.toHaveBeenCalled();
  });
});

describe("durations and retries", () => {
  it("parses compact duration strings", () => {
    expect(parseDuration("100ms")).toBe(100);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(() => parseDuration("tomorrow")).toThrow(ValidationError);
  });

  it("normalizes retry defaults and calculates bounded jitter", () => {
    const retry = normalizeRetryPolicy({
      attempts: 5,
      backoff: { type: "exponential", delay: "1s", factor: 3, maxDelay: "5s", jitter: 0.2 }
    });
    expect(retry).toEqual({
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000, factor: 3, maxDelay: 5_000, jitter: 0.2 }
    });
    expect(calculateRetryDelay(retry.backoff, 3, () => 0.5)).toBe(5_000);
  });
});

describe("durable serialization", () => {
  it("round-trips JSON values and dates", () => {
    const value = { createdAt: new Date("2026-07-10T00:00:00.000Z"), values: [1, true, null] };
    expect(deserialize(serialize(value))).toEqual(value);
  });

  it.each([1n, Symbol("no"), () => undefined, { value: undefined }])(
    "rejects unsupported value %#",
    (value) => {
      expect(() => serialize(value)).toThrow(SerializationError);
    }
  );

  it("rejects circular references and unsupported class instances", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serialize(circular)).toThrow("circular");
    expect(() => serialize(new Map())).toThrow("class instance");
  });

  it("always serializes thrown values, even when the value itself is unsupported", async () => {
    const { serializeError } = await import("@durlo/core");
    expect(serializeError(undefined)).toEqual({
      name: "Error",
      message: "Unknown error",
      cause: "undefined"
    });
    expect(serializeError(1n)).toEqual({ name: "Error", message: "Unknown error", cause: "1" });
  });
});
