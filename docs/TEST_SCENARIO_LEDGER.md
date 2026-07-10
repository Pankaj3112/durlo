# Durlo V1 Test Scenario Ledger

Status: Active
Date: 2026-07-11

This ledger maps Durlo's documented v1 guarantees to stable scenario ids and executable evidence.
It is the completeness checklist; coverage percentages are secondary.

Status meanings:

- **PR**: required on every pull request.
- **Nightly**: deterministic but intentionally heavier.
- **Release**: manual or release-candidate verification.
- **Deferred**: cannot be implemented honestly until the named product surface exists.

## Creation And Transactions

| ID      | Scenario                                                   | Evidence                                                   | Lane         |
| ------- | ---------------------------------------------------------- | ---------------------------------------------------------- | ------------ |
| CRE-001 | Task/workflow creation persists normalized options         | `test/core/index.test.ts`, `test/postgres/index.test.ts`   | PR           |
| CRE-002 | Unsupported inputs fail before persistence                 | `test/core/index.test.ts`                                  | PR           |
| CRE-003 | Idempotency deduplicates for the full row lifetime         | `test/postgres/index.test.ts`                              | PR           |
| CRE-004 | Concurrent idempotent creates produce one run              | `test/postgres/index.test.ts`, `contention.stress.test.ts` | PR + Nightly |
| CRE-005 | Duplicate keys inside one batch are rejected               | `test/core/index.test.ts`                                  | PR           |
| CRE-006 | Database failure rolls back the complete batch             | `test/postgres/state-matrix.test.ts`                       | PR           |
| CRE-007 | Caller-owned transaction commit and rollback are respected | `test/postgres/index.test.ts`, `state-matrix.test.ts`      | PR           |

## Claims, Leases, And Attempts

| ID      | Scenario                                                                         | Evidence                                                                    | Lane         |
| ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------ |
| CLM-001 | Claims filter by app, resource registration, due time, priority, and limit       | `test/postgres/state-matrix.test.ts`                                        | PR           |
| CLM-002 | Concurrent workers claim each run at most once                                   | `test/postgres/index.test.ts`, `contention.stress.test.ts`                  | PR + Nightly |
| CLM-003 | Locked rows are skipped rather than blocking                                     | `test/postgres/index.test.ts`                                               | PR           |
| CLM-004 | Expired running work is reclaimed with a new token                               | `test/postgres/index.test.ts`                                               | PR           |
| CLM-005 | Stalled attempts exhaust the failure budget honestly                             | `test/postgres/index.test.ts`                                               | PR           |
| CLM-006 | Wrong worker and stale tokens cannot extend, release, complete, or fail          | `test/postgres/index.test.ts`                                               | PR           |
| CLM-007 | Attempts are append-only and no active attempt remains after terminal transition | `test/postgres/index.test.ts`, `races.test.ts`, `contention.stress.test.ts` | PR + Nightly |
| CLM-008 | Safety predicates kill deliberate SQL mutations                                  | `scripts/check-persistence-mutations.mjs`                                   | Nightly      |
| CLM-009 | Pure retry, serialization, and validation decisions resist mutation              | `stryker.config.mjs` (90% breaking floor)                                   | Nightly      |

## Worker And Retry Behavior

| ID      | Scenario                                                            | Evidence                                                 | Lane |
| ------- | ------------------------------------------------------------------- | -------------------------------------------------------- | ---- |
| WRK-001 | Worker options and duplicate resource registration are validated    | `test/core/worker.test.ts`                               | PR   |
| WRK-002 | A running worker rejects duplicate start and can restart after stop | `test/core/worker.test.ts`                               | PR   |
| WRK-003 | Successful heartbeat renews and permits completion                  | `test/core/worker.test.ts`                               | PR   |
| WRK-004 | Lost or failed heartbeat aborts the signal and suppresses writes    | `test/core/worker.test.ts`                               | PR   |
| WRK-005 | Fixed/exponential backoff, jitter, cap, and exhaustion are enforced | `test/core/index.test.ts`, `test/postgres/index.test.ts` | PR   |
| WRK-006 | Timeout aborts the signal and records a timed-out attempt           | `test/postgres/index.test.ts`                            | PR   |
| WRK-007 | No transaction is held while user code executes                     | `test/postgres/operational.test.ts`                      | PR   |

## Workflow Steps And Timers

| ID      | Scenario                                                             | Evidence                             | Lane |
| ------- | -------------------------------------------------------------------- | ------------------------------------ | ---- |
| STP-001 | Completed checkpoints return stored values after re-entry            | `test/postgres/index.test.ts`        | PR   |
| STP-002 | Failed steps retry without rerunning successful predecessors         | `test/postgres/index.test.ts`        | PR   |
| STP-003 | Duplicate and nested step calls fail                                 | `test/postgres/index.test.ts`        | PR   |
| STP-004 | Step/timer ids cannot collide across re-entry                        | `test/postgres/state-matrix.test.ts` | PR   |
| STP-005 | Cancellation ownership loss cannot persist a late step result        | `test/postgres/state-matrix.test.ts` | PR   |
| TMR-001 | Sleep and sleepUntil persist, fire, and resume                       | `test/postgres/index.test.ts`        | PR   |
| TMR-002 | Sleep re-entry claims do not consume failure retries                 | `test/postgres/index.test.ts`        | PR   |
| TMR-003 | Invalid sleep dates create no timer                                  | `test/postgres/state-matrix.test.ts` | PR   |
| TMR-004 | Cancellation and due-timer firing serialize without future execution | `test/postgres/races.test.ts`        | PR   |

## Run Controls And Race Pairs

| ID      | Scenario                                                          | Evidence                                              | Lane |
| ------- | ----------------------------------------------------------------- | ----------------------------------------------------- | ---- |
| CTL-001 | Pending, running, and sleeping runs can be cancelled idempotently | `test/postgres/index.test.ts`, `state-matrix.test.ts` | PR   |
| CTL-002 | Terminal and missing runs reject invalid controls                 | `test/postgres/index.test.ts`, `state-matrix.test.ts` | PR   |
| CTL-003 | Manual retry permits only dead-letter tasks and failed workflows  | `test/postgres/index.test.ts`                         | PR   |
| CTL-004 | Cancel-versus-complete has exactly one winner                     | `test/postgres/races.test.ts`                         | PR   |
| CTL-005 | Cancel-versus-failure has exactly one winner                      | `test/postgres/races.test.ts`                         | PR   |

## Crash And At-Least-Once Guarantees

| ID      | Scenario                                                                            | Evidence                                | Lane |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------- | ---- |
| FLT-001 | Process death after claim is reclaimed                                              | `test/postgres/fault-injection.test.ts` | PR   |
| FLT-002 | Process death after an external side effect demonstrates honest duplicate execution | `test/postgres/fault-injection.test.ts` | PR   |
| FLT-003 | Process death after a checkpoint reuses the checkpoint                              | `test/postgres/fault-injection.test.ts` | PR   |

## Migrations, Delivery, And Compatibility

| ID      | Scenario                                                             | Evidence                                                                                   | Lane          |
| ------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| MIG-001 | Fresh and repeated migration is idempotent                           | `test/postgres/index.test.ts`, `migrations.test.ts`                                        | PR            |
| MIG-002 | Concurrent migrators apply each version once                         | `test/postgres/migrations.test.ts`                                                         | PR            |
| MIG-003 | Failed migration rolls back bookkeeping and later recovers           | `test/postgres/migrations.test.ts`                                                         | PR            |
| MIG-004 | Schema-owner role migrates and executes without superuser privileges | `restricted-role.privileged.test.ts`                                                       | PR privileged |
| MIG-005 | Upgrade from every prior released schema                             | No prior released schema exists yet; add fixture before migration `0002`                   | Deferred      |
| PKG-001 | Packed ESM and CJS exports load in a clean consumer                  | `scripts/test-packed-consumer.mjs`                                                         | PR            |
| PKG-002 | Packed declarations typecheck without undeclared dependencies        | `scripts/test-packed-consumer.mjs`                                                         | PR            |
| CMP-001 | Node 22/24 LTS and Node 26 Current, PostgreSQL 14/18 bounds          | `.github/workflows/nightly.yml`                                                            | Nightly       |
| CMP-002 | Actual PgBouncer transaction-pool proxy                              | The no-open-transaction invariant is automated; proxy matrix remains future operational CI | Deferred      |

## Exploratory QA

| ID     | Scenario                                   | Evidence                                    | Lane     |
| ------ | ------------------------------------------ | ------------------------------------------- | -------- |
| QA-001 | Public API and packed-artifact quickstart  | `test/qa/charters/public-api-quickstart.md` | Release  |
| QA-002 | Adversarial crash and recovery exploration | `test/qa/charters/crash-recovery.md`        | Release  |
| QA-003 | Controls and timing exploration            | `test/qa/charters/controls-and-timers.md`   | Release  |
| QA-004 | CLI/dashboard usability and consistency    | Slice 7 does not exist yet                  | Deferred |

Every confirmed QA finding must receive a new ledger id and deterministic regression test before
the fix is considered complete.
