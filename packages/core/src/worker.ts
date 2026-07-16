import { randomUUID } from "node:crypto";
import { LostLeaseError, ValidationError, WorkflowSleepError } from "./errors.js";
import { calculateRetryDelay } from "./retry.js";
import { deserialize, serialize, serializeError } from "./serialization.js";
import { createStepTools } from "./steps.js";
import type {
  ClaimRunsInput,
  ClaimedRun,
  DurloAdapter,
  Logger,
  NormalizedRetryPolicy,
  RegisteredTaskDefinition,
  RegisteredWorkflowDefinition,
  WorkerHealth,
  WorkerOptions
} from "./types.js";
import { parseDuration } from "./validation.js";

class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

const OPERATIONAL_BACKOFF_INITIAL = 100;
const OPERATIONAL_BACKOFF_MAX = 30_000;
const OPERATIONAL_BACKOFF_JITTER = 0.2;

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function isLostLease(error: unknown): boolean {
  return error instanceof LostLeaseError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationalBackoff(failureCount: number): number {
  const exponential = OPERATIONAL_BACKOFF_INITIAL * 2 ** Math.min(failureCount - 1, 20);
  const base = Math.min(OPERATIONAL_BACKOFF_MAX, exponential);
  const jitter = 1 - OPERATIONAL_BACKOFF_JITTER + Math.random() * OPERATIONAL_BACKOFF_JITTER * 2;
  return Math.min(OPERATIONAL_BACKOFF_MAX, Math.floor(base * jitter));
}

export class Worker {
  readonly id: string;
  private readonly appId: string;
  private readonly adapter: DurloAdapter;
  private readonly tasks = new Map<string, RegisteredTaskDefinition>();
  private readonly workflows = new Map<string, RegisteredWorkflowDefinition>();
  private readonly concurrency: number;
  private readonly pollInterval: number;
  private readonly leaseDuration: number;
  private readonly logger: Logger | undefined;
  private readonly activeRuns = new Set<Promise<void>>();
  private stopController: AbortController | undefined;
  private claimFailures = 0;
  private timerFailures = 0;
  private lastSuccessfulClaimAt: Date | null = null;
  private lastSuccessfulTimerPromotionAt: Date | null = null;
  private lastError: WorkerHealth["database"]["lastError"] = null;
  private started = false;

  constructor(appId: string, adapter: DurloAdapter, options: WorkerOptions, logger?: Logger) {
    this.appId = appId;
    this.adapter = adapter;
    this.logger = logger;
    this.id = options.workerId ?? randomUUID();
    this.concurrency = options.concurrency ?? 10;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 1_000) {
      throw new ValidationError("worker concurrency must be an integer from 1 to 1000");
    }
    this.pollInterval = parseDuration(options.pollInterval ?? "1s", "poll interval");
    this.leaseDuration = parseDuration(options.leaseDuration ?? "30s", "lease duration");
    if (this.leaseDuration <= 0)
      throw new ValidationError("lease duration must be greater than zero");
    for (const task of options.tasks ?? []) {
      if (this.tasks.has(task.id))
        throw new ValidationError(`task '${task.id}' is registered more than once`);
      this.tasks.set(task.id, task);
    }
    for (const workflow of options.workflows ?? []) {
      if (this.workflows.has(workflow.id)) {
        throw new ValidationError(`workflow '${workflow.id}' is registered more than once`);
      }
      this.workflows.set(workflow.id, workflow);
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("worker is already started");
    this.started = true;
    this.claimFailures = 0;
    this.timerFailures = 0;
    this.lastError = null;
    const stopController = new AbortController();
    this.stopController = stopController;
    this.log("info", "worker.started", { concurrency: this.concurrency });
    const claimLoop = this.runClaimLoop(stopController.signal);
    const timerLoop = this.runTimerLoop(stopController.signal);
    try {
      await Promise.all([claimLoop, timerLoop]);
    } finally {
      stopController.abort();
      await Promise.allSettled([claimLoop, timerLoop]);
      await Promise.allSettled([...this.activeRuns]);
      this.stopController = undefined;
      this.started = false;
      this.log("info", "worker.stopped");
    }
  }

  stop(): void {
    if (this.stopController && !this.stopController.signal.aborted) {
      this.log("info", "worker.stopping", { activeRuns: this.activeRuns.size });
    }
    this.stopController?.abort();
  }

  getHealth(): WorkerHealth {
    const stopping = this.stopController?.signal.aborted === true;
    return {
      workerId: this.id,
      appId: this.appId,
      status: this.started ? (stopping ? "stopping" : "running") : "idle",
      activeRuns: this.activeRuns.size,
      concurrency: this.concurrency,
      database: {
        healthy: this.claimFailures === 0 && this.timerFailures === 0,
        claimFailures: this.claimFailures,
        timerFailures: this.timerFailures,
        lastSuccessfulClaimAt: this.lastSuccessfulClaimAt,
        lastSuccessfulTimerPromotionAt: this.lastSuccessfulTimerPromotionAt,
        lastError: this.lastError
      }
    };
  }

  async runOnce(): Promise<number> {
    await this.adapter.fireDueTimers({ appId: this.appId, limit: this.concurrency });
    const runs = await this.adapter.claimRuns({
      appId: this.appId,
      workerId: this.id,
      limit: this.concurrency,
      leaseDuration: this.leaseDuration,
      resources: [
        ...[...this.tasks.keys()].map((resourceId) => ({ kind: "task" as const, resourceId })),
        ...[...this.workflows.keys()].map((resourceId) => ({
          kind: "workflow" as const,
          resourceId
        }))
      ]
    });
    await Promise.all(runs.map((run) => this.executeRun(run)));
    return runs.length;
  }

  private async runClaimLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const capacity = this.concurrency - this.activeRuns.size;
      if (capacity === 0) {
        await Promise.race([...this.activeRuns, delay(this.pollInterval, signal)]);
        continue;
      }

      let runs: ClaimedRun[];
      try {
        runs = await this.adapter.claimRuns({
          appId: this.appId,
          workerId: this.id,
          limit: capacity,
          leaseDuration: this.leaseDuration,
          resources: this.resources()
        });
        this.claimFailures = 0;
        this.lastSuccessfulClaimAt = new Date();
      } catch (error) {
        if (signal.aborted) return;
        this.claimFailures += 1;
        const retryIn = operationalBackoff(this.claimFailures);
        this.recordError("claim", error);
        this.log("warn", "worker.database_retry", {
          operation: "claim",
          failureCount: this.claimFailures,
          retryIn,
          error: errorMessage(error)
        });
        await delay(retryIn, signal);
        continue;
      }
      if (signal.aborted) {
        const released = await Promise.allSettled(
          runs.map((run) =>
            this.adapter.releaseRun({
              runId: run.id,
              workerId: this.id,
              leaseToken: run.leaseToken
            })
          )
        );
        for (const result of released) {
          if (result.status === "rejected") {
            this.recordError("release", result.reason);
            this.log("error", "worker.release_failed", {
              error: errorMessage(result.reason)
            });
          }
        }
        return;
      }
      if (runs.length === 0) {
        await delay(this.pollInterval, signal);
        continue;
      }
      this.log("debug", "worker.runs_claimed", { count: runs.length });
      for (const run of runs) this.trackRun(run);
    }
  }

  private async runTimerLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let timers;
      try {
        timers = await this.adapter.fireDueTimers({
          appId: this.appId,
          limit: this.concurrency
        });
        this.timerFailures = 0;
        this.lastSuccessfulTimerPromotionAt = new Date();
      } catch (error) {
        if (signal.aborted) return;
        this.timerFailures += 1;
        const retryIn = operationalBackoff(this.timerFailures);
        this.recordError("timer", error);
        this.log("warn", "worker.database_retry", {
          operation: "timer",
          failureCount: this.timerFailures,
          retryIn,
          error: errorMessage(error)
        });
        await delay(retryIn, signal);
        continue;
      }
      if (timers.length > 0) {
        this.log("debug", "worker.timers_promoted", { count: timers.length });
      }
      if (timers.length < this.concurrency) await delay(this.pollInterval, signal);
    }
  }

  private trackRun(run: ClaimedRun): void {
    const tracked = this.executeRun(run)
      .catch((error: unknown) => {
        this.recordError("execution", error);
        this.log("error", "run.persistence_failed", {
          runId: run.id,
          resourceId: run.resourceId,
          error: errorMessage(error)
        });
      })
      .finally(() => {
        this.activeRuns.delete(tracked);
      });
    this.activeRuns.add(tracked);
  }

  private resources(): ClaimRunsInput["resources"] {
    return [
      ...[...this.tasks.keys()].map((resourceId) => ({ kind: "task" as const, resourceId })),
      ...[...this.workflows.keys()].map((resourceId) => ({
        kind: "workflow" as const,
        resourceId
      }))
    ];
  }

  private async executeRun(run: ClaimedRun): Promise<void> {
    const task = run.kind === "task" ? this.tasks.get(run.resourceId) : undefined;
    const workflow = run.kind === "workflow" ? this.workflows.get(run.resourceId) : undefined;
    if (!task && !workflow) return;
    this.log("debug", "run.started", {
      runId: run.id,
      kind: run.kind,
      resourceId: run.resourceId,
      attempt: run.attemptCount
    });
    const abortController = new AbortController();
    let ownsLease = true;
    const heartbeatController = new AbortController();
    const heartbeat = this.runHeartbeat(run, heartbeatController.signal, (error) => {
      ownsLease = false;
      abortController.abort(error);
      this.log("warn", "run.lease_lost", {
        runId: run.id,
        resourceId: run.resourceId,
        error: error.message
      });
    });
    const stopHeartbeat = async (): Promise<void> => {
      heartbeatController.abort();
      await heartbeat;
    };

    try {
      const definition = task ?? workflow!;
      const input = await definition._durlo.validate(deserialize(run.input));
      const context = {
        run: { id: run.id, kind: run.kind, resourceId: run.resourceId },
        attempt: { number: run.attemptCount, maxAttempts: run.maxAttempts },
        signal: abortController.signal
      };
      const execution = task
        ? task._durlo.run(input, context)
        : workflow!._durlo.run({
            input,
            step: createStepTools(this.adapter, run),
            ...context
          });
      const timeout = this.timeoutFor(run);
      const output =
        timeout === undefined
          ? await execution
          : await this.withTimeout(execution, timeout, abortController);
      await stopHeartbeat();
      if (!ownsLease) return;
      await this.adapter.completeRun({
        runId: run.id,
        workerId: this.id,
        leaseToken: run.leaseToken,
        output: serialize(output === undefined ? null : output)
      });
      this.log("info", "run.completed", {
        runId: run.id,
        kind: run.kind,
        resourceId: run.resourceId
      });
    } catch (error) {
      await stopHeartbeat();
      if (error instanceof WorkflowSleepError) {
        this.log("debug", "run.sleeping", { runId: run.id, resourceId: run.resourceId });
        return;
      }
      if (!ownsLease || isLostLease(error)) return;
      const retry = this.retryFor(run);
      const failureNumber = run.failureCount + 1;
      const exhausted = failureNumber >= run.maxAttempts;
      const outcome = exhausted
        ? ({ status: run.kind === "task" ? "dead_letter" : "failed" } as const)
        : ({
            status: "pending",
            scheduledAt: new Date(Date.now() + calculateRetryDelay(retry.backoff, failureNumber))
          } as const);
      try {
        await this.adapter.failRun({
          runId: run.id,
          workerId: this.id,
          leaseToken: run.leaseToken,
          error: serializeError(error),
          ...(error instanceof TimeoutError ? { attemptStatus: "timed_out" } : {}),
          outcome
        });
        this.log(outcome.status === "pending" ? "warn" : "error", "run.failed", {
          runId: run.id,
          kind: run.kind,
          resourceId: run.resourceId,
          attemptStatus: error instanceof TimeoutError ? "timed_out" : "failed",
          outcome: outcome.status,
          error: errorMessage(error)
        });
      } catch (writeError) {
        if (!isLostLease(writeError)) throw writeError;
      }
    } finally {
      await stopHeartbeat();
    }
  }

  private async runHeartbeat(
    run: ClaimedRun,
    signal: AbortSignal,
    loseLease: (error: LostLeaseError) => void
  ): Promise<void> {
    const interval = Math.max(1, Math.floor(this.leaseDuration / 3));
    while (!signal.aborted) {
      await delay(interval, signal);
      if (signal.aborted) return;
      try {
        const extended = await this.adapter.extendRunLease({
          runId: run.id,
          workerId: this.id,
          leaseToken: run.leaseToken,
          leaseDuration: this.leaseDuration
        });
        if (!extended) {
          loseLease(new LostLeaseError(`lease lost for run ${run.id}`));
          return;
        }
      } catch {
        loseLease(new LostLeaseError(`lease renewal failed for run ${run.id}`));
        return;
      }
    }
  }

  private retryFor(run: ClaimedRun): NormalizedRetryPolicy {
    const options = run.options as { retry?: NormalizedRetryPolicy };
    if (!options.retry) throw new Error(`run ${run.id} is missing its retry policy`);
    return options.retry;
  }

  private timeoutFor(run: ClaimedRun): number | undefined {
    const options = run.options as { timeout?: unknown };
    return typeof options.timeout === "number" ? options.timeout : undefined;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    milliseconds: number,
    controller: AbortController
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new TimeoutError(`attempt timed out after ${milliseconds}ms`);
        controller.abort(error);
        reject(error);
      }, milliseconds);
      timer.unref();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private recordError(
    operation: WorkerHealth["database"]["lastError"] extends infer T
      ? T extends { operation: infer O }
        ? O
        : never
      : never,
    error: unknown
  ): void {
    this.lastError = { operation, message: errorMessage(error), at: new Date() };
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data: Record<string, unknown> = {}
  ): void {
    try {
      this.logger?.[level]?.(message, {
        event: message,
        appId: this.appId,
        workerId: this.id,
        ...data
      });
    } catch {
      // Logging must never change durable execution behavior.
    }
  }
}
