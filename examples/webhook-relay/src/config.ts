const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost"];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4310");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}

function parseAllowedHosts(value: string | undefined): ReadonlySet<string> {
  const hosts = (value?.split(",") ?? DEFAULT_ALLOWED_HOSTS)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) throw new Error("WEBHOOK_RELAY_ALLOWED_HOSTS cannot be empty");
  return new Set(hosts);
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  port: parsePort(process.env.PORT),
  allowedHosts: parseAllowedHosts(process.env.WEBHOOK_RELAY_ALLOWED_HOSTS),
  allowHttp: process.env.WEBHOOK_RELAY_ALLOW_HTTP === "1"
};

export function getApiKey(): string {
  return required("WEBHOOK_RELAY_API_KEY");
}

export function assertAllowedDestination(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("destinationUrl must be an absolute URL");
  }

  if (url.username || url.password) {
    throw new Error("destinationUrl must not contain credentials");
  }
  if (url.protocol !== "https:" && !(config.allowHttp && url.protocol === "http:")) {
    throw new Error("destinationUrl must use HTTPS (or explicitly enable HTTP for local testing)");
  }
  if (!config.allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`destination host '${url.hostname}' is not allowlisted`);
  }
  return url;
}
