# Durlo

Durlo is a TypeScript library for durable tasks and direct workflows in applications that already
use PostgreSQL. It runs in normal Node.js processes and provides retries, delays, workflow
checkpoints, durable sleeps, cancellation, manual retry, and local inspection without requiring a
separate queue service.

## Project status

Durlo is pre-release. The execution foundation is substantial, but input handling, public API
cleanup, package metadata, and the production operating surface still have release-blocking work
tracked in the [roadmap](docs/ROADMAP.md). The packages remain at
`0.0.0`; do not treat the current repository as a supported production release.

The intended v1 scope is deliberately narrow:

- direct task enqueue and workflow start
- PostgreSQL persistence
- Node.js workers
- retries, delays, durable workflow steps, and sleeps
- cancellation, manual retry, and bounded retention cleanup
- raw `pg` transaction-bound run creation
- a local CLI and dashboard

V1 does not include events, cron, hosted orchestration, other languages, framework adapters, or
distributed concurrency and rate limiting.

## Run the repository locally

You need Node.js 22 through 26, pnpm 11, Docker, and PostgreSQL 14 through 18. From a clone:

```bash
pnpm install --frozen-lockfile
pnpm test:unit
pnpm test:local
```

`test:local` creates and removes a disposable PostgreSQL 17 container. It runs the database-backed
suite, packed crash-and-resume quickstart, and both reference applications. It does not require a
VPS or access to another repository.

To explore one application manually, use the
[crash-and-resume example](examples/quickstart/README.md), the
[webhook relay](examples/webhook-relay/README.md), or the
[catalog import](examples/catalog-import/README.md).

## API shape

```ts
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

const adapter = postgresAdapter({ connectionString: process.env.DATABASE_URL! });
const durlo = new Durlo({ id: "billing", adapter });

const sendInvoice = durlo.task({
  id: "send-invoice",
  version: "1",
  run: async (input: { invoiceId: string }, { signal }) => {
    await deliverInvoice(input.invoiceId, signal);
  }
});

const run = await sendInvoice.enqueue(
  { invoiceId: "inv_42" },
  { idempotencyKey: "invoice:inv_42" }
);
```

To commit application data and durable work atomically, use Durlo's raw-`pg` transaction callback:

```ts
const run = await durlo.transaction(async ({ client, enqueue }) => {
  await client.query("insert into invoices (id) values ($1)", ["inv_42"]);
  return enqueue(sendInvoice, { invoiceId: "inv_42" }, { idempotencyKey: "invoice:inv_42" });
});
```

Durlo acquires and releases one client and owns `BEGIN`, `COMMIT`, and `ROLLBACK`. The callback's
query surface and creation operations use that same client. Raw `pg` is the only transaction
integration in v1.

Calling `enqueue` or `workflow.start` only persists work. A separately running worker must register
the matching definition and version before it can execute the run.

## Execution honesty

Durlo is at-least-once. A worker can perform an external side effect and die before recording
success, so emails, payments, webhooks, and similar effects need business-level or provider
idempotency. A Durlo idempotency key deduplicates run creation while its run row exists; it does not
make execution exactly once.

Workflow code re-enters from the top after retry, crash recovery, or sleep. Completed
`step.run(...)` results are reused. Branching should depend on input or stored step results, and step
ids must remain stable.

The [execution semantics](docs/EXECUTION_SEMANTICS.md) document describes current behavior and
known limitations. It is intentionally more conservative than the roadmap.

## CLI and local dashboard

`@durlo/cli` provides:

- `durlo init` to scaffold `durlo.config.ts`
- `durlo migrate` to apply migrations
- `durlo worker` to run registered definitions
- `durlo dev` to migrate, run a worker, and serve the local dashboard

The dashboard binds to `127.0.0.1:3210` by default. It has no authentication and exposes payloads
plus cancel/retry controls. Keep it on loopback or place it behind an authenticated trusted proxy.
It is not a production control plane.

## Documentation

- [Roadmap](docs/ROADMAP.md) — what to build, in order
- [Architecture](docs/ARCHITECTURE.md) — how the repository works today
- [Execution semantics](docs/EXECUTION_SEMANTICS.md) — public behavior and known limitations
- [Operations](docs/OPERATIONS.md) — PostgreSQL, workers, migrations, monitoring, and cleanup
- [Decisions and edge cases](docs/DECISIONS_AND_EDGE_CASES.md) — durable product decisions

Package and source types remain the final authority when documentation and code disagree.

## Contributor verification

```bash
pnpm test:unit             # pure core and CLI tests
pnpm test:local            # default disposable-Postgres suite
pnpm test:audit            # complete release-candidate audit
pnpm benchmark:local       # query-plan regression benchmark
```

The audit adds formatting, lint, typechecking, builds, packed ESM/CommonJS/TypeScript consumers,
mutation checks, restricted-role tests, contention stress, and persistence-safety mutations. The
query benchmark is a selector regression check, not a production throughput claim.
