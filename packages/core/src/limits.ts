import { SerializationError, StorageLimitError, ValidationError } from "./errors.js";
import type {
  DurloLimits,
  PersistedRunLimits,
  SerializationVersion,
  SerializedError
} from "./types.js";
import { serializeError } from "./serialization.js";

export const DEFAULT_DURLO_LIMITS: Readonly<DurloLimits> = Object.freeze({
  maxInputBytes: 1_048_576,
  maxOutputBytes: 1_048_576,
  maxErrorBytes: 65_536,
  maxBatchItems: 1_000,
  maxBatchBytes: 10_485_760,
  maxStepResultBytes: 1_048_576,
  maxWorkflowSteps: 1_000
});

const BYTE_LIMITS = [
  "maxInputBytes",
  "maxOutputBytes",
  "maxErrorBytes",
  "maxBatchBytes",
  "maxStepResultBytes"
] as const;
const COUNT_LIMITS = ["maxBatchItems", "maxWorkflowSteps"] as const;

export function normalizeDurloLimits(
  input: Partial<DurloLimits> | undefined,
  base: DurloLimits = DEFAULT_DURLO_LIMITS
): DurloLimits {
  const limits = { ...base, ...input };
  for (const name of [...BYTE_LIMITS, ...COUNT_LIMITS]) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ValidationError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxErrorBytes < 128) {
    throw new ValidationError("maxErrorBytes must be at least 128 bytes");
  }
  return limits;
}

export function persistedRunLimits(limits: DurloLimits): PersistedRunLimits {
  return {
    maxOutputBytes: limits.maxOutputBytes,
    maxErrorBytes: limits.maxErrorBytes,
    maxStepResultBytes: limits.maxStepResultBytes,
    maxWorkflowSteps: limits.maxWorkflowSteps
  };
}

export function jsonByteSize(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new SerializationError("value does not have a JSON representation");
  }
  return Buffer.byteLength(serialized, "utf8");
}

export function assertByteLimit(
  value: unknown,
  limitName: keyof DurloLimits,
  limit: number,
  label: string
): number {
  const actual = jsonByteSize(value);
  if (actual > limit) {
    throw new StorageLimitError(
      `${label} is ${actual} bytes; ${limitName} is ${limit} bytes`,
      limitName,
      actual,
      limit
    );
  }
  return actual;
}

export function assertCountLimit(
  actual: number,
  limitName: "maxBatchItems" | "maxWorkflowSteps",
  limit: number,
  label: string
): void {
  if (actual > limit) {
    throw new StorageLimitError(
      `${label} is ${actual}; ${limitName} is ${limit}`,
      limitName,
      actual,
      limit
    );
  }
}

export function serializeErrorWithinLimit(
  error: unknown,
  maxErrorBytes: number,
  version?: SerializationVersion
): SerializedError {
  const serialized = serializeError(error, version);
  const actual = jsonByteSize(serialized);
  if (actual <= maxErrorBytes) return serialized;

  return {
    name: "StorageLimitError",
    message: `error payload is ${actual} bytes; maxErrorBytes is ${maxErrorBytes} bytes`
  };
}
