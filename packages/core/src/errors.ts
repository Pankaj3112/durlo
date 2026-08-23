import type { IdempotencyMismatch, SerializedError } from "./types.js";

export class DurloError extends Error {
  override readonly name: string = "DurloError";
}

export class ValidationError extends DurloError {
  override readonly name = "ValidationError";
}

export class SerializationError extends DurloError {
  override readonly name = "SerializationError";
}

export class StorageLimitError extends DurloError {
  override readonly name = "StorageLimitError";

  constructor(
    message: string,
    readonly limitName: string,
    readonly actual: number,
    readonly limit: number
  ) {
    super(message);
  }
}

export class AttemptTimeoutError extends DurloError {
  override readonly name = "AttemptTimeoutError";
}

export class RunStateError extends DurloError {
  override readonly name = "RunStateError";
}

export class IdempotencyConflictError extends DurloError {
  override readonly name = "IdempotencyConflictError";
  readonly idempotencyKey: string;
  readonly existingRunId: string;
  readonly mismatches: readonly IdempotencyMismatch[];

  constructor(
    idempotencyKey: string,
    existingRunId: string,
    mismatches: readonly IdempotencyMismatch[]
  ) {
    const sorted = [...new Set(mismatches)].sort();
    super(
      `idempotency key '${idempotencyKey}' already belongs to run '${existingRunId}' with mismatches: ${sorted.join(", ")}`
    );
    this.idempotencyKey = idempotencyKey;
    this.existingRunId = existingRunId;
    this.mismatches = sorted;
  }
}

export class RunWaitTimeoutError extends DurloError {
  override readonly name = "RunWaitTimeoutError";

  constructor(
    readonly runId: string,
    readonly timeout: number
  ) {
    super(`run '${runId}' did not reach a terminal state within ${timeout}ms`);
  }
}

export class RunNotFoundError extends DurloError {
  override readonly name = "RunNotFoundError";

  constructor(readonly runId: string) {
    super(`run '${runId}' was not found`);
  }
}

export class RunFailedError extends DurloError {
  override readonly name = "RunFailedError";

  constructor(
    readonly runId: string,
    readonly status: "failed" | "dead_letter",
    readonly error: SerializedError | null
  ) {
    super(`run '${runId}' ended with status '${status}'`);
  }
}

export class RunCancelledError extends DurloError {
  override readonly name = "RunCancelledError";

  constructor(readonly runId: string) {
    super(`run '${runId}' was cancelled`);
  }
}
