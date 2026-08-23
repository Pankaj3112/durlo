import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo, RunStateError } from "@durlo/core";
import { postgresAdapter } from "../helpers/postgres-internal.js";
import type { PostgresAdapter } from "../helpers/postgres-internal.js";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres races", () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = postgresAdapter({ connectionString: databaseUrl! });
    await adapter.migrate();
  });

  beforeEach(async () => {
    await adapter.pool.query("truncate durlo_runs cascade");
  });

  afterAll(async () => {
    await adapter.close();
  });

  it("serializes cancellation racing with completion without a stale write", async () => {
    const durlo = new Durlo({ id: "race-tests", adapter });
    const task = durlo.task({ id: "cancel-complete", run: async () => undefined });
    const handle = await task.enqueue({});
    const [claim] = await adapter.claimRuns({
      appId: "race-tests",
      workerId: "worker",
      limit: 1,
      leaseDuration: 10_000,
      resources: [{ kind: "task", resourceId: task.id }]
    });

    const [cancel, complete] = await Promise.allSettled([
      adapter.cancelRun({ appId: "race-tests", runId: handle.run.id }),
      adapter.completeRun({
        runId: handle.run.id,
        workerId: "worker",
        leaseToken: claim!.leaseToken,
        output: "completed",
        outputKind: "value"
      })
    ]);

    expect([cancel.status, complete.status].sort()).toEqual(["fulfilled", "rejected"]);
    const run = await adapter.getRun({ appId: "race-tests", runId: handle.run.id });
    expect(["cancelled", "completed"]).toContain(run?.status);
    expect(run).toMatchObject({ lockedBy: null, leaseToken: null, lockedUntil: null });
    if (run?.status === "cancelled") {
      expect(cancel.status).toBe("fulfilled");
      expect(complete.status).toBe("rejected");
      if (complete.status === "rejected")
        expect(complete.reason).toMatchObject({ message: expect.stringContaining("lease lost") });
    } else {
      expect(complete.status).toBe("fulfilled");
      expect(cancel.status).toBe("rejected");
      if (cancel.status === "rejected") expect(cancel.reason).toBeInstanceOf(RunStateError);
    }

    const attempts = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 and kind = 'run'",
      [handle.run.id]
    );
    expect(attempts.rows).toHaveLength(1);
    expect(["cancelled", "succeeded"]).toContain(attempts.rows[0]?.status);
  });

  it("serializes cancellation racing with final failure", async () => {
    const durlo = new Durlo({ id: "race-tests", adapter });
    const task = durlo.task({ id: "cancel-fail", run: async () => undefined });
    const handle = await task.enqueue({});
    const [claim] = await adapter.claimRuns({
      appId: "race-tests",
      workerId: "worker",
      limit: 1,
      leaseDuration: 10_000,
      resources: [{ kind: "task", resourceId: task.id }]
    });

    const [cancel, fail] = await Promise.allSettled([
      adapter.cancelRun({ appId: "race-tests", runId: handle.run.id }),
      adapter.failRun({
        runId: handle.run.id,
        workerId: "worker",
        leaseToken: claim!.leaseToken,
        error: { name: "Error", message: "failed" },
        outcome: { status: "dead_letter" }
      })
    ]);

    expect([cancel.status, fail.status].sort()).toEqual(["fulfilled", "rejected"]);
    const run = await adapter.getRun({ appId: "race-tests", runId: handle.run.id });
    expect(["cancelled", "dead_letter"]).toContain(run?.status);
    expect(run).toMatchObject({ lockedBy: null, leaseToken: null, lockedUntil: null });
    if (run?.status === "cancelled") {
      expect(cancel.status).toBe("fulfilled");
      expect(fail.status).toBe("rejected");
      if (fail.status === "rejected")
        expect(fail.reason).toMatchObject({ message: expect.stringContaining("lease lost") });
    } else {
      expect(fail.status).toBe("fulfilled");
      expect(cancel.status).toBe("rejected");
      if (cancel.status === "rejected") expect(cancel.reason).toBeInstanceOf(RunStateError);
    }
  });

  it("never resumes a workflow after cancellation races a due timer", async () => {
    const durlo = new Durlo({ id: "race-tests", adapter });
    const workflow = durlo.workflow({
      id: "cancel-timer",
      run: async ({ step }) => {
        await step.sleep("due", "1d");
        return "resumed";
      }
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow], workerId: "timer-worker" });
    await worker.runOnce();
    await adapter.pool.query(
      "update durlo_timers set fire_at = now() - interval '1 second' where run_id = $1",
      [handle.run.id]
    );

    const [cancel, fired] = await Promise.all([
      adapter.cancelRun({ appId: "race-tests", runId: handle.run.id }),
      adapter.fireDueTimers({ appId: "race-tests", limit: 1 })
    ]);

    expect(cancel.status).toBe("cancelled");
    expect([0, 1]).toContain(fired.length);
    expect(await adapter.getRun({ appId: "race-tests", runId: handle.run.id })).toMatchObject({
      status: "cancelled",
      output: null,
      lockedBy: null,
      leaseToken: null
    });
    const timer = await adapter.getTimer(handle.run.id, "due");
    expect(["cancelled", "fired"]).toContain(timer?.status);
    expect(timer?.status).toBe(fired.length === 1 ? "fired" : "cancelled");
    expect(await worker.runOnce()).toBe(0);
  });

  it("serializes retention cleanup racing with manual retry", async () => {
    const durlo = new Durlo({ id: "race-tests", adapter });
    const task = durlo.task({
      id: "cleanup-retry",
      retry: { attempts: 1 },
      run: async () => {
        throw new Error("expected failure");
      }
    });
    const handle = await task.enqueue({});
    await durlo.worker({ tasks: [task] }).runOnce();
    await adapter.pool.query(
      "update durlo_runs set updated_at = now() - interval '2 days' where id = $1",
      [handle.run.id]
    );

    const [cleanup, retry] = await Promise.allSettled([
      durlo.runs.cleanup({ olderThan: "1d", limit: 1 }),
      durlo.runs.retry(handle.run)
    ]);
    const run = await durlo.runs.get(handle.run);

    if (cleanup.status === "fulfilled" && cleanup.value.deletedRuns === 1) {
      expect(retry.status).toBe("rejected");
      expect(run).toBeNull();
    } else {
      expect(cleanup).toMatchObject({ status: "fulfilled", value: { deletedRuns: 0 } });
      expect(retry).toMatchObject({ status: "fulfilled", value: { status: "pending" } });
      expect(run).toMatchObject({ status: "pending" });
    }
  });
});
