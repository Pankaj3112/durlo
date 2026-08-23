import { SerializationError } from "./errors.js";
import type { DurableValue, JsonValue, SerializationVersion, SerializedError } from "./types.js";

const LEGACY_DATE_TAG = "$durlo.date";
const ENVELOPE_KEY = "$durlo";
const SERIALIZATION_VERSION = 2;
const DATE_KIND = "date";
const OBJECT_KIND = "object";
export const CURRENT_SERIALIZATION_VERSION: SerializationVersion = SERIALIZATION_VERSION;

type SerializationEnvelope = [
  version: typeof SERIALIZATION_VERSION,
  kind: typeof DATE_KIND | typeof OBJECT_KIND,
  value: string | Array<[string, JsonValue]>
];

function envelope(value: SerializationEnvelope): { [ENVELOPE_KEY]: SerializationEnvelope } {
  return { [ENVELOPE_KEY]: value };
}

function isEnvelope(
  value: Record<string, JsonValue>
): value is { [ENVELOPE_KEY]: SerializationEnvelope } {
  if (
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, ENVELOPE_KEY)
  ) {
    return false;
  }
  const candidate = value[ENVELOPE_KEY];
  if (!Array.isArray(candidate) || candidate.length !== 3) return false;
  if (candidate[0] !== SERIALIZATION_VERSION) return false;
  if (candidate[1] === DATE_KIND) return typeof candidate[2] === "string";
  if (candidate[1] !== OBJECT_KIND || !Array.isArray(candidate[2])) return false;
  return candidate[2].every(
    (entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
  );
}

export function serialize(
  value: unknown,
  version: SerializationVersion = SERIALIZATION_VERSION
): JsonValue {
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
      return version === 1
        ? { [LEGACY_DATE_TAG]: current.toISOString() }
        : envelope([SERIALIZATION_VERSION, DATE_KIND, current.toISOString()]);
    }
    if (current instanceof Error) return serializeError(current, version) as unknown as JsonValue;
    const object = current as object;
    if (seen.has(object)) throw new SerializationError(`${path} contains a circular reference`);
    seen.add(object);
    try {
      if (Array.isArray(object))
        return object.map((item, index) => visit(item, `${path}[${index}]`));
      const prototype = Object.getPrototypeOf(object) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SerializationError(`${path} contains an unsupported class instance`);
      }
      const entries = Object.entries(object).map(
        ([key, item]) => [key, visit(item, `${path}.${key}`)] as [string, JsonValue]
      );
      if (version === 1) return Object.fromEntries(entries);
      return envelope([SERIALIZATION_VERSION, OBJECT_KIND, entries]);
    } finally {
      seen.delete(object);
    }
  };

  return visit(value, "value");
}

export function deserialize(value: JsonValue, version?: SerializationVersion): DurableValue {
  if (value instanceof Date) return value;
  const decode = (item: JsonValue): DurableValue => deserialize(item, version);
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    if (version !== 1 && isEnvelope(record)) {
      const [, kind, payload] = record[ENVELOPE_KEY] as SerializationEnvelope;
      if (kind === DATE_KIND) return new Date(payload as string);
      return Object.fromEntries(
        (payload as Array<[string, JsonValue]>).map(([key, item]) => [key, decode(item)])
      ) as Record<string, DurableValue>;
    }
    if (
      version !== SERIALIZATION_VERSION &&
      Object.keys(record).length === 1 &&
      typeof record[LEGACY_DATE_TAG] === "string"
    ) {
      return new Date(record[LEGACY_DATE_TAG]);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decode(item)])
    ) as Record<string, DurableValue>;
  }
  return value;
}

export function serializeError(
  error: unknown,
  version: SerializationVersion = SERIALIZATION_VERSION
): SerializedError {
  if (error instanceof Error) {
    let cause: JsonValue | undefined;
    if (error.cause !== undefined) {
      try {
        cause = serialize(error.cause, version);
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
    cause = serialize(error, version);
  } catch {
    cause = String(error);
  }
  return { name: "Error", message: typeof error === "string" ? error : "Unknown error", cause };
}
