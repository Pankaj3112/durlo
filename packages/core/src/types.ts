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

export type IdempotencyMismatch =
  "resource_version" | "input" | "execution_options" | "schedule" | "legacy_unverifiable";

export type ScheduleIntent =
  | { type: "immediate" }
  | { type: "delay"; milliseconds: number }
  | { type: "runAt"; timestamp: string };

export type RunKind = "task" | "workflow";
export type RunStatus =
  "pending" | "running" | "sleeping" | "completed" | "failed" | "dead_letter" | "cancelled";
export type TerminalRunStatus = "completed" | "failed" | "dead_letter" | "cancelled";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type DurableValue = JsonPrimitive | Date | DurableValue[] | { [key: string]: DurableValue };
export type SerializationVersion = 1 | 2;

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  cause?: JsonValue;
};

export type DecodedSerializedError = {
  name: string;
  message: string;
  stack?: string;
  cause?: DurableValue;
};

export type DurloLimits = {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxErrorBytes: number;
  maxBatchItems: number;
  maxBatchBytes: number;
  maxStepResultBytes: number;
  maxWorkflowSteps: number;
};

export type PersistedRunLimits = Pick<
  DurloLimits,
  "maxOutputBytes" | "maxErrorBytes" | "maxStepResultBytes" | "maxWorkflowSteps"
>;

export type RunRecord = {
  id: string;
  appId: string;
  kind: RunKind;
  resourceId: string;
  resourceVersion: string;
  status: RunStatus;
  input: DurableValue;
  output: DurableValue | null;
  error: DecodedSerializedError | null;
  options: DurableValue;
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
  "id" | "kind" | "resourceId" | "resourceVersion" | "status" | "createdAt"
> & { readonly __output?: TOutput };

export type RunCreation<TOutput = unknown> = {
  readonly run: RunHandle<TOutput>;
  readonly created: boolean;
};

export type RunSummary = Pick<
  RunRecord,
  | "id"
  | "kind"
  | "resourceId"
  | "resourceVersion"
  | "status"
  | "priority"
  | "scheduledAt"
  | "attemptCount"
  | "maxAttempts"
  | "stalledCount"
  | "createdAt"
  | "updatedAt"
  | "startedAt"
  | "completedAt"
  | "cancelledAt"
>;

export type RunListOptions = {
  limit?: number;
  cursor?: string;
  statuses?: RunStatus[];
  kinds?: RunKind[];
  resourceId?: string;
  resourceVersion?: string;
  createdAfter?: Date | string | number;
  createdBefore?: Date | string | number;
};

export type RunListPage = {
  runs: RunSummary[];
  nextCursor: string | null;
};

export type RunListCursor = {
  createdAt: Date;
  id: string;
};

export type RunListInput = {
  appId: string;
  limit: number;
  cursor: RunListCursor | null;
  statuses: RunStatus[];
  kinds: RunKind[];
  resourceId: string | null;
  resourceVersion: string | null;
  createdAfter: Date | null;
  createdBefore: Date | null;
};

export type ClaimedRun = Omit<RunRecord, "input" | "output" | "error" | "options"> & {
  input: JsonValue;
  output: JsonValue | null;
  error: SerializedError | null;
  options: JsonValue;
  status: "running";
  lockedBy: string;
  leaseToken: string;
  lockedUntil: Date;
  failureCount: number;
  /** Persisted codec for every durable value owned by this run. */
  serializationVersion?: SerializationVersion;
};

export type ClaimRunsInput = {
  appId: string;
  workerId: string;
  limit: number;
  leaseDuration: number;
  resources: RegisteredResource[];
};

export type RegisteredResource = {
  kind: RunKind;
  resourceId: string;
  resourceVersion?: string;
};

export type UnavailableRunReason = "unregistered_resource" | "incompatible_version";

export type UnavailableRun = Pick<
  RunRecord,
  "id" | "kind" | "resourceId" | "resourceVersion" | "status" | "scheduledAt" | "createdAt"
> & {
  reason: UnavailableRunReason;
};

export type WorkerCompatibilityReport = {
  workerId: string;
  appId: string;
  checkedAt: Date;
  registeredResources: Array<Required<RegisteredResource>>;
  unavailableRuns: UnavailableRun[];
  truncated: boolean;
};

export type OwnedRunInput = {
  runId: string;
  workerId: string;
  leaseToken: string;
};

export type AppRunInput = {
  appId: string;
  runId: string;
};

export type RetentionCleanupOptions = {
  olderThan: DurationInput;
  limit?: number;
  statuses?: TerminalRunStatus[];
};

export type RetentionCleanupInput = {
  appId: string;
  olderThan: number;
  limit: number;
  statuses: TerminalRunStatus[];
};

export type RetentionCleanupResult = {
  deletedRuns: number;
  deletedRunIds: string[];
  limitReached: boolean;
};

export type FailRunInput = OwnedRunInput & {
  error: SerializedError;
  attemptStatus?: "failed" | "timed_out";
  outcome: { status: "pending"; scheduledAt: Date } | { status: "failed" | "dead_letter" };
};

export type StepStatus =
  "pending" | "running" | "completed" | "failed" | "stalled" | "timed_out" | "cancelled";

export type StepRecord = {
  id: string;
  runId: string;
  stepId: string;
  status: StepStatus;
  result: DurableValue | null;
  error: DecodedSerializedError | null;
  options: DurableValue;
  attemptCount: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type RawStepRecord = Omit<StepRecord, "result" | "error" | "options"> & {
  result: JsonValue | null;
  error: SerializedError | null;
  options: JsonValue;
};

export type StepInput = OwnedRunInput & { stepId: string };

export type AttemptKind = "run" | "step";
export type AttemptStatus =
  "running" | "succeeded" | "failed" | "timed_out" | "stalled" | "cancelled";

export type AttemptRecord = {
  id: string;
  runId: string;
  stepId: string | null;
  kind: AttemptKind;
  attemptNumber: number;
  status: AttemptStatus;
  workerId: string | null;
  error: DecodedSerializedError | null;
  startedAt: Date;
  completedAt: Date | null;
};

export type TimerStatus = "pending" | "fired" | "cancelled";

export type TimerRecord = {
  id: string;
  runId: string;
  stepId: string;
  fireAt: Date;
  status: TimerStatus;
  createdAt: Date;
  firedAt: Date | null;
  cancelledAt: Date | null;
};

export type RunTimelineEventType =
  | "run_created"
  | "run_attempt_started"
  | "run_attempt_succeeded"
  | "run_attempt_failed"
  | "run_attempt_timed_out"
  | "run_attempt_stalled"
  | "run_attempt_cancelled"
  | "run_retry_started"
  | "run_manual_retry_started"
  | "run_retry_scheduled"
  | "run_manual_retry_scheduled"
  | "run_released"
  | "step_created"
  | "step_attempt_started"
  | "step_attempt_succeeded"
  | "step_attempt_failed"
  | "step_attempt_timed_out"
  | "step_attempt_stalled"
  | "step_attempt_cancelled"
  | "step_completed"
  | "step_failed"
  | "timer_scheduled"
  | "timer_fired"
  | "timer_cancelled"
  | "run_completed"
  | "run_failed"
  | "run_dead_letter"
  | "run_cancelled";

export type RunTimelineEvent = {
  id: string;
  type: RunTimelineEventType;
  at: Date;
  runId: string;
  recordId: string;
  stepId?: string;
  attemptNumber?: number;
  workerId?: string;
  status?: RunStatus | StepStatus | TimerStatus | AttemptStatus;
  error?: DecodedSerializedError;
  scheduledAt?: Date;
  fireAt?: Date;
};

export type RunDiagnostics = {
  failureCount: number;
  failedAttempts: number;
  timedOutAttempts: number;
  stalledAttempts: number;
  retryCount: number;
  leaseLossCount: number;
  hasExpiredLease: boolean;
  timerLagMs: number;
};

export type StoredRunDetails = {
  run: RunRecord;
  steps: StepRecord[];
  attempts: AttemptRecord[];
  timers: TimerRecord[];
  checkedAt: Date;
};

export type RunDetails = StoredRunDetails & {
  timeline: RunTimelineEvent[];
  diagnostics: RunDiagnostics;
};

export type BacklogHealth = {
  appId: string;
  checkedAt: Date;
  runs: {
    active: number;
    pending: number;
    ready: number;
    delayed: number;
    running: number;
    sleeping: number;
    expiredLeases: number;
    oldestReadyAt: Date | null;
    oldestReadyCreatedAt: Date | null;
    readyLagMs: number;
  };
  timers: {
    pending: number;
    due: number;
    oldestDueAt: Date | null;
    lagMs: number;
  };
};

export type CreateRunInput = {
  id: string;
  appId: string;
  kind: RunKind;
  resourceId: string;
  resourceVersion: string;
  input: JsonValue;
  options: JsonValue;
  idempotencyKey: string | null;
  priority: number;
  scheduledAt: Date;
  maxAttempts: number;
  idempotency?: {
    resourceVersion: string;
    input: JsonValue;
    executionOptions: JsonValue;
    schedule: ScheduleIntent;
  };
};

export type PersistedRunCreation = {
  run: RunRecord;
  created: boolean;
};

export interface TransactionalDurloAdapter {
  createRun(input: CreateRunInput): Promise<PersistedRunCreation>;
  createRuns(inputs: CreateRunInput[]): Promise<PersistedRunCreation[]>;
}

export type RawPgTransactionClient = {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
};

export type DurloTransaction = {
  readonly client: RawPgTransactionClient;
  enqueue<TInput, TOutput, THandlerInput>(
    task: TaskDefinition<TInput, TOutput, THandlerInput>,
    input: TInput,
    options?: RunOptions
  ): Promise<RunCreation<TOutput>>;
  start<TInput, TOutput, THandlerInput>(
    workflow: WorkflowDefinition<TInput, TOutput, THandlerInput>,
    input: TInput,
    options?: RunOptions
  ): Promise<RunCreation<TOutput>>;
  batchEnqueue<TInput, TOutput, THandlerInput>(
    task: TaskDefinition<TInput, TOutput, THandlerInput>,
    items: ReadonlyArray<BatchItem<TInput>>
  ): Promise<Array<RunCreation<TOutput>>>;
};

export interface DurloAdapter extends TransactionalDurloAdapter {
  getRun(input: AppRunInput): Promise<RunRecord | null>;
  getRunDetails(input: AppRunInput): Promise<StoredRunDetails | null>;
  getBacklogHealth(input: { appId: string }): Promise<BacklogHealth>;
  listRuns(input: RunListInput): Promise<RunSummary[]>;
  cancelRun(input: AppRunInput): Promise<RunRecord>;
  retryRun(input: AppRunInput): Promise<RunRecord>;
  cleanupRuns(input: RetentionCleanupInput): Promise<RetentionCleanupResult>;
  claimRuns(input: ClaimRunsInput): Promise<ClaimedRun[]>;
  findUnavailableRuns(input: {
    appId: string;
    resources: RegisteredResource[];
    limit: number;
  }): Promise<UnavailableRun[]>;
  extendRunLease(input: OwnedRunInput & { leaseDuration: number }): Promise<boolean>;
  completeRun(input: OwnedRunInput & { output: JsonValue }): Promise<void>;
  failRun(input: FailRunInput): Promise<void>;
  releaseRun(input: OwnedRunInput): Promise<boolean>;
  isLeaseLoss?(error: unknown): boolean;
  getStep(runId: string, stepId: string): Promise<StepRecord | null>;
  startStep(input: StepInput & { maxAttempts: number; maxSteps: number }): Promise<StepRecord>;
  /** Encoded step access used by the worker before it performs one decode. */
  getStepRaw?(runId: string, stepId: string): Promise<RawStepRecord | null>;
  startStepRaw?(
    input: StepInput & { maxAttempts: number; maxSteps: number }
  ): Promise<RawStepRecord>;
  completeStep(input: StepInput & { result: JsonValue }): Promise<void>;
  failStep(input: StepInput & { error: SerializedError }): Promise<void>;
  getTimer(runId: string, stepId: string): Promise<TimerRecord | null>;
  sleepRun(input: StepInput & { fireAt: Date; maxSteps: number }): Promise<TimerRecord>;
  fireDueTimers(input: { appId: string; limit: number }): Promise<TimerRecord[]>;
}

export type StandardSchemaPathSegment = PropertyKey | { readonly key: PropertyKey };

export type StandardSchemaOptions = {
  readonly libraryOptions?: Record<string, unknown> | undefined;
};

export type StandardSchemaResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<StandardSchemaPathSegment> | undefined;
      }>;
    };

export type StandardSchema<TInput = unknown, TOutput = TInput> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: StandardSchemaOptions | undefined
    ) => StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>;
    readonly types?:
      | {
          readonly input: TInput;
          readonly output: TOutput;
        }
      | undefined;
  };
};

export type RunContext = {
  id: string;
  kind: RunKind;
  resourceId: string;
  resourceVersion: string;
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

export type TaskDefinitionOptions<TInput, TOutput, THandlerInput = TInput> = {
  id: string;
  version?: string;
  name?: string;
  schema?: StandardSchema<TInput, THandlerInput>;
  retry?: RetryPolicy;
  timeout?: DurationInput;
  run: (input: THandlerInput, context: TaskContext) => Promise<TOutput> | TOutput;
};

export type WorkflowDefinitionOptions<TInput, TOutput, THandlerInput = TInput> = {
  id: string;
  version?: string;
  name?: string;
  schema?: StandardSchema<TInput, THandlerInput>;
  retry?: RetryPolicy;
  timeout?: DurationInput;
  run: (context: WorkflowContext<THandlerInput>) => Promise<TOutput> | TOutput;
};

export type BatchItem<TInput> = { input: TInput; options?: RunOptions };

export interface RegisteredTaskDefinition {
  readonly id: string;
  readonly version: string;
  readonly kind: "task";
  readonly _durlo: {
    run(input: unknown, context: TaskContext): Promise<unknown>;
  };
}

export interface TaskDefinition<
  TInput,
  TOutput,
  THandlerInput = TInput
> extends RegisteredTaskDefinition {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly kind: "task";
  readonly options: TaskDefinitionOptions<TInput, TOutput, THandlerInput>;
  enqueue(input: TInput, options?: RunOptions): Promise<RunCreation<TOutput>>;
  batchEnqueue(items: ReadonlyArray<BatchItem<TInput>>): Promise<Array<RunCreation<TOutput>>>;
}

export interface RegisteredWorkflowDefinition {
  readonly id: string;
  readonly version: string;
  readonly kind: "workflow";
  readonly _durlo: {
    run(context: WorkflowContext<unknown>): Promise<unknown>;
  };
}

export interface WorkflowDefinition<
  TInput,
  TOutput,
  THandlerInput = TInput
> extends RegisteredWorkflowDefinition {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly kind: "workflow";
  readonly options: WorkflowDefinitionOptions<TInput, TOutput, THandlerInput>;
  start(input: TInput, options?: RunOptions): Promise<RunCreation<TOutput>>;
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
  limits?: Partial<DurloLimits>;
};

export type WorkerOptions = {
  tasks?: RegisteredTaskDefinition[];
  workflows?: RegisteredWorkflowDefinition[];
  concurrency?: number;
  pollInterval?: DurationInput;
  leaseDuration?: DurationInput;
  workerId?: string;
};

export type WorkerHealth = {
  workerId: string;
  appId: string;
  status: "idle" | "running" | "stopping";
  activeRuns: number;
  concurrency: number;
  database: {
    healthy: boolean;
    claimFailures: number;
    timerFailures: number;
    persistenceFailures: number;
    lastSuccessfulClaimAt: Date | null;
    lastSuccessfulTimerPromotionAt: Date | null;
    lastSuccessfulPersistenceAt: Date | null;
    lastError: {
      operation: "claim" | "timer" | "execution" | "release";
      message: string;
      at: Date;
    } | null;
  };
};
