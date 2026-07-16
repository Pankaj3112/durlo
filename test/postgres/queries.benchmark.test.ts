import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;
const runCount = positiveInteger("DURLO_BENCHMARK_RUNS", 50_000);
const sampleCount = positiveInteger("DURLO_BENCHMARK_SAMPLES", 5);
const maximumQueryMilliseconds = positiveNumber("DURLO_BENCHMARK_MAX_MS", 250);

type ExplainNode = {
  "Index Name"?: string;
  "Node Type": string;
  Plans?: ExplainNode[];
};

type ExplainDocument = {
  "Execution Time": number;
  Plan: ExplainNode;
  "Planning Time": number;
};

type ExplainRow = {
  "QUERY PLAN": ExplainDocument[];
};

type QueryBenchmark = {
  indexes: string[];
  maximumMilliseconds: number;
  medianMilliseconds: number;
  nodeTypes: string[];
  planningMilliseconds: number;
  query: string;
  samples: number;
};

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres query benchmarks", () => {
  let admin: PostgresAdapter;
  let adapter: PostgresAdapter;
  let schema: string;

  beforeAll(async () => {
    admin = postgresAdapter({ connectionString: databaseUrl! });
    schema = `durlo_benchmark_${randomUUID().replaceAll("-", "")}`;
    await admin.pool.query(`create schema ${quoteIdentifier(schema)}`);
    adapter = postgresAdapter({
      connectionString: databaseUrl!,
      options: `-c search_path=${schema}`
    });
    await adapter.migrate();
    await seedBenchmarkData(adapter, runCount);
  });

  afterAll(async () => {
    await adapter?.close();
    if (admin && schema) {
      await admin.pool.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
    }
    await admin?.close();
  });

  it("keeps claim, attempt, and timer queries inside the measured envelope", async () => {
    const results = await Promise.all([
      benchmarkQuery(
        adapter,
        "claim expired leases",
        `
          select
            id, app_id, kind, resource_id, resource_version, status, input_json, output_json,
            error_json, options_json, idempotency_key, priority, scheduled_at, attempt_count,
            max_attempts, locked_by, lease_token, locked_until, stalled_count, created_at,
            updated_at, started_at, completed_at, cancelled_at
          from durlo_runs
          where app_id = $1
            and exists (
              select 1
              from unnest($2::text[], $3::text[], $4::text[])
                as resource(kind, resource_id, resource_version)
              where resource.kind = durlo_runs.kind
                and resource.resource_id = durlo_runs.resource_id
                and resource.resource_version = durlo_runs.resource_version
            )
            and status = 'running' and locked_until < now()
          order by priority desc, scheduled_at asc, created_at asc
          for update skip locked
          limit $5
        `,
        ["benchmark", ["task"], ["benchmark-task"], ["1"], 25]
      ),
      benchmarkQuery(
        adapter,
        "claim pending",
        `
          select
            id, app_id, kind, resource_id, resource_version, status, input_json, output_json,
            error_json, options_json, idempotency_key, priority, scheduled_at, attempt_count,
            max_attempts, locked_by, lease_token, locked_until, stalled_count, created_at,
            updated_at, started_at, completed_at, cancelled_at
          from durlo_runs
          where app_id = $1
            and exists (
              select 1
              from unnest($2::text[], $3::text[], $4::text[])
                as resource(kind, resource_id, resource_version)
              where resource.kind = durlo_runs.kind
                and resource.resource_id = durlo_runs.resource_id
                and resource.resource_version = durlo_runs.resource_version
            )
            and status = 'pending' and scheduled_at <= now()
          order by priority desc, scheduled_at asc, created_at asc
          for update skip locked
          limit $5
        `,
        ["benchmark", ["task"], ["benchmark-task"], ["1"], 25]
      ),
      benchmarkQuery(
        adapter,
        "attempt failure count",
        `
          select count(*)::text as count from durlo_attempts
          where run_id = $1 and kind = 'run'
            and status in ('failed', 'timed_out', 'stalled')
        `,
        ["benchmark-run-1"]
      ),
      benchmarkQuery(
        adapter,
        "due timers",
        `
          select
            t.id, t.run_id, t.step_id, t.fire_at, t.status, t.created_at,
            t.fired_at, t.cancelled_at
          from durlo_timers t
          join durlo_runs r on r.id = t.run_id
          where r.app_id = $1 and r.status = 'sleeping'
            and t.status = 'pending' and t.fire_at <= now()
          order by t.fire_at, t.created_at
          for update of t, r skip locked
          limit $2
        `,
        ["benchmark", 25]
      )
    ]);

    process.stdout.write(`DURLO_BENCHMARK ${JSON.stringify({ datasetRuns: runCount, results })}\n`);

    for (const result of results) {
      expect(result.maximumMilliseconds, result.query).toBeLessThanOrEqual(
        maximumQueryMilliseconds
      );
      if (runCount >= 50_000) {
        expect(result.indexes, result.query).toContain(
          {
            "attempt failure count": "durlo_attempts_run_idx",
            "claim expired leases": "durlo_runs_lease_idx",
            "claim pending": "durlo_runs_due_idx",
            "due timers": "durlo_timers_due_idx"
          }[result.query]
        );
      }
    }
  });
});

async function benchmarkQuery(
  adapter: PostgresAdapter,
  name: string,
  sql: string,
  values: unknown[]
): Promise<QueryBenchmark> {
  await explain(adapter, sql, values);
  const plans: ExplainDocument[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    plans.push(await explain(adapter, sql, values));
  }
  const executionTimes = plans
    .map((plan) => plan["Execution Time"])
    .sort((left, right) => left - right);
  const planningTimes = plans
    .map((plan) => plan["Planning Time"])
    .sort((left, right) => left - right);
  const planDetails = collectPlanDetails(plans.at(-1)!.Plan);
  return {
    query: name,
    samples: sampleCount,
    medianMilliseconds: median(executionTimes),
    maximumMilliseconds: executionTimes.at(-1)!,
    planningMilliseconds: median(planningTimes),
    indexes: [...planDetails.indexes].sort(),
    nodeTypes: [...planDetails.nodeTypes].sort()
  };
}

async function explain(
  adapter: PostgresAdapter,
  sql: string,
  values: unknown[]
): Promise<ExplainDocument> {
  const result = await adapter.pool.query<ExplainRow>(
    `explain (analyze, buffers, format json) ${sql}`,
    values
  );
  const plan = result.rows[0]?.["QUERY PLAN"][0];
  if (!plan) throw new Error("Postgres did not return an EXPLAIN plan");
  return plan;
}

function collectPlanDetails(root: ExplainNode): { indexes: Set<string>; nodeTypes: Set<string> } {
  const indexes = new Set<string>();
  const nodeTypes = new Set<string>();
  const visit = (node: ExplainNode): void => {
    nodeTypes.add(node["Node Type"]);
    if (node["Index Name"]) indexes.add(node["Index Name"]);
    node.Plans?.forEach(visit);
  };
  visit(root);
  return { indexes, nodeTypes };
}

async function seedBenchmarkData(adapter: PostgresAdapter, count: number): Promise<void> {
  await adapter.pool.query(
    `
      with generated as (
        select
          value,
          case
            when value % 100 < 80 then 'completed'
            when value % 100 < 92 then 'pending'
            when value % 100 < 96 then 'sleeping'
            else 'running'
          end as status
        from generate_series(1, $1::integer) as value
      )
      insert into durlo_runs (
        id, app_id, kind, resource_id, resource_version, status, input_json, options_json,
        priority, scheduled_at, attempt_count, max_attempts, locked_by, lease_token,
        locked_until, created_at, updated_at, started_at, completed_at
      )
      select
        'benchmark-run-' || value,
        'benchmark',
        'task',
        case when value % 10 = 0 then 'other-task' else 'benchmark-task' end,
        '1',
        status,
        jsonb_build_object('value', value),
        '{}',
        value % 10,
        case
          when status = 'pending' and value % 100 >= 88 then now() + interval '1 day'
          else now() - ((value % 86400) + 1) * interval '1 second'
        end,
        case when status in ('completed', 'running') then 1 else 0 end,
        3,
        case when status = 'running' then 'expired-worker' end,
        case when status = 'running' then 'expired-lease-' || value end,
        case when status = 'running' then now() - interval '1 minute' end,
        now() - ((value % 86400) + 1) * interval '1 second',
        case
          when status = 'completed' then now() - ((value % 60) + 31) * interval '1 day'
          else now() - ((value % 86400) + 1) * interval '1 second'
        end,
        case when status in ('completed', 'running') then now() - interval '1 hour' end,
        case when status = 'completed' then now() - ((value % 60) + 31) * interval '1 day' end
      from generated
    `,
    [count]
  );
  await adapter.pool.query(`
    insert into durlo_attempts (
      id, run_id, kind, attempt_number, status, worker_id, lease_token, started_at, completed_at
    )
    select
      'benchmark-attempt-' || id,
      id,
      'run',
      1,
      case when id = 'benchmark-run-1' then 'failed' else 'succeeded' end,
      'benchmark-worker',
      null,
      created_at,
      updated_at
    from durlo_runs
    where status = 'completed'
  `);
  await adapter.pool.query(`
    insert into durlo_attempts (
      id, run_id, kind, attempt_number, status, worker_id, started_at, completed_at
    ) values
      ('benchmark-attempt-extra-2', 'benchmark-run-1', 'run', 2, 'timed_out',
       'benchmark-worker', now() - interval '2 hours', now() - interval '2 hours'),
      ('benchmark-attempt-extra-3', 'benchmark-run-1', 'run', 3, 'stalled',
       'benchmark-worker', now() - interval '1 hour', now() - interval '1 hour')
  `);
  await adapter.pool.query(`
    insert into durlo_timers (id, run_id, step_id, fire_at, status, created_at)
    select
      'benchmark-timer-' || id,
      id,
      'sleep',
      now() - ((priority + 1) * interval '1 minute'),
      'pending',
      created_at
    from durlo_runs
    where status = 'sleeping'
  `);
  await adapter.pool.query(`
    insert into durlo_timers (
      id, run_id, step_id, fire_at, status, created_at, fired_at
    )
    select
      'benchmark-fired-timer-' || id,
      id,
      'historical-sleep',
      completed_at - interval '1 hour',
      'fired',
      created_at,
      completed_at
    from durlo_runs
    where status = 'completed'
  `);
  await adapter.pool.query("analyze");
}

function median(values: number[]): number {
  return values[Math.floor(values.length / 2)]!;
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`${name} must be a positive integer`);
}

function positiveNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  throw new Error(`${name} must be a positive number`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
