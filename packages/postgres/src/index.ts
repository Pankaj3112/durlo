import type { Pool } from "pg";
import {
  PostgresAdapter as InternalPostgresAdapter,
  type PostgresAdapterOptions
} from "./adapter.js";

export type { PostgresAdapterOptions, PostgresTransactionClient } from "./adapter.js";
export { migrations } from "./migrations.js";

/** The supported PostgreSQL control surface. Execution storage methods stay package-private. */
export interface PostgresAdapter {
  readonly pool: Pool;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export const PostgresAdapter = InternalPostgresAdapter as unknown as {
  new (options: PostgresAdapterOptions): PostgresAdapter;
};

export function postgresAdapter(options: PostgresAdapterOptions): PostgresAdapter {
  return new InternalPostgresAdapter(options);
}
