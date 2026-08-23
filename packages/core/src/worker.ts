import { randomUUID } from "node:crypto";
import { AttemptTimeoutError, ValidationError } from "./errors.js";
import { createLostLeaseSignal, isLostLeaseSignal, isWorkflowSleepSignal } from "./control.js";
import { calculateRetryDelay } from "./retry.js";
import { CURRENT_SERIALIZATION_VERSION, deserialize, serialize } from "./serialization.js";
import { createStepTools } from "./steps.js";
import {
  DEFAULT_DURLO_LIMITS,
  assertByteLimit,
  normalizeDurloLimits,
  serializeErrorWithinLimit
} from "./limits.js";
import type {
  ClaimedRun,
  DurloAdapter,
  DurloLimits,
  Logger,
  NormalizedRetryPolicy,
  RegisteredResource,
  TaskContext,
  WorkerCompatibilityReport,
  WorkerHealth,
  WorkerOptions,
  WorkflowContext
} from "./types.js";
import { parseTimerDuration } from "./validation.js";
import { getTaskRegistration, getWorkflowRegistration } from "./definitions.js";

type RegisteredTask = {
  id: string;
  version: string;
  run(input: unknown, context: TaskContext): Promise<unknown>;
};

type RegisteredWorkflow = {
  id: string;
  version: string;
  run(context: WorkflowContext<unknown>): Promise<unknown>;
};

const OPERATIONAL_BACKOFF_INITIAL = 100;
const OPERATIONAL_BACKOFF_MAX = 30_000;
const OPERATIONAL_BACKOFF_JITTER = 0.2;

function resourceKey(resourceId: string, resourceVersion?: string): string {
  return `${resourceId}\u0000${resourceVersion ?? "1"}`;
}

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

function isLostLease(error: unknown, adapter: DurloAdapter): boolean {
  return isLostLeaseSignal(error) || adapter.isLeaseLoss?.(error) === true;
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
  private readonly tasks = new Map<string, RegisteredTask>();
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  private readonly concurrency: number;
  private readonly pollInterval: number;
  private readonly leaseDuration: number;
  private readonly logger: Logger | undefined;
  private readonly defaultLimits: DurloLimits;
  private readonly activeRuns = new Set<Promise<void>>();
  private stopController: AbortController | undefined;
  private claimFailures = 0;
  private timerFailures = 0;
  private persistenceFailures = 0;
  private lastSuccessfulClaimAt: Date | null = null;
  private lastSuccessfulTimerPromotionAt: Date | null = null;
  private lastSuccessfulPersistenceAt: Date | null = null;
  private lastError: WorkerHealth["database"]["lastError"] = null;
  private started = false;

  constructor(
    appId: string,
    adapter: DurloAdapter,
    options: WorkerOptions,
    logger?: Logger,
    limits: DurloLimits = DEFAULT_DURLO_LIMITS
  ) {
    this.appId = appId;
    this.adapter = adapter;
    this.logger = logger;
    this.defaultLimits = normalizeDurloLimits(limits);
    this.id = options.workerId ?? randomUUID();
    this.concurrency = options.concurrency ?? 10;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 1_000) {
      throw new ValidationError("worker concurrency must be an integer from 1 to 1000");
    }
    this.pollInterval = parseTimerDuration(options.pollInterval ?? "1s", "poll interval", {
      allowZero: false
    });
    this.leaseDuration = parseTimerDuration(options.leaseDuration ?? "30s", "lease duration", {
      allowZero: false
    });
    for (const task of options.tasks ?? []) {
      const key = resourceKey(task.id, task.version);
      if (this.tasks.has(key)) {
        throw new ValidationError(
          `task '${task.id}' version '${task.version}' is registered more than once`
        );
      }
      const registration = getTaskRegistration(task);
      if (!registration) {
        throw new ValidationError(
          `task '${task.id}' version '${task.version}' is not a Durlo task definition`
        );
      }
      this.tasks.set(key, { id: task.id, version: task.version, run: registration.run });
    }
    for (const workflow of options.workflows ?? []) {
      const key = resourceKey(workflow.id, workflow.version);
      if (this.workflows.has(key)) {
        throw new ValidationError(
          `workflow '${workflow.id}' version '${workflow.version}' is registered more than once`
        );
      }
      const registration = getWorkflowRegistration(workflow);
      if (!registration) {
        throw new ValidationError(
          `workflow '${workflow.id}' version '${workflow.version}' is not a Durlo workflow definition`
        );
      }
      this.workflows.set(key, {
        id: workflow.id,
        version: workflow.version,
        run: registration.run
      });
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("worker is already started");
    this.started = true;
    this.claimFailures = 0;
    this.timerFailures = 0;
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
        healthy:
          this.claimFailures === 0 && this.timerFailures === 0 && this.persistenceFailures === 0,
        claimFailures: this.claimFailures,
        timerFailures: this.timerFailures,
        persistenceFailures: this.persistenceFailures,
        lastSuccessfulClaimAt: this.lastSuccessfulClaimAt,
        lastSuccessfulTimerPromotionAt: this.lastSuccessfulTimerPromotionAt,
        lastSuccessfulPersistenceAt: this.lastSuccessfulPersistenceAt,
        lastError: this.lastError
      }
    };
  }

  async getCompatibilityReport(
    options: { limit?: number } = {}
  ): Promise<WorkerCompatibilityReport> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new ValidationError("compatibility report limit must be an integer from 1 to 1000");
    }
    const registeredResources = this.resources();
    const unavailableRuns = await this.adapter.findUnavailableRuns({
      appId: this.appId,
      resources: registeredResources,
      limit: limit + 1
    });
    return {
      workerId: this.id,
      appId: this.appId,
      checkedAt: new Date(),
      registeredResources,
      unavailableRuns: unavailableRuns.slice(0, limit),
      truncated: unavailableRuns.length > limit
    };
  }

  async runOnce(): Promise<number> {
    await this.adapter.fireDueTimers({ appId: this.appId, limit: this.concurrency });
    const runs = await this.adapter.claimRuns({
      appId: this.appId,
      workerId: this.id,
      limit: this.concurrency,
      leaseDuration: this.leaseDuration,
      resources: this.resources()
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
            this.notePersistenceFailure(result.reason, "release");
            this.log("error", "worker.release_failed", {
              error: errorMessage(result.reason)
            });
          } else if (result.value) {
            this.notePersistenceSuccess();
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

  private resources(): Array<Required<RegisteredResource>> {
    return [
      ...[...this.tasks.values()].map(({ id: resourceId, version: resourceVersion }) => ({
        kind: "task" as const,
        resourceId,
        resourceVersion
      })),
      ...[...this.workflows.values()].map(({ id: resourceId, version: resourceVersion }) => ({
        kind: "workflow" as const,
        resourceId,
        resourceVersion
      }))
    ];
  }

  private async executeRun(run: ClaimedRun): Promise<void> {
    const key = resourceKey(run.resourceId, run.resourceVersion);
    const task = run.kind === "task" ? this.tasks.get(key) : undefined;
    const workflow = run.kind === "workflow" ? this.workflows.get(key) : undefined;
    if (!task && !workflow) {
      let released = false;
      try {
        released = await this.adapter.releaseRun({
          runId: run.id,
          workerId: this.id,
          leaseToken: run.leaseToken
        });
      } catch (error) {
        this.notePersistenceFailure(error, "release");
        throw error;
      }
      if (released) this.notePersistenceSuccess();
      this.log("error", "run.incompatible_claim", {
        runId: run.id,
        kind: run.kind,
        resourceId: run.resourceId,
        resourceVersion: run.resourceVersion,
        released
      });
      return;
    }
    this.log("debug", "run.started", {
      runId: run.id,
      kind: run.kind,
      resourceId: run.resourceId,
      resourceVersion: run.resourceVersion,
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
    let limits = this.defaultLimits;

    try {
      limits = this.limitsFor(run);
      const serializationVersion = run.serializationVersion ?? CURRENT_SERIALIZATION_VERSION;
      const input = deserialize(run.input, serializationVersion);
      const context = {
        run: {
          id: run.id,
          kind: run.kind,
          resourceId: run.resourceId,
          resourceVersion: run.resourceVersion
        },
        attempt: { number: run.attemptCount, maxAttempts: run.maxAttempts },
        signal: abortController.signal
      };
      const execution = task
        ? task.run(input, context)
        : workflow!.run({
            input,
            step: createStepTools(this.adapter, run, limits, (error) =>
              this.notePersistenceFailure(error)
            ),
            ...context
          });
      const timeout = this.timeoutFor(run);
      const output =
        timeout === undefined
          ? await execution
          : await this.withTimeout(execution, timeout, abortController);
      await stopHeartbeat();
      if (!ownsLease) return;
      const serializedOutput = serialize(
        output === undefined ? null : output,
        serializationVersion
      );
      assertByteLimit(serializedOutput, "maxOutputBytes", limits.maxOutputBytes, "run output");
      try {
        await this.adapter.completeRun({
          runId: run.id,
          workerId: this.id,
          leaseToken: run.leaseToken,
          output: serializedOutput
        });
      } catch (error) {
        this.notePersistenceFailure(error);
        throw error;
      }
      this.notePersistenceSuccess();
      this.log("info", "run.completed", {
        runId: run.id,
        kind: run.kind,
        resourceId: run.resourceId,
        resourceVersion: run.resourceVersion
      });
    } catch (error) {
      await stopHeartbeat();
      if (isWorkflowSleepSignal(error)) {
        this.notePersistenceSuccess();
        this.log("debug", "run.sleeping", { runId: run.id, resourceId: run.resourceId });
        return;
      }
      if (!ownsLease || isLostLease(error, this.adapter)) return;
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
          error: serializeErrorWithinLimit(
            error,
            limits.maxErrorBytes,
            run.serializationVersion ?? CURRENT_SERIALIZATION_VERSION
          ),
          ...(error instanceof AttemptTimeoutError ? { attemptStatus: "timed_out" } : {}),
          outcome
        });
        this.notePersistenceSuccess();
        this.log(outcome.status === "pending" ? "warn" : "error", "run.failed", {
          runId: run.id,
          kind: run.kind,
          resourceId: run.resourceId,
          attemptStatus: error instanceof AttemptTimeoutError ? "timed_out" : "failed",
          outcome: outcome.status,
          error: errorMessage(error)
        });
      } catch (writeError) {
        if (!isLostLease(writeError, this.adapter)) {
          this.notePersistenceFailure(writeError);
          throw writeError;
        }
      }
    } finally {
      await stopHeartbeat();
    }
  }

  private async runHeartbeat(
    run: ClaimedRun,
    signal: AbortSignal,
    loseLease: (error: Error) => void
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
          loseLease(createLostLeaseSignal(`lease lost for run ${run.id}`));
          return;
        }
      } catch {
        loseLease(createLostLeaseSignal(`lease renewal failed for run ${run.id}`));
        return;
      }
    }
  }

  private retryFor(run: ClaimedRun): NormalizedRetryPolicy {
    const options = this.optionsFor(run) as { retry?: NormalizedRetryPolicy };
    if (!options.retry) throw new Error(`run ${run.id} is missing its retry policy`);
    return options.retry;
  }

  private limitsFor(run: ClaimedRun): DurloLimits {
    const options = this.optionsFor(run) as { limits?: unknown };
    if (options.limits === undefined) return this.defaultLimits;
    if (!options.limits || typeof options.limits !== "object" || Array.isArray(options.limits)) {
      throw new ValidationError(`run ${run.id} has invalid storage limits`);
    }
    return normalizeDurloLimits(options.limits as Partial<DurloLimits>, this.defaultLimits);
  }

  private timeoutFor(run: ClaimedRun): number | undefined {
    const options = this.optionsFor(run) as { timeout?: unknown };
    return typeof options.timeout === "number" ? options.timeout : undefined;
  }

  private optionsFor(run: ClaimedRun): Record<string, unknown> {
    const options = deserialize(
      run.options,
      run.serializationVersion ?? CURRENT_SERIALIZATION_VERSION
    );
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new ValidationError(`run ${run.id} has invalid options`);
    }
    return options as Record<string, unknown>;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    milliseconds: number,
    controller: AbortController
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new AttemptTimeoutError(`attempt timed out after ${milliseconds}ms`);
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

  private notePersistenceFailure(
    error: unknown,
    operation: "execution" | "release" = "execution"
  ): void {
    if (isLostLease(error, this.adapter)) return;
    this.persistenceFailures += 1;
    this.recordError(operation, error);
  }

  private notePersistenceSuccess(): void {
    this.persistenceFailures = 0;
    this.lastSuccessfulPersistenceAt = new Date();
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
