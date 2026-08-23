# Durlo Operations

Status: Current pre-release guidance
Updated: 2026-08-23

Durlo has no supported production release yet. This document records the operating behavior that
exists and the boundaries exercised by the repository.

## Tested environment

- Node.js 22 through 26
- PostgreSQL 14 through 18
- ESM, CommonJS, and strict TypeScript package consumers

CI runs Node 22 with PostgreSQL 17. Nightly tests the boundary cells Node 22, 24, and 26 against
PostgreSQL 14 and 18. These are tested repository boundaries, not a support commitment for a
published package.

## Process layout

Use separate application, migration, and worker processes:

```txt
application/API    creates business rows and Durlo runs
migration job      runs `durlo migrate` before new workers
worker processes   run `durlo worker` with explicit registrations
PostgreSQL         stores application and Durlo state
```

`durlo dev` runs migrations, a worker, and the local dashboard together. It is a development
command, not a production deployment shape.

The CLI loads the first `durlo.config.ts`, `.mts`, `.js`, `.mjs`, or `.cjs` in the current directory
unless `--config`/`-c` is provided. A config exports one `Durlo` instance, explicit task/workflow
registrations, and optional worker/dashboard settings.

## Migrations

Run `durlo migrate` once as a deployment step with a schema-owner connection before starting
workers that require the new schema. `durlo worker` does not migrate automatically.

Migrations run in one transaction under a transaction-scoped advisory lock. Current index changes
are not created concurrently, and no lock or statement timeout is supplied by Durlo. On large live
tables, review migration SQL and schedule an appropriate maintenance window. Migration versions are
stored, but their checksums are currently enforced by repository tests rather than stored in the
database.

Migration `0005_truthful_step_interruptions` expands the step-status constraint and repairs
attributable stale step history from the matching run attempt and lease. It preserves a currently
active step owned by the parent run's lease and any later completed checkpoint. The constraint
change and backfill take ordinary table locks, so assess the affected table sizes before rollout.

Migration `0006_serialization_versions` permits the reserved PostgreSQL resource-version token used
to route codec-v2 runs. It does not rewrite existing rows. Apply it first, then deploy new workers,
then switch producers to the new package. New workers continue to claim legacy rows; old workers
continue legacy work but cannot claim newly written codec-v2 rows.

Migration `0007_idempotency_comparison_metadata` adds the transformed-input, normalized-execution,
schedule-intent, and resource-version fields used to verify compatible idempotency reuse. Existing
rows without those fields are intentionally not guessed to be compatible; reuse reports
`legacy_unverifiable` and makes no mutation.

The runtime role requires normal read/write access to Durlo tables and sequences but should not own
the schema.

## Connections and concurrency

Two independent limits matter:

1. worker execution slots (`concurrency`, default 10, accepted range 1–1,000);
2. PostgreSQL pool capacity (`max`, controlled by `pg`).

Each worker has a claim loop, a timer loop, and heartbeat/persistence queries for active runs. Pool
connections are shared rather than reserved. A saturated pool can delay heartbeats and cause false
lease loss even when the database is healthy.

Start conservatively:

- keep concurrency near the expected number of simultaneously useful I/O operations;
- give the pool headroom above normal claim, timer, heartbeat, and completion demand;
- budget the sum of every API, worker, migration, dashboard, and administrative pool against the
  PostgreSQL connection limit;
- alert on sustained `pool.waitingCount`, not brief bursts alone;
- configure connection, query, and statement timeouts in the supplied `pg` options where needed.

`postgresAdapter(config)` constructs an owned pool; calling `adapter.close()` more than once is safe
and ends that pool once. `postgresAdapter({ pool })` borrows a caller-supplied `pg.Pool`; closing the
adapter never calls `pool.end()`, so the caller remains responsible for the pool lifecycle. This is
the supported way to share application pool capacity with Durlo.

Each `durlo.transaction(...)` call checks out one client for `BEGIN`, application SQL, Durlo inserts,
and `COMMIT` or `ROLLBACK`, then releases it. Account for that checked-out client when sizing a
shared pool. Do not release the client inside the callback; the exposed surface intentionally omits
`release()`.

## Polling and latency

The default `pollInterval` is one second. Each worker polls both runs and timers, so idle database
traffic grows linearly with worker replicas. Pickup and timer latency include the polling interval,
pool wait, query time, and available execution capacity.

`pollInterval` and `leaseDuration` must be greater than zero. All timer-backed durations are finite
and at most `2_147_483_647` milliseconds, the safe Node.js timer range. Retry backoff delay and
maximum delay follow the same bound and must be positive. A run schedule may use `delay: 0`, which
is the valid immediate schedule; invalid dates and oversized delays are rejected before insertion.
Durlo provides no pickup-latency or timer-lag SLA.

Polling failures use bounded exponential backoff with jitter. Heartbeat query errors are treated as
immediate lease loss rather than retried under the existing lease.

## Leases and user code

The default `leaseDuration` is 30 seconds and heartbeats occur at roughly one third of it. Choose a
lease long enough to cover normal event-loop delay, pool waiting, network interruption, database
latency, and failover; choose it short enough to meet crash-recovery objectives.

Handlers run in-process. CPU-bound synchronous work blocks heartbeat and timeout timers. Timeouts
and cancellation only abort a signal; work that ignores it can continue and overlap a retry.
External effects must be idempotent.

Graceful shutdown calls `worker.stop()`, stops claims and timer promotion, and waits for active work
through the outstanding `worker.start()` promise. Allow enough process termination grace for the
longest cooperative handler.

## Deployment compatibility

For a Durlo package rollout that introduces a new persisted codec, apply its migration and deploy
new workers before new producers. Codec routing prevents old workers from claiming rows they cannot
decode while allowing new workers to finish legacy work.

Definition versions are exact compatibility tokens. For a breaking change from version `1` to `2`:

1. deploy workers that register version 2;
2. switch producers to the version-2 definition;
3. keep version-1 workers while version-1 work is pending, running, or sleeping;
4. inspect reports from the complete worker fleet before removing old code.

Manual retry preserves the original version. Restore matching code before retrying an old terminal
run. A version bump does not change idempotency scope; an existing key still returns its original
run.

## What to monitor

At minimum collect:

- `worker.getHealth()` lifecycle, active slots, claim/timer failures, and last successful polls;
- `durlo.runs.getBacklogHealth()` ready lag, delayed work, expired leases, due timers, and timer lag;
- `worker.getCompatibilityReport()` from every registration set in the fleet;
- structured `run.lease_lost`, `run.persistence_failed`, database retry, and transition logs;
- `pool.totalCount`, `pool.idleCount`, and sustained `pool.waitingCount`;
- PostgreSQL query latency, CPU, I/O, active connections, lock waits, dead tuples, and WAL volume;
- terminal-history growth and cleanup duration.

`worker.getHealth().database.healthy` is true only when consecutive claim, timer, and execution
persistence failures are all zero. Inspect `persistenceFailures` and
`lastSuccessfulPersistenceAt` alongside the polling timestamps. A confirmed durable run
outcome—completion, failure/retry, sleep, or release—resets persistence failures; claim/timer polls,
lease loss, stale-write suppression, and handler-only failures do not. The CLI and local dashboard
serialize these fields in their health JSON.

Run detail and timelines are diagnostic snapshots, not a complete event log. A displayed `running`
step attempt should have a currently running parent run with the same lease; interruption close
events are derived from the retained attempt records.

## Local dashboard security

The dashboard defaults to `127.0.0.1:3210` and exposes full inputs, outputs, errors, health, cancel,
and retry. It has no authentication. Same-origin checks are not authentication, and requests without
an `Origin` header are accepted.

Do not bind it publicly. If access beyond loopback is unavoidable, use an authenticated trusted
reverse proxy, TLS, network restrictions, and application-level payload redaction.

The browser polls list, health, compatibility, and selected-run detail every three seconds; account
for that read traffic during local diagnosis.

## Retention

Durlo never schedules cleanup. Run it from an operator-controlled process:

```ts
await durlo.runs.cleanup({
  olderThan: "30d",
  limit: 1_000,
  statuses: ["completed", "failed", "dead_letter", "cancelled"]
});
```

The operation is app-scoped, terminal-only, oldest-first, and protected with row locks plus
`SKIP LOCKED`. Repeat while `limitReached` is true and pause between batches under load.

Deletion cascades through attempts, steps, and timers and releases idempotency keys. The limit
counts parent runs, not child rows or bytes; one batch can still generate substantial WAL and
autovacuum work. Back up history first when audit retention matters.

## Performance evidence

Run `pnpm benchmark:local` for the query-plan regression harness. Its default deterministic dataset
contains 50,000 runs; `DURLO_BENCHMARK_RUNS`, `DURLO_BENCHMARK_SAMPLES`, and
`DURLO_BENCHMARK_MAX_MS` configure it. At 50,000 or more rows it also asserts the intended claim,
attempt, timer, list, detail, and backlog indexes.

The harness uses `EXPLAIN (ANALYZE, BUFFERS)` for selector/read queries. It excludes network time,
pool waiting, the per-run updates and inserts inside claim transactions, user execution, payload
size, cleanup, and end-to-end throughput. Passing it is not a jobs-per-second or capacity claim.

Before production use, measure realistic retained history, eligible-work distribution, resource
registrations, payloads, connection contention, workflow length, failures, and outage recovery on
the intended infrastructure.

## Incident recovery

After a worker or database interruption:

1. confirm claim, timer, and persistence success timestamps advance again;
2. inspect ready lag, expired leases, and due timer lag;
3. check compatibility across the full worker fleet;
4. inspect stalled attempts and business idempotency records for possible duplicate effects;
5. keep compatible workers running until work is terminal, intentionally delayed, or sleeping on a
   future timer.

A failed heartbeat can leave the stored run `running` until its lease expires. That interval is
expected. Once recovery, timeout, or cancellation commits, the old owned step and attempt should be
terminal. Treat any unexplained active step beneath a terminal run as an integrity incident.
