import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres restricted role", () => {
  let admin: PostgresAdapter;

  beforeAll(() => {
    admin = postgresAdapter({ connectionString: databaseUrl! });
  });

  afterAll(async () => {
    await admin.close();
  });

  it("migrates and executes using a schema-owner role without superuser privileges", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const role = `durlo_role_${suffix}`;
    const schema = `durlo_schema_${suffix}`;
    const password = `durlo_password_${suffix}`;
    const roleUrl = new URL(databaseUrl!);
    roleUrl.username = role;
    roleUrl.password = password;
    let roleAdapter: PostgresAdapter | undefined;

    try {
      await admin.pool.query(
        `create role ${quoteIdentifier(role)} login nosuperuser nocreatedb nocreaterole password ${quoteLiteral(password)}`
      );
      await admin.pool.query(
        `create schema ${quoteIdentifier(schema)} authorization ${quoteIdentifier(role)}`
      );

      roleAdapter = postgresAdapter({
        connectionString: roleUrl.toString(),
        options: `-c search_path=${schema}`
      });
      await roleAdapter.migrate();
      const durlo = new Durlo({ id: "restricted-role", adapter: roleAdapter });
      const task = durlo.task({ id: "owned-schema-task", run: async () => "completed" });
      const handle = await task.enqueue({});
      await durlo.worker({ tasks: [task], workerId: "restricted-worker" }).runOnce();

      expect(await roleAdapter.getRun(handle.id)).toMatchObject({
        status: "completed",
        output: "completed"
      });
      const privileges = await admin.pool.query<{ is_superuser: boolean }>(
        "select rolsuper as is_superuser from pg_roles where rolname = $1",
        [role]
      );
      expect(privileges.rows).toEqual([{ is_superuser: false }]);
    } finally {
      await roleAdapter?.close();
      await admin.pool.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
      await admin.pool.query(`drop role if exists ${quoteIdentifier(role)}`);
    }
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
