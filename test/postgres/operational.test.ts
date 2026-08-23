import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres operational guarantees", () => {
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

  it("holds no transaction open while user code is running", async () => {
    const applicationName = `durlo-transaction-check-${randomUUID()}`;
    const workerAdapter = postgresAdapter({
      connectionString: databaseUrl!,
      application_name: applicationName
    });
    let markStarted!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });

    try {
      const durlo = new Durlo({ id: "transaction-check", adapter: workerAdapter });
      const task = durlo.task({
        id: "long-user-code",
        run: async () => {
          markStarted();
          await blocked;
          return "done";
        }
      });
      const handle = await task.enqueue({});
      const execution = durlo.worker({ tasks: [task], workerId: "transaction-worker" }).runOnce();
      await started;

      const activity = await observer.pool.query<{
        idle_in_transaction: string;
        active_transactions: string;
      }>(
        `select
           count(*) filter (where state = 'idle in transaction')::text as idle_in_transaction,
           count(*) filter (where xact_start is not null)::text as active_transactions
         from pg_stat_activity where application_name = $1`,
        [applicationName]
      );
      expect(activity.rows[0]).toEqual({
        idle_in_transaction: "0",
        active_transactions: "0"
      });

      finish();
      await execution;
      expect(
        await workerAdapter.getRun({ appId: "transaction-check", runId: handle.run.id })
      ).toMatchObject({
        status: "completed",
        output: "done"
      });
    } finally {
      finish?.();
      await workerAdapter.close();
    }
  });

  it("supports more execution slots than pool connections without losing leases", async () => {
    const workerAdapter = postgresAdapter({ connectionString: databaseUrl!, max: 2 });
    const executionCount = 8;
    let startedCount = 0;
    let markAllStarted!: () => void;
    let finish!: () => void;
    let execution: Promise<number> | undefined;
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });

    try {
      const durlo = new Durlo({ id: "constrained-pool", adapter: workerAdapter });
      const task = durlo.task({
        id: "pool-sized-task",
        run: async () => {
          startedCount += 1;
          if (startedCount === executionCount) markAllStarted();
          await blocked;
          return "done";
        }
      });
      const handles = await task.batchEnqueue(
        Array.from({ length: executionCount }, (_, value) => ({ input: { value } }))
      );
      execution = durlo
        .worker({
          tasks: [task],
          concurrency: executionCount,
          leaseDuration: "3s",
          workerId: "constrained-pool-worker"
        })
        .runOnce();
      await allStarted;

      const before = await observer.pool.query<{ id: string; locked_until: Date }>(
        `select id, locked_until from durlo_runs
         where app_id = 'constrained-pool' and status = 'running'`
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const after = await observer.pool.query<{ id: string; locked_until: Date }>(
        `select id, locked_until from durlo_runs
         where app_id = 'constrained-pool' and status = 'running'`
      );
      const initialLeases = new Map(before.rows.map(({ id, locked_until }) => [id, locked_until]));

      expect(after.rows).toHaveLength(executionCount);
      expect(
        after.rows.every(
          ({ id, locked_until }) => locked_until > (initialLeases.get(id) ?? locked_until)
        )
      ).toBe(true);

      finish();
      await expect(execution).resolves.toBe(executionCount);
      expect(workerAdapter.pool.totalCount).toBeLessThanOrEqual(2);
      expect(workerAdapter.pool.waitingCount).toBe(0);
      const completed = await observer.pool.query<{ count: string }>(
        `select count(*)::text as count from durlo_runs
         where id = any($1::text[]) and status = 'completed'`,
        [handles.map(({ run }) => run.id)]
      );
      expect(completed.rows[0]?.count).toBe(String(executionCount));
    } finally {
      finish?.();
      await execution?.catch(() => undefined);
      await workerAdapter.close();
    }
  });
});
