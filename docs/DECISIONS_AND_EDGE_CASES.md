# Durlo Decisions And Edge Cases

Status: Current
Updated: 2026-08-23

This file records decisions that should survive refactors. It explains why Durlo has its current
boundary; it does not repeat every API rule or track unfinished work.

## Direct tasks and workflows first

V1 exposes `task.enqueue(input)` and `workflow.start(input)`. It does not add event ingestion,
trigger matching, cron, or wait-for-event behavior.

Events and schedules require separate durable identities, deduplication, matching, failure,
retention, and operating semantics. They are not small convenience methods. The narrow direct API
must be trustworthy before those systems are considered.

## PostgreSQL is the coordination system

Durlo targets applications already using PostgreSQL. PostgreSQL owns run eligibility, lease time,
timer time, row locking, and transactional run creation. The application transaction callback runs
inside a Durlo-held transaction; task and workflow handlers never do.

Polling is the required wakeup mechanism. `LISTEN/NOTIFY` may someday reduce latency but cannot be
the correctness path because notifications are not durable.

Result waiting therefore polls app-scoped reads and never holds a connection between polls. New
completions store private output-kind metadata because TypeScript generics do not exist at runtime:
`undefined` and JSON `null` must be distinguished durably. Legacy rows without that metadata return
their existing decoded output; guessing would silently change old behavior.

## Atomic creation is the product wedge

The important differentiator is committing application data and its background work in the same
database transaction, without an outbox relay. An API that silently accepts a non-transactional
connection invalidates that differentiator and is therefore a release blocker, not a minor type
issue.

Durlo owns the raw-`pg` transaction lifecycle through `durlo.transaction(callback)`. It acquires and
releases one client, begins before the callback, commits only after success, and attempts rollback
for every failure after acquisition. The callback receives a query-only client surface and
transaction-scoped creation operations, all bound to that same client. Callers cannot pass an
arbitrary pool or unverified client as a transaction.

Pools built from connection configuration are Durlo-owned. Caller-supplied pools are borrowed and
remain usable after the adapter closes. Task and workflow handlers never execute inside the
transaction callback.

## Execution is at-least-once

A worker can perform an external effect and die before persisting success. No lease, retry, or
idempotency-key implementation can make an arbitrary external effect exactly once.

Durlo must preserve:

- a unique lease token per claim;
- token checks on running-state writes;
- recovery of expired work;
- durable evidence for failed, timed-out, stalled, and cancelled attempts;
- documentation and examples that use business or provider idempotency.

Late local JavaScript may continue after timeout or lease loss, but it must not write durable
success after another claim rotates ownership.

Intentional failure controls are exact branded values. `PermanentError` stops automatic retry;
`RetryError` carries one normalized directed time. Both consume the current failure budget, retain
lease-token fencing, and persist ordinary structured error history. Names and shapes are forgeable,
so lookalikes and subclasses deliberately receive ordinary failure handling. Cancellation,
timeout, and a rotated lease remain authoritative when they win a race.

## Idempotency identifies logical creation

An idempotency key is scoped by app, resource kind, and resource id. Resource version is excluded so
a deployment does not authorize duplicate logical work. The reservation lasts as long as the run
row.

Every creation surface returns `{ run, created }`; `created` is the single-call insertion result.
Batch items are explicit `{ input, options? }` records so a business payload cannot be mistaken for
metadata. A duplicate key compares resource version, schema-transformed durable input, normalized
execution options, and canonical schedule intent. Incompatible reuse throws
`IdempotencyConflictError` with sorted mismatch categories and does not mutate the original row.
Rows from before the comparison metadata migration are explicitly `legacy_unverifiable`, never
silently accepted. The key uniqueness scope remains app + kind + resource + key so version changes
do not create duplicate logical work.

## Workflows use checkpoints, not replay

Durlo workflows re-enter normal code from the top. `step.run` persists successful results;
`step.sleep` persists timers. Durlo does not record or replay every branch, local variable, promise,
or side effect.

Consequences:

- completed step results must drive later durable branching;
- step ids must be stable and retain their meaning;
- step calls remain sequential and non-nested in v1;
- top-level workflow code must be safe to run again;
- stored inputs and step results define deployment compatibility.

Per-step retry policies and fan-out/fan-in graphs are deferred until run-level workflows and their
attempt accounting are stable.

## Compatibility is explicit

Each definition has an opaque version, defaulting to `"1"`. Workers claim exact kind/id/version
matches. Breaking code gets a new version, and old workers remain available for old active runs.

Versions are routing compatibility tokens, not necessarily package or semantic versions. A
Standard Schema may transform creation input before it is stored; an incompatible change to that
persisted output requires a new resource version. Durlo does not rewrite old inputs or checkpoints
during deployment, and workers trust persisted input rather than revalidating it.

Persisted codec generations are separate internal routing compatibility. Existing PostgreSQL rows
keep their legacy codec and resource version; new rows use a reserved storage token that maps back
to the same public resource version. New workers claim both generations, while older workers cannot
claim rows written with a codec they do not understand.

Package semantic versions are a different contract. Alpha APIs may break between prereleases only
with changelog or migration-note disclosure. Starting at `1.0`, documented runtime/type exports,
configuration, CLI behavior, and supported Node.js/PostgreSQL ranges follow Semantic Versioning.
Breaking changes require a major; deprecations survive until a later major; dropping a supported
runtime or database major is breaking. Released migrations are immutable and later schema changes
move forward with explicit code/schema rollout requirements. These promises do not convert
at-least-once execution into exactly once or imply production support.

The first package release is `0.1.0-alpha.0` under a one-version policy for `@durlo/core`,
`@durlo/postgres`, and `@durlo/cli`. Its Node.js 22-through-26 and PostgreSQL 14-through-18 matrix
describes installation/runtime compatibility only; it is not a production-support promise or
measured operating envelope.

## Cancellation and timeout are cooperative

Node.js cannot safely terminate arbitrary in-process JavaScript. Cancellation and timeout abort a
signal and fence later durable writes; handlers must observe the signal. External effects remain
the application's responsibility.

CPU-heavy work can block heartbeat timers. V1 must either state that only cooperative I/O-oriented
handlers are supported or add execution isolation before making broader production claims.

## Timing and health are bounded

Timer-backed durations use the safe Node.js maximum of `2_147_483_647` milliseconds. Polling,
lease, and retry backoff intervals must be positive; immediate scheduling with `delay: 0` is valid.
Retry calculation saturates rather than overflowing. Worker health keeps polling failures separate
from unresolved execution persistence failures and only clears the latter after a confirmed durable
outcome: completion, failure/retry, sleep, or release. Lease loss and stale-write suppression are
ownership outcomes, not database-health successes or failures.

## Concurrency is process-local in v1

`worker.concurrency` limits active executions in one worker process. Fleet concurrency is the sum
of worker capacities. V1 does not promise global, resource, tenant, or queue limits.

Distributed concurrency, rate limiting, throttling, and fairness belong after the first narrow
release. Priority is descending among eligible work and can starve lower values.

## History is derived from execution records

V1 uses runs, steps, timers, and attempts as both execution state and inspection evidence. It does
not add a second event-history system for the dashboard. Timelines may explain only facts retained
in those records and must not imply Temporal-style replay.

Attempt state must remain truthful. A terminal run with an unexplained `running` step attempt is a
correctness defect because it makes the chosen evidence model unreliable.

Lease reclaim, attempt timeout, cancellation, and ordinary failure transition the active step
attempt and its `durlo_steps` row to `stalled`, `timed_out`, `cancelled`, or `failed` in the same
transaction as the run transition. The transition is scoped to the interrupted lease token.
Re-entry creates a new numbered step attempt; a completed checkpoint always takes precedence over
older interruption evidence and is never downgraded.

## Limits and retention are explicit

Inputs, outputs, errors, batches, step results, and workflow step/sleep counts have configurable
bounds. Values that affect later execution are persisted with the run.

Retention is manual and app-scoped. Deleting a terminal run also deletes its attempt/checkpoint
history and releases its idempotency key. Durlo will not add a hidden cleanup scheduler in v1.

## Public API before adapters

Raw `pg` is the only v1 transaction integration. The transaction-provider seam stays internal;
there is no public generic adapter SDK. Drizzle is the first possible later client integration;
Prisma, Kysely, frameworks, and other storage engines depend on demonstrated demand and equal
guarantees.

Package root exports are exact allowlists rather than wildcard snapshots. Official definitions use
private registration instead of `_durlo`; codecs, limits/normalization helpers, registered resource
internals, adapter/provider contracts, and CLI lifecycle helpers stay out of public entry points.
The CLI executable owns init, migration, worker, and dev behavior; only `defineConfig` and its
configuration types are programmatic CLI API.

## Documentation ownership

- public runtime behavior and limitations: `EXECUTION_SEMANTICS.md`
- current internal design: `ARCHITECTURE.md`
- deployment and database guidance: `OPERATIONS.md`
- implementation order: `ROADMAP.md`

Do not create a new top-level document for a subject owned by one of those files. Code and tests are
the final authority; documentation must be corrected in the same change whenever behavior moves.
