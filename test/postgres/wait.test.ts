import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo, RunCancelledError, RunFailedError, RunNotFoundError } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("PostgreSQL run result waiting", () => {
  let adapter: PostgresAdapter;
  let durlo: Durlo;

  beforeAll(async () => {
    adapter = postgresAdapter({ connectionString: databaseUrl! });
    await adapter.migrate();
    durlo = new Durlo({ id: "wait-integration", adapter });
  });

  beforeEach(async () => {
    await adapter.pool.query("truncate durlo_runs cascade");
  });

  afterAll(async () => {
    await adapter.close();
  });

  it("durably distinguishes object, null, and undefined task outputs", async () => {
    const valueTask = durlo.task({ id: "wait-value", run: async () => ({ ready: true }) });
    const nullTask = durlo.task({ id: "wait-null", run: async (): Promise<null> => null });
    const voidTask = durlo.task({ id: "wait-void", run: async () => undefined });
    const value = await valueTask.enqueue({});
    const nullValue = await nullTask.enqueue({});
    const voidValue = await voidTask.enqueue({});

    await durlo.worker({ tasks: [valueTask, nullTask, voidTask], concurrency: 3 }).runOnce();

    await expect(durlo.runs.wait(value.run, { timeout: "1s" })).resolves.toEqual({ ready: true });
    await expect(durlo.runs.wait(nullValue.run, { timeout: "1s" })).resolves.toBeNull();
    await expect(durlo.runs.wait(voidValue.run, { timeout: "1s" })).resolves.toBeUndefined();
    const kinds = await adapter.pool.query<{ id: string; output_kind: string }>(
      "select id, output_kind from durlo_runs order by id"
    );
    expect(new Map(kinds.rows.map((row) => [row.id, row.output_kind]))).toEqual(
      new Map([
        [value.run.id, "value"],
        [nullValue.run.id, "value"],
        [voidValue.run.id, "undefined"]
      ])
    );
  });

  it("polls from pending to completed without retaining a checked-out connection", async () => {
    const task = durlo.task({ id: "wait-pending", run: async () => "complete" });
    const creation = await task.enqueue({});
    const waiting = durlo.runs.wait(creation.run, { timeout: "2s" });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(adapter.pool.waitingCount).toBe(0);
    expect(adapter.pool.totalCount - adapter.pool.idleCount).toBe(0);

    await durlo.worker({ tasks: [task] }).runOnce();
    await expect(waiting).resolves.toBe("complete");
  });

  it("returns typed failed, dead-lettered, cancelled, and missing outcomes", async () => {
    const task = durlo.task({
      id: "wait-failed-task",
      retry: { attempts: 1 },
      run: async () => {
        throw new Error("task failed", { cause: { code: "TASK" } });
      }
    });
    const workflow = durlo.workflow({
      id: "wait-failed-workflow",
      retry: { attempts: 1 },
      run: async () => {
        throw new Error("workflow failed");
      }
    });
    const cancelledTask = durlo.task({ id: "wait-cancelled", run: async () => undefined });
    const failedTask = await task.enqueue({});
    const failedWorkflow = await workflow.start({});
    const cancelled = await cancelledTask.enqueue({});
    await durlo.runs.cancel(cancelled.run);
    await durlo.worker({ tasks: [task], workflows: [workflow], concurrency: 2 }).runOnce();

    await expect(durlo.runs.wait(failedTask.run, { timeout: "1s" })).rejects.toMatchObject({
      name: RunFailedError.name,
      runId: failedTask.run.id,
      status: "dead_letter",
      error: { name: "Error", message: "task failed", cause: { code: "TASK" } }
    });
    await expect(durlo.runs.wait(failedWorkflow.run, { timeout: "1s" })).rejects.toMatchObject({
      name: RunFailedError.name,
      status: "failed"
    });
    await expect(durlo.runs.wait(cancelled.run, { timeout: "1s" })).rejects.toBeInstanceOf(
      RunCancelledError
    );
    await adapter.pool.query("delete from durlo_runs where id = $1", [cancelled.run.id]);
    await expect(durlo.runs.wait(cancelled.run, { timeout: "1s" })).rejects.toBeInstanceOf(
      RunNotFoundError
    );
  });

  it("keeps the decoded legacy output when output-kind metadata is absent", async () => {
    const task = durlo.task({ id: "wait-legacy", run: async () => undefined });
    const creation = await task.enqueue({});
    await durlo.worker({ tasks: [task] }).runOnce();
    await adapter.pool.query("update durlo_runs set output_kind = null where id = $1", [
      creation.run.id
    ]);

    await expect(durlo.runs.wait(creation.run, { timeout: "1s" })).resolves.toBeNull();
  });
});
