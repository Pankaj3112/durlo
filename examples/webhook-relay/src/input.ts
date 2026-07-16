import type { JsonValue, StandardSchema } from "@durlo/core";
import { assertAllowedDestination } from "./config.js";

export type WebhookDeliveryInput = {
  deliveryId: string;
  destinationUrl: string;
  payload: JsonValue;
};

const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function issue(message: string): { issues: [{ message: string }] } {
  return { issues: [{ message }] };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}

export function parseDeliveryInput(
  value: unknown
): { value: WebhookDeliveryInput } | { issues: [{ message: string }] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return issue("request body must be a JSON object");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.deliveryId !== "string" || !DELIVERY_ID.test(candidate.deliveryId)) {
    return issue("deliveryId must be 1-100 URL-safe characters");
  }
  if (typeof candidate.destinationUrl !== "string") {
    return issue("destinationUrl must be a string");
  }
  try {
    assertAllowedDestination(candidate.destinationUrl);
  } catch (error) {
    return issue(error instanceof Error ? error.message : "destinationUrl is invalid");
  }
  if (!("payload" in candidate) || !isJsonValue(candidate.payload)) {
    return issue("payload must be a finite JSON value");
  }

  return {
    value: {
      deliveryId: candidate.deliveryId,
      destinationUrl: candidate.destinationUrl,
      payload: candidate.payload
    }
  };
}

export const webhookDeliverySchema: StandardSchema<WebhookDeliveryInput> = {
  "~standard": {
    version: 1,
    vendor: "durlo-webhook-relay",
    validate: parseDeliveryInput
  }
};
