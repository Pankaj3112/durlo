# Catalog import

This production-shaped reference application accepts a bounded product catalog, stores it in application
tables, and uses Durlo's raw-`pg` transaction callback to start a small workflow through the same
client. Large business payloads stay out of workflow input and remain available after Durlo history
retention.

The workflow validates and normalizes its input, checkpoints the source, enters a durable publication
window that holds no worker slot, and publishes the catalog in an idempotent transaction. Imports are
ordered by creation time and id so a recovered older workflow cannot overwrite a newer product value.

## Run locally

```bash
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/durlo
export CATALOG_IMPORT_API_KEY=local-secret
export CATALOG_PUBLICATION_DELAY=10s

pnpm migrate
pnpm start
```

In a second terminal run `pnpm dev:worker`. The development command starts the worker and dashboard
at <http://127.0.0.1:4321>.

Start and inspect an import:

```bash
curl -X POST http://127.0.0.1:4320/imports \
  -H 'Authorization: Bearer local-secret' \
  -H 'Content-Type: application/json' \
  -d '{"importId":"supplier-2026-07-16","rows":[{"sku":"SKU-1","name":"Travel mug","priceCents":2499}]}'

curl http://127.0.0.1:4320/imports/supplier-2026-07-16 \
  -H 'Authorization: Bearer local-secret'
```

Cancel during the publication window with `POST /imports/:id/cancel`. List the currently published
catalog with `GET /products`. Failed workflow runs can be manually retried with
`POST /imports/:id/retry`.

## Crash and deployment exercises

Set `DURLO_EXAMPLE_PAUSE_AFTER_PREPARE=1` only on a disposable worker. After it prints `CRASH_READY`,
kill that worker and restart without the variable. The recovered workflow reuses both checkpoints,
resumes its durable timer, and publishes once.

`DURLO_WORKER_LEASE_DURATION` defaults to `15s`. Keep it comfortably above normal database and
event-loop latency in production; the automated smoke test lowers it only to make crash recovery
finish quickly.

`CATALOG_IMPORT_WORKFLOW_VERSION` controls the opaque compatibility version. During a breaking
deployment, including a change to the normalized workflow input, keep workers for the previous value
available until their active workflows complete; use the worker compatibility report before removing
them.

## Production boundaries

- Keep `CATALOG_IMPORT_API_KEY` secret and terminate TLS before the API.
- Run API and worker processes separately against the same Postgres database.
- Keep the 1,000-row and 2 MiB request bounds or replace the request path with object storage.
- Preserve application import/publication rows independently of Durlo retention cleanup.
- Treat cancellation as best-effort if publication has already started.
- Do not change workflow behavior incompatibly without changing its version and retaining old code.

This application is a direct-workflow regression fixture and integration example. It has not
carried customer production traffic and does not establish a throughput or support claim.
