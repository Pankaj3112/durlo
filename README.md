# Durlo

Durlo is a TypeScript-native durable task and workflow library for Postgres-backed applications.
It gives normal Node.js processes retries, delays, workflow checkpoints, durable sleeps, crash
recovery, cancellation, manual retry, and a local operations dashboard—without events, cron,
hosted orchestration, or framework adapters.

## Quickstart: first durable task in under ten minutes

You need Node.js 22 through 26 and PostgreSQL 14 through 18. For a disposable local database:

```bash
docker run --rm --name durlo-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=durlo \
  -p 5432:5432 \
  -d postgres:17-alpine

export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/durlo
```

Create a TypeScript project, install the three Durlo packages, and scaffold an explicit config:

```bash
mkdir durlo-hello && cd durlo-hello
npm init -y
npm install @durlo/core @durlo/postgres @durlo/cli pg tsx
npx durlo init
```

The generated `durlo.config.ts` defines a `hello` task and registers it with the worker. Add
`enqueue.ts` beside it:

```ts
import { adapter, hello } from "./durlo.config.js";

const run = await hello.enqueue({ name: "Ada" });
console.log(`queued ${run.id}`);
await adapter.close();
```

In the first terminal, migrate once and start the local worker plus dashboard:

```bash
npx durlo migrate
npx durlo dev
```

Open <http://127.0.0.1:3210>. In a second terminal, set the same `DATABASE_URL` and enqueue:

```bash
npx tsx enqueue.ts
```

The run moves from pending to completed in the runs list. Select it to inspect its input, output,
attempts, diagnostics, and derived timeline. `Ctrl-C` gracefully stops new claims and drains work
already running.

For production, run `durlo migrate` as a deployment step and `durlo worker` as the long-lived
process. `durlo dev` applies migrations automatically for local convenience and exposes an
unauthenticated local dashboard, bound to `127.0.0.1` by default.

## Crash, checkpoint, sleep, retry, resume

The [crash-and-resume demo](examples/quickstart/README.md) starts an order workflow in the same
raw `pg` transaction as its business row. It then proves checkpoint reuse after `SIGKILL`, expired
lease recovery, a durable sleep, one deliberate failure, automatic retry, and the final timeline.
The repository test installs packed tarballs into an empty consumer before running that scenario;
it does not import workspace source.

## Reference applications

The [`webhook-relay`](examples/webhook-relay/README.md) and
[`catalog-import`](examples/catalog-import/README.md) examples are complete HTTP applications for
direct tasks and direct workflows. Their automated smoke test covers transactional creation,
at-least-once external delivery, retry, idempotency conflicts, durable sleep, cancellation,
`SIGKILL` recovery, and checkpoint reuse.

See the [examples index](examples/README.md) for the complete, locally runnable Phase 5
application-level proof. It needs Docker for a disposable PostgreSQL container, not a VPS.

## Delivery semantics

Durlo is at-least-once. A process can perform an external side effect and die before recording
success, so emails, charges, API calls, and similar effects still need business-level or provider
idempotency. A Durlo idempotency key deduplicates run creation; it does not make external effects
exactly once.

Workflow code re-enters from the top after retry, crash recovery, or sleep. Completed
`step.run(...)` results are reused, so branching should depend on input or stored step results and
step ids must remain stable.

## Documentation

- [CLI and local dashboard](docs/CLI_AND_DASHBOARD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Execution semantics](docs/EXECUTION_SEMANTICS.md)
- [Deployment compatibility](docs/DEPLOYMENT_COMPATIBILITY.md)
- [Storage limits](docs/STORAGE_LIMITS.md)
- [Retention cleanup](docs/RETENTION.md)
- [Observability](docs/OBSERVABILITY.md)
- [Postgres operations](docs/OPERATIONS.md)
- [Beta support policy](docs/SUPPORT.md)
- [Beta release proof](docs/BETA_RELEASE_PROOF.md)
- [Roadmap](docs/ROADMAP.md)

## Contributor verification

Pure unit tests require no database:

```bash
pnpm test:unit
```

The default local suite creates a disposable PostgreSQL 17 container and includes the packed
crash-and-resume quickstart and both deployable reference applications:

```bash
pnpm test:local
```

Use `pnpm test:audit` for the complete release-candidate audit. It adds formatting, lint,
typechecking, builds, packed ESM/CommonJS/CLI consumers, mutation checks, privileged-role tests,
seeded contention, and persistence-safety mutations.
