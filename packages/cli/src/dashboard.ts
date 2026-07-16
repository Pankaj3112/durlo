import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { RunStateError, ValidationError } from "@durlo/core";
import type { RunKind, RunListOptions, RunStatus, Worker } from "@durlo/core";
import { dashboardPage } from "./dashboard-page.js";
import type { DashboardOptions, DurloConfig } from "./types.js";

const STATUSES = new Set<RunStatus>([
  "pending",
  "running",
  "sleeping",
  "completed",
  "failed",
  "dead_letter",
  "cancelled"
]);
const KINDS = new Set<RunKind>(["task", "workflow"]);

export type DashboardServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

export async function startDashboard(
  config: DurloConfig,
  worker?: Worker,
  options: DashboardOptions = {}
): Promise<DashboardServer> {
  const host = options.host ?? config.dashboard?.host ?? "127.0.0.1";
  const port = options.port ?? config.dashboard?.port ?? 3210;
  validateAddress(host, port);

  const server = createServer((request, response) => {
    void route(config, worker, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status =
        error instanceof ValidationError ? 400 : error instanceof RunStateError ? 409 : 500;
      sendJson(response, status, { error: errorMessage(error) });
    });
  });
  await listen(server, host, port);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("dashboard did not bind a TCP address");
  }
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return {
    host,
    port: address.port,
    url: `http://${displayHost}:${address.port}`,
    close: () => closeServer(server)
  };
}

async function route(
  config: DurloConfig,
  worker: Worker | undefined,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, dashboardPage(config.durlo.id));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/runs") {
    sendJson(response, 200, await config.durlo.runs.list(runListOptions(url.searchParams)));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    const [backlog, compatibility] = await Promise.all([
      config.durlo.runs.getBacklogHealth(),
      worker?.getCompatibilityReport({ limit: 100 }) ?? null
    ]);
    sendJson(response, 200, {
      appId: config.durlo.id,
      backlog,
      worker: worker?.getHealth() ?? null,
      compatibility
    });
    return;
  }

  const match = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(cancel|retry))?$/);
  if (match) {
    const runId = decodeURIComponent(match[1]!);
    const action = match[2];
    if (request.method === "GET" && action === undefined) {
      const details = await config.durlo.runs.getDetails(runId);
      if (!details) {
        sendJson(response, 404, { error: `run '${runId}' was not found` });
        return;
      }
      sendJson(response, 200, details);
      return;
    }
    if (request.method === "POST" && action) {
      assertSameOrigin(request);
      const run =
        action === "cancel"
          ? await config.durlo.runs.cancel(runId)
          : await config.durlo.runs.retry(runId);
      sendJson(response, 200, { run });
      return;
    }
  }
  sendJson(response, 404, { error: "not found" });
}

function runListOptions(search: URLSearchParams): RunListOptions {
  const limitValue = search.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit)) throw new ValidationError("limit must be an integer");
  const statuses = values(search, "status");
  const kinds = values(search, "kind");
  if (statuses.some((status) => !STATUSES.has(status as RunStatus))) {
    throw new ValidationError("status contains an invalid run status");
  }
  if (kinds.some((kind) => !KINDS.has(kind as RunKind))) {
    throw new ValidationError("kind contains an invalid run kind");
  }
  const cursor = search.get("cursor") ?? undefined;
  const resourceId = search.get("resourceId") ?? undefined;
  const resourceVersion = search.get("resourceVersion") ?? undefined;
  return {
    limit,
    statuses: statuses as RunStatus[],
    kinds: kinds as RunKind[],
    ...(cursor === undefined ? {} : { cursor }),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(resourceVersion === undefined ? {} : { resourceVersion })
  };
}

function values(search: URLSearchParams, key: string): string[] {
  return search
    .getAll(key)
    .flatMap((value) => value.split(","))
    .filter(Boolean);
}

function assertSameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ValidationError("invalid request origin");
  }
  if (originHost !== request.headers.host) {
    throw new ValidationError("cross-origin dashboard actions are not allowed");
  }
}

function validateAddress(host: string, port: number): void {
  if (host.trim().length === 0) throw new ValidationError("dashboard host must not be empty");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ValidationError("dashboard port must be an integer from 0 to 65535");
  }
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
