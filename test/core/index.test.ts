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
    cancelRun: async () => {
      throw new Error("not implemented by test adapter");
    },
    retryRun: async () => {
      throw new Error("not implemented by test adapter");
    },
    claimRuns: async () => [],
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
      retry: { backoff: { type: "fixed", delay: "5s" } },
      run: async () => ({ sent: true })
    });

    const handle = await task.enqueue(
      { email: "a@example.com" },
      { delay: "10s", attempts: 2, idempotencyKey: "email:1", priority: 10 }
    );

    expect(handle).toMatchObject({ kind: "task", resourceId: "send-email", status: "pending" });
    expect(adapter.created[0]).toMatchObject({
      appId: "test-app",
      maxAttempts: 2,
      idempotencyKey: "email:1",
      priority: 10,
      input: { email: "a@example.com" },
      options: { retry: { attempts: 2, backoff: { type: "fixed", delay: 5_000, jitter: 0 } } }
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

  it("passes the owning app id to every public run control", async () => {
    const adapter = createAdapter();
    const getRun = vi.spyOn(adapter, "getRun").mockResolvedValue(null);
    const cancelRun = vi
      .spyOn(adapter, "cancelRun")
      .mockRejectedValue(new Error("cancel not implemented"));
    const retryRun = vi
      .spyOn(adapter, "retryRun")
      .mockRejectedValue(new Error("retry not implemented"));
    const durlo = new Durlo({ id: "scoped-app", adapter });

    await expect(durlo.runs.get("run-1")).resolves.toBeNull();
    await expect(durlo.runs.cancel("run-1")).rejects.toThrow("cancel not implemented");
    await expect(durlo.runs.retry("run-1")).rejects.toThrow("retry not implemented");

    const expected = { appId: "scoped-app", runId: "run-1" };
    expect(getRun).toHaveBeenCalledWith(expected);
    expect(cancelRun).toHaveBeenCalledWith(expected);
    expect(retryRun).toHaveBeenCalledWith(expected);
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
