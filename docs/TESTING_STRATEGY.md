# Durlo Testing Strategy

Status: Proposed
Date: 2026-07-10

## Goal

Build confidence that Durlo preserves its documented execution semantics under success, failure,
restart, and contention.

"Fully tested" does not mean every possible program or timing can be enumerated. For Durlo v1 it
means:

- every invariant in `EXECUTION_SEMANTICS.md`, `INTERNAL_ADAPTER_SPEC.md`, and
  `DECISIONS_AND_EDGE_CASES.md` maps to one or more named tests;
- every allowed state transition has a happy-path test;
- every forbidden transition has a rejection/no-op test;
- every ownership-sensitive write is tested with the current token, a stale token, the wrong
  worker, and a cancelled or terminal run;
- important race pairs are executed concurrently against real Postgres;
- process crashes are tested at the boundaries where at-least-once execution matters;
- the default CI path never silently skips datastore tests;
- every production bug gets a regression test at the lowest layer that reproduces it.

The test strategy stays inside the v1 scope: direct tasks, direct workflows, Postgres, and local
workers. It does not introduce events, cron, distributed concurrency, or framework adapters.

## Baseline Before This Testing Branch

As of 2026-07-10:

- the suite contains 36 tests: 15 core/CLI tests and 21 Postgres integration tests;
- `pnpm test` passes without Postgres by silently skipping all 21 Postgres tests;
- all 36 tests pass against a disposable PostgreSQL 17 instance;
- the Postgres suite already covers the main task, retry, stall, checkpoint, sleep, cancellation,
  manual retry, and timeout paths;
- there is no checked-in CI workflow, coverage gate, package-consumer test, multi-process crash
  harness, or repeated contention suite.

The most urgent change is to make real Postgres testing a required gate. Adding more mocked tests
while the durable suite remains optional would give misleading confidence.

Implementation status (2026-07-10): Phase 0 is underway on `codex/testing-strategy`. Explicit unit
and required integration commands, disposable local Postgres execution, coverage/JUnit reporting,
Postgres CI, and the first concurrent idempotency/claim and owned-write tests have been added.

Implementation status (2026-07-11): worker lifecycle and lease-renewal success/loss/error paths now
have controlled unit tests. Real-Postgres races cover cancel-versus-complete,
cancel-versus-final-failure, and cancel-versus-due-timer safety. The suite has 48 tests and its
ratcheted global coverage floor is 88% statements, 80% branches, 95% functions, and 90% lines.

Implementation status (2026-07-11, expanded): the state matrix, real process-death fixtures, seeded
contention, persistence mutation audit, migration concurrency/recovery, restricted-role execution,
packed ESM/CJS/TypeScript consumers, nightly Node/Postgres bounds, scenario ledger, and release QA
charters are implemented. Upgrade fixtures remain structurally deferred until migration `0002`;
CLI/dashboard QA remains deferred until Slice 7.

Core mutation testing is enforced nightly for retry, serialization, and validation logic. The
initial mutation score is 91.83%, with a 90% breaking floor; persistence safety mutations remain a
separate real-Postgres gate.

Final implementation audit (2026-07-11): the required PR suite has 70 tests, the privileged-role
lane has 1 test, and the default seeded stress run has 10 scenarios (50 per compatibility job
nightly). Coverage is 93.76% statements, 88.51% branches, 97.39% functions, and 96.24% lines; the
ratcheted floors are 93%, 88%, 97%, and 96% respectively.

## What To Copy From Mature Durable Execution Projects

The useful common pattern is layered verification, not their product-specific machinery:

- BullMQ runs datastore-backed behavior tests, explicit stalled-worker scenarios, a fast smoke
  gate, coverage thresholds, and runtime/datastore compatibility jobs. See its
  [test workflow](https://github.com/taskforcesh/bullmq/blob/418de1e51db09ffc8e95bac35015a1057d8a7271/.github/workflows/test.yml),
  [stalled job suite](https://github.com/taskforcesh/bullmq/blob/418de1e51db09ffc8e95bac35015a1057d8a7271/tests/stalled_jobs.test.ts),
  and [coverage config](https://github.com/taskforcesh/bullmq/blob/418de1e51db09ffc8e95bac35015a1057d8a7271/vitest.coverage.config.ts).
- Temporal's TypeScript SDK runs against a real local service across supported runtimes and
  platforms, tests persisted-history replay, tests the published-package experience, and has
  separate stress/nightly lanes. See its
  [CI workflow](https://github.com/temporalio/sdk-typescript/blob/4804a43408fcb4e0de9f5455f9dde6936fa3e56e/.github/workflows/ci.yml),
  [replay tests](https://github.com/temporalio/sdk-typescript/blob/4804a43408fcb4e0de9f5455f9dde6936fa3e56e/packages/test/src/test-replay.ts),
  and [stress workflow](https://github.com/temporalio/sdk-typescript/blob/4804a43408fcb4e0de9f5455f9dde6936fa3e56e/.github/workflows/stress.yml).
- Inngest separates race-enabled unit tests from split end-to-end suites, runs real service
  processes with different storage modes, and uploads coverage, test results, and failure logs.
  See its [Go CI](https://github.com/inngest/inngest/blob/385708c00e044a0669abe031ea03bfaca05da713/.github/workflows/go.yaml)
  and [E2E workflow](https://github.com/inngest/inngest/blob/385708c00e044a0669abe031ea03bfaca05da713/.github/workflows/e2e.yml).

Durlo should copy those principles at its own scale. It does not need Temporal replay tests because
Durlo explicitly uses checkpoints rather than full deterministic replay.

## Test Layers

### 1. Pure unit and contract tests

Run without Postgres and finish in seconds.

Cover:

- validation boundaries and invalid values;
- serialization round trips and rejected values;
- retry normalization, caps, exponential overflow, and deterministic jitter boundaries;
- task/workflow option precedence;
- worker lifecycle and registration validation;
- worker decisions using a strict in-memory adapter spy;
- type-level API examples using `tsc`, including expected compile failures.

Use fake timers only for JavaScript timers. Never fake Postgres time in an adapter test. Backoff
randomness must accept or expose a deterministic random source so tests do not depend on luck.

### 2. Postgres adapter integration tests

These are the center of the v1 test strategy. Run every adapter operation against a real,
supported Postgres server and inspect both returned records and persisted rows.

For every adapter operation, test:

1. the valid transition;
2. invalid source states;
3. a repeated call;
4. wrong worker and stale lease tokens where ownership applies;
5. transaction rollback on an injected error;
6. two concurrent callers when the operation can race.

Keep integration files sequential if they share a database. Concurrency must be created explicitly
inside a test with separate pool clients and barriers, rather than relying on test-runner timing.
Avoid wall-clock sleeps: move `scheduled_at`, `locked_until`, or `fire_at` with SQL, then let
Postgres evaluate `now()` normally.

### 3. Black-box worker E2E tests

Exercise only public Durlo APIs plus database reads used as the test oracle. Use real worker loops
and real Postgres.

Required journeys:

- enqueue -> claim -> complete -> read output;
- throw -> retry with backoff -> terminal task/workflow state;
- checkpoint -> later failure -> re-entry skips completed step;
- sleep -> worker restart -> timer fire -> resume;
- cancel pending, running, sleeping, and retry-scheduled work;
- manual retry after task dead-letter and workflow failure;
- delayed and priority ordering among eligible runs;
- separate workers registering disjoint resources;
- graceful stop and restart.

### 4. Multi-process fault-injection tests

Use child-process worker fixtures so the test can terminate a worker without running its cleanup.
Each fixture must announce deterministic checkpoints to the parent process.

Kill at least at these boundaries:

- after claim, before user code;
- while user code is running;
- after a simulated external side effect, before completion persistence;
- after a workflow step checkpoint, before run completion;
- while lease renewal is active;
- while a workflow is sleeping.

Assert that expired work is reclaimed, stale completion/failure is rejected, attempt history is
honest, and external side effects may occur more than once. The side-effect test should prove and
document at-least-once behavior rather than pretend to provide exactly-once execution.

### 5. Contention, property, and stress tests

Run a seeded scenario generator over public operations and compare the final database state with a
small reference model. Always print and retain the seed on failure.

Core conservation properties:

- one idempotency identity maps to at most one run;
- a run has at most one current lease token;
- a stale token never changes run, step, timer, or attempt state;
- a terminal run is never claimable;
- every active attempt belongs to the current lease;
- successful completed steps do not execute again after re-entry;
- cancellation prevents future claims and timer resumes;
- failure-budget exhaustion uses failed/timed-out/stalled attempts, not sleep re-entry claims;
- after workers stop and leases expire, every created run is terminal, sleeping on a valid timer,
  or eligible for future work. Nothing is silently stranded.

Run repeated contention with multiple workers claiming the same resource, concurrent idempotent
creates, cancel-versus-complete, cancel-versus-fail, timer-fire-versus-cancel, manual-retry races,
and claim-versus-lease-expiry cleanup. Keep performance benchmarks separate from correctness stress
tests so a slow shared runner does not look like a semantic failure.

### 6. Migration, packaging, and compatibility tests

Cover the way users actually consume Durlo:

- migrate an empty database;
- migrate twice and concurrently;
- migrate from every previously released schema fixture;
- fail partway through a migration and verify transactional recovery;
- run with an application role that has only documented permissions;
- build package tarballs, install them into a temporary consumer project, and test ESM, CJS, and
  TypeScript imports;
- run the quickstart against packed artifacts, not workspace source;
- test the declared minimum and newest supported Node and Postgres versions.

PgBouncer transaction-mode compatibility belongs in a nightly or release lane once Durlo declares
it supported. No transaction may remain open while user code runs.

### 7. AI-agent exploratory QA

AI agents are useful for finding scenarios humans did not encode, especially once the CLI and
dashboard exist. They are not a merge gate and do not replace deterministic tests.

Give each agent:

- a fresh database or unique app id;
- a packed Durlo build and public documentation;
- one charter, such as quickstart usability, worker crash recovery, cancellation races, invalid
  inputs, or dashboard/CLI consistency;
- permission to inspect database state but not rewrite it to manufacture success;
- a structured report containing commands, observed state, expected state, timestamps, logs, and
  a reproducible seed where applicable.

Every confirmed agent finding must become a normal regression test before it is considered fixed.
Run agent charters before releases and after large API or operational changes.

## V1 Scenario Matrix

Maintain a machine-readable or reviewable scenario ledger with a stable id for each row. A compact
starting matrix is below; each row expands into happy, invalid-state, repeat, stale-owner, rollback,
and race cases where applicable.

| Area         | Required scenarios                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creation     | validation, serialization, delay/runAt, priority, idempotency scope, empty/duplicate/atomic batch, caller transaction commit and rollback            |
| Claim        | due boundary, priority/FIFO, app/resource filter, limit, `SKIP LOCKED`, simultaneous workers, expired lease reclaim, exhausted stalled attempt       |
| Lease writes | extend, complete, fail, release with current/wrong/stale token; cancellation or reclaim between execution and write                                  |
| Worker       | concurrency cap, start/stop/restart, no resources, input/output failure, thrown non-Error, timeout, heartbeat success/false/error                    |
| Retry        | fixed/exponential/jitter/cap, exact attempt exhaustion, timed-out and stalled accounting, sleep claims excluded from failure budget                  |
| Steps        | success/undefined/serialized result, failure and re-entry, duplicate/nested ids, step/timer id collision both directions, ownership loss during step |
| Timers       | future/due boundary, idempotent creation, fired re-entry, cancellation, fire/cancel race, terminal owner never resumed, firing limit                 |
| Controls     | get/not found, cancel matrix for every status, repeat cancel, manual retry matrix for every kind/status, concurrent controls                         |
| Migrations   | fresh, repeat, concurrent, prior-version upgrade, rollback, restricted role                                                                          |
| Delivery     | packed ESM/CJS/types, quickstart, supported Node/Postgres matrix, clean shutdown, no transaction held during user code                               |

## CI Lanes

### Pull requests

Required and fast:

1. formatting/lint, typecheck, and build;
2. pure unit and type-contract tests;
3. all integration tests against a real Postgres service with no conditional skip;
4. a small two-worker E2E and crash-reclaim smoke suite;
5. packed-package consumer smoke test;
6. coverage report and test-result artifact.

Use one canonical Node/Postgres pair for the full PR suite. The suite is currently small enough that
real Postgres tests should run on every pull request.

### Nightly

- declared Node/Postgres compatibility matrix;
- seeded concurrency scenarios across many seeds;
- repeated race and crash tests;
- one longer multi-worker soak;
- PgBouncer compatibility when supported;
- mutation testing for core decision logic;
- logs, database diagnostics, seed, and test results uploaded even on failure.

### Release

- full PR and nightly suites;
- upgrade from every released migration fixture;
- install and quickstart from the exact release tarballs;
- AI-agent exploratory charters;
- no ignored flaky test without an owner and tracked issue.

## Coverage And Mutation Policy

Coverage is a guardrail, not the definition of correctness.

1. Record the current unit-plus-integration baseline.
2. Set an initial floor that the current meaningful suite meets.
3. Reject coverage regressions and ratchet floors upward as gaps are filled.
4. Track branches separately; state-machine bugs often live in an untested branch of covered code.
5. Require complete scenario-ledger coverage for lease safety, idempotency, cancellation, timers,
   retry accounting, and transaction atomicity regardless of the numeric percentage.

Use mutation testing on pure core logic. For persistence safety, also maintain a small manual
mutation audit: remove a `lease_token` predicate, remove a status predicate, change an expiry
comparison, remove `SKIP LOCKED`, or split an atomic transaction. The suite must fail for every one
of those mutations.

## Implementation Order

### Phase 0: make the current truth visible

- split scripts into `test:unit`, `test:integration`, `test:e2e`, and `test:all`;
- make `test:integration` fail clearly when its database is unavailable instead of skipping;
- add a disposable local Postgres command and a required Postgres CI job;
- enable coverage and test-result reporting;
- document exact local commands.

### Phase 1: complete the state machine

- create shared factories, database assertions, and concurrency barriers;
- split the single Postgres test file by creation, claims/leases, steps, timers, and controls;
- implement the scenario matrix, starting with wrong/stale ownership and forbidden states;
- add simultaneous claim, idempotency, cancel, timer, and retry races.

### Phase 2: prove failure behavior

- add child-process workers and deterministic crash checkpoints;
- test heartbeat loss and database disconnects;
- add the seeded model/property runner;
- add manual persistence-safety mutation checks.

### Phase 3: prove delivery and upgrades

- add migration fixtures and restricted-role tests;
- add packed-package consumer and quickstart tests;
- add supported runtime/database nightly matrices;
- add release AI-agent QA charters when Slice 7 exists.

## Merge Standard

A change to execution semantics is ready only when:

- docs and the scenario ledger describe the behavior;
- the happy path and relevant failure paths are automated;
- ownership-sensitive changes include stale-token and cancellation/reclaim coverage;
- SQL changes include rollback and contention coverage;
- all required Postgres tests actually ran;
- any expected at-least-once duplication is explicit in the assertion and documentation.
