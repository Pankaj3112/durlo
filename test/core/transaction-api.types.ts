import { Durlo } from "@durlo/core";
import { PostgresAdapter, postgresAdapter } from "@durlo/postgres";

const adapter = postgresAdapter({ connectionString: "postgres://unused" });
const durlo = new Durlo({ id: "type-test", adapter });

void durlo.transaction(async ({ client }) => {
  await client.query<{ answer: number }>("select 42 as answer");
});

function assertLegacyApiRemoved() {
  // @ts-expect-error The unsafe caller-supplied transaction API was removed.
  durlo.tx(adapter.pool);
  // @ts-expect-error The internal bound-client constructor path is not public.
  new PostgresAdapter({ pool: adapter.pool }, { query: async () => ({ rows: [] }) });
}

void assertLegacyApiRemoved;
