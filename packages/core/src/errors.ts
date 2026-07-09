export class DurloError extends Error {
  override readonly name: string = "DurloError";
}

export class ValidationError extends DurloError {
  override readonly name = "ValidationError";
}

export class SerializationError extends DurloError {
  override readonly name = "SerializationError";
}

export class LostLeaseError extends DurloError {
  override readonly name = "LostLeaseError";
}

export class RunStateError extends DurloError {
  override readonly name = "RunStateError";
}
