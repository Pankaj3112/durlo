# Durlo

[![CI](https://github.com/Pankaj3112/durlo/actions/workflows/ci.yml/badge.svg)](https://github.com/Pankaj3112/durlo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@durlo/core?label=%40durlo%2Fcore)](https://www.npmjs.com/package/@durlo/core)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Durlo is a TypeScript library for durable background tasks and workflows backed by PostgreSQL.

Use it when a job must survive a restart, retry later, wait for hours, or be created in the same
transaction as your application data. Workers are ordinary Node.js processes. Durlo does not need
Redis, a separate queue, or a hosted orchestration service.

> **Alpha:** `0.1.0-alpha.1` is for evaluation and integration. This is not a production-support promise
> or SLA.

## What it handles

- Background tasks with retries, timeouts, cancellation, and attempt history
- Sequential workflows with durable steps and sleeps
- Atomic application writes and run creation in one PostgreSQL transaction
- Crash recovery through leases, heartbeats, and fenced writes
- Local inspection through the included CLI and dashboard

Durlo is a good fit for payment follow-ups, webhook delivery, imports, and other application-owned
work that cannot disappear after an API process exits.

## Install

```bash
npm install @durlo/core@0.1.0-alpha.1 @durlo/postgres@0.1.0-alpha.1 \
  @durlo/cli@0.1.0-alpha.1 pg
```

Durlo supports Node.js 22 through 26 and PostgreSQL 14 through 18.

## Tasks

```ts
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

const adapter = postgresAdapter({ connectionString: process.env.DATABASE_URL! });
const durlo = new Durlo({ id: "billing", adapter });

export const sendInvoice = durlo.task({
  id: "send-invoice",
  version: "1",
  run: async (input: { invoiceId: string }, { signal }) => {
    await deliverInvoice(input.invoiceId, signal);
  }
});
```

Enqueue it from your application:

```ts
await sendInvoice.enqueue(
  { invoiceId: "inv_42" },
  { idempotencyKey: "invoice:inv_42" }
);
```

## Workflows

A workflow breaks longer jobs into checkpointed steps. Durlo reuses recorded step results after a
crash, and sleeps do not hold a worker open.

```ts
export const fulfillOrder = durlo.workflow<
  { orderId: string },
  { trackingId: string }
>({
  id: "fulfill-order",
  version: "1",
  run: async ({ input, step }) => {
    const order = await step.run("load-order", () => loadOrder(input.orderId));
    await step.run("reserve-stock", () => reserveStock(order));
    await step.sleep("packing-window", "2h");
    return step.run("book-courier", () => bookCourier(order));
  }
});

await fulfillOrder.start({ orderId: "ord_42" });
```

Register both definitions in a worker process:

```ts
const worker = durlo.worker({
  tasks: [sendInvoice],
  workflows: [fulfillOrder]
});
await worker.start();
```

`enqueue()` and `start()` only persist work. The worker executes it.

## Commit data and work together

Durlo can create a run in the same transaction as your application write:

```ts
await durlo.transaction(async ({ client, enqueue }) => {
  await client.query("insert into invoices (id) values ($1)", ["inv_42"]);

  return enqueue(
    sendInvoice,
    { invoiceId: "inv_42" },
    { idempotencyKey: "invoice:inv_42" }
  );
});
```

If the transaction fails, neither the invoice nor the task is committed. This avoids the gap where
application data is saved but its background work is lost.

## Execution model

Durlo provides **at-least-once** execution. A handler may complete an external side effect and crash
before Durlo records success, so payments, emails, and HTTP calls still need a business or provider
idempotency key. Durlo's idempotency key deduplicates run creation, not execution.

Workflow functions re-enter from the top after recovery. Completed `step.run(...)` calls reuse their
stored result, while `step.sleep(...)` persists its timer. Keep step ids stable and calls sequential.

V1 focuses on direct tasks and sequential workflows on PostgreSQL. It does not include events, cron,
framework adapters, distributed concurrency, rate limiting, or other storage engines.

## Next steps

- Follow the [clean quickstart](examples/quickstart/README.md) to run PostgreSQL, a worker, crash
  recovery, and the dashboard.
- See the [webhook relay](examples/webhook-relay/README.md) and
  [catalog import](examples/catalog-import/README.md) examples.
- Read the [execution semantics](docs/EXECUTION_SEMANTICS.md),
  [operations guide](docs/OPERATIONS.md), and [architecture](docs/ARCHITECTURE.md).

## Development

```bash
pnpm install --frozen-lockfile
pnpm test:unit
pnpm test:local
```

See [Contributing](CONTRIBUTING.md) before opening a change.

MIT licensed. See [LICENSE](LICENSE).
