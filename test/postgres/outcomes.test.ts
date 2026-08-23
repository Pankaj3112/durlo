import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo, PermanentError, RetryError } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("PostgreSQL explicit handler outcomes", () => {
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

  it("persists permanent task, workflow, and step failures without another retry", async () => {
    const durlo = new Durlo({ id: "permanent-outcomes", adapter });
    const task = durlo.task({
      id: "permanent-task",
      retry: { attempts: 3 },
      run: async () => {
        throw new PermanentError("task is invalid", { cause: { code: "INVALID_TASK" } });
      }
    });
    const workflow = durlo.workflow({
      id: "permanent-workflow",
      retry: { attempts: 3 },
      run: async () => {
        throw new PermanentError("workflow is invalid");
      }
    });
    const stepWorkflow = durlo.workflow({
      id: "permanent-step-workflow",
      retry: { attempts: 3 },
      run: async ({ step }) =>
        step.run("validate", () => {
          throw new PermanentError("step is invalid", { cause: "bad input" });
        })
    });
    const taskRun = await task.enqueue({});
    const workflowRun = await workflow.start({});
    const stepRun = await stepWorkflow.start({});

    await durlo
      .worker({ tasks: [task], workflows: [workflow, stepWorkflow], concurrency: 3 })
      .runOnce();

    await expect(durlo.runs.get(taskRun.run)).resolves.toMatchObject({
      status: "dead_letter",
      attemptCount: 1,
      error: {
        name: "PermanentError",
        message: "task is invalid",
        cause: { code: "INVALID_TASK" }
      }
    });
    await expect(durlo.runs.get(workflowRun.run)).resolves.toMatchObject({
      status: "failed",
      attemptCount: 1,
      error: { name: "PermanentError", message: "workflow is invalid" }
    });
    await expect(durlo.runs.get(stepRun.run)).resolves.toMatchObject({
      status: "failed",
      attemptCount: 1,
      error: { name: "PermanentError", message: "step is invalid", cause: "bad input" }
    });
    await expect(adapter.getStep(stepRun.run.id, "validate")).resolves.toMatchObject({
      status: "failed",
      attemptCount: 1,
      error: { name: "PermanentError", message: "step is invalid", cause: "bad input" }
    });
  });

  it("persists exact directed times and exhausts rather than resetting the failure budget", async () => {
    const durlo = new Durlo({ id: "directed-outcomes", adapter });
    const retryAt = new Date("2020-01-02T03:04:05.000Z");
    const task = durlo.task({
      id: "directed-task",
      retry: { attempts: 2 },
      run: async () => {
        throw new RetryError({ at: retryAt, message: "rate limited", cause: { status: 429 } });
      }
    });
    const creation = await task.enqueue({});
    const worker = durlo.worker({ tasks: [task] });

    expect(await worker.runOnce()).toBe(1);
    await expect(durlo.runs.get(creation.run)).resolves.toMatchObject({
      status: "pending",
      scheduledAt: retryAt,
      attemptCount: 1,
      error: { name: "RetryError", message: "rate limited", cause: { status: 429 } }
    });
    expect(await worker.runOnce()).toBe(1);
    await expect(durlo.runs.get(creation.run)).resolves.toMatchObject({
      status: "dead_letter",
      attemptCount: 2,
      error: { name: "RetryError", message: "rate limited", cause: { status: 429 } }
    });
    const attempts = await adapter.pool.query<{ status: string; error_json: { name: string } }>(
      "select status, error_json from durlo_attempts where run_id = $1 order by attempt_number",
      [creation.run.id]
    );
    expect(attempts.rows).toEqual([
      { status: "failed", error_json: expect.objectContaining({ name: "RetryError" }) },
      { status: "failed", error_json: expect.objectContaining({ name: "RetryError" }) }
    ]);
  });

  it("records directed step history and re-enters the failed checkpoint", async () => {
    const durlo = new Durlo({ id: "directed-step-outcomes", adapter });
    const retryAt = new Date("2020-02-03T04:05:06.000Z");
    let executions = 0;
    const workflow = durlo.workflow({
      id: "directed-step-workflow",
      retry: { attempts: 2 },
      run: async ({ step }) =>
        step.run("provider-call", () => {
          executions += 1;
          if (executions === 1)
            throw new RetryError({ at: retryAt, message: "try provider again" });
          return "done";
        })
    });
    const creation = await workflow.start({});
    const worker = durlo.worker({ workflows: [workflow] });

    expect(await worker.runOnce()).toBe(1);
    await expect(durlo.runs.get(creation.run)).resolves.toMatchObject({
      status: "pending",
      scheduledAt: retryAt,
      attemptCount: 1
    });
    await expect(adapter.getStep(creation.run.id, "provider-call")).resolves.toMatchObject({
      status: "failed",
      error: { name: "RetryError", message: "try provider again" }
    });
    expect(await worker.runOnce()).toBe(1);
    await expect(durlo.runs.get(creation.run)).resolves.toMatchObject({
      status: "completed",
      output: "done",
      attemptCount: 2
    });
    const stepAttempts = await adapter.pool.query<{ status: string; error_json: unknown }>(
      `select status, error_json from durlo_attempts
       where run_id = $1 and step_id = 'provider-call' order by attempt_number`,
      [creation.run.id]
    );
    expect(stepAttempts.rows).toEqual([
      { status: "failed", error_json: expect.objectContaining({ name: "RetryError" }) },
      { status: "succeeded", error_json: null }
    ]);
  });

  it("does not activate controls for matching names or subclasses", async () => {
    class DerivedPermanentError extends PermanentError {}
    const durlo = new Durlo({ id: "lookalike-outcomes", adapter });
    const lookalike = durlo.task({
      id: "retry-lookalike",
      retry: { attempts: 2, backoff: { type: "fixed", delay: "1h" } },
      run: async () => {
        throw Object.assign(new Error("ordinary"), {
          name: "RetryError",
          retryAt: new Date("2020-01-01T00:00:00.000Z")
        });
      }
    });
    const subclass = durlo.task({
      id: "permanent-subclass",
      retry: { attempts: 2, backoff: { type: "fixed", delay: "1h" } },
      run: async () => {
        throw new DerivedPermanentError("ordinary subclass");
      }
    });
    const lookalikeRun = await lookalike.enqueue({});
    const subclassRun = await subclass.enqueue({});
    const before = Date.now();

    await durlo.worker({ tasks: [lookalike, subclass], concurrency: 2 }).runOnce();

    for (const handle of [lookalikeRun.run, subclassRun.run]) {
      const run = await durlo.runs.get(handle);
      expect(run).toMatchObject({ status: "pending", attemptCount: 1 });
      expect(run!.scheduledAt.getTime()).toBeGreaterThanOrEqual(before + 3_599_000);
    }
  });
});
