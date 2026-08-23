# Durlo Architecture

Status: Current
Updated: 2026-08-24

This document describes the implementation that exists today. Public behavior belongs in
[Execution Semantics](EXECUTION_SEMANTICS.md), deployment guidance in
[Operations](OPERATIONS.md), durable rationale in
[Decisions And Edge Cases](DECISIONS_AND_EDGE_CASES.md), and future work in the
[Roadmap](ROADMAP.md).

## Product boundary

Durlo is a TypeScript library for direct tasks and direct workflows in applications that already
use PostgreSQL. It is embedded in application and worker processes; it is not a hosted service.

```txt
application process                 worker process
task.enqueue / workflow.start       registered definitions
            \                           /
             \                         /
              PostgreSQL durable state
          runs / steps / timers / attempts
```

Creating a run never executes user code. A worker must register the exact resource kind, id, and
compatibility version before it can claim that run.

## Packages

The root workspace and all three public packages use the one-version release policy. The first
complete alpha version is `0.1.0-alpha.1`; the incomplete core-only `alpha.0` is superseded.
Resource definition versions remain independent routing tokens.

```txt
@durlo/core       definitions, validation, retries, workflow tools, worker, read API
@durlo/postgres   schema migrations and PostgreSQL state transitions
@durlo/cli        config loading, process lifecycle, and local dashboard
```

Core depends on an adapter contract rather than PostgreSQL. The Postgres adapter never imports
user definitions. The CLI uses the same core worker and read/control APIs as library consumers; it
does not implement another execution state machine.

Package root indexes are explicit allowlists. Core keeps adapter/storage protocols in internal
types, and task/workflow handler registration lives in module-private `WeakMap` registries rather
than `_durlo` or another forgeable public property. CLI configuration carries public definition
objects; worker construction resolves them through that private registry and rejects imitations.

## Durable records

The schema in `packages/postgres/src/migrations.ts` contains:

- `durlo_runs`: scheduling state, current status, input/output/error, lease, retained summary,
  internal serialization-generation and output-kind metadata, and idempotency comparison metadata
- `durlo_steps`: workflow checkpoint state and result
- `durlo_timers`: durable sleep state
- `durlo_attempts`: run and step execution evidence
- `durlo_schema_migrations`: applied migration versions

PostgreSQL `now()` decides eligibility, lease expiry, cleanup age, and timer readiness. Active queue
state and retained history share the same tables.

## Run ownership

Workers poll for pending due runs and expired leases using short transactions and
`FOR UPDATE SKIP LOCKED`. Each claim writes a worker id, a unique lease token, and an expiry. The
worker renews the lease while executing user code outside a database transaction.

Completion, failure, release, checkpoint, and sleep writes verify the current lease token. Once a
new claim rotates that token, writes from the older worker are rejected. This fences durable state;
it cannot prevent a late external side effect.

Workflow sleep and lease-loss control flow is represented by module-private identity signals rather
than public error classes or forgeable names. The Postgres adapter uses the same private lease-loss
identity for its storage errors; the worker never trusts an error's public name or shape.

Intentional handler outcomes use separately branded exact `PermanentError` and `RetryError`
instances. The worker checks both private brand membership and exact prototype identity. A
subclass, copied shape, or matching `name` cannot enter control flow. Step callbacks persist the
structured error before rethrowing it to the run-level decision.

Claiming currently selects a bounded group and then performs failure counts, state updates, and
attempt inserts sequentially for each run while row locks remain held. Timer promotion and batch
creation also perform per-record queries. The selector benchmark does not measure these full
transactions or end-to-end throughput.

## Tasks

```txt
pending -> running -> completed
                   -> pending retry -> running
                   -> dead_letter
                   -> cancelled
```

Tasks execute in the worker's Node.js process. Timeouts and cancellation use `AbortSignal`; Durlo
does not terminate arbitrary JavaScript. CPU-bound or signal-ignoring work can block heartbeats or
continue after a timeout.

## Workflows

Workflow code re-enters from the top after a retry, crash, or sleep. `step.run(id, fn)` stores a
successful result and returns it without running `fn` again on later entry. `step.sleep` and
`step.sleepUntil` store a timer and move the run to `sleeping`; a separate worker polling loop fires
due timers and returns the run to `pending`.

V1 requires sequential, non-nested `step.*` calls. Durlo stores checkpoints, not a Temporal-style
event history, so local variables and non-checkpointed reads are not replayed.

An active step row is backed by a running attempt that carries the parent run's current lease
token. Lease reclaim, timeout, cancellation, and ordinary failure close both records inside the
run-transition transaction as `stalled`, `timed_out`, `cancelled`, or `failed`. Re-entry increments
the step's attempt count and inserts a new attempt; interruption handling never downgrades a
completed checkpoint.

## Worker loops

One worker runs:

1. a claim loop that fills process-local execution slots;
2. a timer loop that promotes due workflow timers independently;
3. one serialized heartbeat loop per active run.

Both polling loops use the configured `pollInterval` and recover from query failures with bounded
backoff and jitter. Every worker currently polls timers even if it registers only tasks.

Execution persistence is tracked independently from polling. `persistenceFailures` counts consecutive
unresolved completion, failure, release, checkpoint, and sleep writes; lease-loss and stale-write
suppression do not count. `lastSuccessfulPersistenceAt` advances after a confirmed durable run
outcome (completion, failure/retry, sleep, or release), and `database.healthy` requires all three
failure counters to be zero. Claim/timer polls cannot mask an unresolved execution write.

`worker.stop()` stops new claims and timer promotion. The promise returned by `worker.start()`
settles after active executions drain. `worker.getHealth()` describes only that process;
`durlo.runs.getBacklogHealth()` describes stored work for one app; and
`worker.getCompatibilityReport()` compares active stored work with one worker's registrations.

Failure handling computes the consumed failure count first. Permanent outcomes select the normal
task/workflow terminal state immediately. Directed retries use their normalized timestamp only
while budget remains; exhaustion selects the same terminal state as an ordinary failure. Storage
transitions remain lease-token fenced, so cancellation, timeout, or lease rotation can defeat a
late intentional outcome without a stale write.

## Transactions and adapters

`durlo.transaction(callback)` asks the PostgreSQL adapter to acquire one pool client, execute
`BEGIN`, and expose a query-only raw-`pg` client plus transaction-scoped task enqueue, workflow
start, and task batch enqueue operations. Application statements and Durlo inserts therefore use
the same client. A successful callback is committed before its result is returned; any callback,
validation, serialization, batch, query, or commit failure triggers a rollback attempt. The client
is released once even when commit or rollback fails, and rollback failure does not replace the
primary error.

The callback never receives `release()`, and callers cannot bind arbitrary pools or clients as
transactions. Task and workflow handlers still execute later in workers, outside this transaction.
The adapter transaction-provider seam remains internal; raw `pg` is the only v1 integration.

An adapter built from PostgreSQL connection configuration owns its pool. An adapter built from a
caller-supplied `pg.Pool` borrows it. `close()` is idempotent and ends only an owned pool; closing a
borrowed adapter leaves the caller's pool usable.

## Reads, controls, and cleanup

Run list uses app-scoped keyset pagination. Run details read the run, steps, attempts, and timers in
one short repeatable-read transaction, then core derives a timeline and diagnostics. Backlog health
aggregates active state using the PostgreSQL clock.

Typed waiting uses repeated app-scoped single-run reads. Every poll acquires and returns a pool
connection through a normal query; no transaction or client is retained between polls. The adapter
returns internal output-kind and structured-error metadata alongside the public record. `value`
preserves JSON `null`, `undefined` returns JavaScript `undefined`, and absent metadata follows the
legacy decoded record without inference.

Cancellation and manual retry are app-scoped storage transitions. Retention cleanup deletes a
bounded set of terminal parent runs and cascades to their steps, timers, and attempts. There is no
automatic cleanup scheduler.

Creation metadata is persisted with each new run. The unique key remains app + kind + resource +
idempotency key, while a conflict compares resource version, transformed input, normalized
execution options, and canonical schedule intent. Migration `0007` adds these fields; rows without
them are returned as `legacy_unverifiable` conflicts rather than guessed compatible.

## Source of truth

- public surface and records: `packages/core/src/types.ts`
- client behavior: `packages/core/src/client.ts`
- private definition registration: `packages/core/src/definitions.ts`
- intentional outcome branding: `packages/core/src/outcomes.ts`
- worker behavior: `packages/core/src/worker.ts`
- workflow checkpoints: `packages/core/src/steps.ts`
- derived diagnostics: `packages/core/src/observability.ts`
- PostgreSQL transitions: `packages/postgres/src/adapter.ts`
- schema: `packages/postgres/src/migrations.ts`
