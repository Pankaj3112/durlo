import { DurloError, ValidationError } from "./errors.js";
import type { DurationInput } from "./types.js";
import { parseDuration } from "./validation.js";

const permanentErrors = new WeakSet<object>();
const retryErrors = new WeakSet<object>();

function dateTimestamp(value: unknown): number | null {
  try {
    return Date.prototype.getTime.call(value) as number;
  } catch {
    return null;
  }
}

export class PermanentError extends DurloError {
  override readonly name = "PermanentError";
  override readonly cause?: unknown;

  constructor(message = "", options: { cause?: unknown } = {}) {
    const hasCause = Object.prototype.hasOwnProperty.call(options, "cause");
    super(message, hasCause ? { cause: options.cause } : undefined);
    if (hasCause) this.cause = options.cause;
    permanentErrors.add(this);
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
    const atTimestamp = hasAt ? dateTimestamp(at) : null;
    if (hasAt && atTimestamp === null && typeof at !== "string" && typeof at !== "number") {
      throw new ValidationError("retry time must be a Date, string, or number");
    }
    const retryAt = hasAfter
      ? new Date(Date.now() + parseDuration((options as RetryAfterOptions).after, "retry delay"))
      : new Date(atTimestamp ?? (at as string | number));
    if (!Number.isFinite(retryAt.getTime())) {
      throw new ValidationError("retry time must be a valid date");
    }
    this.retryAt = retryAt;
    retryErrors.add(this);
  }
}

export function isPermanentError(error: unknown): error is PermanentError {
  return (
    error instanceof PermanentError &&
    Object.getPrototypeOf(error) === PermanentError.prototype &&
    permanentErrors.has(error)
  );
}

export function isRetryError(error: unknown): error is RetryError {
  return (
    error instanceof RetryError &&
    Object.getPrototypeOf(error) === RetryError.prototype &&
    retryErrors.has(error) &&
    Number.isFinite(error.retryAt.getTime())
  );
}
