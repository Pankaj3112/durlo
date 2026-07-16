import { parseDuration } from "@durlo/core";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4320");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}

function parsePublicationDelay(value: string | undefined): number {
  const delay = parseDuration(value ?? "30s", "CATALOG_PUBLICATION_DELAY");
  if (delay < 100 || delay > 86_400_000) {
    throw new Error("CATALOG_PUBLICATION_DELAY must be between 100ms and 1d");
  }
  return delay;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  port: parsePort(process.env.PORT),
  publicationDelayMs: parsePublicationDelay(process.env.CATALOG_PUBLICATION_DELAY),
  workflowVersion: process.env.CATALOG_IMPORT_WORKFLOW_VERSION?.trim() || "1",
  workerLeaseDuration: process.env.DURLO_WORKER_LEASE_DURATION?.trim() || "15s"
};

export function getApiKey(): string {
  return required("CATALOG_IMPORT_API_KEY");
}
