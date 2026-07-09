import { randomUUID } from "node:crypto";
import { LostLeaseError, ValidationError } from "./errors.js";
import { calculateRetryDelay } from "./retry.js";
import { deserialize, serialize, serializeError } from "./serialization.js";
import { createStepTools } from "./steps.js";
import type {
  ClaimedRun,
  DurloAdapter,
  NormalizedRetryPolicy,
  RegisteredTaskDefinition,
  RegisteredWorkflowDefinition,
  WorkerOptions,
} from "./types.js";
import { parseDuration } from "./validation.js";

class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLostLease(error: unknown): boolean {
  return error instanceof LostLeaseError;
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
  private stopping = false;
  private started = false;

  constructor(appId: string, adapter: DurloAdapter, options: WorkerOptions) {
    this.appId = appId;
    this.adapter = adapter;
    this.id = options.workerId ?? randomUUID();
    this.concurrency = options.concurrency ?? 10;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 1_000) {
      throw new ValidationError("worker concurrency must be an integer from 1 to 1000");
    }
    this.pollInterval = parseDuration(options.pollInterval ?? "1s", "poll interval");
    this.leaseDuration = parseDuration(options.leaseDuration ?? "30s", "lease duration");
    if (this.leaseDuration <= 0) throw new ValidationError("lease duration must be greater than zero");
    for (const task of options.tasks ?? []) {
      if (this.tasks.has(task.id)) throw new ValidationError(`task '${task.id}' is registered more than once`);
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
    this.stopping = false;
    try {
      while (!this.stopping) {
        const count = await this.runOnce();
        if (count === 0 && !this.stopping) await delay(this.pollInterval);
      }
    } finally {
      this.started = false;
    }
  }

  stop(): void {
    this.stopping = true;
  }

  async runOnce(): Promise<number> {
    const runs = await this.adapter.claimRuns({
      appId: this.appId,
      workerId: this.id,
      limit: this.concurrency,
      leaseDuration: this.leaseDuration,
      resources: [
        ...[...this.tasks.keys()].map((resourceId) => ({ kind: "task" as const, resourceId })),
        ...[...this.workflows.keys()].map((resourceId) => ({ kind: "workflow" as const, resourceId })),
      ],
    });
    await Promise.all(runs.map((run) => this.executeRun(run)));
    return runs.length;
  }

  private async executeRun(run: ClaimedRun): Promise<void> {
    const task = run.kind === "task" ? this.tasks.get(run.resourceId) : undefined;
    const workflow = run.kind === "workflow" ? this.workflows.get(run.resourceId) : undefined;
    if (!task && !workflow) return;
    const abortController = new AbortController();
    let ownsLease = true;
    const heartbeat = setInterval(() => {
      void this.adapter
        .extendRunLease({
          runId: run.id,
          workerId: this.id,
          leaseToken: run.leaseToken,
          leaseDuration: this.leaseDuration,
        })
        .then((extended) => {
          if (!extended) {
            ownsLease = false;
            abortController.abort(new LostLeaseError(`lease lost for run ${run.id}`));
          }
        })
        .catch(() => {
          ownsLease = false;
          abortController.abort(new LostLeaseError(`lease renewal failed for run ${run.id}`));
        });
    }, Math.max(1, Math.floor(this.leaseDuration / 3)));
    heartbeat.unref();

    try {
      const definition = task ?? workflow!;
      const input = await definition._durlo.validate(deserialize(run.input));
      const context = {
        run: { id: run.id, kind: run.kind, resourceId: run.resourceId },
        attempt: { number: run.attemptCount, maxAttempts: run.maxAttempts },
        signal: abortController.signal,
      };
      const execution = task
        ? task._durlo.run(input, context)
        : workflow!._durlo.run({
            input,
            step: createStepTools(this.adapter, run),
            ...context,
          });
      const timeout = this.timeoutFor(run);
      const output = timeout === undefined ? await execution : await this.withTimeout(execution, timeout, abortController);
      if (!ownsLease) return;
      await this.adapter.completeRun({
        runId: run.id,
        workerId: this.id,
        leaseToken: run.leaseToken,
        output: serialize(output === undefined ? null : output),
      });
    } catch (error) {
      if (!ownsLease || isLostLease(error)) return;
      const retry = this.retryFor(run);
      const exhausted = run.attemptCount >= run.maxAttempts;
      const outcome = exhausted
        ? ({ status: run.kind === "task" ? "dead_letter" : "failed" } as const)
        : ({
            status: "pending",
            scheduledAt: new Date(Date.now() + calculateRetryDelay(retry.backoff, run.attemptCount)),
          } as const);
      try {
        await this.adapter.failRun({
          runId: run.id,
          workerId: this.id,
          leaseToken: run.leaseToken,
          error: serializeError(error),
          ...(error instanceof TimeoutError ? { attemptStatus: "timed_out" } : {}),
          outcome,
        });
      } catch (writeError) {
        if (!isLostLease(writeError)) throw writeError;
      }
    } finally {
      clearInterval(heartbeat);
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

  private async withTimeout<T>(promise: Promise<T>, milliseconds: number, controller: AbortController): Promise<T> {
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
}
