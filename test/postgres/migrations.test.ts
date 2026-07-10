import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

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
      expect(versions.rows).toEqual([{ version: "0001_initial", count: "1" }]);

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
      expect(applied.rows[0]?.count).toBe("1");
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
