import type { JsonPrimitive, JsonValue } from "@durlo/core";
import type { SerializationVersion } from "./core-internal.js";

type DurableValue = JsonPrimitive | Date | DurableValue[] | { [key: string]: DurableValue };

const LEGACY_DATE_TAG = "$durlo.date";
const ENVELOPE_KEY = "$durlo";
const SERIALIZATION_VERSION = 2;
const DATE_KIND = "date";
const OBJECT_KIND = "object";

type SerializationEnvelope = [
  version: typeof SERIALIZATION_VERSION,
  kind: typeof DATE_KIND | typeof OBJECT_KIND,
  value: string | Array<[string, JsonValue]>
];

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
  if (!Array.isArray(candidate) || candidate.length !== 3 || candidate[0] !== 2) return false;
  if (candidate[1] === DATE_KIND) return typeof candidate[2] === "string";
  if (candidate[1] !== OBJECT_KIND || !Array.isArray(candidate[2])) return false;
  return candidate[2].every(
    (entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
  );
}

export function deserialize(value: JsonValue, version?: SerializationVersion): DurableValue {
  if (value instanceof Date) return value;
  const decode = (item: JsonValue): DurableValue => deserialize(item, version);
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    if (version !== 1 && isEnvelope(record)) {
      const [, kind, payload] = record[ENVELOPE_KEY];
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
