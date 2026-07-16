# Webhook relay

This deployable reference application accepts authenticated delivery requests and sends them from a
Durlo task. The API inserts its delivery row and Durlo run in one Postgres transaction, so a process
crash cannot commit one without the other.

The task retries transient errors and non-2xx responses, supports cancellation and manual retry,
and sends the stable `Idempotency-Key` header to the destination. Durlo remains at-least-once: a
destination that performs side effects must deduplicate that key because a worker can die after the
HTTP request succeeds but before completion is persisted.

## Run locally

Set the following environment variables:

```bash
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/durlo
export WEBHOOK_RELAY_API_KEY=local-secret
export WEBHOOK_RELAY_ALLOWED_HOSTS=localhost,127.0.0.1
export WEBHOOK_RELAY_ALLOW_HTTP=1
```

Then run:

```bash
pnpm migrate
pnpm start
```

In a second terminal run `pnpm dev:worker`. The development command starts the worker and dashboard
at <http://127.0.0.1:4311>.

Enqueue and inspect a delivery:

```bash
curl -X POST http://127.0.0.1:4310/deliveries \
  -H 'Authorization: Bearer local-secret' \
  -H 'Content-Type: application/json' \
  -d '{"deliveryId":"invoice-42","destinationUrl":"http://127.0.0.1:9000/hooks","payload":{"invoiceId":"42"}}'

curl http://127.0.0.1:4310/deliveries/invoice-42 \
  -H 'Authorization: Bearer local-secret'
```

Cancel pending/running work with `POST /deliveries/:id/cancel`. After a task exhausts its automatic
attempts, start a manual attempt with `POST /deliveries/:id/retry`.

## Production boundaries

- Keep `WEBHOOK_RELAY_API_KEY` secret and terminate TLS before the API.
- Set `WEBHOOK_RELAY_ALLOWED_HOSTS` explicitly. Arbitrary destinations would turn the service into
  an SSRF primitive.
- Leave HTTP disabled in production.
- Run API and worker processes separately against the same Postgres database.
- Keep old task versions registered until their active runs finish during rolling deployments.
- Keep business delivery rows independently of Durlo history; retention cleanup may remove the run
  after its operational evidence window without removing the application record.
- Do not place destination credentials in task input. Add server-managed credentials at execution
  time if adapting this example for a real endpoint.

This repository example is not itself Phase 5 production evidence. A deployment counts only when a
real operator uses it and records the required retry, cancellation, deployment, and recovery
observations without credentials or payload data.
