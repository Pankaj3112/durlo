import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo, LostLeaseError, RunStateError } from "@durlo/core";
import type { CreateRunInput } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

function createRunInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    id: randomUUID(),
    appId: "matrix-tests",
    kind: "task",
    resourceId: "atomic-batch",
    input: {},
    options: {
      retry: { attempts: 3, backoff: { type: "fixed", delay: 0, jitter: 0 } }
    },
    idempotencyKey: null,
    priority: 0,
    scheduledAt: new Date(),
    maxAttempts: 3,
    ...overrides
  };
}

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres state matrix", () => {
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

  it("filters claims by app, resource, due time, limit, and priority", async () => {
    const durlo = new Durlo({ id: "matrix-tests", adapter });
    const registered = durlo.task({ id: "registered", run: async () => undefined });
    const unregistered = durlo.task({ id: "unregistered", run: async () => undefined });
    const low = await registered.enqueue({ name: "low" }, { priority: -10 });
    const high = await registered.enqueue({ name: "high" }, { priority: 50 });
    const future = await registered.enqueue({ name: "future" }, { runAt: "2030-01-01" });
    await unregistered.enqueue({ name: "wrong-resource" }, { priority: 100 });
    const otherApp = new Durlo({ id: "other-app", adapter }).task({
      id: "registered",
      run: async () => undefined
    });
    await otherApp.enqueue({ name: "wrong-app" }, { priority: 100 });

    const resources = [{ kind: "task" as const, resourceId: registered.id }];
    expect(
      await adapter.claimRuns({
        appId: "matrix-tests",
        workerId: "worker",
        limit: 0,
        leaseDuration: 10_000,
        resources
      })
    ).toEqual([]);
    expect(
      await adapter.claimRuns({
        appId: "matrix-tests",
        workerId: "worker",
        limit: 10,
        leaseDuration: 10_000,
        resources: []
      })
    ).toEqual([]);

    const first = await adapter.claimRuns({
      appId: "matrix-tests",
      workerId: "worker",
      limit: 1,
      leaseDuration: 10_000,
      resources
    });
    expect(first.map(({ id }) => id)).toEqual([high.id]);

    const second = await adapter.claimRuns({
      appId: "matrix-tests",
      workerId: "worker",
      limit: 10,
      leaseDuration: 10_000,
      resources
    });
    expect(second.map(({ id }) => id)).toEqual([low.id]);
    expect(second.some(({ id }) => id === future.id)).toBe(false);
  });

  it("rolls back every row when a database error occurs inside a batch", async () => {
    const valid = createRunInput();
    const invalid = createRunInput({ maxAttempts: 0 });

    await expect(adapter.createRuns([valid, invalid])).rejects.toThrow();
    expect(await adapter.getRun(valid.id)).toBeNull();
    expect(await adapter.getRun(invalid.id)).toBeNull();
    await expect(adapter.createRuns([])).resolves.toEqual([]);
  });

  it("commits caller-owned transaction writes without taking ownership of the transaction", async () => {
    const durlo = new Durlo({ id: "matrix-tests", adapter });
    const task = durlo.task({ id: "committed-transaction", run: async () => undefined });
    const client = await adapter.pool.connect();
    let runId = "";
    try {
      await client.query("begin");
      runId = (await durlo.tx(client).enqueue(task, { committed: true })).id;
      expect(await adapter.getRun(runId)).toBeNull();
      await client.query("commit");
    } finally {
      client.release();
    }

    expect(await adapter.getRun(runId)).toMatchObject({
      status: "pending",
      input: { committed: true }
    });
  });

  it("rejects retry and cancellation from forbidden or missing states", async () => {
    const durlo = new Durlo({ id: "matrix-tests", adapter });
    const pendingTask = durlo.task({ id: "pending-controls", run: async () => undefined });
    const pending = await pendingTask.enqueue({});

    await expect(adapter.retryRun(pending.id)).rejects.toBeInstanceOf(RunStateError);
    await expect(adapter.retryRun("missing-run")).rejects.toBeInstanceOf(RunStateError);
    await expect(adapter.cancelRun("missing-run")).rejects.toBeInstanceOf(RunStateError);

    await adapter.cancelRun(pending.id);
    await expect(adapter.retryRun(pending.id)).rejects.toBeInstanceOf(RunStateError);
    await expect(adapter.cancelRun(pending.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects step and timer namespace collisions across workflow re-entry", async () => {
    const durlo = new Durlo({ id: "matrix-tests", adapter });
    const stepThenTimer = durlo.workflow({
      id: "step-then-timer",
      retry: { attempts: 2, backoff: { type: "fixed", delay: 0 } },
      run: async ({ attempt, step }) => {
        if (attempt.number === 1) {
          await step.run("shared-id", () => "checkpoint");
          throw new Error("force re-entry");
        }
        await step.sleep("shared-id", 0);
      }
    });
    const first = await stepThenTimer.start({});
    const firstWorker = durlo.worker({ workflows: [stepThenTimer], workerId: "step-first" });
    await firstWorker.runOnce();
    await firstWorker.runOnce();
    expect(await adapter.getRun(first.id)).toMatchObject({
      status: "failed",
      error: { name: "ValidationError", message: expect.stringContaining("used by step.run") }
    });
    expect(await adapter.getTimer(first.id, "shared-id")).toBeNull();

    const timerThenStep = durlo.workflow({
      id: "timer-then-step",
      retry: { attempts: 1 },
      run: async ({ attempt, step }) => {
        if (attempt.number === 1) await step.sleep("shared-id", 0);
        else await step.run("shared-id", () => "must not execute");
      }
    });
    const second = await timerThenStep.start({});
    const secondWorker = durlo.worker({ workflows: [timerThenStep], workerId: "timer-first" });
    await secondWorker.runOnce();
    await secondWorker.runOnce();
    expect(await adapter.getRun(second.id)).toMatchObject({
      status: "failed",
      error: { name: "ValidationError", message: expect.stringContaining("used by a sleep") }
    });
  });

  it("rejects invalid sleep dates before creating timers", async () => {
    const durlo = new Durlo({ id: "matrix-tests", adapter });
    const workflow = durlo.workflow({
      id: "invalid-sleep-date",
      retry: { attempts: 1 },
      run: async ({ step }) => step.sleepUntil("invalid", "not-a-date")
    });
    const handle = await workflow.start({});
    await durlo.worker({ workflows: [workflow] }).runOnce();

    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "failed",
      error: { name: "ValidationError", message: "sleepUntil date must be valid" }
    });
    expect(await adapter.getTimer(handle.id, "invalid")).toBeNull();
  });

  it("does not persist a step result after cancellation invalidates ownership", async () => {
    const durlo = new Durlo({ id: "matrix-tests", adapter });
    let markStarted!: () => void;
    let finishStep!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finishStep = resolve;
    });
    const workflow = durlo.workflow({
      id: "cancel-running-step",
      run: async ({ step }) =>
        step.run("blocked", async () => {
          markStarted();
          await blocked;
          return "stale-result";
        })
    });
    const handle = await workflow.start({});
    const execution = durlo
      .worker({ workflows: [workflow], workerId: "step-owner", leaseDuration: "30s" })
      .runOnce();
    await started;
    await adapter.cancelRun(handle.id);
    finishStep();
    await execution;

    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "cancelled", output: null });
    expect(await adapter.getStep(handle.id, "blocked")).toMatchObject({
      status: "running",
      result: null
    });
    await expect(
      adapter.completeStep({
        runId: handle.id,
        workerId: "step-owner",
        leaseToken: "stale-token",
        stepId: "blocked",
        result: "stale-result"
      })
    ).rejects.toBeInstanceOf(LostLeaseError);
  });
});
