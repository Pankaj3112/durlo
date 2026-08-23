import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttemptTimeoutError, Durlo, IdempotencyConflictError, RunStateError } from "@durlo/core";
import { jsonByteSize } from "../../packages/core/src/limits.js";
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
      { attempts: 5, priority: 20, runAt: "2030-01-01T00:00:00.000Z" }
    );
    const record = await adapter.getRun({ appId: "integration", runId: handle.run.id });

    expect(record).toMatchObject({
      id: handle.run.id,
      appId: "integration",
      kind: "task",
      resourceId: "email",
      resourceVersion: "1",
      status: "pending",
      input: { email: "test@example.com" },
      maxAttempts: 5,
      priority: 20,
      attemptCount: 0
    });
    expect(record?.scheduledAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("lists app-scoped runs with stable keyset pagination and filters", async () => {
    const durlo = new Durlo({ id: "list-app", adapter });
    const emailV1 = durlo.task({ id: "email", version: "1", run: async () => undefined });
    const emailV2 = durlo.task({ id: "email", version: "2", run: async () => undefined });
    const workflow = durlo.workflow({ id: "onboarding", run: async () => undefined });
    const first = await emailV1.enqueue({ secret: "one" });
    const second = await emailV2.enqueue({ secret: "two" });
    const third = await workflow.start({ secret: "three" });
    const otherDurlo = new Durlo({ id: "other-list-app", adapter });
    const otherTask = otherDurlo.task({ id: "email", run: async () => undefined });
    await otherTask.enqueue({ secret: "hidden" });

    await adapter.pool.query(
      `update durlo_runs
       set created_at = case
         when id = any($1::text[]) then '2026-07-16T10:00:00.000Z'::timestamptz
         else '2026-07-15T10:00:00.000Z'::timestamptz
       end
       where id = any($2::text[])`,
      [
        [first.run.id, second.run.id],
        [first.run.id, second.run.id, third.run.id]
      ]
    );
    const expectedNewest = [first.run.id, second.run.id].sort().reverse();

    const pageOne = await durlo.runs.list({ limit: 2 });
    expect(pageOne.runs.map(({ id }) => id)).toEqual(expectedNewest);
    expect(pageOne.nextCursor).toEqual(expect.any(String));
    expect(pageOne.runs[0]).not.toHaveProperty("input");

    const pageTwo = await durlo.runs.list({ limit: 2, cursor: pageOne.nextCursor! });
    expect(pageTwo.runs.map(({ id }) => id)).toEqual([third.run.id]);
    expect(pageTwo.nextCursor).toBeNull();
    expect(new Set([...pageOne.runs, ...pageTwo.runs].map(({ id }) => id)).size).toBe(3);

    await expect(
      durlo.runs.list({ kinds: ["task"], resourceId: "email", resourceVersion: "2" })
    ).resolves.toMatchObject({ runs: [{ id: second.run.id, resourceVersion: "2" }] });
    await expect(
      durlo.runs.list({
        statuses: ["pending"],
        createdAfter: "2026-07-15T23:59:59.000Z",
        createdBefore: "2026-07-17T00:00:00.000Z"
      })
    ).resolves.toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({ id: first.run.id }),
        expect.objectContaining({ id: second.run.id })
      ])
    });
    await expect(
      adapter.listRuns({
        appId: durlo.id,
        limit: 0,
        cursor: null,
        statuses: [],
        kinds: [],
        resourceId: null,
        resourceVersion: null,
        createdAfter: null,
        createdBefore: null
      })
    ).rejects.toThrow("run list limit");
  });

  it("reads a consistent app-scoped run detail and chronological durable timeline", async () => {
    const durlo = new Durlo({ id: "details-app", adapter });
    const workflow = durlo.workflow<{ value: number }, { value: number }>({
      id: "observable-workflow",
      retry: { attempts: 3, backoff: { type: "fixed", delay: 1 } },
      run: async ({ attempt, input, step }) => {
        const checkpoint = await step.run("checkpoint", async () => ({ value: input.value * 2 }));
        if (attempt.number === 1) throw new Error("retry me");
        await step.sleep("brief-pause", 0);
        return checkpoint;
      }
    });
    const handle = await workflow.start({ value: 21 });
    const worker = durlo.worker({ workflows: [workflow], workerId: "details-worker" });

    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(1);

    const details = await durlo.runs.getDetails(handle.run);
    expect(details).toMatchObject({
      run: {
        id: handle.run.id,
        input: { value: 21 },
        output: { value: 42 },
        error: null,
        status: "completed"
      },
      steps: [
        {
          stepId: "checkpoint",
          status: "completed",
          result: { value: 42 }
        }
      ],
      timers: [{ stepId: "brief-pause", status: "fired" }],
      diagnostics: {
        failureCount: 1,
        failedAttempts: 1,
        retryCount: 1,
        stalledAttempts: 0,
        leaseLossCount: 0,
        timerLagMs: 0
      }
    });
    expect(
      details?.attempts
        .filter(({ kind }) => kind === "run")
        .map(({ attemptNumber, status }) => [attemptNumber, status])
    ).toEqual([
      [1, "failed"],
      [2, "succeeded"],
      [3, "succeeded"]
    ]);
    expect(details?.timeline.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "run_created",
        "step_created",
        "step_completed",
        "run_attempt_failed",
        "timer_scheduled",
        "timer_fired",
        "run_completed"
      ])
    );
    expect(
      details?.timeline.every(
        (event, index, timeline) => index === 0 || timeline[index - 1]!.at <= event.at
      )
    ).toBe(true);

    const otherApp = new Durlo({ id: "other-details-app", adapter });
    await expect(otherApp.runs.getDetails(handle.run.id)).resolves.toBeNull();
  });

  it("surfaces reclaimed lease loss as a stalled durable attempt", async () => {
    const durlo = new Durlo({ id: "details-app", adapter });
    const task = durlo.task({
      id: "stalled-details",
      retry: { attempts: 2 },
      run: async () => "recovered"
    });
    const handle = await task.enqueue({});
    await adapter.claimRuns({
      appId: durlo.id,
      workerId: "crashed-worker",
      limit: 1,
      leaseDuration: 10_000,
      resources: [{ kind: "task", resourceId: task.id, resourceVersion: task.version }]
    });
    await adapter.pool.query(
      "update durlo_runs set locked_until = now() - interval '1 second' where id = $1",
      [handle.run.id]
    );

    expect(await durlo.worker({ tasks: [task], workerId: "recovery-worker" }).runOnce()).toBe(1);
    const details = await durlo.runs.getDetails(handle.run);
    expect(details?.diagnostics).toMatchObject({
      failureCount: 1,
      stalledAttempts: 1,
      retryCount: 1,
      leaseLossCount: 1,
      hasExpiredLease: false
    });
    expect(details?.timeline.map(({ type }) => type)).toContain("run_attempt_stalled");
    expect(details?.attempts.map(({ workerId, status }) => [workerId, status])).toEqual([
      ["crashed-worker", "stalled"],
      ["recovery-worker", "succeeded"]
    ]);
  });

  it("keeps terminal errors in attempt history across a visible manual retry", async () => {
    const durlo = new Durlo({ id: "details-app", adapter });
    const task = durlo.task({
      id: "manual-retry-details",
      retry: { attempts: 1 },
      run: async () => {
        throw new Error("original failure");
      }
    });
    const handle = await task.enqueue({ operation: "charge" });
    expect(await durlo.worker({ tasks: [task] }).runOnce()).toBe(1);
    await durlo.runs.retry(handle.run);

    const details = await durlo.runs.getDetails(handle.run);
    expect(details).toMatchObject({
      run: { status: "pending", error: null, input: { operation: "charge" } },
      attempts: [
        {
          kind: "run",
          status: "failed",
          error: { name: "Error", message: "original failure" }
        }
      ],
      diagnostics: { failureCount: 1, retryCount: 1 }
    });
    expect(details?.timeline.map(({ type }) => type)).toContain("run_manual_retry_scheduled");
  });

  it("reports app-scoped backlog, expired leases, and database-clocked timer lag", async () => {
    const durlo = new Durlo({ id: "health-app", adapter });
    const readyTask = durlo.task({ id: "ready-health", run: async () => undefined });
    const runningTask = durlo.task({ id: "running-health", run: async () => undefined });
    const delayedTask = durlo.task({ id: "delayed-health", run: async () => undefined });
    const sleepingWorkflow = durlo.workflow({
      id: "sleeping-health",
      run: async ({ step }) => step.sleep("health-timer", "1d")
    });
    const running = await runningTask.enqueue({});
    await adapter.claimRuns({
      appId: durlo.id,
      workerId: "expired-health-worker",
      limit: 1,
      leaseDuration: 10_000,
      resources: [
        { kind: "task", resourceId: runningTask.id, resourceVersion: runningTask.version }
      ]
    });
    const ready = await readyTask.enqueue({});
    await delayedTask.enqueue({}, { runAt: "2030-01-01" });
    const sleeping = await sleepingWorkflow.start({});
    expect(await durlo.worker({ workflows: [sleepingWorkflow] }).runOnce()).toBe(1);

    await adapter.pool.query(
      `update durlo_runs
       set locked_until = now() - interval '2 seconds'
       where id = $1`,
      [running.run.id]
    );
    await adapter.pool.query(
      `update durlo_runs
       set scheduled_at = now() - interval '10 seconds',
           created_at = now() - interval '20 seconds'
       where id = $1`,
      [ready.run.id]
    );
    await adapter.pool.query(
      "update durlo_timers set fire_at = now() - interval '5 seconds' where run_id = $1",
      [sleeping.run.id]
    );
    const otherDurlo = new Durlo({ id: "other-health-app", adapter });
    const otherTask = otherDurlo.task({ id: "other-ready", run: async () => undefined });
    await otherTask.enqueue({});

    const health = await durlo.runs.getBacklogHealth();
    expect(health).toMatchObject({
      appId: "health-app",
      runs: {
        active: 4,
        pending: 2,
        ready: 1,
        delayed: 1,
        running: 1,
        sleeping: 1,
        expiredLeases: 1,
        oldestReadyAt: expect.any(Date),
        oldestReadyCreatedAt: expect.any(Date)
      },
      timers: {
        pending: 1,
        due: 1,
        oldestDueAt: expect.any(Date)
      }
    });
    expect(health.runs.readyLagMs).toBeGreaterThanOrEqual(9_000);
    expect(health.timers.lagMs).toBeGreaterThanOrEqual(4_000);
    expect(health.checkedAt).toBeInstanceOf(Date);
    await expect(durlo.runs.get(running.run)).resolves.toMatchObject({ status: "running" });
    await expect(durlo.runs.get(sleeping.run)).resolves.toMatchObject({ status: "sleeping" });
    const sleepingDetails = await durlo.runs.getDetails(sleeping.run);
    expect(sleepingDetails?.diagnostics.timerLagMs).toBeGreaterThanOrEqual(4_000);

    const emptyHealth = await new Durlo({
      id: "empty-health-app",
      adapter
    }).runs.getBacklogHealth();
    expect(emptyHealth).toMatchObject({
      runs: {
        active: 0,
        pending: 0,
        ready: 0,
        delayed: 0,
        running: 0,
        sleeping: 0,
        expiredLeases: 0,
        oldestReadyAt: null,
        oldestReadyCreatedAt: null,
        readyLagMs: 0
      },
      timers: { pending: 0, due: 0, oldestDueAt: null, lagMs: 0 }
    });
  });

  it("resumes a sleeping workflow only on its exact compatible version", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const oldWorkflow = durlo.workflow({
      id: "versioned-workflow",
      version: "1",
      run: async ({ step }) => {
        await step.sleep("deployment-boundary", "1d");
        return "completed by version 1";
      }
    });
    const newWorkflow = durlo.workflow({
      id: "versioned-workflow",
      version: "2",
      run: async () => {
        throw new Error("version 2 must not execute a version 1 run");
      }
    });
    const handle = await oldWorkflow.start({});
    const oldWorker = durlo.worker({ workflows: [oldWorkflow], workerId: "version-1-worker" });
    const newWorker = durlo.worker({ workflows: [newWorkflow], workerId: "version-2-worker" });

    expect(await oldWorker.runOnce()).toBe(1);
    expect(await newWorker.getCompatibilityReport()).toMatchObject({
      unavailableRuns: [
        {
          id: handle.run.id,
          status: "sleeping",
          resourceVersion: "1",
          reason: "incompatible_version"
        }
      ]
    });

    await adapter.pool.query(
      "update durlo_timers set fire_at = now() - interval '1 second' where run_id = $1",
      [handle.run.id]
    );
    expect(await newWorker.runOnce()).toBe(0);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "pending",
      resourceVersion: "1",
      attemptCount: 1
    });

    expect(await oldWorker.runOnce()).toBe(1);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "completed by version 1",
      resourceVersion: "1",
      attemptCount: 2
    });
  });

  it("prevents cross-app reads, cancellation, and manual retry", async () => {
    const owner = new Durlo({ id: "scope-owner", adapter });
    const otherApp = new Durlo({ id: "scope-other", adapter });
    const pendingTask = owner.task({ id: "scoped-pending", run: async () => undefined });
    const pending = await pendingTask.enqueue({});

    await expect(otherApp.runs.get(pending.run)).resolves.toBeNull();
    await expect(otherApp.runs.cancel(pending.run)).rejects.toBeInstanceOf(RunStateError);
    await expect(owner.runs.get(pending.run)).resolves.toMatchObject({ status: "pending" });

    const failingTask = owner.task({
      id: "scoped-failure",
      retry: { attempts: 1 },
      run: async () => {
        throw new Error("expected failure");
      }
    });
    const failed = await failingTask.enqueue({});
    await owner.worker({ tasks: [failingTask] }).runOnce();
    await expect(owner.runs.get(failed.run)).resolves.toMatchObject({ status: "dead_letter" });

    await expect(otherApp.runs.retry(failed.run)).rejects.toBeInstanceOf(RunStateError);
    await expect(owner.runs.get(failed.run)).resolves.toMatchObject({ status: "dead_letter" });
    await expect(owner.runs.retry(failed.run)).resolves.toMatchObject({ status: "pending" });
  });

  it("returns compatible reuse and rejects incompatible idempotency input", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "email", version: "1", run: async () => undefined });
    const nextTask = durlo.task({ id: "email", version: "2", run: async () => undefined });

    const first = await task.enqueue({ value: 1 }, { idempotencyKey: "business-key" });
    const duplicate = await task.enqueue({ value: 1 }, { idempotencyKey: "business-key" });

    expect(duplicate.run.id).toBe(first.run.id);
    expect(duplicate.created).toBe(false);
    expect(duplicate.run.resourceVersion).toBe("1");
    expect(await adapter.getRun({ appId: "integration", runId: first.run.id })).toMatchObject({
      input: { value: 1 },
      resourceVersion: "1"
    });
    await expect(
      nextTask.enqueue({ value: 2 }, { idempotencyKey: "business-key" })
    ).rejects.toMatchObject({
      name: "IdempotencyConflictError",
      idempotencyKey: "business-key",
      existingRunId: first.run.id,
      mismatches: ["input", "resource_version"]
    });
  });

  it("compares every idempotency dimension canonically and preserves the original row", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({
      id: "idempotency-dimensions",
      retry: { attempts: 2, backoff: { type: "fixed", delay: 1 } },
      run: async (input: unknown) => input
    });

    const expectConflict = async (
      key: string,
      input: unknown,
      options: Parameters<typeof task.enqueue>[1],
      mismatches: string[]
    ) => {
      const first = await task.enqueue({ a: 1, b: 2 }, { idempotencyKey: key, priority: 1 });
      await expect(
        task.enqueue(input, { priority: 1, ...options, idempotencyKey: key })
      ).rejects.toEqual(
        expect.objectContaining({
          name: "IdempotencyConflictError",
          idempotencyKey: key,
          existingRunId: first.run.id,
          mismatches
        })
      );
      await expect(
        adapter.getRun({ appId: "integration", runId: first.run.id })
      ).resolves.toMatchObject({
        input: { a: 1, b: 2 },
        priority: 1
      });
    };

    const equivalent = await task.enqueue(
      { first: { a: 1, b: 2 }, second: ["nested", { c: true }] },
      { idempotencyKey: "canonical-input" }
    );
    const equivalentRetry = await task.enqueue(
      { second: ["nested", { c: true }], first: { b: 2, a: 1 } },
      { idempotencyKey: "canonical-input", delay: 0 }
    );
    expect(equivalentRetry).toMatchObject({ run: { id: equivalent.run.id }, created: false });

    const nullInput = await task.enqueue(null, { idempotencyKey: "canonical-null-input" });
    const nullInputRetry = await task.enqueue(null, { idempotencyKey: "canonical-null-input" });
    expect(nullInputRetry).toMatchObject({ run: { id: nullInput.run.id }, created: false });

    await expectConflict("input-mismatch", { a: 9 }, {}, ["input"]);
    await expectConflict("options-mismatch", { a: 1, b: 2 }, { priority: 2 }, [
      "execution_options"
    ]);
    await expectConflict("schedule-mismatch", { a: 1, b: 2 }, { delay: 1 }, ["schedule"]);

    const legacy = await task.enqueue({ a: 1, b: 2 }, { idempotencyKey: "legacy-key" });
    await adapter.pool.query(
      `update durlo_runs
       set idempotency_metadata_version = null,
           idempotency_resource_version = null,
           idempotency_input_json = null,
           idempotency_execution_options_json = null,
           idempotency_schedule_json = null
       where id = $1`,
      [legacy.run.id]
    );
    await expect(task.enqueue({ a: 1, b: 2 }, { idempotencyKey: "legacy-key" })).rejects.toEqual(
      expect.objectContaining({
        name: "IdempotencyConflictError",
        mismatches: ["legacy_unverifiable"]
      })
    );
    expect(IdempotencyConflictError).toBeDefined();
  });

  it("rejects oversized inputs and batches before any row is persisted", async () => {
    const durlo = new Durlo({
      id: "integration",
      adapter,
      limits: { maxInputBytes: 10, maxBatchItems: 2, maxBatchBytes: 5 }
    });
    const task = durlo.task({ id: "limited-creation", run: async (input: unknown) => input });

    await expect(task.enqueue({ value: "too large" })).rejects.toMatchObject({
      name: "StorageLimitError",
      limitName: "maxInputBytes"
    });
    await expect(
      task.batchEnqueue([{ input: 1 }, { input: 2 }, { input: 3 }])
    ).rejects.toMatchObject({
      limitName: "maxBatchItems"
    });
    await expect(task.batchEnqueue([{ input: 1 }, { input: 20 }])).rejects.toMatchObject({
      limitName: "maxBatchBytes"
    });

    const count = await adapter.pool.query<{ count: string }>(
      "select count(*)::text as count from durlo_runs where app_id = 'integration'"
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("fails oversized outputs and stores bounded thrown errors", async () => {
    const outputDurlo = new Durlo({
      id: "integration",
      adapter,
      limits: { maxOutputBytes: 5 }
    });
    const outputTask = outputDurlo.task({
      id: "limited-output",
      retry: { attempts: 1 },
      run: async () => "too large"
    });
    const outputHandle = await outputTask.enqueue({});
    await outputDurlo.worker({ tasks: [outputTask] }).runOnce();
    expect(await outputDurlo.runs.get(outputHandle.run)).toMatchObject({
      status: "dead_letter",
      output: null,
      error: { name: "StorageLimitError", message: expect.stringContaining("maxOutputBytes") }
    });

    const errorDurlo = new Durlo({
      id: "integration",
      adapter,
      limits: { maxErrorBytes: 128 }
    });
    const errorTask = errorDurlo.task({
      id: "limited-error",
      retry: { attempts: 1 },
      run: async () => {
        throw new Error("x".repeat(10_000));
      }
    });
    const errorHandle = await errorTask.enqueue({});
    await errorDurlo.worker({ tasks: [errorTask] }).runOnce();
    const errorRun = await errorDurlo.runs.get(errorHandle.run);
    expect(errorRun).toMatchObject({
      status: "dead_letter",
      error: { name: "StorageLimitError", message: expect.stringContaining("maxErrorBytes") }
    });
    expect(jsonByteSize(errorRun?.error)).toBeLessThanOrEqual(128);
  });

  it("bounds durable step results and total workflow step storage", async () => {
    const resultDurlo = new Durlo({
      id: "integration",
      adapter,
      limits: { maxStepResultBytes: 5 }
    });
    const resultWorkflow = resultDurlo.workflow({
      id: "limited-step-result",
      retry: { attempts: 1 },
      run: async ({ step }) => step.run("large-result", async () => "too large")
    });
    const resultHandle = await resultWorkflow.start({});
    await resultDurlo.worker({ workflows: [resultWorkflow] }).runOnce();
    expect(await resultDurlo.runs.get(resultHandle.run)).toMatchObject({
      status: "failed",
      error: { name: "StorageLimitError", message: expect.stringContaining("maxStepResultBytes") }
    });
    expect(await adapter.getStep(resultHandle.run.id, "large-result")).toMatchObject({
      status: "failed",
      result: null,
      error: { name: "StorageLimitError" }
    });

    const countDurlo = new Durlo({
      id: "integration",
      adapter,
      limits: { maxWorkflowSteps: 1 }
    });
    const countWorkflow = countDurlo.workflow({
      id: "limited-step-count",
      retry: { attempts: 1 },
      run: async ({ step }) => {
        await step.run("first", async () => 1);
        await step.sleep("second", "1d");
      }
    });
    const countHandle = await countWorkflow.start({});
    await countDurlo.worker({ workflows: [countWorkflow] }).runOnce();
    expect(await countDurlo.runs.get(countHandle.run)).toMatchObject({
      status: "failed",
      error: { name: "StorageLimitError", message: expect.stringContaining("maxWorkflowSteps") }
    });
    const stored = await adapter.pool.query<{ steps: string; timers: string }>(
      `select
         (select count(*)::text from durlo_steps where run_id = $1) as steps,
         (select count(*)::text from durlo_timers where run_id = $1) as timers`,
      [countHandle.run.id]
    );
    expect(stored.rows[0]).toEqual({ steps: "1", timers: "0" });
  });

  it("deduplicates concurrent run creation atomically", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "concurrent-idempotency", run: async () => undefined });

    const handles = await Promise.all(
      Array.from({ length: 20 }, () =>
        task.enqueue({ value: 1 }, { idempotencyKey: "one-business-operation" })
      )
    );

    expect(new Set(handles.map(({ run }) => run.id)).size).toBe(1);
    const count = await adapter.pool.query<{ count: string }>(
      "select count(*)::text as count from durlo_runs where resource_id = 'concurrent-idempotency'"
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("creates batches atomically and preserves input order", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "batch", run: async (input: number) => input });

    const handles = await task.batchEnqueue([{ input: 1 }, { input: 2 }, { input: 3 }]);
    const rows = await adapter.pool.query<{ input_json: number }>(
      "select input_json from durlo_runs where resource_id = 'batch' order by created_at, id"
    );

    expect(handles).toHaveLength(3);
    expect(rows.rows.map(({ input_json }) => input_json).sort()).toEqual([1, 2, 3]);
  });

  it("cleans up terminal history in bounded app-scoped batches and releases idempotency keys", async () => {
    const durlo = new Durlo({ id: "retention-app", adapter });
    const task = durlo.task({
      id: "retained-task",
      run: async (input: { value: number }) => input
    });
    const handles = await task.batchEnqueue([
      { input: { value: 1 }, options: { idempotencyKey: "retention-1" } },
      { input: { value: 2 }, options: { idempotencyKey: "retention-2" } },
      { input: { value: 3 }, options: { idempotencyKey: "retention-3" } }
    ]);
    expect(await durlo.worker({ tasks: [task], concurrency: 3 }).runOnce()).toBe(3);

    const pending = await task.enqueue({ value: 4 }, { idempotencyKey: "pending-key" });
    const otherDurlo = new Durlo({ id: "other-retention-app", adapter });
    const otherTask = otherDurlo.task({ id: "retained-task", run: async () => undefined });
    const other = await otherTask.enqueue({});
    await otherDurlo.worker({ tasks: [otherTask] }).runOnce();

    await adapter.pool.query(
      `update durlo_runs
       set updated_at = case id
         when $1 then now() - interval '4 days'
         when $2 then now() - interval '3 days'
         when $3 then now() - interval '1 hour'
         when $4 then now() - interval '5 days'
         when $5 then now() - interval '5 days'
       end
      where id = any($6::text[])`,
      [
        handles[0]!.run.id,
        handles[1]!.run.id,
        handles[2]!.run.id,
        pending.run.id,
        other.run.id,
        [...handles.map(({ run }) => run.id), pending.run.id, other.run.id]
      ]
    );

    const duplicateBeforeCleanup = await task.enqueue(
      { value: 1 },
      { idempotencyKey: "retention-1" }
    );
    expect(duplicateBeforeCleanup.run.id).toBe(handles[0]!.run.id);
    expect(duplicateBeforeCleanup.created).toBe(false);

    await expect(
      durlo.runs.cleanup({ olderThan: "1d", limit: 1, statuses: ["completed"] })
    ).resolves.toEqual({
      deletedRuns: 1,
      deletedRunIds: [handles[0]!.run.id],
      limitReached: true
    });
    expect(await durlo.runs.get(handles[0]!.run)).toBeNull();
    expect(await durlo.runs.get(handles[1]!.run)).toMatchObject({ status: "completed" });
    expect(await durlo.runs.get(handles[2]!.run)).toMatchObject({ status: "completed" });
    expect(await durlo.runs.get(pending.run)).toMatchObject({ status: "pending" });
    expect(await otherDurlo.runs.get(other.run)).toMatchObject({ status: "completed" });
    const cascaded = await adapter.pool.query<{ attempts: string }>(
      "select count(*)::text as attempts from durlo_attempts where run_id = $1",
      [handles[0]!.run.id]
    );
    expect(cascaded.rows[0]?.attempts).toBe("0");

    const reused = await task.enqueue({ value: 100 }, { idempotencyKey: "retention-1" });
    expect(reused.run.id).not.toBe(handles[0]!.run.id);
    expect(reused.run.resourceVersion).toBe("1");

    await expect(durlo.runs.cleanup({ olderThan: "1d", limit: 10 })).resolves.toEqual({
      deletedRuns: 1,
      deletedRunIds: [handles[1]!.run.id],
      limitReached: false
    });
    await expect(durlo.runs.cleanup({ olderThan: "1d", limit: 10 })).resolves.toEqual({
      deletedRuns: 0,
      deletedRunIds: [],
      limitReached: false
    });
  });

  it("rolls back transaction-scoped task creation when the callback rejects", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "transactional", run: async () => undefined });
    let runId = "";
    await expect(
      durlo.transaction(async (transaction) => {
        runId = (await transaction.enqueue(task, { value: true })).run.id;
        await transaction.batchEnqueue(task, [
          { input: { value: "batch-1" } },
          { input: { value: "batch-2" } }
        ]);
        throw new Error("rollback transaction");
      })
    ).rejects.toThrow("rollback transaction");

    expect(await adapter.getRun({ appId: "integration", runId: runId })).toBeNull();
    const count = await adapter.pool.query<{ count: string }>(
      "select count(*)::text as count from durlo_runs where resource_id = 'transactional'"
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("claims and completes tasks with append-only attempt history", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({
      id: "complete-task",
      run: async (input: { value: number }, context) => ({
        doubled: input.value * 2,
        attempt: context.attempt.number
      })
    });
    const handle = await task.enqueue({ value: 21 });

    const worker = durlo.worker({ tasks: [task], workerId: "worker-a", leaseDuration: "5s" });
    expect(await worker.runOnce()).toBe(1);

    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: { doubled: 42, attempt: 1 },
      attemptCount: 1,
      lockedBy: null,
      leaseToken: null
    });
    const attempts = await adapter.pool.query<{ status: string; worker_id: string }>(
      "select status, worker_id from durlo_attempts where run_id = $1",
      [handle.run.id]
    );
    expect(attempts.rows).toEqual([{ status: "succeeded", worker_id: "worker-a" }]);
  });

  it("claims each run at most once across concurrent workers", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "contended-task", run: async () => undefined });
    const handles = await task.batchEnqueue(
      Array.from({ length: 20 }, (_, value) => ({ input: { value } }))
    );
    const resources = [{ kind: "task" as const, resourceId: task.id }];

    const [workerA, workerB] = await Promise.all([
      adapter.claimRuns({
        appId: "integration",
        workerId: "worker-a",
        limit: 10,
        leaseDuration: 10_000,
        resources
      }),
      adapter.claimRuns({
        appId: "integration",
        workerId: "worker-b",
        limit: 10,
        leaseDuration: 10_000,
        resources
      })
    ]);

    const claimedIds = [...workerA, ...workerB].map(({ id }) => id);
    expect(workerA).toHaveLength(10);
    expect(workerB).toHaveLength(10);
    expect(new Set(claimedIds).size).toBe(20);
    expect(new Set(claimedIds)).toEqual(new Set(handles.map(({ run }) => run.id)));

    const attempts = await adapter.pool.query<{ run_id: string; count: string }>(
      `select run_id, count(*)::text as count
       from durlo_attempts where kind = 'run' group by run_id`
    );
    expect(attempts.rows).toHaveLength(20);
    expect(attempts.rows.every(({ count }) => count === "1")).toBe(true);
  });

  it("skips a claimable row locked by another transaction", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "skip-locked-task", run: async () => undefined });
    await task.batchEnqueue([
      { input: { value: 1 }, options: { priority: 100 } },
      { input: { value: 2 }, options: { priority: 0 } }
    ]);
    const lockingClient = await adapter.pool.connect();
    let claimPromise: ReturnType<typeof adapter.claimRuns> | undefined;

    try {
      await lockingClient.query("begin");
      const locked = await lockingClient.query<{ id: string }>(
        `select id from durlo_runs
         where resource_id = 'skip-locked-task'
         order by priority desc, scheduled_at, created_at, id
         for update limit 1`
      );

      claimPromise = adapter.claimRuns({
        appId: "integration",
        workerId: "non-blocked-worker",
        limit: 1,
        leaseDuration: 10_000,
        resources: [{ kind: "task", resourceId: task.id }]
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("claim blocked on a row lock")), 1_000).unref();
      });
      const [claim] = await Promise.race([claimPromise, timeout]);

      expect(claim).toBeDefined();
      expect(claim?.id).not.toBe(locked.rows[0]?.id);
    } finally {
      await lockingClient.query("rollback");
      lockingClient.release();
      await claimPromise?.catch(() => undefined);
    }
  });

  it("skips a locked expired lease while reclaiming another", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "skip-locked-expired", run: async () => undefined });
    await task.batchEnqueue([
      { input: { value: 1 }, options: { priority: 100 } },
      { input: { value: 2 }, options: { priority: 0 } }
    ]);
    const resources = [{ kind: "task" as const, resourceId: task.id }];
    await adapter.claimRuns({
      appId: "integration",
      workerId: "expired-owner",
      limit: 2,
      leaseDuration: 10_000,
      resources
    });
    await adapter.pool.query(
      `update durlo_runs set locked_until = now() - interval '1 second'
       where resource_id = 'skip-locked-expired'`
    );
    const lockingClient = await adapter.pool.connect();
    let claimPromise: ReturnType<typeof adapter.claimRuns> | undefined;

    try {
      await lockingClient.query("begin");
      const locked = await lockingClient.query<{ id: string }>(
        `select id from durlo_runs
         where resource_id = 'skip-locked-expired'
         order by priority desc, scheduled_at, created_at, id
         for update limit 1`
      );

      claimPromise = adapter.claimRuns({
        appId: "integration",
        workerId: "expired-reclaimer",
        limit: 1,
        leaseDuration: 10_000,
        resources
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("expired claim blocked on a row lock")), 1_000).unref();
      });
      const [claim] = await Promise.race([claimPromise, timeout]);

      expect(claim).toBeDefined();
      expect(claim?.id).not.toBe(locked.rows[0]?.id);
    } finally {
      await lockingClient.query("rollback");
      lockingClient.release();
      await claimPromise?.catch(() => undefined);
    }
  });

  it("rejects every ownership-sensitive write with the wrong worker or lease token", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "owned-write-task", run: async () => undefined });
    const handle = await task.enqueue({});
    const [claim] = await adapter.claimRuns({
      appId: "integration",
      workerId: "owner",
      limit: 1,
      leaseDuration: 10_000,
      resources: [{ kind: "task", resourceId: task.id }]
    });

    const invalidOwners = [
      { runId: handle.run.id, workerId: "owner", leaseToken: "stale-token" },
      { runId: handle.run.id, workerId: "intruder", leaseToken: claim!.leaseToken }
    ];
    for (const invalidOwner of invalidOwners) {
      expect(await adapter.extendRunLease({ ...invalidOwner, leaseDuration: 10_000 })).toBe(false);
      expect(await adapter.releaseRun(invalidOwner)).toBe(false);
      await expect(
        adapter.completeRun({ ...invalidOwner, output: "stale", outputKind: "value" })
      ).rejects.toThrow("lease lost");
      await expect(
        adapter.failRun({
          ...invalidOwner,
          error: { name: "Error", message: "stale" },
          outcome: { status: "dead_letter" }
        })
      ).rejects.toThrow("lease lost");
    }

    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "running",
      lockedBy: "owner",
      leaseToken: claim!.leaseToken
    });
    const attempt = await adapter.pool.query<{ status: string; lease_token: string }>(
      "select status, lease_token from durlo_attempts where run_id = $1 and kind = 'run'",
      [handle.run.id]
    );
    expect(attempt.rows).toEqual([{ status: "running", lease_token: claim!.leaseToken }]);

    await adapter.completeRun({
      runId: handle.run.id,
      workerId: "owner",
      leaseToken: claim!.leaseToken,
      output: "current",
      outputKind: "value"
    });
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "current"
    });
  });

  it("retries thrown task errors and dead-letters after exhaustion", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let executions = 0;
    const task = durlo.task({
      id: "retry-task",
      retry: { attempts: 2, backoff: { type: "fixed", delay: 1 } },
      run: async () => {
        executions += 1;
        throw new Error(`failure ${executions}`);
      }
    });
    const handle = await task.enqueue({});
    const worker = durlo.worker({ tasks: [task], workerId: "worker-retry" });

    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "pending",
      attemptCount: 1
    });
    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "dead_letter",
      attemptCount: 2,
      error: { name: "Error", message: "failure 2" }
    });
  });

  it("reclaims expired leases, records stalls, and rejects stale completion", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({
      id: "stalled-task",
      retry: { attempts: 2 },
      run: async () => "done"
    });
    const handle = await task.enqueue({});
    const resources = [{ kind: "task" as const, resourceId: task.id }];

    const [first] = await adapter.claimRuns({
      appId: "integration",
      workerId: "worker-old",
      limit: 1,
      leaseDuration: 10_000,
      resources
    });
    expect(first).toBeDefined();
    await adapter.pool.query(
      "update durlo_runs set locked_until = now() - interval '1 second' where id = $1",
      [handle.run.id]
    );
    const [second] = await adapter.claimRuns({
      appId: "integration",
      workerId: "worker-new",
      limit: 1,
      leaseDuration: 10_000,
      resources
    });

    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    await expect(
      adapter.completeRun({
        runId: handle.run.id,
        workerId: "worker-old",
        leaseToken: first!.leaseToken,
        output: "stale",
        outputKind: "value"
      })
    ).rejects.toThrow("lease lost");
    await adapter.completeRun({
      runId: handle.run.id,
      workerId: "worker-new",
      leaseToken: second!.leaseToken,
      output: "current",
      outputKind: "value"
    });

    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "current",
      attemptCount: 2,
      stalledCount: 1
    });
    const attempts = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 order by started_at",
      [handle.run.id]
    );
    expect(attempts.rows.map(({ status }) => status).sort()).toEqual(["stalled", "succeeded"]);
  });

  it("terminally fails an expired lease when its retry budget is exhausted", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({
      id: "expired-task",
      retry: { attempts: 1 },
      run: async () => undefined
    });
    const handle = await task.enqueue({});
    const claimInput = {
      appId: "integration",
      workerId: "worker",
      limit: 1,
      leaseDuration: 10_000,
      resources: [{ kind: "task" as const, resourceId: task.id }]
    };

    expect(await adapter.claimRuns(claimInput)).toHaveLength(1);
    await adapter.pool.query(
      "update durlo_runs set locked_until = now() - interval '1 second' where id = $1",
      [handle.run.id]
    );
    expect(await adapter.claimRuns(claimInput)).toHaveLength(0);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "dead_letter",
      stalledCount: 1,
      error: { name: "StalledError" }
    });
  });

  it("releases owned work before execution without treating it as a failure", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const task = durlo.task({ id: "release-task", run: async () => "done" });
    const handle = await task.enqueue({});
    const claimInput = {
      appId: "integration",
      workerId: "releasing-worker",
      limit: 1,
      leaseDuration: 10_000,
      resources: [{ kind: "task" as const, resourceId: task.id }]
    };
    const [claim] = await adapter.claimRuns(claimInput);

    expect(
      await adapter.releaseRun({
        runId: handle.run.id,
        workerId: claim!.lockedBy,
        leaseToken: claim!.leaseToken
      })
    ).toBe(true);
    expect(
      await adapter.releaseRun({
        runId: handle.run.id,
        workerId: claim!.lockedBy,
        leaseToken: claim!.leaseToken
      })
    ).toBe(false);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "pending"
    });
    const attempts = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 and kind = 'run'",
      [handle.run.id]
    );
    expect(attempts.rows).toEqual([{ status: "cancelled" }]);
  });

  it("executes workflows and persists reusable step results", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "step-workflow",
      run: async ({ input, step }: { input: { value: number }; step: StepTools }) => {
        const doubled = await step.run("double", () => input.value * 2);
        return step.run("result", () => ({ doubled }));
      }
    });
    const handle = await workflow.start({ value: 21 });
    const worker = durlo.worker({ workflows: [workflow], workerId: "workflow-worker" });

    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: { doubled: 42 }
    });
    expect(await adapter.getStep(handle.run.id, "double")).toMatchObject({
      status: "completed",
      result: 42,
      attemptCount: 1
    });
    expect(await adapter.getStep(handle.run.id, "result")).toMatchObject({
      status: "completed",
      result: { doubled: 42 }
    });
  });

  it("skips completed checkpoints when a failed workflow is re-entered", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let durableExecutions = 0;
    let flakyExecutions = 0;
    const workflow = durlo.workflow({
      id: "retry-workflow",
      retry: { attempts: 2, backoff: { type: "fixed", delay: 1 } },
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
      }
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow], workerId: "workflow-retry" });

    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "pending",
      attemptCount: 1
    });
    expect(await worker.runOnce()).toBe(1);

    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: 11,
      attemptCount: 2
    });
    expect(durableExecutions).toBe(1);
    expect(flakyExecutions).toBe(2);
    expect(await adapter.getStep(handle.run.id, "durable")).toMatchObject({
      attemptCount: 1,
      status: "completed"
    });
    expect(await adapter.getStep(handle.run.id, "flaky")).toMatchObject({
      attemptCount: 2,
      status: "completed"
    });
  });

  it("fails workflows that reuse a step id in one execution", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "duplicate-step-workflow",
      retry: { attempts: 1 },
      run: async ({ step }) => {
        await step.run("same", () => 1);
        await step.run("same", () => 2);
      }
    });
    const handle = await workflow.start({});

    await durlo.worker({ workflows: [workflow] }).runOnce();

    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "failed",
      error: { name: "ValidationError", message: expect.stringContaining("more than once") }
    });
  });

  it("rejects nested step calls", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "nested-step-workflow",
      retry: { attempts: 1 },
      run: async ({ step }) => {
        await step.run("outer", async () => step.run("inner", () => "no"));
      }
    });
    const handle = await workflow.start({});

    await durlo.worker({ workflows: [workflow] }).runOnce();

    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "failed",
      error: { name: "ValidationError", message: "nested step calls are not allowed" }
    });
    expect(await adapter.getStep(handle.run.id, "inner")).toBeNull();
    expect(await adapter.getStep(handle.run.id, "outer")).toMatchObject({ status: "failed" });
  });

  it("rejects concurrent workflow step calls predictably", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "concurrent-step-workflow",
      retry: { attempts: 1 },
      run: async ({ step }) => {
        await Promise.all([
          step.run("first", async () => "first"),
          step.run("second", async () => "second")
        ]);
      }
    });
    const handle = await workflow.start({});

    await durlo.worker({ workflows: [workflow] }).runOnce();

    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "failed",
      error: {
        name: "ValidationError",
        message: "workflow steps must be sequential; cannot start 'second' while 'first' is active"
      }
    });
    expect(await adapter.getStep(handle.run.id, "second")).toBeNull();
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
      }
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow], workerId: "sleep-worker" });

    for (let index = 0; index < 4; index += 1) {
      expect(await worker.runOnce()).toBe(1);
      expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
        status: "sleeping"
      });
    }
    expect(await worker.runOnce()).toBe(1);

    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "awake",
      attemptCount: 5
    });
    expect(firstStepExecutions).toBe(1);
    const timers = await adapter.pool.query<{ status: string }>(
      "select status from durlo_timers where run_id = $1 order by step_id",
      [handle.run.id]
    );
    expect(timers.rows).toEqual([
      { status: "fired" },
      { status: "fired" },
      { status: "fired" },
      { status: "fired" }
    ]);
  });

  it("keeps sleepUntil durable until its timer becomes due", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "sleep-until-workflow",
      run: async ({ step }) => {
        await step.sleepUntil("future", "2030-01-01T00:00:00.000Z");
        return "resumed";
      }
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow] });

    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(0);
    expect(await adapter.getTimer(handle.run.id, "future")).toMatchObject({
      status: "pending",
      fireAt: new Date("2030-01-01T00:00:00.000Z")
    });
    await adapter.pool.query(
      "update durlo_timers set fire_at = now() - interval '1 second' where run_id = $1",
      [handle.run.id]
    );
    expect(await worker.runOnce()).toBe(1);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "resumed"
    });
  });

  it("cancels sleeping timers atomically and never resumes the workflow", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    const workflow = durlo.workflow({
      id: "cancel-sleep-workflow",
      run: async ({ step }) => {
        await step.sleep("long-wait", "1d");
      }
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow] });

    await worker.runOnce();
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "sleeping"
    });
    expect(await durlo.runs.cancel(handle.run)).toMatchObject({ status: "cancelled" });
    expect(await durlo.runs.cancel(handle.run)).toMatchObject({ status: "cancelled" });
    expect(await adapter.getTimer(handle.run.id, "long-wait")).toMatchObject({
      status: "cancelled"
    });
    expect(await worker.runOnce()).toBe(0);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "cancelled"
    });
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
      resources: [{ kind: "task", resourceId: task.id }]
    });

    await durlo.runs.cancel(handle.run);
    await expect(
      adapter.completeRun({
        runId: handle.run.id,
        workerId: "cancellable-worker",
        leaseToken: claim!.leaseToken,
        output: "late",
        outputKind: "value"
      })
    ).rejects.toThrow("lease lost");
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "cancelled"
    });
    const attempt = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 and kind = 'run'",
      [handle.run.id]
    );
    expect(attempt.rows).toEqual([{ status: "cancelled" }]);
  });

  it("delivers running cancellation cooperatively through lease loss", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let markStarted!: () => void;
    let markAborted!: () => void;
    let abortReason: unknown;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const task = durlo.task({
      id: "cooperative-cancellation",
      run: async (_input: unknown, { signal }) => {
        markStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              abortReason = signal.reason;
              markAborted();
              resolve();
            },
            { once: true }
          );
        });
        return "late completion";
      }
    });
    const handle = await task.enqueue({});
    const execution = durlo
      .worker({ tasks: [task], workerId: "cooperative-worker", leaseDuration: 30 })
      .runOnce();

    await started;
    await durlo.runs.cancel(handle.run);
    await aborted;
    await execution;

    expect(abortReason).toMatchObject({ message: expect.stringContaining("lease") });
    expect(await durlo.runs.get(handle.run)).toMatchObject({
      status: "cancelled",
      output: null,
      error: null
    });
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
      }
    });
    const handle = await task.enqueue({}, { idempotencyKey: "manual-key" });
    const worker = durlo.worker({ tasks: [task] });

    await worker.runOnce();
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "dead_letter",
      attemptCount: 1
    });
    expect(await durlo.runs.retry(handle.run)).toMatchObject({
      status: "pending",
      idempotencyKey: "manual-key",
      attemptCount: 1
    });
    await worker.runOnce();
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "recovered",
      attemptCount: 2,
      idempotencyKey: "manual-key"
    });
    await expect(durlo.runs.retry(handle.run)).rejects.toBeInstanceOf(RunStateError);
    await expect(durlo.runs.cancel(handle.run)).rejects.toBeInstanceOf(RunStateError);
    const attempts = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 and kind = 'run' order by started_at",
      [handle.run.id]
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
      }
    });
    const handle = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow] });

    await worker.runOnce();
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "failed"
    });
    expect(await durlo.runs.retry(handle.run)).toMatchObject({ status: "pending" });
    await worker.runOnce();
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "workflow recovered"
    });
  });

  it("records cooperative attempt timeouts and aborts the task signal", async () => {
    const durlo = new Durlo({ id: "integration", adapter });
    let aborted = false;
    let abortReason: unknown;
    const task = durlo.task({
      id: "timeout-task",
      retry: { attempts: 1 },
      timeout: "5ms",
      run: async (_input: unknown, { signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          abortReason = signal.reason;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    const handle = await task.enqueue({});

    await durlo.worker({ tasks: [task], leaseDuration: "1s" }).runOnce();

    expect(aborted).toBe(true);
    expect(abortReason).toBeInstanceOf(AttemptTimeoutError);
    expect(await adapter.getRun({ appId: "integration", runId: handle.run.id })).toMatchObject({
      status: "dead_letter",
      error: { name: "AttemptTimeoutError" }
    });
    const attempt = await adapter.pool.query<{ status: string }>(
      "select status from durlo_attempts where run_id = $1 and kind = 'run'",
      [handle.run.id]
    );
    expect(attempt.rows).toEqual([{ status: "timed_out" }]);
  });
});
