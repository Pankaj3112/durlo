import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("Standard Schema persistence", () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = postgresAdapter({ connectionString: databaseUrl! });
    await adapter.migrate();
    await adapter.pool.query(`
      create table if not exists durlo_schema_probe (
        id text primary key,
        value text not null
      )
    `);
  });

  beforeEach(async () => {
    await adapter.pool.query("truncate durlo_runs cascade");
    await adapter.pool.query("truncate durlo_schema_probe");
  });

  afterAll(async () => {
    await adapter.pool.query("drop table if exists durlo_schema_probe");
    await adapter.close();
  });

  it("persists synchronous transformed JSONB input and executes it without revalidation", async () => {
    const validate = vi.fn((input: { raw: string }) => ({
      value: {
        normalized: input.raw.trim(),
        characters: [...input.raw.trim()]
      }
    }));
    const observed: Array<{ normalized: string; characters: string[] }> = [];
    const durlo = new Durlo({ id: "schema-roundtrip", adapter });
    const task = durlo.task({
      id: "sync-transform",
      schema: {
        "~standard": { version: 1, vendor: "test", validate }
      },
      run: async (input: { normalized: string; characters: string[] }) => {
        observed.push(input);
        return input.normalized;
      }
    });

    const handle = await task.enqueue({ raw: "  durable  " });
    const persisted = await adapter.getRun({ appId: durlo.id, runId: handle.id });
    expect(persisted?.input).toEqual({
      normalized: "durable",
      characters: ["d", "u", "r", "a", "b", "l", "e"]
    });
    expect(validate).toHaveBeenCalledOnce();

    await expect(
      durlo.worker({ tasks: [task], workerId: "schema-task-worker" }).runOnce()
    ).resolves.toBe(1);
    expect(validate).toHaveBeenCalledOnce();
    expect(observed).toEqual([
      {
        normalized: "durable",
        characters: ["d", "u", "r", "a", "b", "l", "e"]
      }
    ]);
    await expect(adapter.getRun({ appId: durlo.id, runId: handle.id })).resolves.toMatchObject({
      status: "completed",
      output: "durable"
    });
  });

  it("awaits an asynchronous workflow transform once and exposes it through context.input", async () => {
    const validate = vi.fn(async (input: { raw: string }) => ({
      value: { normalized: input.raw.trim().toUpperCase() }
    }));
    const observed: string[] = [];
    const durlo = new Durlo({ id: "schema-roundtrip", adapter });
    const workflow = durlo.workflow({
      id: "async-transform",
      schema: {
        "~standard": { version: 1, vendor: "test", validate }
      },
      run: async ({ input }) => {
        observed.push(input.normalized);
        return input.normalized;
      }
    });

    const handle = await workflow.start({ raw: "  workflow  " });
    expect(validate).toHaveBeenCalledOnce();
    expect(await adapter.getRun({ appId: durlo.id, runId: handle.id })).toMatchObject({
      input: { normalized: "WORKFLOW" }
    });

    await expect(
      durlo.worker({ workflows: [workflow], workerId: "schema-workflow-worker" }).runOnce()
    ).resolves.toBe(1);
    expect(validate).toHaveBeenCalledOnce();
    expect(observed).toEqual(["WORKFLOW"]);
  });

  it("validates every batch item before PostgreSQL persistence", async () => {
    const validate = vi.fn(async (input: { value: number }) =>
      input.value === 2
        ? { issues: [{ message: "value 2 is not allowed" }] }
        : { value: { doubled: input.value * 2 } }
    );
    const durlo = new Durlo({ id: "schema-atomicity", adapter });
    const task = durlo.task({
      id: "atomic-batch-transform",
      schema: {
        "~standard": { version: 1, vendor: "test", validate }
      },
      run: async (input: { doubled: number }) => input.doubled
    });

    await expect(task.batchEnqueue([{ value: 1 }, { value: 2 }])).rejects.toThrow(
      "value 2 is not allowed"
    );
    expect(validate).toHaveBeenCalledTimes(2);
    await expect(
      adapter.pool.query<{ count: string }>(
        "select count(*)::text as count from durlo_runs where app_id = $1",
        [durlo.id]
      )
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("rolls back application writes when a transaction schema rejects input", async () => {
    const durlo = new Durlo({ id: "schema-transaction-atomicity", adapter });
    const task = durlo.task({
      id: "transaction-transform",
      schema: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => ({ issues: [{ message: "transaction input rejected" }] })
        }
      },
      run: async () => undefined
    });

    await expect(
      durlo.transaction(async (transaction) => {
        await transaction.client.query(
          "insert into durlo_schema_probe (id, value) values ('rolled-back', 'application')"
        );
        await transaction.enqueue(task, {});
      })
    ).rejects.toThrow("transaction input rejected");

    await expect(
      adapter.pool.query<{ count: string }>(
        "select count(*)::text as count from durlo_schema_probe where id = 'rolled-back'"
      )
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(
      adapter.pool.query<{ count: string }>(
        "select count(*)::text as count from durlo_runs where app_id = $1",
        [durlo.id]
      )
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });
});
