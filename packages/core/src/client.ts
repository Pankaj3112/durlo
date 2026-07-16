import { randomUUID } from "node:crypto";
import { normalizeRetryPolicy } from "./retry.js";
import { serialize } from "./serialization.js";
import type {
  BatchItem,
  CreateRunInput,
  DurloAdapter,
  DurloOptions,
  Logger,
  NormalizedRetryPolicy,
  RunHandle,
  RunOptions,
  RunRecord,
  TaskDefinition,
  TaskDefinitionOptions,
  TransactionalDurloAdapter,
  WorkflowDefinition,
  WorkflowDefinitionOptions
} from "./types.js";
import { parseDuration, validateId, validateRunOptions, validateSchema } from "./validation.js";
import { Worker } from "./worker.js";
import type { WorkerOptions } from "./types.js";

function toHandle<TOutput>(record: RunRecord): RunHandle<TOutput> {
  return {
    id: record.id,
    kind: record.kind,
    resourceId: record.resourceId,
    status: record.status,
    createdAt: record.createdAt
  };
}

function isBatchItem<T>(item: T | BatchItem<T>): item is BatchItem<T> {
  if (!item || typeof item !== "object" || !("input" in item)) return false;
  return Object.keys(item).every((key) => key === "input" || key === "options");
}

export class Durlo {
  readonly id: string;
  readonly adapter: DurloAdapter;
  readonly runs: {
    get: (handleOrId: RunHandle | string) => Promise<RunRecord | null>;
    cancel: (handleOrId: RunHandle | string) => Promise<RunRecord>;
    retry: (handleOrId: RunHandle | string) => Promise<RunRecord>;
  };
  private readonly defaultRetry: NormalizedRetryPolicy;
  private readonly defaultTimeout?: number;
  private readonly logger: Logger | undefined;
  private readonly resourceKeys = new Set<string>();

  constructor(options: DurloOptions) {
    validateId(options.id, "app id");
    if (!options.adapter) throw new TypeError("adapter is required");
    this.id = options.id;
    this.adapter = options.adapter;
    this.logger = options.logger === false ? undefined : options.logger;
    this.defaultRetry = normalizeRetryPolicy(options.defaultRetry);
    if (options.defaultTimeout !== undefined)
      this.defaultTimeout = parseDuration(options.defaultTimeout, "default timeout");
    const getId = (value: RunHandle | string): string =>
      typeof value === "string" ? value : value.id;
    this.runs = {
      get: (value) => this.adapter.getRun(getId(value)),
      cancel: (value) => this.adapter.cancelRun(getId(value)),
      retry: (value) => this.adapter.retryRun(getId(value))
    };
  }

  task<TInput, TOutput = void>(
    options: TaskDefinitionOptions<TInput, TOutput>
  ): TaskDefinition<TInput, TOutput> {
    this.register("task", options.id);
    const definitionRetry = normalizeRetryPolicy(options.retry, this.defaultRetry);
    const definitionTimeout =
      options.timeout === undefined
        ? this.defaultTimeout
        : parseDuration(options.timeout, "task timeout");
    const create = (adapter: TransactionalDurloAdapter, input: TInput, runOptions?: RunOptions) =>
      this.createRun<TInput, TOutput>(
        adapter,
        "task",
        options.id,
        options.schema,
        input,
        runOptions,
        definitionRetry,
        definitionTimeout
      );
    return {
      id: options.id,
      ...(options.name === undefined ? {} : { name: options.name }),
      kind: "task",
      options,
      _durlo: {
        validate: (input) => validateSchema(options.schema, input),
        run: async (input, context) => options.run(input as TInput, context)
      },
      enqueue: (input, runOptions) => create(this.adapter, input, runOptions),
      batchEnqueue: async (items) => {
        const normalized = items.map((item) => (isBatchItem(item) ? item : { input: item }));
        const prepared = await Promise.all(
          normalized.map(({ input, options: runOptions }) =>
            this.prepareRun(
              "task",
              options.id,
              options.schema,
              input,
              runOptions,
              definitionRetry,
              definitionTimeout
            )
          )
        );
        const keys = prepared
          .map((item) => item.idempotencyKey)
          .filter((key): key is string => key !== null);
        if (new Set(keys).size !== keys.length)
          throw new Error("duplicate idempotency keys in one batch are not allowed");
        return (await this.adapter.createRuns(prepared)).map(toHandle<TOutput>);
      }
    };
  }

  workflow<TInput, TOutput = void>(
    options: WorkflowDefinitionOptions<TInput, TOutput>
  ): WorkflowDefinition<TInput, TOutput> {
    this.register("workflow", options.id);
    const definitionRetry = normalizeRetryPolicy(options.retry, this.defaultRetry);
    const definitionTimeout =
      options.timeout === undefined
        ? this.defaultTimeout
        : parseDuration(options.timeout, "workflow timeout");
    return {
      id: options.id,
      ...(options.name === undefined ? {} : { name: options.name }),
      kind: "workflow",
      options,
      _durlo: {
        validate: (input) => validateSchema(options.schema, input),
        run: async (context) => options.run(context as Parameters<typeof options.run>[0])
      },
      start: (input, runOptions) =>
        this.createRun(
          this.adapter,
          "workflow",
          options.id,
          options.schema,
          input,
          runOptions,
          definitionRetry,
          definitionTimeout
        )
    };
  }

  tx(client: unknown): {
    enqueue: <TInput, TOutput>(
      task: TaskDefinition<TInput, TOutput>,
      input: TInput,
      options?: RunOptions
    ) => Promise<RunHandle<TOutput>>;
    start: <TInput, TOutput>(
      workflow: WorkflowDefinition<TInput, TOutput>,
      input: TInput,
      options?: RunOptions
    ) => Promise<RunHandle<TOutput>>;
    batchEnqueue: <TInput, TOutput>(
      task: TaskDefinition<TInput, TOutput>,
      items: Array<TInput | BatchItem<TInput>>
    ) => Promise<Array<RunHandle<TOutput>>>;
  } {
    const adapter = this.adapter.withTransaction(client);
    return {
      enqueue: (task, input, options) => {
        const retry = normalizeRetryPolicy(task.options.retry, this.defaultRetry);
        const timeout =
          task.options.timeout === undefined
            ? this.defaultTimeout
            : parseDuration(task.options.timeout);
        return this.createRun(
          adapter,
          "task",
          task.id,
          task.options.schema,
          input,
          options,
          retry,
          timeout
        );
      },
      start: (workflow, input, options) => {
        const retry = normalizeRetryPolicy(workflow.options.retry, this.defaultRetry);
        const timeout =
          workflow.options.timeout === undefined
            ? this.defaultTimeout
            : parseDuration(workflow.options.timeout);
        return this.createRun(
          adapter,
          "workflow",
          workflow.id,
          workflow.options.schema,
          input,
          options,
          retry,
          timeout
        );
      },
      batchEnqueue: async <TInput, TOutput>(
        task: TaskDefinition<TInput, TOutput>,
        items: Array<TInput | BatchItem<TInput>>
      ) => {
        const retry = normalizeRetryPolicy(task.options.retry, this.defaultRetry);
        const timeout =
          task.options.timeout === undefined
            ? this.defaultTimeout
            : parseDuration(task.options.timeout);
        const normalized = items.map((item) => (isBatchItem(item) ? item : { input: item }));
        const prepared = await Promise.all(
          normalized.map(({ input, options }) =>
            this.prepareRun("task", task.id, task.options.schema, input, options, retry, timeout)
          )
        );
        const keys = prepared
          .map((item) => item.idempotencyKey)
          .filter((key): key is string => key !== null);
        if (new Set(keys).size !== keys.length)
          throw new Error("duplicate idempotency keys in one batch are not allowed");
        return (await adapter.createRuns(prepared)).map(toHandle<TOutput>);
      }
    };
  }

  worker(options: WorkerOptions): Worker {
    return new Worker(this.id, this.adapter, options, this.logger);
  }

  private register(kind: "task" | "workflow", id: string): void {
    validateId(id, `${kind} id`);
    const key = `${kind}:${id}`;
    if (this.resourceKeys.has(key)) throw new Error(`${kind} '${id}' is already defined`);
    this.resourceKeys.add(key);
  }

  private async createRun<TInput, TOutput>(
    adapter: TransactionalDurloAdapter,
    kind: "task" | "workflow",
    resourceId: string,
    schema: TaskDefinitionOptions<TInput, TOutput>["schema"],
    input: TInput,
    options: RunOptions | undefined,
    retry: NormalizedRetryPolicy,
    timeout: number | undefined
  ): Promise<RunHandle<TOutput>> {
    return toHandle<TOutput>(
      await adapter.createRun(
        await this.prepareRun(kind, resourceId, schema, input, options, retry, timeout)
      )
    );
  }

  private async prepareRun<TInput>(
    kind: "task" | "workflow",
    resourceId: string,
    schema: TaskDefinitionOptions<TInput, unknown>["schema"],
    input: TInput,
    options: RunOptions | undefined,
    definitionRetry: NormalizedRetryPolicy,
    definitionTimeout: number | undefined
  ): Promise<CreateRunInput> {
    const runOptions = options ?? {};
    validateRunOptions(runOptions);
    const validatedInput = await validateSchema(schema, input);
    const retry = normalizeRetryPolicy(
      {
        ...(runOptions.attempts === undefined ? {} : { attempts: runOptions.attempts }),
        ...(runOptions.backoff === undefined ? {} : { backoff: runOptions.backoff })
      },
      definitionRetry
    );
    const timeout =
      runOptions.timeout === undefined
        ? definitionTimeout
        : parseDuration(runOptions.timeout, "run timeout");
    const now = Date.now();
    const scheduledAt =
      runOptions.runAt !== undefined
        ? new Date(runOptions.runAt)
        : new Date(
            now + (runOptions.delay === undefined ? 0 : parseDuration(runOptions.delay, "delay"))
          );
    const storedOptions = serialize({ retry, ...(timeout === undefined ? {} : { timeout }) });
    return {
      id: randomUUID(),
      appId: this.id,
      kind,
      resourceId,
      input: serialize(validatedInput),
      options: storedOptions,
      idempotencyKey: runOptions.idempotencyKey ?? null,
      priority: runOptions.priority ?? 0,
      scheduledAt,
      maxAttempts: retry.attempts
    };
  }
}
