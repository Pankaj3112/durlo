const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const DURATION_FACTORS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

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
  const match = DURATION_PATTERN.exec((value ?? "30s").trim());
  if (!match) throw new Error("CATALOG_PUBLICATION_DELAY must use ms, s, m, h, or d units");
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof DURATION_FACTORS;
  const delay = amount * DURATION_FACTORS[unit];
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
