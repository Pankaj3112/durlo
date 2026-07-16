# Postgres Operations

Status: Current
Updated: 2026-07-16

This guide sizes a Durlo v1 worker against Postgres. It describes process-local execution concurrency, connection pools, polling, leases, and retention. It does not introduce a distributed concurrency limit.

## Two Independent Limits

`worker.concurrency` is the maximum number of run bodies executing in one worker process. The default is 10. If `W` worker processes each use concurrency `C`, the fleet may execute up to `W × C` runs at once.

The Postgres adapter's `max` option is the maximum number of database connections in that adapter's `pg` pool. `pg` defaults to 10 when `max` is omitted.

These values do not need to be equal. Durlo holds a connection only for a query or short transaction; it does not hold one while task or workflow user code runs. A worker with concurrency 8 and pool `max: 2` is covered by integration tests, including concurrent lease renewal and completion. A smaller pool queues database operations, however, so it can add checkpoint, completion, timer, and heartbeat latency.

```ts
const adapter = postgresAdapter({
  connectionString: process.env.DATABASE_URL,
  max: 12
});

const durlo = new Durlo({ id: "billing", adapter });

await durlo.worker({
  tasks: [sendInvoice],
  workflows: [settleInvoice],
  concurrency: 10,
  pollInterval: "1s",
  leaseDuration: "30s"
}).start();
```

## Starting Pool Size

For a dedicated worker adapter, use this as a starting point rather than a guarantee:

```txt
pool max = min(worker concurrency + 2, per-process connection budget)
```

The extra two connections allow claim and timer-promotion transactions to overlap ordinary run persistence. `concurrency + 2` also gives one connection per active slot during a synchronized burst of completions or checkpoints. Heartbeats can overlap those operations and will queue briefly; workloads with frequent durable steps may benefit from a larger measured pool.

Do not increase the pool merely because `worker.concurrency` is high. Long HTTP or queueing tasks can use many execution slots while doing little database work. Conversely, short workflows with many checkpoints can need more pool capacity at lower execution concurrency.

Pool `max: 2` is a reasonable lower starting bound for a continuously running worker because it lets the claim and timer loops make progress independently. `max: 1` remains semantically valid, but every claim, timer, heartbeat, step, and completion is serialized and lease headroom becomes more sensitive to a slow query.

Tune from observed saturation:

- Increase the pool gradually when `pool.waitingCount` remains above zero, query latency is healthy, and Postgres has connection and CPU headroom.
- Decrease the pool or worker concurrency when Postgres CPU, I/O, lock waits, or transaction latency rises.
- Decrease worker concurrency when the external service or Node process is the bottleneck; more database connections will not fix that.
- Run the [Postgres Performance Envelope](PERFORMANCE.md) on production-like storage before choosing a latency budget.

## Fleet Connection Budget

Every `postgresAdapter(...)` owns a `pg` pool. Budget the complete fleet, not one process:

```txt
Durlo connections = sum(adapter pool max across all application and worker processes)
```

Then add application query pools, migration/admin sessions, monitoring, and emergency access. Keep the total below the database or proxy connection limit with deliberate headroom. For example, four workers at `max: 12` can open 48 server connections before API processes are counted.

When an API process creates runs and also hosts a worker, sharing one adapter shares one pool budget. Separate adapters isolate pressure but their `max` values add together. Call `adapter.close()` only during process shutdown, after workers have drained.

PgBouncer transaction pooling fits the v1 worker query shape: Durlo uses short transactions and does not require session affinity while user code runs. Use a direct or appropriately privileged administrative connection for migrations. A caller-owned `durlo.tx(pgClient)` operation must remain inside the transaction associated with that checked-out client.

## Lease And Heartbeat Headroom

The default lease is 30 seconds. Each active run attempts renewal every one third of its lease duration. Renewals for one run are serialized. A failed renewal makes that worker abandon durable ownership; the run can be reclaimed after its stored lease expires.

Choose a lease duration comfortably above all of these:

- high-percentile Postgres query time
- time waiting for a pool connection during a synchronized burst
- expected network pauses or failovers
- Node event-loop stalls and garbage-collection pauses

Increasing `leaseDuration` reduces false stalls but delays crash recovery. Start with the 30-second default unless measurements justify a change. Alert on lease-loss logs and stalled attempts; either signal means the database, pool, network, or event loop missed the operational budget.

CPU-bound JavaScript blocks all heartbeats in its Node process. Split CPU-heavy work, use worker threads or another service, or place it in a separate worker process with an appropriately measured lease. A longer lease is safety margin, not a substitute for keeping the event loop responsive.

## Polling And Timer Lag

The default `pollInterval` is one second. When a queue is idle, a worker process normally polls claims and timers independently at roughly that interval. More worker processes therefore multiply idle polling load.

Lower intervals reduce pickup latency but increase empty-query traffic. Higher intervals reduce idle database work but add latency before new and due work is observed. Under backlog, claim slots replenish as executions finish, and the timer loop immediately continues while it keeps filling batches; each batch is bounded by worker concurrency.

Timer timestamps and run eligibility use Postgres `now()`. Application clock drift does not make a row early or late, but database load, pool waiting, poll interval, and available execution slots can all add observed delay.

## Retention And Maintenance

`durlo.runs.cleanup()` uses a bounded transaction and never schedules itself. Run cleanup from an operator-controlled process, use modest batches, and pause between batches when the worker pool or database is busy. A separate adapter can isolate cleanup queueing, but its connections still count against the fleet budget.

Run migrations before starting new-version workers. Migrations are serialized with a transaction-scoped advisory lock and should not be run continuously by every worker replica during normal operation.

## What To Monitor

At minimum, observe:

- `worker.getHealth()` claim/timer failures and last successful poll times
- `durlo.runs.getBacklogHealth()` ready-run lag, expired leases, due timers, and timer lag
- `worker.getCompatibilityReport()` for bounded worker-relative unregistered resources and incompatible versions
- structured lease-loss, stalled-attempt, and database-retry logs
- `pool.totalCount`, `pool.idleCount`, and sustained `pool.waitingCount`
- Postgres query latency, CPU, I/O, active connections, and lock waits
- pending-run age, expired running leases, and due-timer lag
- cleanup batch duration and retained terminal-row growth

Pool waiting alone is not failure; brief bursts are expected. Sustained waiting combined with heartbeat loss or increasing timer lag is the signal that the current concurrency, pool, or database budget is too small.

Backlog health aggregates the active rows for one app. Poll it at an operator or dashboard cadence rather than at the worker's claim interval. Run detail and compatibility reads are bounded; run list pages are limited to 200 summaries. See [Observability](OBSERVABILITY.md) for field definitions and scope.
