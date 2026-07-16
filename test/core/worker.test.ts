import { describe, expect, it, vi } from "vitest";
import { AttemptTimeoutError, Durlo, LostLeaseError, jsonByteSize } from "@durlo/core";
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
    getRunDetails: unsupported,
    listRuns: unsupported,
    cancelRun: unsupported,
    retryRun: unsupported,
    cleanupRuns: vi.fn(async () => ({ deletedRuns: 0, deletedRunIds: [], limitReached: false })),
    claimRuns: vi.fn(async () => []),
    findUnavailableRuns: vi.fn(async () => []),
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

function claimedTask(resourceId: string, id = "run-1"): ClaimedRun {
  const now = new Date("2026-07-11T00:00:00.000Z");
  return {
    id,
    appId: "worker-tests",
    kind: "task",
    resourceId,
    resourceVersion: "1",
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
    leaseToken: id === "run-1" ? "lease-1" : `lease-${id}`,
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

  it("reports active runs that do not match this worker's registered versions", async () => {
    const adapter = createWorkerAdapter();
    const durlo = new Durlo({ id: "worker-tests", adapter });
    const task = durlo.task({
      id: "versioned-task",
      version: "2",
      run: async () => undefined
    });
    const unavailable = {
      id: "old-run",
      kind: "task" as const,
      resourceId: task.id,
      resourceVersion: "1",
      status: "pending" as const,
      scheduledAt: new Date(),
      createdAt: new Date(),
      reason: "incompatible_version" as const
    };
    adapter.findUnavailableRuns = vi.fn(async () => [unavailable]);
    const worker = durlo.worker({ tasks: [task], workerId: "version-2-worker" });

    await expect(worker.getCompatibilityReport({ limit: 10 })).resolves.toMatchObject({
      workerId: "version-2-worker",
      appId: "worker-tests",
      registeredResources: [{ kind: "task", resourceId: "versioned-task", resourceVersion: "2" }],
      unavailableRuns: [unavailable],
      truncated: false
    });
    expect(adapter.findUnavailableRuns).toHaveBeenCalledWith({
      appId: "worker-tests",
      resources: [{ kind: "task", resourceId: "versioned-task", resourceVersion: "2" }],
      limit: 11
    });
    adapter.findUnavailableRuns = vi.fn(async () => [
      unavailable,
      { ...unavailable, id: "another-old-run" }
    ]);
    await expect(worker.getCompatibilityReport({ limit: 1 })).resolves.toMatchObject({
      unavailableRuns: [{ id: "old-run" }],
      truncated: true
    });
    await expect(worker.getCompatibilityReport({ limit: 0 })).rejects.toThrow(
      "compatibility report limit"
    );
  });

  it("dispatches definitions by exact resource version", async () => {
    const adapter = createWorkerAdapter();
    const executions: string[] = [];
    const durlo = new Durlo({ id: "worker-tests", adapter });
    const v1 = durlo.task({
      id: "same-task",
      version: "1",
      run: async () => executions.push("1")
    });
    const v2 = durlo.task({
      id: "same-task",
      version: "2",
      run: async () => executions.push("2")
    });
    const claim = claimedTask("same-task");
    claim.resourceVersion = "2";
    adapter.claimRuns = vi.fn(async () => [claim]);

    await durlo.worker({ tasks: [v1, v2], workerId: "worker-1" }).runOnce();

    expect(executions).toEqual(["2"]);
    expect(adapter.claimRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [
          { kind: "task", resourceId: "same-task", resourceVersion: "1" },
          { kind: "task", resourceId: "same-task", resourceVersion: "2" }
        ]
      })
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

  it("replenishes a free concurrency slot without waiting for a slow run", async () => {
    const adapter = createWorkerAdapter();
    let finishSlowRun!: () => void;
    let markThirdStarted!: () => void;
    const slowRun = new Promise<void>((resolve) => {
      finishSlowRun = resolve;
    });
    const thirdStarted = new Promise<void>((resolve) => {
      markThirdStarted = resolve;
    });
    const durlo = new Durlo({ id: "worker-tests", adapter });
    const task = durlo.task({
      id: "slot-task",
      run: async (_input: unknown, context) => {
        if (context.run.id === "run-1") await slowRun;
        if (context.run.id === "run-3") {
          markThirdStarted();
          worker.stop();
        }
      }
    });
    adapter.claimRuns = vi
      .fn()
      .mockResolvedValueOnce([claimedTask(task.id, "run-1"), claimedTask(task.id, "run-2")])
      .mockResolvedValueOnce([claimedTask(task.id, "run-3")])
      .mockResolvedValue([]);
    const worker = durlo.worker({
      tasks: [task],
      workerId: "worker-1",
      concurrency: 2,
      pollInterval: 1_000
    });

    let stopped = false;
    const started = worker.start().then(() => {
      stopped = true;
    });
    await thirdStarted;

    expect(adapter.claimRuns).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 1 }));
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishSlowRun();
    await started;
    expect(stopped).toBe(true);
  });

  it("promotes timers while all execution slots are occupied and drains on stop", async () => {
    const adapter = createWorkerAdapter();
    let finishRun!: () => void;
    let markRunStarted!: () => void;
    let markSecondTimerCycle!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const secondTimerCycle = new Promise<void>((resolve) => {
      markSecondTimerCycle = resolve;
    });
    const durlo = new Durlo({ id: "worker-tests", adapter });
    const task = durlo.task({
      id: "timer-task",
      run: async () => {
        markRunStarted();
        await runFinished;
      }
    });
    adapter.claimRuns = vi
      .fn()
      .mockResolvedValueOnce([claimedTask(task.id)])
      .mockResolvedValue([]);
    adapter.fireDueTimers = vi.fn(async () => {
      if (vi.mocked(adapter.fireDueTimers).mock.calls.length === 2) markSecondTimerCycle();
      return [];
    });
    const worker = durlo.worker({
      tasks: [task],
      workerId: "worker-1",
      concurrency: 1,
      pollInterval: 5
    });

    let stopped = false;
    const started = worker.start().then(() => {
      stopped = true;
    });
    await runStarted;
    await secondTimerCycle;
    worker.stop();

    expect(adapter.fireDueTimers).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishRun();
    await started;
    expect(stopped).toBe(true);
  });

  it("recovers claim polling after bounded backoff and reports worker health", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const adapter = createWorkerAdapter();
      const logger = { info: vi.fn(), warn: vi.fn() };
      const durlo = new Durlo({ id: "worker-tests", adapter, logger });
      const worker = durlo.worker({ workerId: "recovering-worker", pollInterval: 1_000 });
      adapter.claimRuns = vi
        .fn()
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockImplementationOnce(async () => {
          worker.stop();
          return [];
        });

      expect(worker.getHealth()).toMatchObject({ status: "idle", activeRuns: 0 });
      const started = worker.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(worker.getHealth()).toMatchObject({
        status: "running",
        database: {
          healthy: false,
          claimFailures: 1,
          lastError: { operation: "claim", message: "database unavailable" }
        }
      });
      expect(adapter.claimRuns).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      await started;
      expect(adapter.claimRuns).toHaveBeenCalledTimes(2);
      expect(worker.getHealth()).toMatchObject({
        status: "idle",
        database: { healthy: true, claimFailures: 0 }
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "worker.database_retry",
        expect.objectContaining({ operation: "claim", failureCount: 1, retryIn: 100 })
      );
      expect(logger.info).toHaveBeenCalledWith(
        "worker.started",
        expect.objectContaining({ appId: "worker-tests", workerId: "recovering-worker" })
      );
      expect(logger.info).toHaveBeenCalledWith(
        "worker.stopped",
        expect.objectContaining({ appId: "worker-tests", workerId: "recovering-worker" })
      );
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("recovers timer promotion independently after a database failure", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const adapter = createWorkerAdapter();
      const logger = { debug: vi.fn() };
      const worker = new Durlo({ id: "worker-tests", adapter, logger }).worker({
        pollInterval: 1_000
      });
      adapter.fireDueTimers = vi
        .fn()
        .mockRejectedValueOnce(new Error("timer query failed"))
        .mockImplementationOnce(async () => {
          worker.stop();
          return [
            {
              id: "timer-1",
              runId: "run-1",
              stepId: "sleep",
              fireAt: new Date(),
              status: "fired",
              createdAt: new Date(),
              firedAt: new Date(),
              cancelledAt: null
            }
          ];
        });

      const started = worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.getHealth()).toMatchObject({
        database: { healthy: false, timerFailures: 1 }
      });

      await vi.advanceTimersByTimeAsync(100);
      await started;
      expect(adapter.fireDueTimers).toHaveBeenCalledTimes(2);
      expect(worker.getHealth()).toMatchObject({
        status: "idle",
        database: { healthy: true, timerFailures: 0 }
      });
      expect(logger.debug).toHaveBeenCalledWith(
        "worker.timers_promoted",
        expect.objectContaining({ count: 1 })
      );
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
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

  it("serializes lease renewals when a heartbeat is slow", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createWorkerAdapter();
      const controlled = controlledTask(adapter, "extended");
      const renewals: Array<(extended: boolean) => void> = [];
      adapter.extendRunLease = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            renewals.push(resolve);
          })
      );

      const run = controlled.worker.runOnce();
      await controlled.started;
      await vi.advanceTimersByTimeAsync(30);
      expect(adapter.extendRunLease).toHaveBeenCalledTimes(1);

      renewals.shift()!(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(adapter.extendRunLease).toHaveBeenCalledTimes(2);

      renewals.shift()!(true);
      controlled.resolveExecution("completed result");
      await expect(run).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("worker logging", () => {
  it("emits structured run transition records when a logger is configured", async () => {
    const adapter = createWorkerAdapter();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const durlo = new Durlo({ id: "worker-tests", adapter, logger });
    const task = durlo.task({ id: "logged-task", run: async () => "done" });
    adapter.claimRuns = vi.fn(async () => [claimedTask(task.id)]);

    await durlo.worker({ tasks: [task], workerId: "logging-worker" }).runOnce();

    expect(logger.debug).toHaveBeenCalledWith(
      "run.started",
      expect.objectContaining({
        appId: "worker-tests",
        workerId: "logging-worker",
        runId: "run-1",
        resourceId: "logged-task"
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "run.completed",
      expect.objectContaining({ runId: "run-1", kind: "task" })
    );
  });
});

describe("worker timeouts", () => {
  it("records a cooperative timeout and ignores a late user-code completion", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createWorkerAdapter();
      let finishExecution!: (value: string) => void;
      let markStarted!: () => void;
      let signal: AbortSignal | undefined;
      const execution = new Promise<string>((resolve) => {
        finishExecution = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const durlo = new Durlo({ id: "worker-tests", adapter });
      const task = durlo.task({
        id: "timeout-task",
        retry: { attempts: 1 },
        run: async (_input: unknown, context) => {
          signal = context.signal;
          markStarted();
          return execution;
        }
      });
      const claim = claimedTask(task.id);
      claim.maxAttempts = 1;
      claim.options = {
        retry: { attempts: 1, backoff: { type: "fixed", delay: 0, jitter: 0 } },
        timeout: 5
      };
      adapter.claimRuns = vi.fn(async () => [claim]);

      const run = durlo
        .worker({ tasks: [task], workerId: "timeout-worker", leaseDuration: 30 })
        .runOnce();
      await started;
      await vi.advanceTimersByTimeAsync(5);
      await expect(run).resolves.toBe(1);

      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBeInstanceOf(AttemptTimeoutError);
      expect(signal?.reason).toMatchObject({
        name: "AttemptTimeoutError",
        message: "attempt timed out after 5ms"
      });
      expect(adapter.failRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          attemptStatus: "timed_out",
          outcome: { status: "dead_letter" }
        })
      );

      finishExecution("late result");
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.completeRun).not.toHaveBeenCalled();
      expect(adapter.failRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("worker storage limits", () => {
  it("turns an oversized output into an actionable run failure", async () => {
    const adapter = createWorkerAdapter();
    const durlo = new Durlo({
      id: "worker-tests",
      adapter,
      limits: { maxOutputBytes: 5 }
    });
    const task = durlo.task({ id: "large-output", run: async () => "too large" });
    const claim = claimedTask(task.id);
    claim.maxAttempts = 1;
    adapter.claimRuns = vi.fn(async () => [claim]);

    await durlo.worker({ tasks: [task], workerId: "worker-1" }).runOnce();

    expect(adapter.completeRun).not.toHaveBeenCalled();
    expect(adapter.failRun).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          name: "StorageLimitError",
          message: expect.stringContaining("maxOutputBytes")
        }),
        outcome: { status: "dead_letter" }
      })
    );
  });

  it("replaces an oversized thrown error with a bounded durable error", async () => {
    const adapter = createWorkerAdapter();
    const durlo = new Durlo({
      id: "worker-tests",
      adapter,
      limits: { maxErrorBytes: 128 }
    });
    const task = durlo.task({
      id: "large-error",
      run: async () => {
        throw new Error("x".repeat(10_000));
      }
    });
    const claim = claimedTask(task.id);
    claim.maxAttempts = 1;
    adapter.claimRuns = vi.fn(async () => [claim]);

    await durlo.worker({ tasks: [task], workerId: "worker-1" }).runOnce();

    const failure = vi.mocked(adapter.failRun).mock.calls[0]![0];
    expect(failure.error).toMatchObject({
      name: "StorageLimitError",
      message: expect.stringContaining("maxErrorBytes")
    });
    expect(jsonByteSize(failure.error)).toBeLessThanOrEqual(128);
  });
});
