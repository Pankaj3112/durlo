# Durlo examples

These applications exercise the public API through real process and PostgreSQL boundaries. They are
regression fixtures and learning material, not evidence of customer adoption or production scale.

| Application | Purpose |
| --- | --- |
| [`quickstart`](quickstart/README.md) | Small packed-package crash, checkpoint, sleep, retry, and resume path |
| [`webhook-relay`](webhook-relay/README.md) | Direct task with transactional creation, HTTP retry, provider idempotency, cancellation, and manual retry |
| [`catalog-import`](catalog-import/README.md) | Direct workflow with business staging, checkpoints, durable sleep, cancellation, versioning, and recovery |

Run both reference applications against an existing disposable database:

```bash
DURLO_TEST_DATABASE_URL=postgres://... pnpm test:reference-apps
```

Or let the repository create and remove a PostgreSQL 17 container:

```bash
pnpm test:local test:reference-apps
```

The test starts the actual APIs and workers, verifies authentication and transaction boundaries,
retries a failed webhook, kills a catalog worker with `SIGKILL`, observes lease recovery and
checkpoint reuse, cancels a sleeping workflow, and removes its data afterward. No VPS is required.

The examples deliberately include business-owned idempotency and durable application tables.
Durlo's run idempotency prevents duplicate run rows while history is retained; it cannot make an
HTTP call, publication, payment, or other external effect exactly once.
