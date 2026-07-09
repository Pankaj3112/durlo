import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo, LostLeaseError, RunStateError } from "@durlo/core";
import type { StepTools } from "@durlo/core";
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

  it("claims and completes tasks with append-only attempt history", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({
      id: "complete-task",
      run: async (input: { value: number }, context) => ({
        doubled: input.value * 2,
        attempt: context.attempt.number,
      }),
    });
    const handle = await task.enqueue({ value: 21 });

    const worker = durlo.worker({ tasks: [task], workerId: "worker-a", leaseDuration: "5s" });
    expect(await worker.runOnce()).toBe(1);

    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "completed",
      output: { doubled: 42, attempt: 1 },
      attemptCount: 1,
      lockedBy: null,
      leaseToken: null,
    });
    const attempts = await adapter.pool.query<{ status: string; worker_id: string }>(
      "select status, worker_id from durlo_attempts where run_id = $1",
      [handle.id],
    );
    expect(attempts.rows).toEqual([{ status: "succeeded", worker_id: "worker-a" }]);
  });

  it("retries thrown task errors and dead-letters after exhaustion", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let executions = 0;
    const task = durlo.task({
      id: "retry-task",
      retry: { attempts: 2, backoff: { type: "fixed", delay: 0 } },
      run: async () => {
        executions += 1;
        throw new Error(`failure ${executions}`);
      },
    });
    const handle = await task.enqueue({});
    const worker = durlo.worker({ tasks: [task], workerId: "worker-retry" });

    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "dead_letter",
      attemptCount: 2,
      error: { name: "Error", message: "failure 2" },
    });
  });

  it("reclaims expired leases, records stalls, and rejects stale completion", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "stalled-task", retry: { attempts: 2 }, run: async () => "done" });
    const handle = await task.enqueue({});
    const resources = [{ kind: "task" as const, resourceId: task.id }];

    const [first] = await adapter.claimRuns({
      appId: "integration",
      workerId: "worker-old",
      limit: 1,
      leaseDuration: 10_000,
      resources,
    });
    expect(first).toBeDefined();
    await adapter.pool.query("update durlo_runs set locked_until = now() - interval '1 second' where id = $1", [
      handle.id,
    ]);
    const [second] = await adapter.claimRuns({
      appId: "integration",
      workerId: "worker-new",
      limit: 1,
      leaseDuration: 10_000,
      resources,
    });

    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    await expect(
      adapter.completeRun({
        runId: handle.id,
        workerId: "worker-old",
        leaseToken: first!.leaseToken,
        output: "stale",
      }),
    ).rejects.toBeInstanceOf(LostLeaseError);
    await adapter.completeRun({
      runId: handle.id,
      workerId: "worker-new",
      leaseToken: second!.leaseToken,
      output: "current",
    });

    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "completed",
      output: "current",
      attemptCount: 2,
      stalledCount: 1,
    });
    const attempts = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 order by started_at",
      [handle.id],
    );
    expect(attempts.rows.map(({ status }) => status).sort()).toEqual(["stalled", "succeeded"]);
  });

  it("terminally fails an expired lease when its retry budget is exhausted", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "expired-task", retry: { attempts: 1 }, run: async () => undefined });
    const handle = await task.enqueue({});
    const claimInput = {
      appId: "integration",
      workerId: "worker",
      limit: 1,
      leaseDuration: 10_000,
      resources: [{ kind: "task" as const, resourceId: task.id }],
    };

    expect(await adapter.claimRuns(claimInput)).toHaveLength(1);
    await adapter.pool.query("update durlo_runs set locked_until = now() - interval '1 second' where id = $1", [
      handle.id,
    ]);
    expect(await adapter.claimRuns(claimInput)).toHaveLength(0);
    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "dead_letter",
      stalledCount: 1,
      error: { name: "StalledError" },
    });
  });

  it("executes workflows and persists reusable step results", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "step-workflow",
      run: async ({ input, step }: { input: { value: number }; step: StepTools }) => {
        const doubled = await step.run("double", () => input.value * 2);
        return step.run("result", () => ({ doubled }));
      },
    });
    const handle = await workflow.start({ value: 21 });
    const worker = durlo.worker({ workflows: [workflow], workerId: "workflow-worker" });

    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "completed", output: { doubled: 42 } });
    expect(await adapter.getStep(handle.id, "double")).toMatchObject({
      status: "completed",
      result: 42,
      attemptCount: 1,
    });
    expect(await adapter.getStep(handle.id, "result")).toMatchObject({
      status: "completed",
      result: { doubled: 42 },
    });
  });

  it("skips completed checkpoints when a failed workflow is re-entered", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let durableExecutions = 0;
    let flakyExecutions = 0;
    const workflow = durlo.workflow({
      id: "retry-workflow",
      retry: { attempts: 2, backoff: { type: "fixed", delay: 0 } },
      run: async ({ step }) => {
        const durable = await step.run("durable", () => {
          durableExecutions += 1;
          return { value: 10 };
        });
        return step.run("flaky", () => {
          flakyExecutions += 1;
          if (flakyExecutions === 1) throw new Error("try again");
          return durable.value + 1;
        });
      },
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow], workerId: "workflow-retry" });

    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(await worker.runOnce()).toBe(1);

    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "completed", output: 11, attemptCount: 2 });
    expect(durableExecutions).toBe(1);
    expect(flakyExecutions).toBe(2);
    expect(await adapter.getStep(handle.id, "durable")).toMatchObject({ attemptCount: 1, status: "completed" });
    expect(await adapter.getStep(handle.id, "flaky")).toMatchObject({ attemptCount: 2, status: "completed" });
  });

  it("fails workflows that reuse a step id in one execution", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "duplicate-step-workflow",
      retry: { attempts: 1 },
      run: async ({ step }) => {
        await step.run("same", () => 1);
        await step.run("same", () => 2);
      },
    });
    const handle = await workflow.start({});

    await durlo.worker({ workflows: [workflow] }).runOnce();

    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "failed",
      error: { name: "ValidationError", message: expect.stringContaining("more than once") },
    });
  });

  it("rejects nested step calls", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "nested-step-workflow",
      retry: { attempts: 1 },
      run: async ({ step }) => {
        await step.run("outer", async () => step.run("inner", () => "no"));
      },
    });
    const handle = await workflow.start({});

    await durlo.worker({ workflows: [workflow] }).runOnce();

    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "failed",
      error: { name: "ValidationError", message: "nested step calls are not allowed" },
    });
    expect(await adapter.getStep(handle.id, "inner")).toBeNull();
    expect(await adapter.getStep(handle.id, "outer")).toMatchObject({ status: "failed" });
  });

  it("sleeps and resumes workflows without consuming the failure retry budget", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let firstStepExecutions = 0;
    const workflow = durlo.workflow({
      id: "sleep-workflow",
      run: async ({ step }) => {
        await step.run("first", () => {
          firstStepExecutions += 1;
          return "checkpoint";
        });
        for (let index = 1; index <= 4; index += 1) {
          await step.sleep(`sleep-${index}`, 0);
        }
        return "awake";
      },
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow], workerId: "sleep-worker" });

    for (let index = 0; index < 4; index += 1) {
      expect(await worker.runOnce()).toBe(1);
      expect(await adapter.getRun(handle.id)).toMatchObject({ status: "sleeping" });
    }
    expect(await worker.runOnce()).toBe(1);

    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "completed",
      output: "awake",
      attemptCount: 5,
    });
    expect(firstStepExecutions).toBe(1);
    const timers = await adapter.pool.query<{ status: string }>(
      "select status from durlo_timers where run_id = $1 order by step_id",
      [handle.id],
    );
    expect(timers.rows).toEqual([{ status: "fired" }, { status: "fired" }, { status: "fired" }, { status: "fired" }]);
  });

  it("keeps sleepUntil durable until its timer becomes due", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "sleep-until-workflow",
      run: async ({ step }) => {
        await step.sleepUntil("future", "2030-01-01T00:00:00.000Z");
        return "resumed";
      },
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow] });

    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(0);
    expect(await adapter.getTimer(handle.id, "future")).toMatchObject({
      status: "pending",
      fireAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await adapter.pool.query("update durlo_timers set fire_at = now() - interval '1 second' where run_id = $1", [
      handle.id,
    ]);
    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "completed", output: "resumed" });
  });

  it("cancels sleeping timers atomically and never resumes the workflow", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "cancel-sleep-workflow",
      run: async ({ step }) => {
        await step.sleep("long-wait", "1d");
      },
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow] });

    await worker.runOnce();
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "sleeping" });
    expect(await durlo.runs.cancel(handle)).toMatchObject({ status: "cancelled" });
    expect(await durlo.runs.cancel(handle)).toMatchObject({ status: "cancelled" });
    expect(await adapter.getTimer(handle.id, "long-wait")).toMatchObject({ status: "cancelled" });
    expect(await worker.runOnce()).toBe(0);
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "cancelled" });
  });

  it("cancels running work by invalidating its lease token", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "cancel-running", run: async () => "late" });
    const handle = await task.enqueue({});
    const [claim] = await adapter.claimRuns({
      appId: "integration",
      workerId: "cancellable-worker",
      limit: 1,
      leaseDuration: 10_000,
      resources: [{ kind: "task", resourceId: task.id }],
    });

    await durlo.runs.cancel(handle);
    await expect(
      adapter.completeRun({
        runId: handle.id,
        workerId: "cancellable-worker",
        leaseToken: claim!.leaseToken,
        output: "late",
      }),
    ).rejects.toBeInstanceOf(LostLeaseError);
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "cancelled" });
    const attempt = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 and kind = 'run'",
      [handle.id],
    );
    expect(attempt.rows).toEqual([{ status: "cancelled" }]);
  });

  it("manually retries only failed workflows and dead-letter tasks while preserving history", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let executions = 0;
    const task = durlo.task({
      id: "manual-retry-task",
      retry: { attempts: 1 },
      run: async () => {
        executions += 1;
        if (executions === 1) throw new Error("first failure");
        return "recovered";
      },
    });
    const handle = await task.enqueue({}, { idempotencyKey: "manual-key" });
    const worker = durlo.worker({ tasks: [task] });

    await worker.runOnce();
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "dead_letter", attemptCount: 1 });
    expect(await durlo.runs.retry(handle)).toMatchObject({
      status: "pending",
      idempotencyKey: "manual-key",
      attemptCount: 1,
    });
    await worker.runOnce();
    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "completed",
      output: "recovered",
      attemptCount: 2,
      idempotencyKey: "manual-key",
    });
    await expect(durlo.runs.retry(handle)).rejects.toBeInstanceOf(RunStateError);
    await expect(durlo.runs.cancel(handle)).rejects.toBeInstanceOf(RunStateError);
    const attempts = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 and kind = 'run' order by started_at",
      [handle.id],
    );
    expect(attempts.rows.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
  });

  it("allows a failed workflow one new manual attempt", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let executions = 0;
    const workflow = durlo.workflow({
      id: "manual-retry-workflow",
      retry: { attempts: 1 },
      run: async () => {
        executions += 1;
        if (executions === 1) throw new Error("workflow failed");
        return "workflow recovered";
      },
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow] });

    await worker.runOnce();
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "failed" });
    expect(await durlo.runs.retry(handle)).toMatchObject({ status: "pending" });
    await worker.runOnce();
    expect(await adapter.getRun(handle.id)).toMatchObject({ status: "completed", output: "workflow recovered" });
  });

  it("records cooperative attempt timeouts and aborts the task signal", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let aborted = false;
    const task = durlo.task({
      id: "timeout-task",
      retry: { attempts: 1 },
      timeout: "5ms",
      run: async (_input: unknown, { signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });
    const handle = await task.enqueue({});

    await durlo.worker({ tasks: [task], leaseDuration: "1s" }).runOnce();

    expect(aborted).toBe(true);
    expect(await adapter.getRun(handle.id)).toMatchObject({
      status: "dead_letter",
      error: { name: "TimeoutError" },
    });
    const attempt = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 and kind = 'run'",
      [handle.id],
    );
    expect(attempt.rows).toEqual([{ status: "timed_out" }]);
  });
});
