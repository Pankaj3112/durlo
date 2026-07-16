# Durlo examples

The examples cover three different purposes:

| Application                                  | Purpose                                                                                                                                              | Release evidence                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [`quickstart`](quickstart/README.md)         | Small crash-and-resume learning path installed from packed packages                                                                                  | Automated Phase 4 proof only                       |
| [`webhook-relay`](webhook-relay/README.md)   | Deployable direct-task service with transactional enqueue, HTTP retry, provider idempotency, cancellation, and manual retry                          | Candidate real application after genuine operation |
| [`catalog-import`](catalog-import/README.md) | Deployable direct-workflow service with business-data staging, checkpoints, durable publication window, cancellation, versioning, and crash recovery | Candidate real application after genuine operation |

Run `pnpm test:reference-apps` from the repository root with `DURLO_TEST_DATABASE_URL` set to exercise
both deployable applications. The smoke test starts their actual APIs and workers, verifies API
authentication and transaction boundaries, retries a failed webhook, kills a catalog worker with
`SIGKILL`, observes lease recovery and checkpoint reuse, cancels a sleeping workflow, and removes
its data afterward.

## When a reference application qualifies

Location under `examples/` does not permanently disqualify an application, but repository execution
alone never qualifies. A reference application becomes real-application evidence only when all of
the following are true:

1. An identifiable operator deploys it as a continuing service, not a temporary test fixture.
2. It carries genuine work that the operator cares about; synthetic smoke payloads are excluded.
3. The deployed release candidate is observed through real runs and controlled, safe recovery
   exercises until the required deployment, retry, cancellation, and recovery coverage exists
   collectively across two applications.
4. The operator removes sensitive data, completes
   [`production-evidence-template.json`](../test/qa/production-evidence-template.json), and a release
   reviewer approves the report.
5. Unexpected behavior becomes a deterministic regression test or a documented accepted beta
   limitation before approval.

Merely deploying these applications, running `test:reference-apps`, or copying the evidence template
does not complete Phase 5.

## Observation map

| Required observation  | Webhook relay                                                                                     | Catalog import                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Deployment            | Keep the task version compatible while API and worker processes roll                              | Change `CATALOG_IMPORT_WORKFLOW_VERSION` only for a breaking change and retain the previous worker                            |
| Retry                 | Record a genuine destination timeout, 429, or 5xx and the later successful attempt                | Record a transient database failure only if it occurs during normal operation or a controlled outage                          |
| Cancellation          | Cancel a delivery that has not completed and verify whether any HTTP effect occurred              | Cancel during the durable publication window and verify that no product was published                                         |
| Crash/outage recovery | Restart a worker or perform a controlled database interruption, then inspect the attempt timeline | Kill a disposable worker after `CRASH_READY`, restart without the pause hook, and verify checkpoint reuse and one publication |
| Duplicate control     | Confirm the receiver deduplicates the stable `Idempotency-Key`                                    | Confirm repeated `importId` submissions return the original run and conflicting content is rejected                           |

Do not deliberately interrupt a production database or external destination without the operator's
approval and a rollback plan.
