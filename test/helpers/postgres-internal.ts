import {
  PostgresAdapter as PublicPostgresAdapter,
  migrations,
  postgresAdapter as createPublicPostgresAdapter
} from "@durlo/postgres";
import type { PostgresAdapterOptions, PostgresTransactionClient } from "@durlo/postgres";
import type { PostgresAdapter as InternalPostgresAdapter } from "../../packages/postgres/src/adapter.js";

export type PostgresAdapter = InternalPostgresAdapter;
export type { PostgresAdapterOptions, PostgresTransactionClient };
export { migrations };

export const PostgresAdapter = PublicPostgresAdapter as unknown as {
  new (options: PostgresAdapterOptions): InternalPostgresAdapter;
};

export const postgresAdapter = createPublicPostgresAdapter as unknown as (
  options: PostgresAdapterOptions
) => InternalPostgresAdapter;
