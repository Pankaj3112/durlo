import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "../helpers/postgres-internal.js";
import type { PostgresAdapter } from "../helpers/postgres-internal.js";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres database outages", () => {
  let observer: PostgresAdapter;

  beforeAll(async () => {
    observer = postgresAdapter({ connectionString: databaseUrl! });
    await observer.migrate();
  });

  beforeEach(async () => {
    await observer.pool.query("truncate durlo_runs cascade");
  });

  afterAll(async () => {
    await observer.close();
  });

  it("recovers polling and reclaims an attempt that lost its lease during a network outage", async () => {
    const appId = "stress-database-outage";
    const proxy = await PostgresProxy.start(databaseUrl!);
    const workerAdapter = postgresAdapter({
      connectionString: proxy.connectionString,
      connectionTimeoutMillis: 200,
      max: 4
    });
    const producer = new Durlo({ id: appId, adapter: observer });
    let markFirstStarted!: () => void;
    let markFirstAborted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstAborted = new Promise<void>((resolve) => {
      markFirstAborted = resolve;
    });
    const task = producer.task<{ kind: "lease-loss" | "queued" }, string>({
      id: "outage-task",
      retry: { attempts: 2, backoff: { type: "fixed", delay: 1 } },
      run: async ({ kind }, { attempt, signal }) => {
        if (kind === "lease-loss" && attempt.number === 1) {
          markFirstStarted();
          await abortSignal(signal);
          markFirstAborted();
          return "stale-result";
        }
        return kind === "lease-loss" ? "reclaimed" : "queued-after-outage";
      }
    });
    const worker = new Durlo({ id: appId, adapter: workerAdapter }).worker({
      tasks: [task],
      workerId: "outage-worker",
      concurrency: 2,
      pollInterval: 20,
      leaseDuration: 600
    });
    const runningWorker = worker.start();

    try {
      const leaseLoss = await task.enqueue({ kind: "lease-loss" });
      await firstStarted;
      proxy.disconnect();
      const queued = await task.enqueue({ kind: "queued" });

      await firstAborted;
      await waitFor(() => Promise.resolve(!worker.getHealth().database.healthy));
      expect(await observer.getRun({ appId, runId: leaseLoss.run.id })).toMatchObject({
        status: "running",
        lockedBy: "outage-worker"
      });
      expect(await observer.getRun({ appId, runId: queued.run.id })).toMatchObject({
        status: "pending"
      });

      proxy.reconnect();
      await waitFor(async () => {
        const result = await observer.pool.query<{ completed: string }>(
          `select count(*)::text as completed from durlo_runs
           where id = any($1::text[]) and status = 'completed'`,
          [[leaseLoss.run.id, queued.run.id]]
        );
        return result.rows[0]?.completed === "2";
      });
      await waitFor(() => Promise.resolve(worker.getHealth().database.healthy));

      expect(await observer.getRun({ appId, runId: leaseLoss.run.id })).toMatchObject({
        status: "completed",
        output: "reclaimed",
        stalledCount: 1
      });
      expect(await observer.getRun({ appId, runId: queued.run.id })).toMatchObject({
        status: "completed",
        output: "queued-after-outage"
      });
      const attempts = await observer.pool.query<{ status: string }>(
        `select status from durlo_attempts
         where run_id = $1 and kind = 'run' order by started_at, id`,
        [leaseLoss.run.id]
      );
      expect(attempts.rows.map(({ status }) => status)).toEqual(["stalled", "succeeded"]);
    } finally {
      proxy.reconnect();
      worker.stop();
      await runningWorker;
      await workerAdapter.close();
      await proxy.close();
    }
  });
});

class PostgresProxy {
  private constructor(
    private readonly server: Server,
    readonly connectionString: string,
    private readonly state: { connected: boolean; sockets: Set<Socket> }
  ) {}

  static async start(connectionString: string): Promise<PostgresProxy> {
    const target = new URL(connectionString);
    const state = { connected: true, sockets: new Set<Socket>() };
    const server = createServer((client) => {
      if (!state.connected) {
        client.destroy();
        return;
      }
      const upstream = createConnection({
        host: target.hostname,
        port: Number(target.port || 5432)
      });
      state.sockets.add(client);
      state.sockets.add(upstream);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => state.sockets.delete(client));
      upstream.on("close", () => state.sockets.delete(upstream));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const proxyUrl = new URL(connectionString);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(address.port);
    return new PostgresProxy(server, proxyUrl.toString(), state);
  }

  disconnect(): void {
    this.state.connected = false;
    for (const socket of this.state.sockets) socket.destroy();
    this.state.sockets.clear();
  }

  reconnect(): void {
    this.state.connected = true;
  }

  async close(): Promise<void> {
    this.disconnect();
    if (!this.server.listening) return;
    this.server.close();
    await once(this.server, "close");
  }
}

function abortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}
