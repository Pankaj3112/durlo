import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Pool } from "pg";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DURLO_TEST_DATABASE_URL is required for reference-app tests; run 'pnpm test:local'"
  );
}

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const webhookDirectory = resolve(workspaceRoot, "examples/webhook-relay");
const catalogDirectory = resolve(workspaceRoot, "examples/catalog-import");
const node = process.execPath;
const children = new Set();
const servers = new Set();
const pool = new Pool({ connectionString: databaseUrl });

try {
  await testWebhookRelay();
  await testCatalogImport();
  process.stdout.write(
    "reference applications passed: authentication, transactional enqueue, retry, idempotency, durable sleep, cancellation, SIGKILL recovery, and checkpoint reuse\n"
  );
} finally {
  await stopAll();
  await dropReferenceState().catch(() => undefined);
  await pool.end();
}

async function testWebhookRelay() {
  runMigration(webhookDirectory, { DATABASE_URL: databaseUrl });
  await pool.query("delete from webhook_relay_deliveries");
  await pool.query("delete from durlo_runs where app_id = 'webhook-relay'");

  const received = [];
  const receiver = createServer(async (request, response) => {
    const body = await readBody(request);
    received.push({
      body,
      idempotencyKey: request.headers["idempotency-key"],
      runId: request.headers["x-durlo-run-id"]
    });
    if (received.length === 1) {
      response.writeHead(503);
      response.end("retry this delivery");
      return;
    }
    response.writeHead(204);
    response.end();
  });
  const receiverPort = await listen(receiver);
  const apiPort = await reservePort();
  const apiKey = "reference-webhook-secret";
  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    WEBHOOK_RELAY_API_KEY: apiKey,
    WEBHOOK_RELAY_ALLOWED_HOSTS: "127.0.0.1",
    WEBHOOK_RELAY_ALLOW_HTTP: "1",
    PORT: String(apiPort)
  };
  const worker = startWorker(webhookDirectory, environment);
  await worker.waitFor(/registered 1 task\(s\) and 0 workflow\(s\)/, 10_000);
  const api = startApi(webhookDirectory, environment);
  await api.waitFor(/webhook relay listening/, 10_000);

  const unauthorized = await requestJson(
    `http://127.0.0.1:${apiPort}/deliveries/reference-webhook`
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error, "unauthorized");

  const input = {
    deliveryId: "reference-webhook",
    destinationUrl: `http://127.0.0.1:${receiverPort}/hooks`,
    payload: { invoiceId: "invoice-42" }
  };
  const created = await requestJson(`http://127.0.0.1:${apiPort}/deliveries`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(input)
  });
  assert.equal(created.status, 202);
  const runId = created.body.runId;
  assert.equal(typeof runId, "string");

  const details = await pollJson(
    `http://127.0.0.1:${apiPort}/deliveries/${input.deliveryId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    (body) => body.run?.run?.status === "completed",
    15_000
  );
  assert.equal(details.delivery.status, "delivered");
  assert.equal(details.delivery.attempt_count, 2);
  assert.deepEqual(
    details.run.attempts.map((attempt) => attempt.status),
    ["failed", "succeeded"]
  );
  assert.equal(details.run.diagnostics.retryCount, 1);
  assert.equal(received.length, 2);
  assert.deepEqual(
    received.map((request) => request.idempotencyKey),
    [input.deliveryId, input.deliveryId]
  );
  assert(received.every((request) => request.runId === runId));

  const duplicate = await requestJson(`http://127.0.0.1:${apiPort}/deliveries`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(input)
  });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.runId, runId);
  const conflict = await requestJson(`http://127.0.0.1:${apiPort}/deliveries`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ ...input, payload: { invoiceId: "different" } })
  });
  assert.equal(conflict.status, 409);

  await stop(api);
  await stop(worker);
  await close(receiver);
}

async function testCatalogImport() {
  runMigration(catalogDirectory, { DATABASE_URL: databaseUrl });
  await pool.query("delete from catalog_publications");
  await pool.query("delete from catalog_products");
  await pool.query("delete from catalog_import_rows");
  await pool.query("delete from catalog_imports");
  await pool.query("delete from durlo_runs where app_id = 'catalog-import'");

  const apiPort = await reservePort();
  const apiKey = "reference-catalog-secret";
  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    CATALOG_IMPORT_API_KEY: apiKey,
    CATALOG_PUBLICATION_DELAY: "1200ms",
    DURLO_WORKER_LEASE_DURATION: "1500ms",
    PORT: String(apiPort)
  };
  const api = startApi(catalogDirectory, environment);
  await api.waitFor(/catalog import API listening/, 10_000);

  const unauthorized = await requestJson(`http://127.0.0.1:${apiPort}/products`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error, "unauthorized");

  const crashWorker = startWorker(catalogDirectory, {
    ...environment,
    DURLO_EXAMPLE_PAUSE_AFTER_PREPARE: "1"
  });
  await crashWorker.waitFor(/registered 0 task\(s\) and 1 workflow\(s\)/, 10_000);

  const recoveredInput = {
    importId: "reference-catalog-recovery",
    rows: [{ sku: "SKU-RECOVERY", name: "Recovered product", priceCents: 2599 }]
  };
  const created = await requestJson(`http://127.0.0.1:${apiPort}/imports`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(recoveredInput)
  });
  assert.equal(created.status, 202);
  const crashOutput = await crashWorker.waitFor(/CRASH_READY runId=([^\s]+)/, 10_000);
  assert.match(crashOutput, new RegExp(`CRASH_READY runId=${escapeRegex(created.body.runId)}\\b`));
  await stop(crashWorker, "SIGKILL");

  const recoveryWorker = startWorker(catalogDirectory, environment);
  await recoveryWorker.waitFor(/registered 0 task\(s\) and 1 workflow\(s\)/, 10_000);
  const recovered = await pollJson(
    `http://127.0.0.1:${apiPort}/imports/${recoveredInput.importId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    (body) => body.run?.run?.status === "completed",
    15_000
  );
  assert.equal(recovered.import.status, "published");
  assert.equal(recovered.run.run.stalledCount, 1);
  assert.equal(recovered.run.diagnostics.leaseLossCount, 1);
  assert.deepEqual(
    recovered.run.steps.map((step) => [step.stepId, step.attemptCount]),
    [
      ["validate-source", 1],
      ["prepare-publication", 1],
      ["publish-catalog", 1]
    ]
  );
  assert.equal(recovered.run.timers[0]?.status, "fired");

  const cancelledInput = {
    importId: "reference-catalog-cancel",
    rows: [{ sku: "SKU-CANCELLED", name: "Cancelled product", priceCents: 999 }]
  };
  const cancelledCreated = await requestJson(`http://127.0.0.1:${apiPort}/imports`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(cancelledInput)
  });
  assert.equal(cancelledCreated.status, 202);
  await pollJson(
    `http://127.0.0.1:${apiPort}/imports/${cancelledInput.importId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    (body) => body.run?.run?.status === "sleeping",
    10_000
  );
  const cancelled = await requestJson(
    `http://127.0.0.1:${apiPort}/imports/${cancelledInput.importId}/cancel`,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } }
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.run.status, "cancelled");
  const cancelledDetails = await requestJson(
    `http://127.0.0.1:${apiPort}/imports/${cancelledInput.importId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  assert.equal(cancelledDetails.body.import.status, "cancelled");
  assert.equal(cancelledDetails.body.run.timers[0]?.status, "cancelled");

  const products = await requestJson(`http://127.0.0.1:${apiPort}/products`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  assert.equal(products.status, 200);
  assert(products.body.products.some((product) => product.sku === "SKU-RECOVERY"));
  assert(!products.body.products.some((product) => product.sku === "SKU-CANCELLED"));

  const duplicate = await requestJson(`http://127.0.0.1:${apiPort}/imports`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(recoveredInput)
  });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.runId, created.body.runId);
  const conflict = await requestJson(`http://127.0.0.1:${apiPort}/imports`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      importId: recoveredInput.importId,
      rows: [{ sku: "SKU-DIFFERENT", name: "Different product", priceCents: 100 }]
    })
  });
  assert.equal(conflict.status, 409);

  await stop(recoveryWorker);
  await stop(api);
}

function runMigration(directory, environment) {
  const result = spawnSync(node, ["--import", "tsx", "src/migrate.ts"], {
    cwd: directory,
    env: { ...process.env, ...environment },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `migration failed in ${directory}:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
}

function startWorker(directory, environment) {
  return start(join(directory, "node_modules/.bin/durlo"), ["worker"], directory, environment);
}

function startApi(directory, environment) {
  return start(node, ["--import", "tsx", "src/server.ts"], directory, environment);
}

function start(executable, args, directory, environment) {
  const child = spawn(executable, args, {
    cwd: directory,
    env: { ...process.env, ...environment },
    stdio: "pipe"
  });
  const processLog = {
    child,
    stdout: "",
    stderr: "",
    waitFor(pattern, timeoutMs) {
      if (pattern.test(this.stdout)) return Promise.resolve(this.stdout);
      return new Promise((resolveWait, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `timed out waiting for ${pattern}; stdout:\n${this.stdout}\nstderr:\n${this.stderr}`
            )
          );
        }, timeoutMs);
        const onData = () => {
          if (!pattern.test(this.stdout)) return;
          cleanup();
          resolveWait(this.stdout);
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(
            new Error(
              `process exited before ${pattern} (${code ?? signal}); stdout:\n${this.stdout}\nstderr:\n${this.stderr}`
            )
          );
        };
        const cleanup = () => {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
        };
        child.stdout.on("data", onData);
        child.once("exit", onExit);
      });
    }
  };
  child.stdout.on("data", (chunk) => (processLog.stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (processLog.stderr += chunk.toString()));
  children.add(processLog);
  return processLog;
}

async function stop(processLog, signal = "SIGINT") {
  if (!children.has(processLog)) return;
  if (processLog.child.exitCode === null && processLog.child.signalCode === null) {
    const exited = once(processLog.child, "exit");
    let timeout;
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`process did not stop after ${signal}`)), 10_000);
    });
    processLog.child.kill(signal);
    try {
      await Promise.race([exited, timedOut]);
    } catch (error) {
      if (processLog.child.exitCode === null && processLog.child.signalCode === null) {
        const forcedExit = once(processLog.child, "exit");
        processLog.child.kill("SIGKILL");
        await forcedExit;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  children.delete(processLog);
}

async function stopAll() {
  await Promise.allSettled([...children].map((processLog) => stop(processLog)));
  await Promise.allSettled([...servers].map((server) => close(server)));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

async function pollJson(url, options, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastBody = null;
  while (Date.now() < deadline) {
    const response = await requestJson(url, options);
    lastBody = response.body;
    if (response.status === 200 && predicate(lastBody)) return lastBody;
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
  }
  throw new Error(`timed out polling ${url}; last body: ${JSON.stringify(lastBody)}`);
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function listen(server) {
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP port");
  return address.port;
}

async function close(server) {
  if (!servers.has(server)) return;
  if (server.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
  servers.delete(server);
}

async function dropReferenceState() {
  await pool.query("drop table if exists webhook_relay_deliveries");
  await pool.query("drop table if exists catalog_publications");
  await pool.query("drop table if exists catalog_products");
  await pool.query("drop table if exists catalog_import_rows");
  await pool.query("drop table if exists catalog_imports");
  await pool.query("delete from durlo_runs where app_id in ('webhook-relay', 'catalog-import')");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
