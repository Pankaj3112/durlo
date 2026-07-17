# Durlo Beta Release Proof

Status: Complete
Updated: 2026-07-17

This document is the repeatable Phase 5 audit for Durlo v1 beta. Every release gate can be reproduced
from the repository on a local machine or in CI; no VPS, hosted Durlo service, unrelated application,
or customer workload is required.

## Repeatable Audit

From a clean checkout with Docker running:

```bash
pnpm install --frozen-lockfile
pnpm test:audit
```

`test:audit` checks release metadata, formatting, lint, types, builds, packed artifacts, pure-core
mutations, the full deterministic suite, the packed quickstart, two deployable reference
applications, restricted-role behavior, seeded stress, and persistence-safety mutations. The
database-backed portion creates and removes a disposable PostgreSQL 17 container. It does not
require or mutate a developer database.

The manually dispatchable nightly workflow repeats release artifacts, integration tests, the
quickstart, privileged-role tests, and stress across the [supported boundaries](SUPPORT.md):

```txt
Node.js 22, 24, 26 × PostgreSQL 14, 18
```

CI and nightly jobs begin with a clean GitHub checkout and a frozen lockfile. Audit output and
coverage are retained as workflow artifacts. A release candidate is not supported on a new runtime
or database major merely because installation succeeds; the declared matrix must pass first.

The Phase 5 candidate at commit `94e82b5` was run from a clean worktree across all six boundary
cells on 2026-07-16:

```txt
Node.js 22.23.1, 24.18.0, 26.5.0 × PostgreSQL 14.23, 18.4
```

Every cell passed the release-contract check, build, packed ESM/CommonJS/TypeScript consumer,
133-test coverage suite, packed crash-and-resume quickstart, restricted-role test, and 50-seed
durability stress suite. The same matrix remains automated nightly so later dependency and runtime
patch changes must continue to pass.

## Automated Durability Evidence

The following tests use the public execution model and real PostgreSQL transactions:

| Risk                        | Repeatable proof                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-worker contention     | Four independent adapters and pools, each with six execution slots, drain 120 contended runs. Every run has exactly one successful attempt and no active attempt remains.                                                                                                                                                        |
| Seeded creation/claim races | Each nightly seed makes three concurrent requests for each of 40 idempotent logical runs, then four claimers race them. Nightly runs 50 deterministic seeds.                                                                                                                                                                     |
| Long-tail concurrency       | With one worker at concurrency three, a deliberately blocked run remains running while at least eight later runs complete through replenished slots.                                                                                                                                                                             |
| Crash windows               | Child processes are killed after claim, after an external side effect, and after a committed workflow checkpoint. Expired leases stall, stale tokens cannot write, effects can duplicate, and checkpoints are reused.                                                                                                            |
| Database outage             | A TCP proxy severs every worker connection during an active attempt. Polling recovers after reconnection, queued work completes, the lost attempt is recorded as stalled, and the expired run is reclaimed with a new lease.                                                                                                     |
| Timer lag                   | Twelve workflows receive 500 ms of injected due-timer lag while both execution slots are occupied. The independent timer loop drains due timers to pending work before the blockers are released.                                                                                                                                |
| Rolling deployment          | A sleeping version-1 workflow remains unavailable to a version-2-only worker, keeps its original idempotency/version identity, and resumes only when the mixed-version fleet restores compatible code. The inverse rollback case is also tested.                                                                                 |
| Migration safety            | Every released migration has an immutable checksum. Fresh concurrent migration and every historical schema prefix upgrade to the current schema are tested.                                                                                                                                                                      |
| Release artifacts           | Empty ESM, CommonJS, and strict TypeScript consumers install only generated tarballs. The exact runtime exports, type declarations, CLI binary, migration exports, and absence of source/workspace-only files are checked.                                                                                                       |
| Packed quickstart           | The tarball-installed CLI migrates a database, starts a transactional workflow, is killed with `SIGKILL`, resumes after lease expiry, reuses its checkpoint, sleeps, retries, completes, and exposes the correct dashboard timeline.                                                                                             |
| Reference applications      | The actual webhook-relay and catalog-import APIs and workers start against Postgres. The relay retries a 503 with one stable provider idempotency key. The importer survives `SIGKILL`, reuses completed checkpoints, fires its durable timer, publishes once, and separately cancels a sleeping workflow without publishing it. |

These are regression scales, not throughput or capacity claims. The reproducible 50,000- and
500,000-row query measurements are documented separately in [Postgres Performance](PERFORMANCE.md).
Applications must benchmark their own retained-row count, hardware, connection proxy, and latency
budget.

## Tested Limits

Durlo validates these public configuration boundaries:

- worker concurrency: 1 through 1,000 per process; default 10
- worker lease duration: greater than zero; default 30 seconds
- run list page: 1 through 200 rows through `durlo.runs.list()`
- compatibility report: 1 through 1,000 unavailable rows; default 100
- retention cleanup: 1 through 10,000 terminal rows per call
- storage defaults: 1 MiB input, 1 MiB output, 64 KiB error, 1,000 batch items, 10 MiB
  aggregate batch input, 1 MiB step result, and 1,000 durable workflow step/sleep records

Storage byte accounting and exact failure behavior are defined in [Storage Limits](STORAGE_LIMITS.md).
Accepting a configuration value does not promise that every workload can operate safely at that
value. Pool pressure, heartbeat latency, database resources, user-code latency, and event-loop
health determine the usable operational envelope.

Durlo provides no hard pickup-latency or timer-lag SLA. Eligibility uses the PostgreSQL clock;
observed lag includes polling, pool waiting, database work, and available execution capacity.

## Expected Duplicate Execution

Durlo is at-least-once. The automated crash and outage tests deliberately prove the duplicate
boundary instead of concealing it.

| Failure window                                                                     | Expected behavior                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process dies after claim but before user code                                      | The attempt stalls after lease expiry and the run is reclaimed. User code did not yet perform an effect in that attempt.                              |
| Process dies after an external effect but before completion/checkpoint persistence | The run is reclaimed and the external effect can occur again. Use a provider idempotency key or transactional business-effect record.                 |
| Process dies after a successful `step.run` checkpoint commits                      | Workflow code re-enters, but that step returns its stored result and does not execute its callback again.                                             |
| Database or network outage causes a missed heartbeat                               | The local attempt loses durable ownership. After the stored lease expires, another attempt can execute while late local JavaScript is still settling. |
| Attempt timeout wins while user JavaScript ignores its signal                      | The timeout is durable and a retry can begin. Late external effects from the old JavaScript remain possible.                                          |
| Workflow resumes after retry, crash, or sleep                                      | Top-level workflow code runs again. Only persisted step results and timers are durable boundaries.                                                    |

An idempotency key prevents duplicate run rows in its app/kind/resource scope while the original row
is retained. It does not prevent any of the execution duplicates above.

## Eligible Work And Stranding

Claim tests cover pending due runs and expired running leases under contention. Timer tests cover
the atomic transition from a due pending timer and sleeping run to a pending run. A supported,
eligible run is therefore expected to make progress after transient database recovery as long as a
compatible worker continues polling.

Rows that correctly remain unclaimed are diagnosable rather than silently stranded:

- delayed runs have a future `scheduledAt`
- sleeping workflows have no due timer
- incompatible or unregistered resource versions appear in compatibility reports
- terminal or cancelled runs are not eligible
- another app's runs are outside the worker's scope

Operators should alert on growing ready lag, expired leases, due-timer lag, and incompatible active
runs. Recovery and escalation steps are in [Postgres Operations](OPERATIONS.md).

## Reference-Application Evidence

The two applications under [`examples/`](../examples/README.md) are the application-level Phase 5
proof. They are intentionally owned by this repository so a clean checkout can exercise the same
behavior without depending on private code, future adopters, or external hosting.

Run only this proof with Docker running:

```bash
pnpm test:local test:reference-apps
```

The command creates a disposable PostgreSQL database, starts each application's actual HTTP API and
Durlo worker as separate processes, performs controlled fault exercises through the public APIs,
checks the durable application and Durlo records, and removes the processes, tables, and container.

| Application    | Application-level evidence                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook relay  | Authenticated API, atomic delivery/run creation, a genuine HTTP boundary, stable provider idempotency, transient 503 retry, duplicate request reuse, conflicting request rejection, and stored business delivery history.       |
| Catalog import | Authenticated API, atomic import/run creation, bounded business data, workflow checkpoints, durable publication sleep, cancellation before publication, `SIGKILL` lease recovery, checkpoint reuse, and idempotent publication. |

The separate rolling-version integration scenario supplies deployment compatibility coverage, and
the outage and stress suites supply database recovery and fleet-level coverage. Together these tests
observe every Phase 5 outcome through real process and PostgreSQL boundaries while remaining fully
repeatable.

This evidence is a beta engineering claim, not a claim of customer adoption or production scale.
Independent operating reports are welcome after adoption and can use
`test/qa/production-evidence-template.json`, but they are not a beta release prerequisite. Any
unexpected behavior found later must still become a deterministic regression test or a documented
accepted limitation. Reports must never include credentials, database URLs, customer data, or
sensitive logs.
