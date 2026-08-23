# Durlo

Durlo is a TypeScript library for durable tasks and direct workflows in applications that already
use PostgreSQL. It runs in normal Node.js processes and provides retries, delays, workflow
checkpoints, durable sleeps, cancellation, manual retry, and local inspection without requiring a
separate queue service.

## Project status

Durlo `0.1.0-alpha.0` is the first pre-release. It is suitable for evaluating the public contract
and failure model, not for making production-readiness or support assumptions. The compatibility
matrix below is an installation/runtime statement, not a production-support promise, SLA, or
measured operating envelope. See the [roadmap](docs/ROADMAP.md) for the work still required before
beta and `1.0`.

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

## Installation

Install the exact alpha versions together:

```bash
npm install @durlo/core@0.1.0-alpha.0 @durlo/postgres@0.1.0-alpha.0 \
  @durlo/cli@0.1.0-alpha.0 pg
```

| Package           | Role                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `@durlo/core`     | Definitions, creation, workers, workflow tools, reads, controls, types     |
| `@durlo/postgres` | PostgreSQL persistence, transactions, and ordered schema migrations        |
| `@durlo/cli`      | Config scaffolding, migrations, workers, and loopback-only local dashboard |

| Consumer/runtime | Alpha compatibility                  |
| ---------------- | ------------------------------------ |
| Node.js          | 22 through 26                        |
| PostgreSQL       | 14 through 18                        |
| Modules/types    | ESM, CommonJS, and strict TypeScript |

All three packages use one version and are released together. Package-specific installation,
minimal usage, requirements, and exports are documented in
[`@durlo/core`](packages/core/README.md), [`@durlo/postgres`](packages/postgres/README.md), and
[`@durlo/cli`](packages/cli/README.md).

## Published-package quickstart

The [clean `0.1.0-alpha.0` quickstart](examples/quickstart/README.md) starts PostgreSQL, installs the
three exact versions from the public npm registry, applies migrations, and downloads only the
example application files from the matching immutable tag. It then proves atomic application/task/
workflow creation, a separately running worker, forced worker termination and lease recovery,
automatic retry, checkpoint reuse, and dashboard inspection, with explicit cleanup and security
limitations.

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
[published-package quickstart](examples/quickstart/README.md), the
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

const creation = await sendInvoice.enqueue(
  { invoiceId: "inv_42" },
  { idempotencyKey: "invoice:inv_42" }
);

const result = await durlo.runs.wait(creation.run, { timeout: "30s" });
```

`runs.wait(handle, { signal?, timeout? })` preserves the handle's output type. It resolves `void`
handlers to JavaScript `undefined` and actual JSON `null` to `null`; terminal failures reject with
`RunFailedError`, cancellation with `RunCancelledError`, missing or cleaned-up rows with
`RunNotFoundError`, and an elapsed wait timeout with `RunWaitTimeoutError`.

With a Standard Schema, the creation input and handler input can be different. Durlo validates the
external value once, persists the transformed output, and passes that output directly to the worker:

```ts
import type { StandardSchema } from "@durlo/core";

type InvoiceRequest = { invoiceId: string };
type InvoiceInput = { invoiceId: string; normalized: true };

const invoiceSchema: StandardSchema<InvoiceRequest, InvoiceInput> = {
  "~standard": {
    version: 1,
    vendor: "billing",
    validate: (input) => {
      const request = input as InvoiceRequest;
      return { value: { invoiceId: request.invoiceId.trim(), normalized: true } };
    }
  }
};

const sendNormalizedInvoice = durlo.task({
  id: "send-normalized-invoice",
  schema: invoiceSchema,
  run: async (input: InvoiceInput, { signal }) => {
    await deliverInvoice(input.invoiceId, signal);
  }
});

await sendNormalizedInvoice.enqueue({ invoiceId: " inv_42 " });
```

The persisted transformed shape is part of resource compatibility. If it changes incompatibly,
publish a new definition version and keep workers for the previous version until its active runs
finish.

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

Handlers may throw `PermanentError` to consume the current failure and stop automatic retries, or
`RetryError({ after: "30s" })` / `RetryError({ at: retryAt })` to persist an intentional next retry
time. Directed retries still consume the normal failure budget. Tasks end in `dead_letter` and
workflows in `failed` when permanent or exhausted. Matching names, lookalikes, and subclasses do
not activate these controls.

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

The executable is the supported interface for those commands. `defineConfig` plus the
`DurloConfig` and `DashboardOptions` types are the only supported programmatic `@durlo/cli`
entry-point exports.

The dashboard binds to `127.0.0.1:3210` by default. It has no authentication and exposes payloads
plus cancel/retry controls. Keep it on loopback or place it behind an authenticated trusted proxy.
It is not a production control plane.

## Compatibility policy

Definition `version` values are opaque resource-routing tokens and are independent of package
versions. Change a definition version when persisted inputs, checkpoints, or behavior become
incompatible, and keep matching workers until old active runs finish.

Before `1.0`, documented APIs may break between alpha releases; every break must be called out in
the changelog or migration notes. Beginning with `1.0`, documented runtime and type exports,
configuration, CLI behavior, and supported Node.js/PostgreSQL ranges follow Semantic Versioning.
Breaking changes require a major release, deprecated APIs are removed only in a later major, and
dropping a supported Node.js or PostgreSQL major is breaking. Released migration files remain
immutable; schema evolution uses forward additive migrations with release-specific code/schema
compatibility guidance. None of these promises changes Durlo's current alpha or at-least-once
status.

## Documentation

- [Changelog](CHANGELOG.md) — user-visible release and compatibility changes
- [Security policy](SECURITY.md) — supported alpha and confidential reporting boundary
- [Contributing](CONTRIBUTING.md) — setup, repository constraints, and verification
- [Roadmap](docs/ROADMAP.md) — what to build, in order
- [Architecture](docs/ARCHITECTURE.md) — how the repository works today
- [Execution semantics](docs/EXECUTION_SEMANTICS.md) — public behavior and known limitations
- [Operations](docs/OPERATIONS.md) — PostgreSQL, workers, migrations, monitoring, and cleanup
- [Decisions and edge cases](docs/DECISIONS_AND_EDGE_CASES.md) — durable product decisions

Package and source types remain the final authority when documentation and code disagree.

Durlo is available under the [MIT License](LICENSE).

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
