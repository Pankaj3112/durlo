import type {
  AttemptRecord,
  BacklogHealth,
  JsonValue,
  RawPgTransactionClient,
  RetentionCleanupResult,
  RunKind,
  RunRecord,
  RunStatus,
  RunSummary,
  SerializedError,
  StepRecord,
  TimerRecord,
  UnavailableRun
} from "@durlo/core";

export type SerializationVersion = 1 | 2;
export type IdempotencyMismatch =
  "resource_version" | "input" | "execution_options" | "schedule" | "legacy_unverifiable";
export type ScheduleIntent =
  | { type: "immediate" }
  | { type: "delay"; milliseconds: number }
  | { type: "runAt"; timestamp: string };
export type RegisteredResource = {
  kind: RunKind;
  resourceId: string;
  resourceVersion?: string;
};
export type AppRunInput = { appId: string; runId: string };
export type OwnedRunInput = { runId: string; workerId: string; leaseToken: string };
export type StepInput = OwnedRunInput & { stepId: string };
export type RunListInput = {
  appId: string;
  limit: number;
  cursor: { createdAt: Date; id: string } | null;
  statuses: RunStatus[];
  kinds: RunKind[];
  resourceId: string | null;
  resourceVersion: string | null;
  createdAfter: Date | null;
  createdBefore: Date | null;
};
export type ClaimRunsInput = {
  appId: string;
  workerId: string;
  limit: number;
  leaseDuration: number;
  resources: RegisteredResource[];
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
  serializationVersion?: SerializationVersion;
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
export type PersistedRunCreation = { run: RunRecord; created: boolean };
export type FailRunInput = OwnedRunInput & {
  error: SerializedError;
  attemptStatus?: "failed" | "timed_out";
  outcome: { status: "pending"; scheduledAt: Date } | { status: "failed" | "dead_letter" };
};
export type RawStepRecord = Omit<StepRecord, "result" | "error" | "options"> & {
  result: JsonValue | null;
  error: SerializedError | null;
  options: JsonValue;
};
export type StoredRunDetails = {
  run: RunRecord;
  steps: StepRecord[];
  attempts: AttemptRecord[];
  timers: TimerRecord[];
  checkedAt: Date;
};
export type RetentionCleanupInput = {
  appId: string;
  olderThan: number;
  limit: number;
  statuses: Array<"completed" | "failed" | "dead_letter" | "cancelled">;
};

export interface TransactionalDurloAdapter {
  createRun(input: CreateRunInput): Promise<PersistedRunCreation>;
  createRuns(inputs: CreateRunInput[]): Promise<PersistedRunCreation[]>;
}

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
  getStepRaw?(runId: string, stepId: string): Promise<RawStepRecord | null>;
  startStep(input: StepInput & { maxAttempts: number; maxSteps: number }): Promise<StepRecord>;
  startStepRaw?(
    input: StepInput & { maxAttempts: number; maxSteps: number }
  ): Promise<RawStepRecord>;
  completeStep(input: StepInput & { result: JsonValue }): Promise<void>;
  failStep(input: StepInput & { error: SerializedError }): Promise<void>;
  getTimer(runId: string, stepId: string): Promise<TimerRecord | null>;
  sleepRun(input: StepInput & { fireAt: Date; maxSteps: number }): Promise<TimerRecord>;
  fireDueTimers(input: { appId: string; limit: number }): Promise<TimerRecord[]>;
}

export type { RawPgTransactionClient };
