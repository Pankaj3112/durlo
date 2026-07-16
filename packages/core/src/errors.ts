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

export class LostLeaseError extends DurloError {
  override readonly name = "LostLeaseError";
}

export class AttemptTimeoutError extends DurloError {
  override readonly name = "AttemptTimeoutError";
}

export class RunStateError extends DurloError {
  override readonly name = "RunStateError";
}

export class WorkflowSleepError extends DurloError {
  override readonly name = "WorkflowSleepError";
}
