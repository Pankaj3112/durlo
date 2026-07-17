# Durlo examples

The examples cover three different purposes:

| Application                                  | Purpose                                                                                                                                               | Release evidence                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [`quickstart`](quickstart/README.md)         | Small crash-and-resume learning path installed from packed packages                                                                                   | Automated Phase 4 proof               |
| [`webhook-relay`](webhook-relay/README.md)   | Production-shaped direct-task service with transactional enqueue, HTTP retry, provider idempotency, cancellation, and manual retry                    | Phase 5 direct-task application proof |
| [`catalog-import`](catalog-import/README.md) | Production-shaped direct-workflow service with business-data staging, checkpoints, durable publication window, cancellation, versioning, and recovery | Phase 5 workflow application proof    |

Run `pnpm test:reference-apps` from the repository root with `DURLO_TEST_DATABASE_URL` set to exercise
both reference applications. The test starts their actual APIs and workers, verifies API
authentication and transaction boundaries, retries a failed webhook, kills a catalog worker with
`SIGKILL`, observes lease recovery and checkpoint reuse, cancels a sleeping workflow, and removes
its data afterward.

No VPS is required. With Docker running, this one command creates and removes the database as well:

```bash
pnpm test:local test:reference-apps
```

## Why these applications qualify for Phase 5

The reference applications are application-level engineering evidence because they:

1. Use public Durlo APIs from complete authenticated HTTP services, not test-only storage calls.
2. Keep business state in application-owned tables and create Durlo runs in the same transaction.
3. Run APIs, workers, an HTTP receiver, and PostgreSQL across real process and network boundaries.
4. Exercise direct-task and direct-workflow behavior, including retries, cancellation, durable
   sleep, process death, lease recovery, checkpoint reuse, and business idempotency.
5. Run from a clean checkout in CI and every supported-boundary nightly cell.

They prove the documented beta behavior reproducibly. They do not claim customer adoption,
production traffic, or a throughput envelope.

## Observation map

| Required observation  | Webhook relay                                                                                     | Catalog import                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Deployment            | Keep the task version compatible while API and worker processes roll                              | Change `CATALOG_IMPORT_WORKFLOW_VERSION` only for a breaking change and retain the previous worker                            |
| Retry                 | Record a genuine destination timeout, 429, or 5xx and the later successful attempt                | Record a transient database failure only if it occurs during normal operation or a controlled outage                          |
| Cancellation          | Cancel a delivery that has not completed and verify whether any HTTP effect occurred              | Cancel during the durable publication window and verify that no product was published                                         |
| Crash/outage recovery | Restart a worker or perform a controlled database interruption, then inspect the attempt timeline | Kill a disposable worker after `CRASH_READY`, restart without the pause hook, and verify checkpoint reuse and one publication |
| Duplicate control     | Confirm the receiver deduplicates the stable `Idempotency-Key`                                    | Confirm repeated `importId` submissions return the original run and conflicting content is rejected                           |

## Later real-world adoption

Operators can adapt either application or use Durlo in independent projects without changing the
Phase 5 result. If a later operating report finds unexpected behavior, add a deterministic
regression test or document it as an accepted limitation. Never commit credentials, customer data,
database URLs, or sensitive logs.
