# Durlo

[![CI](https://github.com/Pankaj3112/durlo/actions/workflows/ci.yml/badge.svg)](https://github.com/Pankaj3112/durlo/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@durlo/core?label=%40durlo%2Fcore)](https://www.npmjs.com/package/@durlo/core)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Postgres-native durable tasks and direct workflows for TypeScript applications.

Durlo stores work in the PostgreSQL database your application already uses, runs handlers in
ordinary Node.js worker processes, and makes the important failure modes inspectable. It is a small
library rather than a hosted queue or orchestration service.

> **Status:** `0.1.0-alpha.1` is an installable preview. It is useful for evaluation and integration
> work, but is not a production-support promise, SLA, or measured operating envelope.

## Why Durlo

- **Atomic creation:** commit application data and a task or workflow run in one raw `pg`
  transaction.
- **Durable workflows:** checkpoint sequential steps and sleeps so a restarted worker can resume.
- **Honest recovery:** lease-token fencing, retries, cancellation, manual retry, and retained
  attempt history make at-least-once behavior visible.
- **Postgres-native:** no queue service, event bus, cron system, or hosted control plane is required.
- **Local-first operations:** migrations, workers, and a loopback-only inspection dashboard are
  included in `@durlo/cli`.

Durlo v1 is intentionally narrow: direct tasks, sequential workflows, PostgreSQL, and Node.js.
Events, cron, framework adapters, hosted orchestration, distributed concurrency, rate limiting,
fan-out/fan-in, and additional storage engines are out of scope.

## Install

Install the three packages at the same version:

```bash
npm install @durlo/core@0.1.0-alpha.1 @durlo/postgres@0.1.0-alpha.1 \
  @durlo/cli@0.1.0-alpha.1 pg
```

| Package | What it provides |
| --- | --- |
| [`@durlo/core`](packages/core/README.md) | Definitions, run creation, workers, workflow tools, reads, controls, and types |
| [`@durlo/postgres`](packages/postgres/README.md) | PostgreSQL persistence and ordered schema migrations |
| [`@durlo/cli`](packages/cli/README.md) | `init`, `migrate`, `worker`, `dev`, and the local dashboard |

Supported alpha installation/runtime boundaries are:

- Node.js 22 through 26
- PostgreSQL 14 through 18
- ESM, CommonJS, and strict TypeScript consumers

These boundaries are compatibility statements, not a production support commitment.

## A small task

Define a task in the application package and register the same definition in a worker process:

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

// In an application/API process:
const creation = await sendInvoice.enqueue(
  { invoiceId: "inv_42" },
  { idempotencyKey: "invoice:inv_42" }
);

// In a separately running worker process:
const worker = durlo.worker({ tasks: [sendInvoice] });
await worker.start();
```

Creating a run only persists it. A worker must register the exact task or workflow id and version
before it can execute the run. Use `await durlo.runs.wait(creation.run)` when the producer needs a
typed terminal result.

## The transaction boundary

Durlo’s main differentiator is transactional creation. The callback owns one raw `pg` client and
binds application SQL and durable work to the same `BEGIN`/`COMMIT`:

```ts
const creation = await durlo.transaction(async ({ client, enqueue }) => {
  await client.query("insert into invoices (id) values ($1)", ["inv_42"]);
  return enqueue(
    sendInvoice,
    { invoiceId: "inv_42" },
    { idempotencyKey: "invoice:inv_42" }
  );
});
```

If the callback fails, neither the application row nor the run is committed. Raw `pg` is the only
transaction integration in v1. A caller-supplied pool is borrowed; a pool created from connection
configuration is owned by the adapter.

## The guarantee to design around

Durlo is **at-least-once**, not exactly-once. A worker can perform an external effect and crash before
recording success. Emails, payments, webhooks, and other side effects need a business or provider
idempotency key. A Durlo idempotency key deduplicates run creation while its row exists; it does not
deduplicate execution.

Workflow code re-enters from the top after retry, crash recovery, or sleep. `step.run(...)` reuses a
completed checkpoint, and `step.sleep(...)` persists a timer. Keep step ids stable and base branching
on input or stored step results.

## Try it

The [clean quickstart](examples/quickstart/README.md) installs the published packages into a new
directory and demonstrates atomic creation, a separate worker, crash recovery, retry, and dashboard
inspection. It requires Node.js, npm, Docker, and `curl`.

The reference applications show larger shapes:

| Example | Demonstrates |
| --- | --- |
| [Webhook relay](examples/webhook-relay/README.md) | Transactional task creation, HTTP retry, provider idempotency, cancellation, and manual retry |
| [Catalog import](examples/catalog-import/README.md) | Transactional workflow creation, checkpoints, durable sleep, cancellation, versioning, and recovery |

## Work on the repository

Requirements: Node.js 22–26, pnpm 11, Docker, and PostgreSQL 14–18 for database-backed tests.

```bash
pnpm install --frozen-lockfile
pnpm test:unit
pnpm test:local
```

`test:local` creates and removes a disposable PostgreSQL 17 container. Useful checks for a change
are:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:audit
git diff --check
```

See [Contributing](CONTRIBUTING.md) for the repository contract and verification expectations.

## Project policies

Durlo is released under the [MIT License](LICENSE). Please read [Contributing](CONTRIBUTING.md)
before opening a change. The project does not infer maintainer contact details or promise a support
SLA.
