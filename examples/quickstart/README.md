# Durlo `0.1.0-alpha.1` clean quickstart

This quickstart installs only the three exact public npm packages into a new project. It creates an
application row, a direct task run, and a workflow run in one PostgreSQL transaction; executes them
in a separate worker; kills that worker after durable checkpoints; restarts it; observes a directed
automatic retry; and inspects the retained timeline in the local dashboard.

Durlo is at-least-once. The example makes its task and workflow effects idempotent with business
unique keys; a Durlo run idempotency key prevents duplicate run creation while its row exists, but
does not make an email, payment, HTTP request, or other external effect exactly once.

## Requirements

- Node.js 22 through 26 and npm
- Docker for a disposable PostgreSQL 17 database
- `curl`

The supported alpha installation/runtime database range is PostgreSQL 14 through 18. This example
uses 17; the matrix is not a production-support promise or measured operating envelope.

## 1. Create a clean published-package project

```bash
mkdir durlo-alpha-quickstart
cd durlo-alpha-quickstart
npm init -y
npm pkg set type=module
npm install @durlo/core@0.1.0-alpha.1 @durlo/postgres@0.1.0-alpha.1 \
  @durlo/cli@0.1.0-alpha.1 pg@8.22.0 tsx@4.23.0
mkdir -p src
curl -fsSL https://raw.githubusercontent.com/Pankaj3112/durlo/v0.1.0-alpha.1/examples/quickstart/durlo.config.ts \
  -o durlo.config.ts
curl -fsSL https://raw.githubusercontent.com/Pankaj3112/durlo/v0.1.0-alpha.1/examples/quickstart/src/durlo.ts \
  -o src/durlo.ts
curl -fsSL https://raw.githubusercontent.com/Pankaj3112/durlo/v0.1.0-alpha.1/examples/quickstart/src/start.ts \
  -o src/start.ts
```

The downloaded files are example application code from the immutable release tag. Every Durlo
runtime import resolves from `node_modules`; no workspace path, local tarball, or repository source
is used.

## 2. Start and migrate PostgreSQL

```bash
docker run --rm --detach --name durlo-alpha-postgres \
  --env POSTGRES_USER=durlo \
  --env POSTGRES_PASSWORD=durlo \
  --env POSTGRES_DB=durlo_quickstart \
  --publish 127.0.0.1:55432:5432 \
  postgres:17-alpine
until docker exec durlo-alpha-postgres pg_isready -U durlo -d durlo_quickstart; do sleep 1; done
export DATABASE_URL=postgres://durlo:durlo@127.0.0.1:55432/durlo_quickstart
npx durlo migrate
```

`durlo migrate` discovers the migrations exported by the installed `@durlo/postgres` package and
applies them in order. Released migrations are immutable.

## 3. Start the separate worker

In terminal A, from `durlo-alpha-quickstart` with the same `DATABASE_URL`:

```bash
DURLO_DEMO_PAUSE_AFTER_CHECKPOINT=1 npx durlo worker
```

The config registers the direct `record-order-created` task and the `fulfill-order` workflow. The
worker executes user code; the producer in the next step only commits durable work.

## 4. Commit application data and both runs atomically

In terminal B, export the same database URL and start an order:

```bash
export DATABASE_URL=postgres://durlo:durlo@127.0.0.1:55432/durlo_quickstart
npx tsx src/start.ts
```

The output contains distinct task and workflow ids:

```text
ORDER_ID=<uuid>
TASK_RUN_ID=<uuid>
RUN_ID=<uuid>
Business row, task run, and workflow run committed in one Postgres transaction.
```

`src/start.ts` uses `durlo.transaction(...)`. Durlo acquires one raw-`pg` client, owns `BEGIN`,
`COMMIT`, rollback, and release, and binds the application insert plus both creation calls to that
client. A failure commits neither the business row nor either run.

## 5. Force a crash and recover

Terminal A prints `CRASH_READY runId=... pid=...` after the workflow's order lookup and inventory
reservation checkpoints are durable. Kill exactly that worker PID:

```bash
kill -9 <pid-from-CRASH_READY>
```

Restart without the pause flag:

```bash
npx durlo dev
```

After the two-second lease expires, the replacement worker reclaims the workflow, reuses its
completed checkpoints, survives its durable packing sleep, and reaches the courier step. The first
courier attempt throws `RetryError({ after: "400ms" })`; Durlo persists the directed retry and the
next attempt completes automatically. The direct task also reaches `completed` and its idempotent
effect exists once.

## 6. Inspect the evidence

Open <http://127.0.0.1:3210>. Select the workflow `RUN_ID` and confirm its timeline includes:

1. a stalled attempt from the killed worker;
2. checkpoint reuse and a durable timer schedule/fire;
3. the failed courier attempt and automatic retry;
4. successful completion.

Select `TASK_RUN_ID` and confirm `record-order-created` is completed. The dashboard also exposes
inputs, outputs, errors, cancellation, and retry controls. It has no authentication; keep it on
`127.0.0.1` or place it behind an authenticated trusted proxy. It is not a production control
plane.

## 7. Clean up

Stop `durlo dev` with Ctrl-C, then run:

```bash
docker rm --force durlo-alpha-postgres
cd ..
rm -rf durlo-alpha-quickstart
```

The database and clean consumer project are disposable. Durlo `0.1.0-alpha.1` is an alpha with
best-effort fixes for only the latest alpha, no response-time SLA, and no production-support
promise. Read the root security policy, changelog, execution semantics, and operations guide before
evaluating a real integration.
