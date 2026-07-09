import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres integration", () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = postgresAdapter({ connectionString: databaseUrl! });
    await adapter.migrate();
    await adapter.migrate();
  });

  beforeEach(async () => {
    await adapter.pool.query("truncate durlo_runs cascade");
  });

  afterAll(async () => {
    await adapter.close();
  });

  it("creates and reads durable run rows", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "email", run: async (input: { email: string }) => input.email });

    const handle = await task.enqueue(
      { email: "test@example.com" },
      { attempts: 5, priority: 20, runAt: "2030-01-01T00:00:00.000Z" },
    );
    const record = await adapter.getRun(handle.id);

    expect(record).toMatchObject({
      id: handle.id,
      appId: "integration",
      kind: "task",
      resourceId: "email",
      status: "pending",
      input: { email: "test@example.com" },
      maxAttempts: 5,
      priority: 20,
      attemptCount: 0,
    });
    expect(record?.scheduledAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("deduplicates run creation for the full row lifetime", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "email", run: async () => undefined });

    const first = await task.enqueue({ value: 1 }, { idempotencyKey: "business-key" });
    const duplicate = await task.enqueue({ value: 2 }, { idempotencyKey: "business-key" });

    expect(duplicate.id).toBe(first.id);
    expect((await adapter.getRun(first.id))?.input).toEqual({ value: 1 });
  });

  it("creates batches atomically and preserves input order", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "batch", run: async (input: number) => input });

    const handles = await task.batchEnqueue([1, 2, 3]);
    const rows = await adapter.pool.query<{ input_json: number }>(
      "select input_json from durlo_runs where resource_id = 'batch' order by created_at, id",
    );

    expect(handles).toHaveLength(3);
    expect(rows.rows.map(({ input_json }) => input_json).sort()).toEqual([1, 2, 3]);
  });

  it("writes through a caller-owned raw pg transaction", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "transactional", run: async () => undefined });
    const client = await adapter.pool.connect();
    let runId = "";
    try {
      await client.query("begin");
      runId = (await durlo.tx(client).enqueue(task, { value: true })).id;
      await client.query("rollback");
    } finally {
      client.release();
    }

    expect(await adapter.getRun(runId)).toBeNull();
  });

  it("rejects invalid raw transaction clients", () => {
    expect(() => adapter.withTransaction({})).toThrow("raw pg client");
  });
});
