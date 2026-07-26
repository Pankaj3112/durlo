import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

const adapter = postgresAdapter({ connectionString: "postgres://unused" });
const durlo = new Durlo({ id: "type-test", adapter });

void durlo.transaction(async ({ client }) => {
  await client.query<{ answer: number }>("select 42 as answer");
});

if (false) {
  // @ts-expect-error The unsafe caller-supplied transaction API was removed.
  durlo.tx(adapter.pool);
}
