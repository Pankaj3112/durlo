import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "../helpers/postgres-internal.js";
import type { StandardSchema } from "@durlo/core";
import type { PostgresAdapter } from "../helpers/postgres-internal.js";

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
    type ExternalInput = { raw: string };
    type HandlerInput = { normalized: string; characters: string[] };
    const validate = vi.fn((input: unknown) => {
      const raw = (input as ExternalInput).raw.trim();
      return { value: { normalized: raw, characters: [...raw] } };
    });
    const schema: StandardSchema<ExternalInput, HandlerInput> = {
      "~standard": { version: 1, vendor: "test", validate }
    };
    const observed: Array<{ normalized: string; characters: string[] }> = [];
    const durlo = new Durlo({ id: "schema-roundtrip", adapter });
    const task = durlo.task({
      id: "sync-transform",
      schema,
      run: async (input: HandlerInput) => {
        observed.push(input);
        return input.normalized;
      }
    });

    const handle = await task.enqueue({ raw: "  durable  " });
    const persisted = await adapter.getRun({ appId: durlo.id, runId: handle.run.id });
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
    await expect(adapter.getRun({ appId: durlo.id, runId: handle.run.id })).resolves.toMatchObject({
      status: "completed",
      output: "durable"
    });
  });

  it("awaits an asynchronous workflow transform once and exposes it through context.input", async () => {
    type ExternalInput = { raw: string };
    type HandlerInput = { normalized: string };
    const validate = vi.fn(async (input: unknown) => ({
      value: { normalized: (input as ExternalInput).raw.trim().toUpperCase() }
    }));
    const schema: StandardSchema<ExternalInput, HandlerInput> = {
      "~standard": { version: 1, vendor: "test", validate }
    };
    const observed: string[] = [];
    const durlo = new Durlo({ id: "schema-roundtrip", adapter });
    const workflow = durlo.workflow({
      id: "async-transform",
      schema,
      run: async ({ input }) => {
        observed.push(input.normalized);
        return input.normalized;
      }
    });

    const handle = await workflow.start({ raw: "  workflow  " });
    expect(validate).toHaveBeenCalledOnce();
    expect(await adapter.getRun({ appId: durlo.id, runId: handle.run.id })).toMatchObject({
      input: { normalized: "WORKFLOW" }
    });

    await expect(
      durlo.worker({ workflows: [workflow], workerId: "schema-workflow-worker" }).runOnce()
    ).resolves.toBe(1);
    expect(validate).toHaveBeenCalledOnce();
    expect(observed).toEqual(["WORKFLOW"]);
  });

  it("validates every batch item before PostgreSQL persistence", async () => {
    type ExternalInput = { value: number };
    type HandlerInput = { doubled: number };
    const validate = vi.fn(async (input: unknown) =>
      (input as ExternalInput).value === 2
        ? { issues: [{ message: "value 2 is not allowed" }] }
        : { value: { doubled: (input as ExternalInput).value * 2 } }
    );
    const schema: StandardSchema<ExternalInput, HandlerInput> = {
      "~standard": { version: 1, vendor: "test", validate }
    };
    const durlo = new Durlo({ id: "schema-atomicity", adapter });
    const task = durlo.task({
      id: "atomic-batch-transform",
      schema,
      run: async (input: HandlerInput) => input.doubled
    });

    await expect(
      task.batchEnqueue([{ input: { value: 1 } }, { input: { value: 2 } }])
    ).rejects.toThrow("value 2 is not allowed");
    expect(validate).toHaveBeenCalledTimes(2);
    await expect(
      adapter.pool.query<{ count: string }>(
        "select count(*)::text as count from durlo_runs where app_id = $1",
        [durlo.id]
      )
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("persists transformed input through transaction task, workflow, and batch creation", async () => {
    type ExternalInput = { raw: string };
    type HandlerInput = { normalized: string };
    const validate = vi.fn((input: unknown) => ({
      value: { normalized: (input as ExternalInput).raw.trim() }
    }));
    const schema: StandardSchema<ExternalInput, HandlerInput> = {
      "~standard": { version: 1, vendor: "test", validate }
    };
    const durlo = new Durlo({ id: "schema-transaction-success", adapter });
    const task = durlo.task({
      id: "transaction-task-transform",
      schema,
      run: async (input: HandlerInput) => input.normalized
    });
    const workflow = durlo.workflow({
      id: "transaction-workflow-transform",
      schema,
      run: async ({ input }) => input.normalized
    });

    const created = await durlo.transaction(async (transaction) => ({
      task: await transaction.enqueue(task, { raw: " task " }),
      workflow: await transaction.start(workflow, { raw: " workflow " }),
      batch: await transaction.batchEnqueue(task, [
        { input: { raw: " batch-1 " } },
        { input: { raw: " batch-2 " } }
      ])
    }));
    const records = await Promise.all([
      adapter.getRun({ appId: durlo.id, runId: created.task.run.id }),
      adapter.getRun({ appId: durlo.id, runId: created.workflow.run.id }),
      ...created.batch.map((handle) => adapter.getRun({ appId: durlo.id, runId: handle.run.id }))
    ]);

    expect(validate).toHaveBeenCalledTimes(4);
    expect(records.map((record) => record?.input)).toEqual([
      { normalized: "task" },
      { normalized: "workflow" },
      { normalized: "batch-1" },
      { normalized: "batch-2" }
    ]);
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
