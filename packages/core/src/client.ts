import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
import { normalizeRetryPolicy } from "./retry.js";
import { serialize } from "./serialization.js";
import { buildRunDetails } from "./observability.js";
import {
  assertByteLimit,
  assertCountLimit,
  normalizeDurloLimits,
  persistedRunLimits
} from "./limits.js";
import type {
  BatchItem,
  BacklogHealth,
  CreateRunInput,
  DurloAdapter,
  DurloLimits,
  DurloOptions,
  DurloTransaction,
  Logger,
  NormalizedRetryPolicy,
  RetentionCleanupOptions,
  RetentionCleanupResult,
  RunDetails,
  RunHandle,
  RunKind,
  RunListCursor,
  RunListOptions,
  RunListPage,
  RunOptions,
  RunRecord,
  RunStatus,
  RawPgTransactionClient,
  StandardSchema,
  TaskDefinition,
  TaskDefinitionOptions,
  TransactionalDurloAdapter,
  WorkflowDefinition,
  WorkflowDefinitionOptions
} from "./types.js";
import {
  normalizeResourceVersion,
  parseDuration,
  validateId,
  validateRunOptions,
  validateSchema
} from "./validation.js";
import { Worker } from "./worker.js";
import type { WorkerOptions } from "./types.js";

function toHandle<TOutput>(record: RunRecord): RunHandle<TOutput> {
  return {
    id: record.id,
    kind: record.kind,
    resourceId: record.resourceId,
    resourceVersion: record.resourceVersion,
    status: record.status,
    createdAt: record.createdAt
  };
}

function isBatchItem<T>(item: T | BatchItem<T>): item is BatchItem<T> {
  if (!item || typeof item !== "object" || !("input" in item)) return false;
  return Object.keys(item).every((key) => key === "input" || key === "options");
}

const RUN_STATUSES = new Set<RunStatus>([
  "pending",
  "running",
  "sleeping",
  "completed",
  "failed",
  "dead_letter",
  "cancelled"
]);
const RUN_KINDS = new Set<RunKind>(["task", "workflow"]);

function normalizeListDate(value: Date | string | number | undefined, label: string): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ValidationError(`${label} must be a valid date`);
  return date;
}

function decodeRunCursor(value: string | undefined): RunListCursor | null {
  if (value === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object") throw new Error("invalid cursor shape");
    const candidate = decoded as { version?: unknown; createdAt?: unknown; id?: unknown };
    if (candidate.version !== 1 || typeof candidate.createdAt !== "string") {
      throw new Error("unsupported cursor version");
    }
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new Error("invalid cursor id");
    }
    const createdAt = new Date(candidate.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error("invalid cursor date");
    return { createdAt, id: candidate.id };
  } catch {
    throw new ValidationError("run list cursor is invalid");
  }
}

function encodeRunCursor(cursor: RunListCursor): string {
  return Buffer.from(
    JSON.stringify({ version: 1, createdAt: cursor.createdAt.toISOString(), id: cursor.id })
  ).toString("base64url");
}

const TRANSACTION_PROVIDER = Symbol.for("@durlo/core/transaction-provider");

type InternalTransactionProvider = {
  [TRANSACTION_PROVIDER]: <TResult>(
    callback: (
      adapter: TransactionalDurloAdapter,
      client: RawPgTransactionClient
    ) => Promise<TResult>
  ) => Promise<TResult>;
};

export class Durlo {
  readonly id: string;
  readonly adapter: DurloAdapter;
  readonly runs: {
    get: (handleOrId: RunHandle | string) => Promise<RunRecord | null>;
    getDetails: (handleOrId: RunHandle | string) => Promise<RunDetails | null>;
    list: (options?: RunListOptions) => Promise<RunListPage>;
    getBacklogHealth: () => Promise<BacklogHealth>;
    cancel: (handleOrId: RunHandle | string) => Promise<RunRecord>;
    retry: (handleOrId: RunHandle | string) => Promise<RunRecord>;
    cleanup: (options: RetentionCleanupOptions) => Promise<RetentionCleanupResult>;
  };
  private readonly defaultRetry: NormalizedRetryPolicy;
  private readonly defaultTimeout?: number;
  private readonly logger: Logger | undefined;
  private readonly limits: DurloLimits;
  private readonly resourceKeys = new Set<string>();

  constructor(options: DurloOptions) {
    validateId(options.id, "app id");
    if (!options.adapter) throw new TypeError("adapter is required");
    this.id = options.id;
    this.adapter = options.adapter;
    this.logger = options.logger === false ? undefined : options.logger;
    this.limits = normalizeDurloLimits(options.limits);
    this.defaultRetry = normalizeRetryPolicy(options.defaultRetry);
    if (options.defaultTimeout !== undefined)
      this.defaultTimeout = parseDuration(options.defaultTimeout, "default timeout");
    const getId = (value: RunHandle | string): string =>
      typeof value === "string" ? value : value.id;
    this.runs = {
      get: (value) => this.adapter.getRun({ appId: this.id, runId: getId(value) }),
      getDetails: async (value) => {
        const records = await this.adapter.getRunDetails({ appId: this.id, runId: getId(value) });
        return records ? buildRunDetails(records) : null;
      },
      list: (listOptions) => this.listRuns(listOptions),
      getBacklogHealth: () => this.adapter.getBacklogHealth({ appId: this.id }),
      cancel: (value) => this.adapter.cancelRun({ appId: this.id, runId: getId(value) }),
      retry: (value) => this.adapter.retryRun({ appId: this.id, runId: getId(value) }),
      cleanup: (cleanupOptions) => this.cleanupRuns(cleanupOptions)
    };
  }

  task<TInput, TOutput = void>(
    options: TaskDefinitionOptions<TInput, TOutput, TInput>
  ): TaskDefinition<TInput, TOutput>;
  task<TInput, TOutput = void, THandlerInput = TInput>(
    options: TaskDefinitionOptions<TInput, TOutput, THandlerInput> & {
      schema: StandardSchema<TInput, THandlerInput>;
    }
  ): TaskDefinition<TInput, TOutput, THandlerInput>;
  task<TInput, TOutput = void, THandlerInput = TInput>(
    options:
      | TaskDefinitionOptions<TInput, TOutput, TInput>
      | (TaskDefinitionOptions<TInput, TOutput, THandlerInput> & {
          schema: StandardSchema<TInput, THandlerInput>;
        })
  ): TaskDefinition<TInput, TOutput, THandlerInput> {
    const definitionOptions = options as TaskDefinitionOptions<TInput, TOutput, THandlerInput>;
    const version = normalizeResourceVersion(definitionOptions.version, "task version");
    this.register("task", definitionOptions.id, version);
    const definitionRetry = normalizeRetryPolicy(definitionOptions.retry, this.defaultRetry);
    const definitionTimeout =
      definitionOptions.timeout === undefined
        ? this.defaultTimeout
        : parseDuration(definitionOptions.timeout, "task timeout");
    const create = (adapter: TransactionalDurloAdapter, input: TInput, runOptions?: RunOptions) =>
      this.createRun<TInput, THandlerInput, TOutput>(
        adapter,
        "task",
        definitionOptions.id,
        version,
        definitionOptions.schema,
        input,
        runOptions,
        definitionRetry,
        definitionTimeout
      );
    return {
      id: definitionOptions.id,
      version,
      ...(definitionOptions.name === undefined ? {} : { name: definitionOptions.name }),
      kind: "task",
      options: definitionOptions,
      _durlo: {
        run: async (input, context) => definitionOptions.run(input as THandlerInput, context)
      },
      enqueue: (input, runOptions) => create(this.adapter, input, runOptions),
      batchEnqueue: async (items) => {
        this.assertBatchCount(items.length);
        const normalized = items.map((item) => (isBatchItem(item) ? item : { input: item }));
        const prepared = await Promise.all(
          normalized.map(({ input, options: runOptions }) =>
            this.prepareRun(
              "task",
              definitionOptions.id,
              version,
              definitionOptions.schema,
              input,
              runOptions,
              definitionRetry,
              definitionTimeout
            )
          )
        );
        this.assertBatchBytes(prepared);
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
    options: WorkflowDefinitionOptions<TInput, TOutput, TInput>
  ): WorkflowDefinition<TInput, TOutput>;
  workflow<TInput, TOutput = void, THandlerInput = TInput>(
    options: WorkflowDefinitionOptions<TInput, TOutput, THandlerInput> & {
      schema: StandardSchema<TInput, THandlerInput>;
    }
  ): WorkflowDefinition<TInput, TOutput, THandlerInput>;
  workflow<TInput, TOutput = void, THandlerInput = TInput>(
    options:
      | WorkflowDefinitionOptions<TInput, TOutput, TInput>
      | (WorkflowDefinitionOptions<TInput, TOutput, THandlerInput> & {
          schema: StandardSchema<TInput, THandlerInput>;
        })
  ): WorkflowDefinition<TInput, TOutput, THandlerInput> {
    const definitionOptions = options as WorkflowDefinitionOptions<TInput, TOutput, THandlerInput>;
    const version = normalizeResourceVersion(definitionOptions.version, "workflow version");
    this.register("workflow", definitionOptions.id, version);
    const definitionRetry = normalizeRetryPolicy(definitionOptions.retry, this.defaultRetry);
    const definitionTimeout =
      definitionOptions.timeout === undefined
        ? this.defaultTimeout
        : parseDuration(definitionOptions.timeout, "workflow timeout");
    return {
      id: definitionOptions.id,
      version,
      ...(definitionOptions.name === undefined ? {} : { name: definitionOptions.name }),
      kind: "workflow",
      options: definitionOptions,
      _durlo: {
        run: async (context) =>
          definitionOptions.run(context as Parameters<typeof definitionOptions.run>[0])
      },
      start: (input, runOptions) =>
        this.createRun(
          this.adapter,
          "workflow",
          definitionOptions.id,
          version,
          definitionOptions.schema,
          input,
          runOptions,
          definitionRetry,
          definitionTimeout
        )
    };
  }

  transaction<TResult>(
    callback: (transaction: DurloTransaction) => TResult | Promise<TResult>
  ): Promise<TResult> {
    const provider = (this.adapter as unknown as InternalTransactionProvider)[TRANSACTION_PROVIDER];
    if (typeof provider !== "function") {
      throw new TypeError("adapter does not support raw pg transactions");
    }
    return provider(async (adapter, client) =>
      callback({
        client,
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
            task.version,
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
            workflow.version,
            workflow.options.schema,
            input,
            options,
            retry,
            timeout
          );
        },
        batchEnqueue: async <TInput, TOutput, THandlerInput>(
          task: TaskDefinition<TInput, TOutput, THandlerInput>,
          items: Array<TInput | BatchItem<TInput>>
        ) => {
          this.assertBatchCount(items.length);
          const retry = normalizeRetryPolicy(task.options.retry, this.defaultRetry);
          const timeout =
            task.options.timeout === undefined
              ? this.defaultTimeout
              : parseDuration(task.options.timeout);
          const normalized = items.map((item) => (isBatchItem(item) ? item : { input: item }));
          const prepared = await Promise.all(
            normalized.map(({ input, options }) =>
              this.prepareRun(
                "task",
                task.id,
                task.version,
                task.options.schema,
                input,
                options,
                retry,
                timeout
              )
            )
          );
          this.assertBatchBytes(prepared);
          const keys = prepared
            .map((item) => item.idempotencyKey)
            .filter((key): key is string => key !== null);
          if (new Set(keys).size !== keys.length)
            throw new Error("duplicate idempotency keys in one batch are not allowed");
          return (await adapter.createRuns(prepared)).map(toHandle<TOutput>);
        }
      })
    );
  }

  worker(options: WorkerOptions): Worker {
    return new Worker(this.id, this.adapter, options, this.logger, this.limits);
  }

  private register(kind: "task" | "workflow", id: string, version: string): void {
    validateId(id, `${kind} id`);
    const key = `${kind}\u0000${id}\u0000${version}`;
    if (this.resourceKeys.has(key)) {
      throw new Error(`${kind} '${id}' version '${version}' is already defined`);
    }
    this.resourceKeys.add(key);
  }

  private async cleanupRuns(options: RetentionCleanupOptions): Promise<RetentionCleanupResult> {
    const olderThan = parseDuration(options.olderThan, "retention age");
    if (olderThan <= 0) throw new ValidationError("retention age must be greater than zero");
    const limit = options.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new ValidationError("retention cleanup limit must be an integer from 1 to 10000");
    }
    const statuses = options.statuses ?? ["completed", "failed", "dead_letter", "cancelled"];
    if (statuses.length === 0 || new Set(statuses).size !== statuses.length) {
      throw new ValidationError("retention statuses must be a non-empty list without duplicates");
    }
    const allowed = new Set(["completed", "failed", "dead_letter", "cancelled"]);
    if (statuses.some((status) => !allowed.has(status))) {
      throw new ValidationError("retention cleanup accepts only terminal run statuses");
    }
    return this.adapter.cleanupRuns({ appId: this.id, olderThan, limit, statuses });
  }

  private async listRuns(options: RunListOptions = {}): Promise<RunListPage> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError("run list limit must be an integer from 1 to 200");
    }
    const statuses = options.statuses ?? [];
    if (
      new Set(statuses).size !== statuses.length ||
      statuses.some((status) => !RUN_STATUSES.has(status))
    ) {
      throw new ValidationError("run list statuses must be unique valid run statuses");
    }
    const kinds = options.kinds ?? [];
    if (new Set(kinds).size !== kinds.length || kinds.some((kind) => !RUN_KINDS.has(kind))) {
      throw new ValidationError("run list kinds must be unique valid run kinds");
    }
    if (options.resourceId !== undefined) validateId(options.resourceId, "resource id filter");
    const resourceVersion =
      options.resourceVersion === undefined
        ? null
        : normalizeResourceVersion(options.resourceVersion, "resource version filter");
    const createdAfter = normalizeListDate(options.createdAfter, "createdAfter");
    const createdBefore = normalizeListDate(options.createdBefore, "createdBefore");
    if (createdAfter && createdBefore && createdAfter >= createdBefore) {
      throw new ValidationError("createdAfter must be earlier than createdBefore");
    }

    const fetched = await this.adapter.listRuns({
      appId: this.id,
      limit: limit + 1,
      cursor: decodeRunCursor(options.cursor),
      statuses,
      kinds,
      resourceId: options.resourceId ?? null,
      resourceVersion,
      createdAfter,
      createdBefore
    });
    const runs = fetched.slice(0, limit);
    const last = runs.at(-1);
    return {
      runs,
      nextCursor:
        fetched.length > limit && last
          ? encodeRunCursor({ createdAt: last.createdAt, id: last.id })
          : null
    };
  }

  private async createRun<TInput, THandlerInput, TOutput>(
    adapter: TransactionalDurloAdapter,
    kind: "task" | "workflow",
    resourceId: string,
    resourceVersion: string,
    schema: StandardSchema<TInput, THandlerInput> | undefined,
    input: TInput,
    options: RunOptions | undefined,
    retry: NormalizedRetryPolicy,
    timeout: number | undefined
  ): Promise<RunHandle<TOutput>> {
    return toHandle<TOutput>(
      await adapter.createRun(
        await this.prepareRun(
          kind,
          resourceId,
          resourceVersion,
          schema,
          input,
          options,
          retry,
          timeout
        )
      )
    );
  }

  private async prepareRun<TInput, THandlerInput>(
    kind: "task" | "workflow",
    resourceId: string,
    resourceVersion: string,
    schema: StandardSchema<TInput, THandlerInput> | undefined,
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
    const serializedInput = serialize(validatedInput);
    assertByteLimit(serializedInput, "maxInputBytes", this.limits.maxInputBytes, "run input");
    const storedOptions = serialize({
      retry,
      ...(timeout === undefined ? {} : { timeout }),
      limits: persistedRunLimits(this.limits)
    });
    return {
      id: randomUUID(),
      appId: this.id,
      kind,
      resourceId,
      resourceVersion,
      input: serializedInput,
      options: storedOptions,
      idempotencyKey: runOptions.idempotencyKey ?? null,
      priority: runOptions.priority ?? 0,
      scheduledAt,
      maxAttempts: retry.attempts
    };
  }

  private assertBatchCount(count: number): void {
    assertCountLimit(count, "maxBatchItems", this.limits.maxBatchItems, "batch item count");
  }

  private assertBatchBytes(inputs: CreateRunInput[]): void {
    if (inputs.length === 0) return;
    assertByteLimit(
      inputs.map(({ input }) => input),
      "maxBatchBytes",
      this.limits.maxBatchBytes,
      "batch inputs"
    );
  }
}
