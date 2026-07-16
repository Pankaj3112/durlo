import { adapter } from "./durlo.js";

try {
  await adapter.migrate();
  await adapter.pool.query(`
    create table if not exists webhook_relay_deliveries (
      id text primary key,
      run_id text unique,
      destination_url text not null,
      payload jsonb not null,
      status text not null check (status in ('queued', 'delivering', 'retrying', 'delivered', 'cancelled')),
      response_status integer,
      response_body text,
      attempt_count integer not null default 0,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      delivered_at timestamptz
    )
  `);
  await adapter.pool.query(
    "alter table webhook_relay_deliveries drop constraint if exists webhook_relay_deliveries_run_id_fkey"
  );
  process.stdout.write("webhook relay migrations applied\n");
} finally {
  await adapter.close();
}
