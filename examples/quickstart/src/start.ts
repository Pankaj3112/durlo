import { randomUUID } from "node:crypto";
import { adapter, durlo, orderWorkflow, recordOrderCreatedTask } from "./durlo.js";

const orderId = randomUUID();

try {
  await adapter.pool.query(`
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

  const creation = await durlo.transaction(async (transaction) => {
    await transaction.client.query(
      "insert into quickstart_orders (id, customer_email) values ($1, $2)",
      [orderId, "ada@example.com"]
    );
    const task = await transaction.enqueue(
      recordOrderCreatedTask,
      { orderId },
      { idempotencyKey: `order-created:${orderId}` }
    );
    const workflow = await transaction.start(
      orderWorkflow,
      { orderId },
      { idempotencyKey: `order:${orderId}` }
    );
    return { task, workflow };
  });

  process.stdout.write(`ORDER_ID=${orderId}\n`);
  process.stdout.write(`TASK_RUN_ID=${creation.task.run.id}\n`);
  process.stdout.write(`RUN_ID=${creation.workflow.run.id}\n`);
  process.stdout.write(
    "Business row, task run, and workflow run committed in one Postgres transaction.\n"
  );
} finally {
  await adapter.close();
}
