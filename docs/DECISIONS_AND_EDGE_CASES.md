# Durlo Decisions And Edge Cases

Status: Current
Updated: 2026-07-20

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
timer time, row locking, and transactional run creation. User code never runs inside a Durlo-held
database transaction.

Polling is the required wakeup mechanism. `LISTEN/NOTIFY` may someday reduce latency but cannot be
the correctness path because notifications are not durable.

## Atomic creation is the product wedge

The important differentiator is committing application data and its background work in the same
database transaction, without an outbox relay. An API that silently accepts a non-transactional
connection invalidates that differentiator and is therefore a release blocker, not a minor type
issue.

Durlo should own or strongly type the transaction boundary so correct use is the default and misuse
fails immediately.

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

## Idempotency identifies logical creation

An idempotency key is scoped by app, resource kind, and resource id. Resource version is excluded so
a deployment does not authorize duplicate logical work. The reservation lasts as long as the run
row.

The public result must eventually distinguish created from deduplicated work and prevent accidental
reuse with incompatible input/options. Silent conflict acceptance is not an acceptable long-term
contract.

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

Versions are routing compatibility tokens, not necessarily package or semantic versions. Durlo
does not rewrite old inputs or checkpoints during deployment.

## Cancellation and timeout are cooperative

Node.js cannot safely terminate arbitrary in-process JavaScript. Cancellation and timeout abort a
signal and fence later durable writes; handlers must observe the signal. External effects remain
the application's responsibility.

CPU-heavy work can block heartbeat timers. V1 must either state that only cooperative I/O-oriented
handlers are supported or add execution isolation before making broader production claims.

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

## Limits and retention are explicit

Inputs, outputs, errors, batches, step results, and workflow step/sleep counts have configurable
bounds. Values that affect later execution are persisted with the run.

Retention is manual and app-scoped. Deleting a terminal run also deletes its attempt/checkpoint
history and releases its idempotency key. Durlo will not add a hidden cleanup scheduler in v1.

## Public API before adapters

Raw `pg` remains the canonical integration until transaction ownership and adapter semantics are
stable and covered by a conformance suite. Drizzle is the first planned client integration; Prisma,
Kysely, frameworks, and other storage engines depend on demonstrated demand and equal guarantees.

## Documentation ownership

- public runtime behavior and limitations: `EXECUTION_SEMANTICS.md`
- current internal design: `ARCHITECTURE.md`
- deployment and database guidance: `OPERATIONS.md`
- implementation order: `ROADMAP.md`

Do not create a new top-level document for a subject owned by one of those files. Code and tests are
the final authority; documentation must be corrected in the same change whenever behavior moves.
