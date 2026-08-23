import { createServer } from "node:http";
import { RunStateError } from "@durlo/core";
import { config, getApiKey } from "./config.js";
import { adapter, durlo } from "./durlo.js";
import { cancelImport, enqueueImport, getImport, listProducts, retryImport } from "./imports.js";
import { HttpError, readJson, sendJson } from "./http.js";
import { parseImportRequest } from "./input.js";

const apiKey = getApiKey();

function authorize(header: string | undefined): void {
  if (header !== `Bearer ${apiKey}`) throw new HttpError(401, "unauthorized");
}

function importRoute(pathname: string): { importId: string; action?: string } | null {
  const match = pathname.match(/^\/imports\/([^/]+)(?:\/(cancel|retry))?$/);
  if (!match?.[1]) return null;
  return { importId: decodeURIComponent(match[1]), ...(match[2] ? { action: match[2] } : {}) };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      await adapter.pool.query("select 1");
      sendJson(response, 200, { ok: true, backlog: await durlo.runs.getBacklogHealth() });
      return;
    }

    authorize(request.headers.authorization);
    if (request.method === "POST" && url.pathname === "/imports") {
      const parsed = parseImportRequest(await readJson(request));
      if ("issues" in parsed) throw new HttpError(400, parsed.issues[0].message);
      const handle = await enqueueImport(parsed.value, parsed.contentHash);
      sendJson(response, 202, {
        importId: parsed.value.importId,
        runId: handle.run.id,
        created: handle.created
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/products") {
      const requestedLimit = Number(url.searchParams.get("limit") ?? "100");
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1_000) {
        throw new HttpError(400, "limit must be an integer from 1 to 1000");
      }
      sendJson(response, 200, { products: await listProducts(requestedLimit) });
      return;
    }

    const route = importRoute(url.pathname);
    if (route && request.method === "GET" && !route.action) {
      const result = await getImport(route.importId);
      if (!result) throw new HttpError(404, "catalog import not found");
      sendJson(response, 200, result);
      return;
    }
    if (route && request.method === "POST" && route.action === "cancel") {
      const run = await cancelImport(route.importId);
      if (!run) throw new HttpError(404, "catalog import not found");
      sendJson(response, 200, { importId: route.importId, run });
      return;
    }
    if (route && request.method === "POST" && route.action === "retry") {
      const run = await retryImport(route.importId);
      if (!run) throw new HttpError(404, "catalog import not found");
      sendJson(response, 202, { importId: route.importId, run });
      return;
    }

    throw new HttpError(404, "not found");
  } catch (error) {
    const status =
      error instanceof HttpError ? error.status : error instanceof RunStateError ? 409 : 500;
    const message = error instanceof Error ? error.message : "internal error";
    if (status === 500) console.error(error);
    sendJson(response, status, { error: message });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`catalog import API listening on http://0.0.0.0:${config.port}\n`);
});

async function shutdown(): Promise<void> {
  server.close();
  await adapter.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
