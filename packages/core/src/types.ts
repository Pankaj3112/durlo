export type DurationInput = number | string;

export type FixedBackoffPolicy = {
  type: "fixed";
  delay: DurationInput;
  jitter?: number;
};

export type ExponentialBackoffPolicy = {
  type: "exponential";
  delay: DurationInput;
  factor?: number;
  maxDelay?: DurationInput;
  jitter?: number;
};

export type BackoffPolicy = FixedBackoffPolicy | ExponentialBackoffPolicy;

export type RetryPolicy = {
  attempts?: number;
  backoff?: BackoffPolicy;
};

export type NormalizedBackoffPolicy =
  | { type: "fixed"; delay: number; jitter: number }
  | { type: "exponential"; delay: number; factor: number; maxDelay?: number; jitter: number };

export type NormalizedRetryPolicy = {
  attempts: number;
  backoff: NormalizedBackoffPolicy;
};

export type RunOptions = {
  delay?: DurationInput;
  runAt?: Date | string | number;
  attempts?: number;
  backoff?: BackoffPolicy;
  idempotencyKey?: string;
  priority?: number;
  timeout?: DurationInput;
};

export type RunKind = "task" | "workflow";
export type RunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "completed"
  | "failed"
  | "dead_letter"
  | "cancelled";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  cause?: JsonValue;
};

export type RunRecord = {
  id: string;
  appId: string;
  kind: RunKind;
  resourceId: string;
  status: RunStatus;
  input: JsonValue;
  output: JsonValue | null;
  error: SerializedError | null;
  options: JsonValue;
  idempotencyKey: string | null;
  priority: number;
  scheduledAt: Date;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  leaseToken: string | null;
  lockedUntil: Date | null;
  stalledCount: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
};

export type RunHandle<TOutput = unknown> = Pick<
  RunRecord,
  "id" | "kind" | "resourceId" | "status" | "createdAt"
> & { readonly __output?: TOutput };

export type CreateRunInput = {
  id: string;
  appId: string;
  kind: RunKind;
  resourceId: string;
  input: JsonValue;
  options: JsonValue;
  idempotencyKey: string | null;
  priority: number;
  scheduledAt: Date;
  maxAttempts: number;
};

export interface TransactionalDurloAdapter {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  createRuns(inputs: CreateRunInput[]): Promise<RunRecord[]>;
}

export interface DurloAdapter extends TransactionalDurloAdapter {
  getRun(id: string): Promise<RunRecord | null>;
  cancelRun(id: string): Promise<RunRecord>;
  retryRun(id: string): Promise<RunRecord>;
  withTransaction(client: unknown): TransactionalDurloAdapter;
}

export type StandardSchemaResult<T> =
  | { value: T; issues?: undefined }
  | { value?: undefined; issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> };

export type StandardSchema<TInput> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<TInput> | Promise<StandardSchemaResult<TInput>>;
  };
};

export type RunContext = {
  id: string;
  kind: RunKind;
  resourceId: string;
};

export type AttemptContext = {
  number: number;
  maxAttempts: number;
};

export type TaskContext = {
  run: RunContext;
  attempt: AttemptContext;
  signal: AbortSignal;
};

export type StepTools = {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  sleep(id: string, duration: DurationInput): Promise<void>;
  sleepUntil(id: string, date: Date | string | number): Promise<void>;
};

export type WorkflowContext<TInput> = {
  input: TInput;
  step: StepTools;
  run: RunContext;
  attempt: AttemptContext;
  signal: AbortSignal;
};

export type TaskDefinitionOptions<TInput, TOutput> = {
  id: string;
  name?: string;
  schema?: StandardSchema<TInput>;
  retry?: RetryPolicy;
  timeout?: DurationInput;
  run: (input: TInput, context: TaskContext) => Promise<TOutput> | TOutput;
};

export type WorkflowDefinitionOptions<TInput, TOutput> = {
  id: string;
  name?: string;
  schema?: StandardSchema<TInput>;
  retry?: RetryPolicy;
  timeout?: DurationInput;
  run: (context: WorkflowContext<TInput>) => Promise<TOutput> | TOutput;
};

export type BatchItem<TInput> = { input: TInput; options?: RunOptions };

export interface TaskDefinition<TInput, TOutput> {
  readonly id: string;
  readonly name?: string;
  readonly kind: "task";
  readonly options: TaskDefinitionOptions<TInput, TOutput>;
  enqueue(input: TInput, options?: RunOptions): Promise<RunHandle<TOutput>>;
  batchEnqueue(items: Array<TInput | BatchItem<TInput>>): Promise<Array<RunHandle<TOutput>>>;
}

export interface WorkflowDefinition<TInput, TOutput> {
  readonly id: string;
  readonly name?: string;
  readonly kind: "workflow";
  readonly options: WorkflowDefinitionOptions<TInput, TOutput>;
  start(input: TInput, options?: RunOptions): Promise<RunHandle<TOutput>>;
}

export type Logger = {
  debug?: (message: string, data?: unknown) => void;
  info?: (message: string, data?: unknown) => void;
  warn?: (message: string, data?: unknown) => void;
  error?: (message: string, data?: unknown) => void;
};

export type DurloOptions = {
  id: string;
  adapter: DurloAdapter;
  logger?: Logger | false;
  defaultRetry?: RetryPolicy;
  defaultTimeout?: DurationInput;
};
