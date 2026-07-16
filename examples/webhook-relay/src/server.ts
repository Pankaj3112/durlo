import { createServer } from "node:http";
import { RunStateError } from "@durlo/core";
import { config, getApiKey } from "./config.js";
import { adapter, durlo } from "./durlo.js";
import { cancelDelivery, enqueueDelivery, getDelivery, retryDelivery } from "./deliveries.js";
import { HttpError, readJson, sendJson } from "./http.js";
import { parseDeliveryInput } from "./input.js";

const apiKey = getApiKey();

function authorize(header: string | undefined): void {
  if (header !== `Bearer ${apiKey}`) throw new HttpError(401, "unauthorized");
}

function deliveryRoute(pathname: string): { deliveryId: string; action?: string } | null {
  const match = pathname.match(/^\/deliveries\/([^/]+)(?:\/(cancel|retry))?$/);
  if (!match?.[1]) return null;
  return { deliveryId: decodeURIComponent(match[1]), ...(match[2] ? { action: match[2] } : {}) };
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
    if (request.method === "POST" && url.pathname === "/deliveries") {
      const parsed = parseDeliveryInput(await readJson(request));
      if ("issues" in parsed) throw new HttpError(400, parsed.issues[0].message);
      const handle = await enqueueDelivery(parsed.value);
      sendJson(response, 202, { deliveryId: parsed.value.deliveryId, runId: handle.id });
      return;
    }

    const route = deliveryRoute(url.pathname);
    if (route && request.method === "GET" && !route.action) {
      const result = await getDelivery(route.deliveryId);
      if (!result) throw new HttpError(404, "delivery not found");
      sendJson(response, 200, result);
      return;
    }
    if (route && request.method === "POST" && route.action === "cancel") {
      const run = await cancelDelivery(route.deliveryId);
      if (!run) throw new HttpError(404, "delivery not found");
      sendJson(response, 200, { deliveryId: route.deliveryId, run });
      return;
    }
    if (route && request.method === "POST" && route.action === "retry") {
      const run = await retryDelivery(route.deliveryId);
      if (!run) throw new HttpError(404, "delivery not found");
      sendJson(response, 202, { deliveryId: route.deliveryId, run });
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
  process.stdout.write(`webhook relay listening on http://0.0.0.0:${config.port}\n`);
});

async function shutdown(): Promise<void> {
  server.close();
  await adapter.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
