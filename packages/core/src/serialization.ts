import { SerializationError } from "./errors.js";
import type { JsonValue, SerializedError } from "./types.js";

const DATE_TAG = "$durlo.date";

export function serialize(value: unknown): JsonValue {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, path: string): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean")
      return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new SerializationError(`${path} contains a non-finite number`);
      return current;
    }
    if (["undefined", "bigint", "function", "symbol"].includes(typeof current)) {
      throw new SerializationError(`${path} contains unsupported ${typeof current}`);
    }
    if (current instanceof Date) {
      if (!Number.isFinite(current.getTime()))
        throw new SerializationError(`${path} contains an invalid Date`);
      return { [DATE_TAG]: current.toISOString() };
    }
    if (current instanceof Error) return serializeError(current) as unknown as JsonValue;
    if (typeof current !== "object") throw new SerializationError(`${path} is not serializable`);
    if (seen.has(current)) throw new SerializationError(`${path} contains a circular reference`);
    seen.add(current);
    try {
      if (Array.isArray(current))
        return current.map((item, index) => visit(item, `${path}[${index}]`));
      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SerializationError(`${path} contains an unsupported class instance`);
      }
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(current))
        result[key] = visit(item, `${path}.${key}`);
      return result;
    } finally {
      seen.delete(current);
    }
  };

  return visit(value, "value");
}

export function deserialize(value: JsonValue): unknown {
  if (Array.isArray(value)) return value.map(deserialize);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value[DATE_TAG] === "string") {
      return new Date(value[DATE_TAG]);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deserialize(item)]));
  }
  return value;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    let cause: JsonValue | undefined;
    if (error.cause !== undefined) {
      try {
        cause = serialize(error.cause);
      } catch {
        cause = String(error.cause);
      }
    }
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(cause === undefined ? {} : { cause })
    };
  }
  let cause: JsonValue;
  try {
    cause = serialize(error);
  } catch {
    cause = String(error);
  }
  return { name: "Error", message: typeof error === "string" ? error : "Unknown error", cause };
}
