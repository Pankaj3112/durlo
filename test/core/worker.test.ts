import { describe, expect, it, vi } from "vitest";
import { Durlo, LostLeaseError } from "@durlo/core";
import type { ClaimedRun, DurloAdapter, TaskContext, TransactionalDurloAdapter } from "@durlo/core";

function createWorkerAdapter(): DurloAdapter {
  const unsupported = async (): Promise<never> => {
    throw new Error("operation is not used by this worker test");
  };
  const transactional: TransactionalDurloAdapter = {
    createRun: unsupported,
    createRuns: unsupported
  };
  return {
    ...transactional,
    getRun: unsupported,
    cancelRun: unsupported,
    retryRun: unsupported,
    claimRuns: vi.fn(async () => []),
    extendRunLease: vi.fn(async () => true),
    completeRun: vi.fn(async () => undefined),
    failRun: vi.fn(async () => undefined),
    releaseRun: vi.fn(async () => false),
    getStep: vi.fn(async () => null),
    startStep: unsupported,
    completeStep: vi.fn(async () => undefined),
    failStep: vi.fn(async () => undefined),
    getTimer: vi.fn(async () => null),
    sleepRun: unsupported,
    fireDueTimers: vi.fn(async () => []),
    withTransaction: () => transactional
  };
}

function claimedTask(resourceId: string): ClaimedRun {
  const now = new Date("2026-07-11T00:00:00.000Z");
  return {
    id: "run-1",
    appId: "worker-tests",
    kind: "task",
    resourceId,
    status: "running",
    input: {},
    output: null,
    error: null,
    options: {
      retry: {
        attempts: 3,
        backoff: { type: "fixed", delay: 0, jitter: 0 }
      }
    },
    idempotencyKey: null,
    priority: 0,
    scheduledAt: now,
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "worker-1",
    leaseToken: "lease-1",
    lockedUntil: new Date(now.getTime() + 30_000),
    stalledCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    cancelledAt: null
  };
}

function controlledTask(adapter: DurloAdapter, leaseResult: "extended" | "lost" | "error") {
  let resolveExecution!: (value: string) => void;
  let markStarted!: () => void;
  let context: TaskContext | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const execution = new Promise<string>((resolve) => {
    resolveExecution = resolve;
  });
  const durlo = new Durlo({ id: "worker-tests", adapter });
  const task = durlo.task({
    id: "heartbeat-task",
    run: async (_input: unknown, taskContext) => {
      context = taskContext;
      markStarted();
      return execution;
    }
  });

  adapter.claimRuns = vi.fn(async () => [claimedTask(task.id)]);
  adapter.extendRunLease = vi.fn(async () => {
    if (leaseResult === "error") throw new Error("database disconnected");
    return leaseResult === "extended";
  });

  return {
    context: () => context,
    resolveExecution,
    started,
    worker: durlo.worker({ tasks: [task], workerId: "worker-1", leaseDuration: 30 })
  };
}

describe("worker lifecycle", () => {
  it("validates concurrency, lease duration, and duplicate resource registration", () => {
    const adapter = createWorkerAdapter();
    const durlo = new Durlo({ id: "worker-tests", adapter });
    const task = durlo.task({ id: "task", run: async () => undefined });
    const workflow = durlo.workflow({ id: "workflow", run: async () => undefined });

    expect(() => durlo.worker({ concurrency: 0 })).toThrow("worker concurrency");
    expect(() => durlo.worker({ concurrency: 1.5 })).toThrow("worker concurrency");
    expect(() => durlo.worker({ concurrency: 1_001 })).toThrow("worker concurrency");
    expect(() => durlo.worker({ leaseDuration: 0 })).toThrow("lease duration");
    expect(() => durlo.worker({ tasks: [task, task] })).toThrow("registered more than once");
    expect(() => durlo.worker({ workflows: [workflow, workflow] })).toThrow(
      "registered more than once"
    );
  });

  it("rejects a second start while running and can restart after stopping", async () => {
    const adapter = createWorkerAdapter();
    let releaseClaim!: (runs: ClaimedRun[]) => void;
    let markClaimStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      markClaimStarted = resolve;
    });
    const blockedClaim = new Promise<ClaimedRun[]>((resolve) => {
      releaseClaim = resolve;
    });
    adapter.claimRuns = vi.fn(() => {
      markClaimStarted();
      return blockedClaim;
    });
    const worker = new Durlo({ id: "worker-tests", adapter }).worker({ pollInterval: 1 });

    const firstStart = worker.start();
    await claimStarted;
    await expect(worker.start()).rejects.toThrow("already started");
    worker.stop();
    releaseClaim([]);
    await firstStart;

    adapter.claimRuns = vi.fn(async () => {
      worker.stop();
      return [];
    });
    await expect(worker.start()).resolves.toBeUndefined();
  });
});

describe("worker heartbeats", () => {
  async function verifyLeaseLoss(leaseResult: "lost" | "error", expectedMessage: string) {
    vi.useFakeTimers();
    try {
      const adapter = createWorkerAdapter();
      const controlled = controlledTask(adapter, leaseResult);

      const run = controlled.worker.runOnce();
      await controlled.started;
      await vi.advanceTimersByTimeAsync(10);

      expect(adapter.extendRunLease).toHaveBeenCalledWith({
        runId: "run-1",
        workerId: "worker-1",
        leaseToken: "lease-1",
        leaseDuration: 30
      });
      expect(controlled.context()?.signal.aborted).toBe(true);
      expect(controlled.context()?.signal.reason).toBeInstanceOf(LostLeaseError);
      expect(controlled.context()?.signal.reason).toMatchObject({ message: expectedMessage });

      controlled.resolveExecution("late result");
      await expect(run).resolves.toBe(1);
      expect(adapter.completeRun).not.toHaveBeenCalled();
      expect(adapter.failRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }

  it("aborts the task and suppresses writes when lease extension returns false", async () => {
    await verifyLeaseLoss("lost", "lease lost for run run-1");
  });

  it("aborts the task and suppresses writes when lease extension throws", async () => {
    await verifyLeaseLoss("error", "lease renewal failed for run run-1");
  });

  it("renews an owned lease and completes normally", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createWorkerAdapter();
      const controlled = controlledTask(adapter, "extended");

      const run = controlled.worker.runOnce();
      await controlled.started;
      await vi.advanceTimersByTimeAsync(10);
      expect(controlled.context()?.signal.aborted).toBe(false);

      controlled.resolveExecution("completed result");
      await expect(run).resolves.toBe(1);
      expect(adapter.completeRun).toHaveBeenCalledWith({
        runId: "run-1",
        workerId: "worker-1",
        leaseToken: "lease-1",
        output: "completed result"
      });
      expect(adapter.failRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
