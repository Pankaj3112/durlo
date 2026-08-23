import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;
const seedCount = Number.parseInt(process.env.DURLO_STRESS_SEEDS ?? "10", 10);
const seeds = Array.from({ length: seedCount }, (_, index) => index + 1);

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres seeded contention", () => {
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

  it.each(seeds)("preserves creation and lease invariants for seed %i", async (seed) => {
    const random = mulberry32(seed);
    const durlo = new Durlo({ id: "stress-tests", adapter });
    const task = durlo.task({ id: "contended", run: async () => undefined });
    const logicalRuns = 40;
    const requests = shuffle(
      Array.from({ length: logicalRuns }, (_, logical) =>
        Array.from({ length: 3 }, () => ({ logical }))
      ).flat(),
      random
    );

    const handles = await Promise.all(
      requests.map(({ logical }) =>
        task.enqueue({ logical }, { idempotencyKey: `seed:${seed}:logical:${logical}` })
      )
    );
    expect(new Set(handles.map(({ run }) => run.id)).size).toBe(logicalRuns);

    const resources = [{ kind: "task" as const, resourceId: task.id }];
    const claimGroups = await Promise.all(
      Array.from({ length: 4 }, (_, worker) =>
        adapter.claimRuns({
          appId: "stress-tests",
          workerId: `worker-${worker}`,
          limit: 10,
          leaseDuration: 30_000,
          resources
        })
      )
    );
    const claims = claimGroups.flat();
    expect(claims).toHaveLength(logicalRuns);
    expect(new Set(claims.map(({ id }) => id)).size).toBe(logicalRuns);

    await Promise.all(
      claims.map(async (claim) => {
        const completion = () =>
          adapter.completeRun({
            runId: claim.id,
            workerId: claim.lockedBy,
            leaseToken: claim.leaseToken,
            output: { seed },
            outputKind: "value"
          });
        if (random() < 0.5) {
          await completion();
          return;
        }
        const results = await Promise.allSettled([
          adapter.cancelRun({ appId: "stress-tests", runId: claim.id }),
          completion()
        ]);
        expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      })
    );

    const conservation = await adapter.pool.query<{
      total: string;
      running_runs: string;
      running_attempts: string;
      duplicate_keys: string;
      wrong_attempt_counts: string;
    }>(`
      select
        (select count(*) from durlo_runs)::text as total,
        (select count(*) from durlo_runs where status = 'running')::text as running_runs,
        (select count(*) from durlo_attempts where status = 'running')::text as running_attempts,
        (select count(*) from (
          select idempotency_key from durlo_runs
          where idempotency_key is not null
          group by app_id, kind, resource_id, idempotency_key having count(*) > 1
        ) duplicates)::text as duplicate_keys,
        (select count(*) from (
          select run_id from durlo_attempts where kind = 'run'
          group by run_id having count(*) <> 1
        ) wrong)::text as wrong_attempt_counts
    `);
    expect(conservation.rows[0]).toEqual({
      total: String(logicalRuns),
      running_runs: "0",
      running_attempts: "0",
      duplicate_keys: "0",
      wrong_attempt_counts: "0"
    });
  });

  it("drains a contended queue across independent worker pools exactly once without failures", async () => {
    const appId = "stress-worker-fleet";
    const runCount = 120;
    const executionCounts = new Map<string, number>();
    const durlo = new Durlo({ id: appId, adapter });
    const task = durlo.task<{ sequence: number }, number>({
      id: "fleet-task",
      run: async ({ sequence }, { run }) => {
        executionCounts.set(run.id, (executionCounts.get(run.id) ?? 0) + 1);
        if (sequence % 7 === 0) await wait(4);
        return sequence;
      }
    });
    const handles = await task.batchEnqueue(
      Array.from({ length: runCount }, (_, sequence) => ({ input: { sequence } }))
    );
    const workerAdapters = Array.from({ length: 4 }, () =>
      postgresAdapter({ connectionString: databaseUrl!, max: 4 })
    );
    const workers = workerAdapters.map((workerAdapter, index) =>
      new Durlo({ id: appId, adapter: workerAdapter }).worker({
        tasks: [task],
        workerId: `fleet-worker-${index}`,
        concurrency: 6,
        pollInterval: 5,
        leaseDuration: 2_000
      })
    );
    const runningWorkers = workers.map((worker) => worker.start());

    try {
      await waitFor(async () => {
        const result = await adapter.pool.query<{ completed: string }>(
          `select count(*)::text as completed from durlo_runs
           where app_id = $1 and status = 'completed'`,
          [appId]
        );
        return result.rows[0]?.completed === String(runCount);
      });
    } finally {
      for (const worker of workers) worker.stop();
      await Promise.all(runningWorkers);
      await Promise.all(workerAdapters.map((workerAdapter) => workerAdapter.close()));
    }

    expect(executionCounts.size).toBe(runCount);
    expect([...executionCounts.values()].every((count) => count === 1)).toBe(true);
    const conservation = await adapter.pool.query<{
      attempts: string;
      distinct_runs: string;
      active_attempts: string;
    }>(
      `select
         count(*)::text as attempts,
         count(distinct run_id)::text as distinct_runs,
         count(*) filter (where status = 'running')::text as active_attempts
       from durlo_attempts where run_id = any($1::text[]) and kind = 'run'`,
      [handles.map(({ run }) => run.id)]
    );
    expect(conservation.rows[0]).toEqual({
      attempts: String(runCount),
      distinct_runs: String(runCount),
      active_attempts: "0"
    });
  });

  it("replenishes slots while one long-tail execution remains blocked", async () => {
    const appId = "stress-long-tail";
    let markSlowStarted!: () => void;
    let releaseSlow!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const durlo = new Durlo({ id: appId, adapter });
    const task = durlo.task<{ slow: boolean; sequence: number }, number>({
      id: "long-tail-task",
      run: async ({ slow, sequence }) => {
        if (slow) {
          markSlowStarted();
          await slowGate;
        } else {
          await wait(5);
        }
        return sequence;
      }
    });
    const slow = await task.enqueue({ slow: true, sequence: 0 }, { priority: 100 });
    const fast = await task.batchEnqueue(
      Array.from({ length: 12 }, (_, index) => ({
        input: { slow: false, sequence: index + 1 }
      }))
    );
    const worker = durlo.worker({
      tasks: [task],
      workerId: "long-tail-worker",
      concurrency: 3,
      pollInterval: 5,
      leaseDuration: 2_000
    });
    const runningWorker = worker.start();

    try {
      await slowStarted;
      await waitFor(async () => {
        const completed = await adapter.pool.query<{ count: string }>(
          `select count(*)::text as count from durlo_runs
           where id = any($1::text[]) and status = 'completed'`,
          [fast.map(({ run }) => run.id)]
        );
        return Number(completed.rows[0]?.count) >= 8;
      });
      expect(await adapter.getRun({ appId, runId: slow.run.id })).toMatchObject({
        status: "running"
      });
      releaseSlow();
      await waitFor(async () => {
        const completed = await adapter.pool.query<{ count: string }>(
          `select count(*)::text as count from durlo_runs
           where app_id = $1 and status = 'completed'`,
          [appId]
        );
        return completed.rows[0]?.count === "13";
      });
    } finally {
      releaseSlow();
      worker.stop();
      await runningWorker;
    }
  });

  it("drains due timer lag while execution slots are occupied", async () => {
    const appId = "stress-timer-lag";
    const workflowCount = 12;
    const durlo = new Durlo({ id: appId, adapter });
    const workflow = durlo.workflow<{ sequence: number }, number>({
      id: "lagged-workflow",
      run: async ({ input, step }) => {
        await step.sleep("release", "1d");
        return input.sequence;
      }
    });
    const workflowHandles = await Promise.all(
      Array.from({ length: workflowCount }, (_, sequence) => workflow.start({ sequence }))
    );
    const preparationWorker = durlo.worker({
      workflows: [workflow],
      workerId: "timer-preparation-worker",
      concurrency: 6
    });
    while (
      (
        await adapter.pool.query<{ count: string }>(
          `select count(*)::text as count from durlo_runs
           where app_id = $1 and status = 'sleeping'`,
          [appId]
        )
      ).rows[0]?.count !== String(workflowCount)
    ) {
      await preparationWorker.runOnce();
    }

    await adapter.pool.query(
      `update durlo_timers set fire_at = now() - interval '500 milliseconds'
       where run_id = any($1::text[])`,
      [workflowHandles.map(({ run }) => run.id)]
    );
    const lagged = await durlo.runs.getBacklogHealth();
    expect(lagged.timers).toMatchObject({ pending: workflowCount, due: workflowCount });
    expect(lagged.timers.lagMs).toBeGreaterThanOrEqual(400);

    let blockersStarted = 0;
    let markBlockersStarted!: () => void;
    let releaseBlockers!: () => void;
    const allBlockersStarted = new Promise<void>((resolve) => {
      markBlockersStarted = resolve;
    });
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlockers = resolve;
    });
    const blocker = durlo.task({
      id: "timer-slot-blocker",
      run: async () => {
        blockersStarted += 1;
        if (blockersStarted === 2) markBlockersStarted();
        await blockerGate;
      }
    });
    await blocker.batchEnqueue([
      { input: {}, options: { priority: 100 } },
      { input: {}, options: { priority: 100 } }
    ]);
    const worker = durlo.worker({
      tasks: [blocker],
      workflows: [workflow],
      workerId: "timer-lag-worker",
      concurrency: 2,
      pollInterval: 10,
      leaseDuration: 2_000
    });
    const runningWorker = worker.start();

    try {
      await allBlockersStarted;
      await waitFor(async () => (await durlo.runs.getBacklogHealth()).timers.due === 0);
      const promoted = await adapter.pool.query<{ count: string }>(
        `select count(*)::text as count from durlo_runs
         where id = any($1::text[]) and status = 'pending'`,
        [workflowHandles.map(({ run }) => run.id)]
      );
      expect(promoted.rows[0]?.count).toBe(String(workflowCount));
      releaseBlockers();
      await waitFor(async () => {
        const completed = await adapter.pool.query<{ count: string }>(
          `select count(*)::text as count from durlo_runs
           where app_id = $1 and status = 'completed'`,
          [appId]
        );
        return completed.rows[0]?.count === String(workflowCount + 2);
      });
      expect((await durlo.runs.getBacklogHealth()).timers).toMatchObject({
        pending: 0,
        due: 0,
        lagMs: 0
      });
    } finally {
      releaseBlockers();
      worker.stop();
      await runningWorker;
    }
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(10);
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
  return values;
}
