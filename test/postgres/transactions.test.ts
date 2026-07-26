import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("owned raw pg transactions", () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = postgresAdapter({ connectionString: databaseUrl! });
    await adapter.migrate();
    await adapter.pool.query(`
      create table if not exists durlo_transaction_probe (
        id text primary key,
        value text not null
      )
    `);
  });

  beforeEach(async () => {
    await adapter.pool.query("truncate durlo_runs cascade");
    await adapter.pool.query("truncate durlo_transaction_probe");
  });

  afterAll(async () => {
    await adapter.pool.query("drop table if exists durlo_transaction_probe");
    await adapter.close();
  });

  it("commits application SQL with a task, workflow, and ordered task batch", async () => {
    const durlo = new Durlo({ id: "transaction-tests", adapter });
    const task = durlo.task({ id: "transaction-task", run: async () => undefined });
    const workflow = durlo.workflow({ id: "transaction-workflow", run: async () => undefined });

    const result = await durlo.transaction(async (transaction) => {
      await transaction.client.query(
        "insert into durlo_transaction_probe (id, value) values ($1, $2)",
        ["committed", "application"]
      );
      const taskHandle = await transaction.enqueue(task, { source: "single" });
      const workflowHandle = await transaction.start(workflow, { source: "workflow" });
      const batchHandles = await transaction.batchEnqueue(task, [
        { source: "batch-1" },
        { source: "batch-2" }
      ]);
      return { taskHandle, workflowHandle, batchHandles };
    });

    expect(result.batchHandles.map(({ resourceId }) => resourceId)).toEqual([
      "transaction-task",
      "transaction-task"
    ]);
    const probe = await adapter.pool.query<{ value: string }>(
      "select value from durlo_transaction_probe where id = 'committed'"
    );
    expect(probe.rows).toEqual([{ value: "application" }]);
    const runs = await adapter.pool.query<{ id: string; kind: string; input_json: unknown }>(
      "select id, kind, input_json from durlo_runs order by created_at, id"
    );
    expect(new Set(runs.rows.map(({ id }) => id))).toEqual(
      new Set([
        result.taskHandle.id,
        result.workflowHandle.id,
        ...result.batchHandles.map(({ id }) => id)
      ])
    );
    expect(
      runs.rows.filter(({ kind }) => kind === "task").map(({ input_json }) => input_json)
    ).toEqual(
      expect.arrayContaining([{ source: "single" }, { source: "batch-1" }, { source: "batch-2" }])
    );
  });

  it("rolls back application and Durlo rows when the callback throws", async () => {
    const durlo = new Durlo({ id: "transaction-tests", adapter });
    const task = durlo.task({ id: "rollback-task", run: async () => undefined });

    await expect(
      durlo.transaction(async (transaction) => {
        await transaction.client.query(
          "insert into durlo_transaction_probe (id, value) values ('throw', 'application')"
        );
        await transaction.enqueue(task, { value: true });
        throw new Error("callback failed");
      })
    ).rejects.toThrow("callback failed");

    await expectPersistedCounts(adapter, 0, 0);
  });

  it.each([
    {
      name: "validation",
      run: async (
        durlo: Durlo,
        transaction: Parameters<Parameters<Durlo["transaction"]>[0]>[0]
      ) => {
        const task = durlo.task({
          id: "validation-failure",
          schema: {
            "~standard": {
              version: 1 as const,
              vendor: "test",
              validate: () => ({ issues: [{ message: "invalid input" }] })
            }
          },
          run: async () => undefined
        });
        await transaction.enqueue(task, { invalid: true });
      }
    },
    {
      name: "serialization",
      run: async (
        durlo: Durlo,
        transaction: Parameters<Parameters<Durlo["transaction"]>[0]>[0]
      ) => {
        const task = durlo.task({ id: "serialization-failure", run: async () => undefined });
        await transaction.enqueue(task, { unsupported: 1n });
      }
    },
    {
      name: "batch",
      run: async (
        durlo: Durlo,
        transaction: Parameters<Parameters<Durlo["transaction"]>[0]>[0]
      ) => {
        const task = durlo.task({ id: "batch-failure", run: async () => undefined });
        await transaction.batchEnqueue(task, [
          { input: { value: 1 }, options: { idempotencyKey: "duplicate" } },
          { input: { value: 2 }, options: { idempotencyKey: "duplicate" } }
        ]);
      }
    }
  ])("rolls back a prior application write after $name failure", async ({ name, run }) => {
    const durlo = new Durlo({ id: `transaction-${name}`, adapter });

    await expect(
      durlo.transaction(async (transaction) => {
        await transaction.client.query(
          "insert into durlo_transaction_probe (id, value) values ($1, 'application')",
          [name]
        );
        await run(durlo, transaction);
      })
    ).rejects.toThrow();

    await expectPersistedCounts(adapter, 0, 0);
  });

  it("rolls back prior writes after a PostgreSQL failure", async () => {
    const durlo = new Durlo({ id: "transaction-postgres", adapter });
    const task = durlo.task({ id: "postgres-failure", run: async () => undefined });

    await expect(
      durlo.transaction(async (transaction) => {
        await transaction.client.query(
          "insert into durlo_transaction_probe (id, value) values ('postgres', 'application')"
        );
        await transaction.enqueue(task, { persistedBeforeFailure: true });
        await transaction.client.query("select * from table_that_does_not_exist");
      })
    ).rejects.toThrow();

    await expectPersistedCounts(adapter, 0, 0);
  });

  it("keeps an idempotency conflict inside the transaction without partial persistence", async () => {
    const durlo = new Durlo({ id: "transaction-idempotency", adapter });
    const task = durlo.task({ id: "idempotent-task", run: async () => undefined });
    const existing = await task.enqueue({ version: "original" }, { idempotencyKey: "same" });

    await expect(
      durlo.transaction(async (transaction) => {
        await transaction.client.query(
          "insert into durlo_transaction_probe (id, value) values ('conflict', 'application')"
        );
        const duplicate = await transaction.enqueue(
          task,
          { version: "duplicate" },
          { idempotencyKey: "same" }
        );
        expect(duplicate.id).toBe(existing.id);
        throw new Error("rollback after conflict");
      })
    ).rejects.toThrow("rollback after conflict");

    await expectPersistedCounts(adapter, 0, 1);
    expect(
      await adapter.getRun({ appId: "transaction-idempotency", runId: existing.id })
    ).toMatchObject({
      input: { version: "original" }
    });
  });

  it("leaves a borrowed pool open and queryable when the adapter closes", async () => {
    const pool = postgresAdapter({ connectionString: databaseUrl! }).pool;
    const end = vi.spyOn(pool, "end");
    const borrowed = postgresAdapter(pool);

    await borrowed.close();
    await borrowed.close();

    expect(end).not.toHaveBeenCalled();
    await expect(pool.query("select 1")).resolves.toMatchObject({ rowCount: 1 });
    end.mockRestore();
    await pool.end();
  });
});

describe("transaction lifecycle faults", () => {
  it("closes an owned pool at most once", async () => {
    const adapter = postgresAdapter({ connectionString: "postgres://unused" });
    const end = vi.spyOn(adapter.pool, "end").mockResolvedValue();

    await adapter.close();
    await adapter.close();

    expect(end).toHaveBeenCalledTimes(1);
  });

  it("uses one client and releases it once after commit", async () => {
    const { adapter, query, release } = adapterWithFakeClient();

    await expect(
      adapter.transaction(async (_transactionAdapter, client) => {
        await client.query("application statement");
        return "committed";
      })
    ).resolves.toBe("committed");

    expect(query.mock.calls.map(([text]) => text)).toEqual([
      "begin",
      "application statement",
      "commit"
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves the callback error when rollback also fails and still releases once", async () => {
    const primary = new Error("primary callback failure");
    const rollback = new Error("rollback failure");
    const { adapter, query, release } = adapterWithFakeClient({ rollback });

    await expect(
      adapter.transaction(async () => {
        throw primary;
      })
    ).rejects.toBe(primary);

    expect(query.mock.calls.map(([text]) => text)).toEqual(["begin", "rollback"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed commit, attempts rollback, and releases once", async () => {
    const commit = new Error("commit failure");
    const { adapter, query, release } = adapterWithFakeClient({ commit });

    await expect(adapter.transaction(async () => "not returned")).rejects.toBe(commit);

    expect(query.mock.calls.map(([text]) => text)).toEqual(["begin", "commit", "rollback"]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function adapterWithFakeClient(failures: { commit?: Error; rollback?: Error } = {}) {
  const adapter = postgresAdapter({ connectionString: "postgres://unused" });
  const query = vi.fn(async (text: string) => {
    if (text === "commit" && failures.commit) throw failures.commit;
    if (text === "rollback" && failures.rollback) throw failures.rollback;
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = {
    query,
    release
  } as unknown as Awaited<ReturnType<PostgresAdapter["pool"]["connect"]>>;
  vi.spyOn(adapter.pool, "connect").mockResolvedValue(client);
  return { adapter, query, release };
}

async function expectPersistedCounts(
  adapter: PostgresAdapter,
  expectedProbeCount: number,
  expectedRunCount: number
) {
  const [probes, runs] = await Promise.all([
    adapter.pool.query<{ count: string }>(
      "select count(*)::text as count from durlo_transaction_probe"
    ),
    adapter.pool.query<{ count: string }>("select count(*)::text as count from durlo_runs")
  ]);
  expect(Number(probes.rows[0]?.count)).toBe(expectedProbeCount);
  expect(Number(runs.rows[0]?.count)).toBe(expectedRunCount);
}
