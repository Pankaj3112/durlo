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
        Array.from({ length: 3 }, (_, duplicate) => ({ logical, duplicate }))
      ).flat(),
      random
    );

    const handles = await Promise.all(
      requests.map(({ logical, duplicate }) =>
        task.enqueue({ logical, duplicate }, { idempotencyKey: `seed:${seed}:logical:${logical}` })
      )
    );
    expect(new Set(handles.map(({ id }) => id)).size).toBe(logicalRuns);

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
            output: { seed }
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
});

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
