import { ValidationError } from "./errors.js";
import type { BackoffPolicy, DurationInput, RunOptions, StandardSchema } from "./types.js";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const DURATION_FACTORS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_DATE_MS = 8_640_000_000_000_000;

export function parseDuration(value: DurationInput, label = "duration"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new ValidationError(`${label} must be a finite, non-negative number`);
    }
    if (value > MAX_DATE_MS) {
      throw new ValidationError(`${label} is too large for a valid JavaScript date`);
    }
    return value;
  }

  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new ValidationError(`${label} must use ms, s, m, h, or d units`);
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof DURATION_FACTORS;
  const milliseconds = amount * DURATION_FACTORS[unit];
  if (!Number.isFinite(milliseconds) || milliseconds > MAX_DATE_MS) {
    throw new ValidationError(`${label} is too large for a valid JavaScript date`);
  }
  return milliseconds;
}

export function parseTimerDuration(
  value: DurationInput,
  label = "duration",
  options: { allowZero?: boolean } = {}
): number {
  const milliseconds = parseDuration(value, label);
  if (milliseconds > MAX_TIMER_DELAY_MS) {
    throw new ValidationError(
      `${label} must be at most ${MAX_TIMER_DELAY_MS} milliseconds for a Node.js timer`
    );
  }
  if (milliseconds > 0 && milliseconds < 1) {
    throw new ValidationError(`${label} must be zero or at least 1 millisecond`);
  }
  if (options.allowZero === false && milliseconds === 0) {
    throw new ValidationError(`${label} must be greater than zero`);
  }
  return milliseconds;
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
  parseTimerDuration(backoff.delay, "backoff delay", { allowZero: false });
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
      parseTimerDuration(backoff.maxDelay, "maximum backoff delay", { allowZero: false });
    }
  }
}

export function validateRunOptions(options: RunOptions): void {
  if (options.delay !== undefined && options.runAt !== undefined) {
    throw new ValidationError("delay and runAt are mutually exclusive");
  }
  if (options.delay !== undefined) parseTimerDuration(options.delay, "delay");
  if (options.timeout !== undefined) parseTimerDuration(options.timeout, "timeout");
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

export async function validateSchema<TInput, TOutput>(
  schema: StandardSchema<TInput, TOutput> | undefined,
  input: TInput
): Promise<TOutput> {
  if (!schema) return input as unknown as TOutput;
  const result = await schema["~standard"].validate(input);
  if (result.issues) {
    const detail = result.issues.map((issue) => issue.message).join(", ");
    throw new ValidationError(`input validation failed: ${detail}`);
  }
  return result.value;
}
