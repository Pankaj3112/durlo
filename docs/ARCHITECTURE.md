# Durlo Architecture

Status: Current
Updated: 2026-07-20

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

```txt
@durlo/core       definitions, validation, retries, workflow tools, worker, read API
@durlo/postgres   schema migrations and PostgreSQL state transitions
@durlo/cli        config loading, process lifecycle, and local dashboard
```

Core depends on an adapter contract rather than PostgreSQL. The Postgres adapter never imports
user definitions. The CLI uses the same core worker and read/control APIs as library consumers; it
does not implement another execution state machine.

## Durable records

The schema in `packages/postgres/src/migrations.ts` contains:

- `durlo_runs`: scheduling state, current status, input/output/error, lease, and retained summary
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

`worker.stop()` stops new claims and timer promotion. The promise returned by `worker.start()`
settles after active executions drain. `worker.getHealth()` describes only that process;
`durlo.runs.getBacklogHealth()` describes stored work for one app; and
`worker.getCompatibilityReport()` compares active stored work with one worker's registrations.

## Transactions and adapters

`durlo.tx(client)` creates a transactional adapter bound to a caller-provided object with a
`query()` method. Durlo does not begin, commit, or roll back the caller transaction.

The current runtime check cannot distinguish an active `pg.PoolClient` transaction from a
`pg.Pool` or a client outside `BEGIN`. Atomic application-write plus run creation therefore depends
on correct caller usage until the transaction API is replaced. The exported `PostgresAdapter`
constructor also accepts a caller-owned pool, but `close()` currently ends it; ownership is not yet
tracked.

## Reads, controls, and cleanup

Run list uses app-scoped keyset pagination. Run details read the run, steps, attempts, and timers in
one short repeatable-read transaction, then core derives a timeline and diagnostics. Backlog health
aggregates active state using the PostgreSQL clock.

Cancellation and manual retry are app-scoped storage transitions. Retention cleanup deletes a
bounded set of terminal parent runs and cascades to their steps, timers, and attempts. There is no
automatic cleanup scheduler.

## Source of truth

- public surface and records: `packages/core/src/types.ts`
- client behavior: `packages/core/src/client.ts`
- worker behavior: `packages/core/src/worker.ts`
- workflow checkpoints: `packages/core/src/steps.ts`
- derived diagnostics: `packages/core/src/observability.ts`
- PostgreSQL transitions: `packages/postgres/src/adapter.ts`
- schema: `packages/postgres/src/migrations.ts`
