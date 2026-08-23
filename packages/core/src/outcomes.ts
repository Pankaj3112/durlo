import { DurloError, ValidationError } from "./errors.js";
import { privateRegistry } from "./private-registry.js";
import type { DurationInput } from "./types.js";
import { parseDuration } from "./validation.js";

export class PermanentError extends DurloError {
  override readonly name = "PermanentError";
  override readonly cause?: unknown;

  constructor(message = "", options: { cause?: unknown } = {}) {
    const hasCause = Object.prototype.hasOwnProperty.call(options, "cause");
    super(message, hasCause ? { cause: options.cause } : undefined);
    if (hasCause) this.cause = options.cause;
    privateRegistry.permanentErrors.set(this, PermanentError);
  }
}

type RetryAfterOptions = {
  after: DurationInput;
  at?: never;
  message?: string;
  cause?: unknown;
};
type RetryAtOptions = {
  at: Date | string | number;
  after?: never;
  message?: string;
  cause?: unknown;
};

export class RetryError extends DurloError {
  override readonly name = "RetryError";
  readonly retryAt: Date;
  override readonly cause?: unknown;

  constructor(options: RetryAfterOptions | RetryAtOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new ValidationError("RetryError requires exactly one retry schedule");
    }
    const hasAfter = Object.prototype.hasOwnProperty.call(options, "after");
    const hasAt = Object.prototype.hasOwnProperty.call(options, "at");
    if (hasAfter === hasAt) {
      throw new ValidationError("RetryError requires exactly one of 'after' or 'at'");
    }
    const hasCause = Object.prototype.hasOwnProperty.call(options, "cause");
    super(options.message ?? "", hasCause ? { cause: options.cause } : undefined);
    if (hasCause) this.cause = options.cause;
    const at = (options as RetryAtOptions).at;
    if (hasAt && !(at instanceof Date) && typeof at !== "string" && typeof at !== "number") {
      throw new ValidationError("retry time must be a Date, string, or number");
    }
    const retryAt = hasAfter
      ? new Date(Date.now() + parseDuration((options as RetryAfterOptions).after, "retry delay"))
      : new Date(at);
    if (!Number.isFinite(retryAt.getTime())) {
      throw new ValidationError("retry time must be a valid date");
    }
    this.retryAt = retryAt;
    privateRegistry.retryErrors.set(this, RetryError);
  }
}

export function isPermanentError(error: unknown): error is PermanentError {
  if (!error || typeof error !== "object") return false;
  const constructor = privateRegistry.permanentErrors.get(error);
  return constructor !== undefined && Object.getPrototypeOf(error) === constructor.prototype;
}

export function isRetryError(error: unknown): error is RetryError {
  if (!error || typeof error !== "object") return false;
  const constructor = privateRegistry.retryErrors.get(error);
  return (
    constructor !== undefined &&
    Object.getPrototypeOf(error) === constructor.prototype &&
    error instanceof Error &&
    "retryAt" in error &&
    error.retryAt instanceof Date &&
    Number.isFinite(error.retryAt.getTime())
  );
}
