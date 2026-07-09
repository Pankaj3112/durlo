import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo, LostLeaseError } from "@durlo/core";
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
});
