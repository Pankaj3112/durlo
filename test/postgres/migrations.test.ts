import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrations, postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

const releasedMigrationChecksums = {
  "0001_initial": "133725b6760c494097d1d04d3ffd372c8f994a4dbdc06affe3cf761c55acd2cf",
  "0002_resource_versions": "fa54ae3a3ccae6526a96151871bef1768b0f75dbf4ef1a8ca973d2e0c41a79fa",
  "0003_retention_cleanup": "031e38f84bfaa30a93e58fc87de0b626dcd74603db82034bed49bacab87288f8",
  "0004_observability_reads": "bfd9dd7605c9a2997bef6c568ab0f355c2f1779dddbc58fd910ed3a4c7a612cb",
  "0005_truthful_step_interruptions":
    "135660d92c76d4d3f77479391fc3f4c09faa7fd2f2a0dcc549d39a95a694118e",
  "0006_serialization_versions": "50d11fb5e2a3d728a1bbb44f492da7c044386078ca29ec2865eeec58dc2e4b5b"
} as const;

describe("@durlo/postgres migration immutability", () => {
  it("keeps every released migration byte-for-byte unchanged", () => {
    for (const [version, expected] of Object.entries(releasedMigrationChecksums)) {
      const migration = migrations.find((candidate) => candidate.version === version);
      expect(migration, `${version} must remain available`).toBeDefined();
      expect(createHash("sha256").update(migration!.sql).digest("hex"), version).toBe(expected);
    }
  });
});

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres migrations", () => {
  let admin: PostgresAdapter;
  const schemas = new Set<string>();

  beforeAll(() => {
    admin = postgresAdapter({ connectionString: databaseUrl! });
  });

  afterEach(async () => {
    for (const schema of schemas) {
      await admin.pool.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
    }
    schemas.clear();
  });

  afterAll(async () => {
    await admin.close();
  });

  it("migrates a fresh schema concurrently and records each version once", async () => {
    const schema = await createSchema();
    const adapters = Array.from({ length: 5 }, () => schemaAdapter(schema));
    try {
      await Promise.all(adapters.map((adapter) => adapter.migrate()));
      const versions = await admin.pool.query<{ version: string; count: string }>(
        `select version, count(*)::text as count
         from ${quoteIdentifier(schema)}.durlo_schema_migrations
         group by version order by version`
      );
      expect(versions.rows).toEqual([
        { version: "0001_initial", count: "1" },
        { version: "0002_resource_versions", count: "1" },
        { version: "0003_retention_cleanup", count: "1" },
        { version: "0004_observability_reads", count: "1" },
        { version: "0005_truthful_step_interruptions", count: "1" },
        { version: "0006_serialization_versions", count: "1" },
        { version: "0007_idempotency_comparison_metadata", count: "1" },
        { version: "0008_idempotency_metadata_presence", count: "1" }
      ]);

      const tables = await admin.pool.query<{ count: string }>(
        `select count(*)::text as count from information_schema.tables
         where table_schema = $1 and table_name like 'durlo_%'`,
        [schema]
      );
      expect(tables.rows[0]?.count).toBe("5");
    } finally {
      await Promise.all(adapters.map((adapter) => adapter.close()));
    }
  });

  it("upgrades a 0001 schema without changing existing run compatibility", async () => {
    const schema = await createSchema();
    const adapter = schemaAdapter(schema);
    try {
      await adapter.pool.query(migrations[0]!.sql);
      await adapter.pool.query(`
        create table durlo_schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await adapter.pool.query(
        "insert into durlo_schema_migrations (version) values ('0001_initial')"
      );
      await adapter.pool.query(`
        insert into durlo_runs (
          id, app_id, kind, resource_id, status, input_json, options_json
        ) values ('legacy-run', 'legacy-app', 'workflow', 'legacy-workflow', 'pending', '{}', '{}')
      `);

      await adapter.migrate();

      const run = await adapter.pool.query<{ resource_version: string }>(
        "select resource_version from durlo_runs where id = 'legacy-run'"
      );
      expect(run.rows).toEqual([{ resource_version: "1" }]);
      const versions = await adapter.pool.query<{ version: string }>(
        "select version from durlo_schema_migrations order by version"
      );
      expect(versions.rows).toEqual([
        { version: "0001_initial" },
        { version: "0002_resource_versions" },
        { version: "0003_retention_cleanup" },
        { version: "0004_observability_reads" },
        { version: "0005_truthful_step_interruptions" },
        { version: "0006_serialization_versions" },
        { version: "0007_idempotency_comparison_metadata" },
        { version: "0008_idempotency_metadata_presence" }
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("upgrades a 0002 schema by adding the retention index", async () => {
    const schema = await createSchema();
    const adapter = schemaAdapter(schema);
    try {
      await adapter.pool.query(migrations[0]!.sql);
      await adapter.pool.query(migrations[1]!.sql);
      await adapter.pool.query(`
        create table durlo_schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await adapter.pool.query(
        `insert into durlo_schema_migrations (version)
         values ('0001_initial'), ('0002_resource_versions')`
      );

      await adapter.migrate();

      const retentionIndex = await adapter.pool.query<{ index_name: string | null }>(
        "select to_regclass('durlo_runs_retention_idx')::text as index_name"
      );
      expect(retentionIndex.rows[0]?.index_name).toBe("durlo_runs_retention_idx");
      const versions = await adapter.pool.query<{ version: string }>(
        "select version from durlo_schema_migrations order by version"
      );
      expect(versions.rows).toEqual([
        { version: "0001_initial" },
        { version: "0002_resource_versions" },
        { version: "0003_retention_cleanup" },
        { version: "0004_observability_reads" },
        { version: "0005_truthful_step_interruptions" },
        { version: "0006_serialization_versions" },
        { version: "0007_idempotency_comparison_metadata" },
        { version: "0008_idempotency_metadata_presence" }
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("upgrades a 0003 schema with indexed observability reads", async () => {
    const schema = await createSchema();
    const adapter = schemaAdapter(schema);
    try {
      for (const migration of migrations.slice(0, 3)) {
        await adapter.pool.query(migration.sql);
      }
      await adapter.pool.query(`
        create table durlo_schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await adapter.pool.query(
        `insert into durlo_schema_migrations (version)
         values ('0001_initial'), ('0002_resource_versions'), ('0003_retention_cleanup')`
      );

      await adapter.migrate();

      const indexes = await adapter.pool.query<{ index_name: string }>(
        `select indexname as index_name
         from pg_indexes
         where schemaname = current_schema()
           and indexname = any($1::text[])
         order by indexname`,
        [
          [
            "durlo_runs_active_health_idx",
            "durlo_runs_list_idx",
            "durlo_runs_resource_list_idx",
            "durlo_runs_status_list_idx",
            "durlo_timers_run_idx"
          ]
        ]
      );
      expect(indexes.rows.map(({ index_name }) => index_name)).toEqual([
        "durlo_runs_active_health_idx",
        "durlo_runs_list_idx",
        "durlo_runs_resource_list_idx",
        "durlo_runs_status_list_idx",
        "durlo_timers_run_idx"
      ]);
      const versions = await adapter.pool.query<{ version: string }>(
        "select version from durlo_schema_migrations order by version"
      );
      expect(versions.rows.at(-1)).toEqual({ version: "0008_idempotency_metadata_presence" });
    } finally {
      await adapter.close();
    }
  });

  it("upgrades 0004 history without rewriting active work or completed checkpoints", async () => {
    const schema = await createSchema();
    const adapter = schemaAdapter(schema);
    try {
      for (const migration of migrations.slice(0, 4)) {
        await adapter.pool.query(migration.sql);
      }
      await adapter.pool.query(`
        create table durlo_schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await adapter.pool.query(
        `insert into durlo_schema_migrations (version)
         values ('0001_initial'), ('0002_resource_versions'),
                ('0003_retention_cleanup'), ('0004_observability_reads')`
      );
      await adapter.pool.query(`
        insert into durlo_runs (
          id, app_id, kind, resource_id, status, input_json, options_json,
          attempt_count, max_attempts, locked_by, lease_token, locked_until,
          completed_at, cancelled_at
        ) values
          ('cancelled-run', 'legacy-app', 'workflow', 'legacy', 'cancelled', '{}', '{}',
           1, 3, null, null, null, null, now()),
          ('timed-out-run', 'legacy-app', 'workflow', 'legacy', 'pending', '{}', '{}',
           1, 3, null, null, null, null, null),
          ('stalled-run', 'legacy-app', 'workflow', 'legacy', 'running', '{}', '{}',
           2, 3, 'new-worker', 'stalled-new-lease', now() + interval '1 hour', null, null),
          ('active-run', 'legacy-app', 'workflow', 'legacy', 'running', '{}', '{}',
           1, 3, 'active-worker', 'active-lease', now() + interval '1 hour', null, null),
          ('completed-run', 'legacy-app', 'workflow', 'legacy', 'completed', '{}', '{}',
           2, 3, null, null, null, now(), null)
      `);
      await adapter.pool.query(`
        insert into durlo_steps (
          id, run_id, step_id, status, result_json, attempt_count, started_at, completed_at
        ) values
          ('cancelled-step', 'cancelled-run', 'work', 'running', null, 1, now(), null),
          ('timed-out-step', 'timed-out-run', 'work', 'running', null, 1, now(), null),
          ('stalled-step', 'stalled-run', 'work', 'running', null, 1, now(), null),
          ('active-step', 'active-run', 'work', 'running', null, 1, now(), null),
          ('completed-step', 'completed-run', 'work', 'completed', '"saved"', 2, now(), now())
      `);
      await adapter.pool.query(`
        insert into durlo_attempts (
          id, run_id, step_id, kind, attempt_number, status, worker_id, lease_token,
          error_json, started_at, completed_at
        ) values
          ('cancelled-run-attempt', 'cancelled-run', null, 'run', 1, 'cancelled',
           'old-worker', 'cancelled-lease', null, now() - interval '5 minutes', now() - interval '4 minutes'),
          ('cancelled-step-attempt', 'cancelled-run', 'work', 'step', 1, 'cancelled',
           'old-worker', 'cancelled-lease', null, now() - interval '5 minutes', now() - interval '4 minutes'),
          ('timed-out-run-attempt', 'timed-out-run', null, 'run', 1, 'timed_out',
           'old-worker', 'timed-out-lease', '{"name":"AttemptTimeoutError","message":"timed out"}',
           now() - interval '5 minutes', now() - interval '4 minutes'),
          ('timed-out-step-attempt', 'timed-out-run', 'work', 'step', 1, 'running',
           'old-worker', 'timed-out-lease', null, now() - interval '5 minutes', null),
          ('stalled-run-attempt-old', 'stalled-run', null, 'run', 1, 'stalled',
           'old-worker', 'stalled-old-lease', '{"name":"StalledError","message":"worker lease expired"}',
           now() - interval '5 minutes', now() - interval '4 minutes'),
          ('stalled-step-attempt', 'stalled-run', 'work', 'step', 1, 'running',
           'old-worker', 'stalled-old-lease', null, now() - interval '5 minutes', null),
          ('stalled-run-attempt-new', 'stalled-run', null, 'run', 2, 'running',
           'new-worker', 'stalled-new-lease', null, now() - interval '1 minute', null),
          ('active-run-attempt', 'active-run', null, 'run', 1, 'running',
           'active-worker', 'active-lease', null, now() - interval '1 minute', null),
          ('active-step-attempt', 'active-run', 'work', 'step', 1, 'running',
           'active-worker', 'active-lease', null, now() - interval '1 minute', null),
          ('completed-run-attempt-old', 'completed-run', null, 'run', 1, 'timed_out',
           'old-worker', 'completed-old-lease', '{"name":"AttemptTimeoutError","message":"timed out"}',
           now() - interval '5 minutes', now() - interval '4 minutes'),
          ('completed-step-attempt-old', 'completed-run', 'work', 'step', 1, 'running',
           'old-worker', 'completed-old-lease', null, now() - interval '5 minutes', null),
          ('completed-run-attempt-new', 'completed-run', null, 'run', 2, 'succeeded',
           'new-worker', 'completed-new-lease', null, now() - interval '3 minutes', now() - interval '1 minute'),
          ('completed-step-attempt-new', 'completed-run', 'work', 'step', 2, 'succeeded',
           'new-worker', 'completed-new-lease', null, now() - interval '3 minutes', now() - interval '2 minutes')
      `);

      await adapter.migrate();

      const steps = await adapter.pool.query<{
        id: string;
        status: string;
        result_json: unknown;
        error_name: string | null;
        completed: boolean;
      }>(
        `select id, status, result_json, error_json->>'name' as error_name,
                completed_at is not null as completed
         from durlo_steps order by id`
      );
      expect(steps.rows).toEqual([
        {
          id: "active-step",
          status: "running",
          result_json: null,
          error_name: null,
          completed: false
        },
        {
          id: "cancelled-step",
          status: "cancelled",
          result_json: null,
          error_name: null,
          completed: true
        },
        {
          id: "completed-step",
          status: "completed",
          result_json: "saved",
          error_name: null,
          completed: true
        },
        {
          id: "stalled-step",
          status: "stalled",
          result_json: null,
          error_name: "StalledError",
          completed: true
        },
        {
          id: "timed-out-step",
          status: "timed_out",
          result_json: null,
          error_name: "AttemptTimeoutError",
          completed: true
        }
      ]);
      const attempts = await adapter.pool.query<{
        id: string;
        status: string;
        completed: boolean;
      }>(
        `select id, status, completed_at is not null as completed from durlo_attempts
         where kind = 'step' order by id`
      );
      expect(attempts.rows).toEqual([
        { id: "active-step-attempt", status: "running", completed: false },
        { id: "cancelled-step-attempt", status: "cancelled", completed: true },
        { id: "completed-step-attempt-new", status: "succeeded", completed: true },
        { id: "completed-step-attempt-old", status: "timed_out", completed: true },
        { id: "stalled-step-attempt", status: "stalled", completed: true },
        { id: "timed-out-step-attempt", status: "timed_out", completed: true }
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("adds serialization routing without rewriting legacy resource versions", async () => {
    const schema = await createSchema();
    const adapter = schemaAdapter(schema);
    const legacyInput = {
      nested: { $durlo: [2, "date", "2026-01-02T03:04:05.000Z"] }
    };
    try {
      for (const migration of migrations.slice(0, 5)) {
        await adapter.pool.query(migration.sql);
      }
      await adapter.pool.query(`
        create table durlo_schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await adapter.pool.query(
        `insert into durlo_schema_migrations (version)
         values ('0001_initial'), ('0002_resource_versions'),
                ('0003_retention_cleanup'), ('0004_observability_reads'),
                ('0005_truthful_step_interruptions')`
      );
      await adapter.pool.query(
        `insert into durlo_runs (
           id, app_id, kind, resource_id, resource_version, status, input_json, options_json
         ) values ('legacy-codec-run', 'legacy-codec-app', 'task', 'legacy-task',
                   'legacy-v1', 'pending', $1::jsonb, '{}')`,
        [JSON.stringify(legacyInput)]
      );

      await adapter.migrate();

      const raw = await adapter.pool.query<{ resource_version: string }>(
        "select resource_version from durlo_runs where id = 'legacy-codec-run'"
      );
      expect(raw.rows).toEqual([{ resource_version: "legacy-v1" }]);
      expect(
        await adapter.getRun({ appId: "legacy-codec-app", runId: "legacy-codec-run" })
      ).toMatchObject({ resourceVersion: "legacy-v1", input: legacyInput });

      await expect(
        adapter.pool.query(
          `insert into durlo_runs (
             id, app_id, kind, resource_id, resource_version, status, input_json, options_json
           ) values ('v2-codec-run', 'legacy-codec-app', 'task', 'v2-task',
                     ' @durlo/serialization/2:v2', 'pending', '{}', '{}')`
        )
      ).resolves.toMatchObject({ rowCount: 1 });
      expect(
        await adapter.getRun({ appId: "legacy-codec-app", runId: "v2-codec-run" })
      ).toMatchObject({ resourceVersion: "v2" });
    } finally {
      await adapter.close();
    }
  });

  it("rolls back migration bookkeeping after a schema conflict and can recover", async () => {
    const schema = await createSchema();
    await admin.pool.query(`create table ${quoteIdentifier(schema)}.durlo_runs (broken integer)`);
    const adapter = schemaAdapter(schema);
    try {
      await expect(adapter.migrate()).rejects.toThrow(/durlo_runs|already exists/i);
      const migrationTable = await admin.pool.query<{ table_name: string | null }>(
        "select to_regclass($1)::text as table_name",
        [`${schema}.durlo_schema_migrations`]
      );
      expect(migrationTable.rows[0]?.table_name).toBeNull();

      await admin.pool.query(`drop table ${quoteIdentifier(schema)}.durlo_runs`);
      await expect(adapter.migrate()).resolves.toBeUndefined();
      const applied = await admin.pool.query<{ count: string }>(
        `select count(*)::text as count
         from ${quoteIdentifier(schema)}.durlo_schema_migrations`
      );
      expect(applied.rows[0]?.count).toBe("8");
    } finally {
      await adapter.close();
    }
  });

  async function createSchema(): Promise<string> {
    const schema = `durlo_migration_${randomUUID().replaceAll("-", "")}`;
    schemas.add(schema);
    await admin.pool.query(`create schema ${quoteIdentifier(schema)}`);
    return schema;
  }

  function schemaAdapter(schema: string): PostgresAdapter {
    return postgresAdapter({
      connectionString: databaseUrl!,
      options: `-c search_path=${schema}`
    });
  }
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
