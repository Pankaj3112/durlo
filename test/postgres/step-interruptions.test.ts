import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo, LostLeaseError } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe
  .runIf(Boolean(databaseUrl))
  .sequential("@durlo/postgres workflow step interruptions", () => {
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

    it("times out an active step, retries it as a new attempt, and fences the late result", async () => {
      const durlo = new Durlo({ id: "step-interruptions", adapter });
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const workflow = durlo.workflow({
        id: "retry-timeout-step",
        timeout: "200ms",
        retry: { attempts: 2, backoff: { type: "fixed", delay: 0 } },
        run: async ({ attempt, step }) =>
          step.run("work", async () => {
            if (attempt.number === 1) {
              await firstBlocked;
              return "late-result";
            }
            return "recovered";
          })
      });
      const handle = await workflow.start({});
      const worker = durlo.worker({ workflows: [workflow], workerId: "timeout-worker" });

      expect(await worker.runOnce()).toBe(1);
      expect(await durlo.runs.get(handle)).toMatchObject({ status: "pending" });
      expect(await adapter.getStep(handle.id, "work")).toMatchObject({
        status: "timed_out",
        result: null,
        error: { name: "AttemptTimeoutError" },
        attemptCount: 1,
        completedAt: expect.any(Date)
      });

      expect(await worker.runOnce()).toBe(1);
      releaseFirst();
      await delay(25);

      expect(await durlo.runs.get(handle)).toMatchObject({
        status: "completed",
        output: "recovered"
      });
      expect(await adapter.getStep(handle.id, "work")).toMatchObject({
        status: "completed",
        result: "recovered",
        error: null,
        attemptCount: 2
      });
      expect(await stepAttemptStatuses(handle.id)).toEqual(["timed_out", "succeeded"]);
      const details = await durlo.runs.getDetails(handle);
      expect(details?.timeline.map(({ type }) => type)).toContain("step_attempt_timed_out");
      expect(details?.attempts.some(({ status }) => status === "running")).toBe(false);
    });

    it("leaves a terminally timed-out workflow with no active step evidence", async () => {
      const durlo = new Durlo({ id: "step-interruptions", adapter });
      let releaseStep!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseStep = resolve;
      });
      const workflow = durlo.workflow({
        id: "terminal-timeout-step",
        timeout: "30ms",
        retry: { attempts: 1 },
        run: async ({ step }) => step.run("work", async () => blocked.then(() => "late-result"))
      });
      const handle = await workflow.start({});

      expect(await durlo.worker({ workflows: [workflow] }).runOnce()).toBe(1);
      expect(await durlo.runs.get(handle)).toMatchObject({
        status: "failed",
        error: { name: "AttemptTimeoutError" }
      });
      expect(await adapter.getStep(handle.id, "work")).toMatchObject({
        status: "timed_out",
        result: null,
        error: { name: "AttemptTimeoutError" },
        completedAt: expect.any(Date)
      });
      expect(await stepAttemptStatuses(handle.id)).toEqual(["timed_out"]);

      releaseStep();
      await delay(25);
      expect(await adapter.getStep(handle.id, "work")).toMatchObject({
        status: "timed_out",
        result: null
      });
    });

    it("stalls an expired step before recovery creates and completes a distinct attempt", async () => {
      const durlo = new Durlo({ id: "step-interruptions", adapter });
      let markStarted!: () => void;
      let releaseFirst!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const workflow = durlo.workflow({
        id: "recover-stalled-step",
        retry: { attempts: 2 },
        run: async ({ attempt, step }) =>
          step.run("work", async () => {
            if (attempt.number === 1) {
              markStarted();
              await blocked;
              return "late-result";
            }
            return "recovered";
          })
      });
      const handle = await workflow.start({});
      const firstExecution = durlo
        .worker({ workflows: [workflow], workerId: "expired-owner", leaseDuration: "30s" })
        .runOnce();
      await started;
      await expireRun(handle.id);

      expect(
        await durlo
          .worker({ workflows: [workflow], workerId: "recovery-owner", leaseDuration: "30s" })
          .runOnce()
      ).toBe(1);
      releaseFirst();
      await firstExecution;

      expect(await durlo.runs.get(handle)).toMatchObject({
        status: "completed",
        output: "recovered",
        attemptCount: 2,
        stalledCount: 1
      });
      expect(await adapter.getStep(handle.id, "work")).toMatchObject({
        status: "completed",
        result: "recovered",
        attemptCount: 2
      });
      expect(await stepAttemptStatuses(handle.id)).toEqual(["stalled", "succeeded"]);
      const details = await durlo.runs.getDetails(handle);
      expect(details?.timeline.map(({ type }) => type)).toContain("step_attempt_stalled");
      expect(details?.steps.some(({ status }) => status === "running")).toBe(false);
    });

    it("stalls an active step when lease reclaim exhausts the workflow failure budget", async () => {
      const durlo = new Durlo({ id: "step-interruptions", adapter });
      let markStarted!: () => void;
      let releaseStep!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseStep = resolve;
      });
      const workflow = durlo.workflow({
        id: "exhaust-stalled-step",
        retry: { attempts: 1 },
        run: async ({ step }) =>
          step.run("work", async () => {
            markStarted();
            await blocked;
            return "late-result";
          })
      });
      const handle = await workflow.start({});
      const firstExecution = durlo
        .worker({ workflows: [workflow], workerId: "expired-owner", leaseDuration: "30s" })
        .runOnce();
      await started;
      await expireRun(handle.id);

      expect(
        await durlo
          .worker({ workflows: [workflow], workerId: "recovery-owner", leaseDuration: "30s" })
          .runOnce()
      ).toBe(0);
      releaseStep();
      await firstExecution;

      expect(await durlo.runs.get(handle)).toMatchObject({
        status: "failed",
        error: { name: "StalledError" },
        stalledCount: 1
      });
      expect(await adapter.getStep(handle.id, "work")).toMatchObject({
        status: "stalled",
        result: null,
        error: { name: "StalledError" },
        completedAt: expect.any(Date)
      });
      expect(await stepAttemptStatuses(handle.id)).toEqual(["stalled"]);
    });

    it("fails any owned active step when ordinary run failure persistence is the fallback", async () => {
      const durlo = new Durlo({ id: "step-interruptions", adapter });
      const workflow = durlo.workflow({
        id: "ordinary-failure-fallback",
        run: async () => undefined
      });
      const handle = await workflow.start({});
      const [claim] = await adapter.claimRuns({
        appId: durlo.id,
        workerId: "failure-owner",
        limit: 1,
        leaseDuration: 30_000,
        resources: [
          { kind: "workflow", resourceId: workflow.id, resourceVersion: workflow.version }
        ]
      });
      await adapter.startStep({
        runId: handle.id,
        workerId: "failure-owner",
        leaseToken: claim!.leaseToken,
        stepId: "work",
        maxAttempts: 1,
        maxSteps: 10
      });

      await adapter.failRun({
        runId: handle.id,
        workerId: "failure-owner",
        leaseToken: claim!.leaseToken,
        error: { name: "Error", message: "workflow failed" },
        outcome: { status: "failed" }
      });

      expect(await adapter.getStep(handle.id, "work")).toMatchObject({
        status: "failed",
        error: { name: "Error", message: "workflow failed" },
        completedAt: expect.any(Date)
      });
      expect(await stepAttemptStatuses(handle.id)).toEqual(["failed"]);
      await expect(
        adapter.completeStep({
          runId: handle.id,
          workerId: "failure-owner",
          leaseToken: claim!.leaseToken,
          stepId: "work",
          result: "late-result"
        })
      ).rejects.toBeInstanceOf(LostLeaseError);
    });

    it("never downgrades a completed checkpoint when its running workflow is cancelled", async () => {
      const durlo = new Durlo({ id: "step-interruptions", adapter });
      let markWaiting!: () => void;
      let releaseWorkflow!: () => void;
      const waiting = new Promise<void>((resolve) => {
        markWaiting = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseWorkflow = resolve;
      });
      const workflow = durlo.workflow({
        id: "preserve-completed-step",
        run: async ({ step }) => {
          await step.run("checkpoint", () => "saved");
          markWaiting();
          await blocked;
        }
      });
      const handle = await workflow.start({});
      const execution = durlo.worker({ workflows: [workflow], leaseDuration: "30s" }).runOnce();
      await waiting;

      await durlo.runs.cancel(handle);
      releaseWorkflow();
      await execution;

      expect(await adapter.getStep(handle.id, "checkpoint")).toMatchObject({
        status: "completed",
        result: "saved",
        error: null,
        attemptCount: 1
      });
      expect(await stepAttemptStatuses(handle.id)).toEqual(["succeeded"]);
    });

    async function expireRun(runId: string): Promise<void> {
      await adapter.pool.query(
        "update durlo_runs set locked_until = now() - interval '1 second' where id = $1",
        [runId]
      );
    }

    async function stepAttemptStatuses(runId: string): Promise<string[]> {
      const attempts = await adapter.pool.query<{ status: string }>(
        `select status from durlo_attempts
       where run_id = $1 and kind = 'step'
       order by attempt_number, started_at, id`,
        [runId]
      );
      return attempts.rows.map(({ status }) => status);
    }
  });

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
