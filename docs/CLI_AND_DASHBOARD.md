# Durlo CLI And Local Dashboard

Status: Current
Updated: 2026-07-16

The `@durlo/cli` package installs the `durlo` binary. It loads task and workflow code only from an
explicit configuration and uses the existing core read/control APIs; the CLI does not implement a
second execution or state-transition path.

## Configuration

By default, commands look in the current directory for the first matching file:

```txt
durlo.config.ts
durlo.config.mts
durlo.config.js
durlo.config.mjs
durlo.config.cjs
```

Every command that loads code accepts `--config <path>` (or `-c <path>`). TypeScript configs are
loaded directly. A config default-exports the `Durlo` instance, its explicit worker registrations,
and optional worker/dashboard settings:

```ts
import { Durlo } from "@durlo/core";
import { defineConfig } from "@durlo/cli";
import { postgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const adapter = postgresAdapter({ connectionString: databaseUrl });
const durlo = new Durlo({ id: "billing", adapter });

const sendInvoice = durlo.task({
  id: "send-invoice",
  version: "1",
  run: async (input: { invoiceId: string }) => sendInvoiceEmail(input.invoiceId)
});

export default defineConfig({
  durlo,
  tasks: [sendInvoice],
  workflows: [],
  worker: { concurrency: 10, leaseDuration: "30s", pollInterval: "1s" },
  dashboard: { host: "127.0.0.1", port: 3210 }
});
```

Only definitions in `tasks` and `workflows` are registered with that worker. Kind, resource id,
and compatibility version must exactly match a stored run before it can be claimed. This keeps
specialized workers and rolling deployments explicit.

## Commands

### `durlo init`

Creates `durlo.config.ts` without overwriting an existing file. `--force` explicitly replaces it.
The scaffold contains a Postgres adapter, a `Durlo` instance, one typed task, explicit resource
arrays, worker settings, and a loopback dashboard address.

### `durlo migrate`

Loads the configured Postgres adapter, applies pending immutable migrations under Durlo's
transaction-scoped advisory lock, and closes the adapter. Run this once as a deployment step with
a schema-owner connection, before new-version production workers start.

### `durlo worker`

Starts a worker with exactly the configured resources and worker settings. `SIGINT` and `SIGTERM`
stop new claims and timer promotion, then wait for active work to drain before the adapter closes.
The command does not run migrations automatically.

### `durlo dev`

Applies migrations, then runs the configured worker and local dashboard in one process. Dashboard
overrides are available as `--host <host>` and `--port <port>`. This automatic migration behavior
is for local development; production should use the separate migration step.

## Dashboard

The default address is `http://127.0.0.1:3210`. The dashboard is self-contained and makes no font,
script, image, analytics, or other network requests. It exposes:

- app-scoped newest-first runs with status, kind, and resource filters
- bounded keyset pagination
- input, output, errors, persisted options, steps, attempts, and timers
- the deterministic durable-record timeline and retry/lease/timer diagnostics
- app backlog health, process-local worker health, and worker-relative compatibility diagnosis
- cancellation for pending, running, or sleeping runs
- manual retry for dead-letter tasks and failed workflows

Cancellation and retry use same-origin `POST` requests and the app-scoped core controls. The UI
shows them only for valid states and requires confirmation, but storage remains the final authority
for races. Cancellation is cooperative: JavaScript already executing may finish late or perform an
external effect. Manual retry preserves attempt history and idempotency keys and grants one new
execution attempt.

The dashboard has no authentication and is a local operations surface. It binds to loopback by
default. Setting another host is an explicit decision to expose it; use a trusted network or an
authenticated reverse proxy and do not treat the built-in origin check as authentication.

## Verification

`pnpm test:quickstart` builds and packs all three public packages, installs them into an empty
consumer, applies migrations with the installed binary, and runs the crash-and-resume demo. The
test kills the first worker after a committed checkpoint, starts `durlo dev`, waits for recovery,
and asserts the stalled lease, timer, failed attempt, retry, completion, one business effect, and
safe terminal-state control response through the dashboard API.
