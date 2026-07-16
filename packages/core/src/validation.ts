import { ValidationError } from "./errors.js";
import type { BackoffPolicy, DurationInput, RunOptions, StandardSchema } from "./types.js";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const DURATION_FACTORS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(value: DurationInput, label = "duration"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new ValidationError(`${label} must be a finite, non-negative number`);
    }
    return value;
  }

  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new ValidationError(`${label} must use ms, s, m, h, or d units`);
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof DURATION_FACTORS;
  return amount * DURATION_FACTORS[unit];
}

export function validateId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > 255) {
    throw new ValidationError(`${label} must be at most 255 characters`);
  }
}

export function normalizeResourceVersion(value: string | undefined, label: string): string {
  const version = value ?? "1";
  if (typeof version !== "string" || version.length === 0 || version.trim() !== version) {
    throw new ValidationError(`${label} must be a non-empty string without surrounding whitespace`);
  }
  if (version.length > 128) {
    throw new ValidationError(`${label} must be at most 128 characters`);
  }
  return version;
}

function validateAttempts(attempts: number): void {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new ValidationError("attempts must be an integer from 1 to 100");
  }
}

export function validateBackoff(backoff: BackoffPolicy): void {
  parseDuration(backoff.delay, "backoff delay");
  const jitter = backoff.jitter ?? 0;
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new ValidationError("jitter must be between 0 and 1");
  }
  if (backoff.type === "exponential") {
    const factor = backoff.factor ?? 2;
    if (!Number.isFinite(factor) || factor < 1) {
      throw new ValidationError("exponential backoff factor must be at least 1");
    }
    if (backoff.maxDelay !== undefined) {
      parseDuration(backoff.maxDelay, "maximum backoff delay");
    }
  }
}

export function validateRunOptions(options: RunOptions): void {
  if (options.delay !== undefined && options.runAt !== undefined) {
    throw new ValidationError("delay and runAt are mutually exclusive");
  }
  if (options.delay !== undefined) parseDuration(options.delay, "delay");
  if (options.timeout !== undefined) parseDuration(options.timeout, "timeout");
  if (options.runAt !== undefined && !Number.isFinite(new Date(options.runAt).getTime())) {
    throw new ValidationError("runAt must be a valid date");
  }
  if (options.attempts !== undefined) validateAttempts(options.attempts);
  if (options.backoff !== undefined) validateBackoff(options.backoff);
  if (options.priority !== undefined) {
    if (
      !Number.isInteger(options.priority) ||
      options.priority < -1000 ||
      options.priority > 1000
    ) {
      throw new ValidationError("priority must be an integer from -1000 to 1000");
    }
  }
  if (options.idempotencyKey !== undefined) {
    if (options.idempotencyKey.length === 0 || options.idempotencyKey.length > 2048) {
      throw new ValidationError("idempotencyKey must contain 1 to 2048 characters");
    }
  }
}

export async function validateSchema<T>(
  schema: StandardSchema<T> | undefined,
  input: unknown
): Promise<T> {
  if (!schema) return input as T;
  const result = await schema["~standard"].validate(input);
  if (result.issues) {
    const detail = result.issues.map((issue) => issue.message).join(", ");
    throw new ValidationError(`input validation failed: ${detail}`);
  }
  return result.value;
}
