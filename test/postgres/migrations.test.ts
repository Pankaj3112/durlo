import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrations, postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

const releasedMigrationChecksums = {
  "0001_initial": "133725b6760c494097d1d04d3ffd372c8f994a4dbdc06affe3cf761c55acd2cf",
  "0002_resource_versions": "fa54ae3a3ccae6526a96151871bef1768b0f75dbf4ef1a8ca973d2e0c41a79fa",
  "0003_retention_cleanup": "031e38f84bfaa30a93e58fc87de0b626dcd74603db82034bed49bacab87288f8"
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
        { version: "0003_retention_cleanup", count: "1" }
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
        { version: "0003_retention_cleanup" }
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
        { version: "0003_retention_cleanup" }
      ]);
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
      expect(applied.rows[0]?.count).toBe("3");
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
