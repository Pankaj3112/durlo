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
      expect(await workerAdapter.getRun(handle.id)).toMatchObject({
        status: "completed",
        output: "done"
      });
    } finally {
      finish?.();
      await workerAdapter.close();
    }
  });
});
