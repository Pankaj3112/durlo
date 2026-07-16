import { randomUUID } from "node:crypto";
import { adapter, durlo, orderWorkflow } from "./durlo.js";

const orderId = randomUUID();
const client = await adapter.pool.connect();

try {
  await client.query(`
    create table if not exists quickstart_orders (
      id text primary key,
      customer_email text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists quickstart_effects (
      run_id text not null,
      effect_key text not null,
      detail text not null,
      created_at timestamptz not null default now(),
      primary key (run_id, effect_key)
    );
    create table if not exists quickstart_courier_attempts (
      run_id text primary key,
      attempt_count integer not null
    );
  `);

  await client.query("begin");
  await client.query("insert into quickstart_orders (id, customer_email) values ($1, $2)", [
    orderId,
    "ada@example.com"
  ]);
  const handle = await durlo
    .tx(client)
    .start(orderWorkflow, { orderId }, { idempotencyKey: `order:${orderId}` });
  await client.query("commit");

  process.stdout.write(`ORDER_ID=${orderId}\n`);
  process.stdout.write(`RUN_ID=${handle.id}\n`);
  process.stdout.write("Business row and workflow run committed in one Postgres transaction.\n");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await adapter.close();
}
