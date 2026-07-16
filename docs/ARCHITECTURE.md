# Durlo Architecture

Status: Current
Updated: 2026-07-16

This document explains how Durlo is built today. Public guarantees belong in [EXECUTION_SEMANTICS.md](EXECUTION_SEMANTICS.md), product decisions belong in [DECISIONS_AND_EDGE_CASES.md](DECISIONS_AND_EDGE_CASES.md), and future work belongs in [ROADMAP.md](ROADMAP.md).

## Product Boundary

Durlo v1 is a TypeScript durable task and workflow library for applications that already use Postgres.

It provides:

- direct task enqueue
- direct workflow start
- Postgres-backed scheduling and state
- a normal Node.js worker process
- retries, delays, checkpoints, sleeps, cancellation, and manual retry
- transaction-bound enqueue and start with raw `pg`

It does not provide events, cron, multiple languages, hosted orchestration, framework adapters, distributed global concurrency, or Temporal-style replay.

## Packages

```txt
@durlo/core       public API, validation, retries, steps, and worker runtime
@durlo/postgres   migrations and atomic Postgres state transitions
durlo             CLI package; product commands remain roadmap work
```

The core package does not depend on Postgres. It consumes the internal adapter contract defined in `packages/core/src/types.ts`.

The Postgres package does not import user task or workflow code. It only stores records and performs state transitions.

## Runtime Topology

```txt
application process
  task.enqueue(...) / workflow.start(...)
                  |
                  v
              Postgres
      runs / steps / timers / attempts
                  ^
                  |
          Node.js worker process
       registered tasks and workflows
```

Calling `enqueue` or `start` persists a run. It does not execute user code. User code runs only inside a worker that registered the matching task or workflow definition.

The application and worker may be separate processes. Multiple worker processes may use the same database; Postgres row locks and lease tokens decide ownership.

## Runtime Entities

### Definition

A task or workflow definition is TypeScript code registered under a stable resource id and an opaque compatibility version. The default version is `"1"`.

### Run

A run is a durable task or workflow instance stored in `durlo_runs`. The run row is both the scheduling record and the current state summary. It retains the resource version selected at creation for its entire lifetime.

### Worker

A worker polls Postgres for eligible runs whose resource ids it registered. It executes user code in-process and renews a lease while the run is active. Execution slots are replenished as individual runs finish; the worker does not wait for an entire claimed group before claiming into newly available capacity.

### Step

`step.run(id, fn)` is a durable checkpoint inside a workflow. The callback runs in the workflow's worker process. A completed result is stored in `durlo_steps` and returned without re-running the callback after re-entry.

### Timer

`step.sleep` and `step.sleepUntil` store timers in `durlo_timers`. Sleeping releases the worker. A later polling cycle atomically fires the timer and makes the workflow pending again.

### Attempt

`durlo_attempts` stores append-only run and step attempt history for failure analysis and the future dashboard.

## Task Execution

```txt
application creates pending task run
worker claims run with worker id, lease token, and expiry
worker validates input and calls task code
worker persists completion or failure
failure schedules retry or moves the task to dead_letter
```

User code is never executed inside an open Durlo database transaction. A worker claims a task only when its registered kind, resource id, and resource version exactly match the run.

## Workflow Execution

```txt
application creates pending workflow run
worker claims run
workflow code starts from the top
completed step results are loaded from Postgres
new step callbacks execute and checkpoint results
workflow completes, fails, retries, or sleeps
```

Durlo does not reconstruct local variables from an event history. Workflow code re-enters after retry, crash recovery, or sleep. Durable branching must depend on input or stored step results. Sleep and resume preserve the run's resource version, so incompatible deployments cannot claim it accidentally.

V1 workflows require sequential step and sleep calls. A step boundary is reserved before its first storage read, so nested or concurrent `step.*` calls fail with a validation error instead of racing durable state.

## Sleep And Resume

```txt
workflow creates timer
run becomes sleeping and releases its lease
worker polling later finds the due timer
timer becomes fired and run becomes pending in one transaction
worker claims the run again
workflow re-enters and the fired sleep returns immediately
```

No compute is held while a workflow sleeps. A running worker is required to promote due timers and claim resumed work. Timer promotion runs independently of execution-slot availability, so long-running user code does not pause due timers.

## Ownership And Crash Recovery

Every claim receives a unique lease token. Running-state writes require:

```txt
run id + worker id + lease token + running status
```

If a worker stops renewing its lease, another worker may reclaim the run after expiry. The expired attempt is recorded as stalled. Writes from the old token are rejected.

This fences durable state updates. It cannot make external side effects exactly once.

## Storage

The schema is defined by `packages/postgres/src/migrations.ts` and currently contains:

- `durlo_schema_migrations`
- `durlo_runs`
- `durlo_steps`
- `durlo_timers`
- `durlo_attempts`

Postgres `now()` decides eligibility, lease expiry, and timer due checks. Partial indexes support pending runs, expired leases, resource lookup, and due timers.

The same run table holds active queue state and retained history. `durlo.runs.cleanup()` performs manual, bounded terminal-row deletion using a terminal-only partial index and row locking; Durlo does not schedule retention. The full contract is documented in [Retention Cleanup](RETENTION.md). Public core APIs enforce the payload and batch limits documented in [Storage Limits](STORAGE_LIMITS.md); the Postgres adapter enforces the durable workflow-step count under the owning run lock.

`worker.getCompatibilityReport()` performs a bounded read for pending, sleeping, and expired-running work that does not match that worker's registrations. The report is worker-relative and does not mutate run state. The complete policy is documented in [Deployment Compatibility](DEPLOYMENT_COMPATIBILITY.md).

## Transaction Boundary

`durlo.tx(client)` binds run creation to a caller-owned raw `pg` transaction.

```txt
business write + Durlo run creation commit together, or neither commits
```

Durlo does not begin, commit, or roll back the caller's transaction.

## Worker Boundary

Worker concurrency is local to one process. Postgres prevents two workers from owning the same claim, but Durlo v1 does not provide a global, per-resource, or per-tenant concurrency limit.

The worker maintains process-local concurrency with continuously replenished execution slots. Claiming waits only when every slot is occupied. Due-timer promotion runs in a separate maintenance loop.

`worker.stop()` stops the claim and timer loops. Already claimed runs retain their heartbeats and are allowed to finish; the `worker.start()` promise settles only after those active runs drain. Lease renewals for each run are serialized so a slow database call cannot overlap a later heartbeat.

Claim and timer polling recover independently from transient database errors. Each loop uses exponential backoff starting at 100 milliseconds, capped at 30 seconds, with 20 percent jitter. A persistence error for one active run is logged and left for lease-based recovery instead of permanently stopping the worker process.

`worker.getHealth()` returns a process-local snapshot containing lifecycle status, active slots, consecutive claim and timer failures, last successful polling times, and the most recent operational error. When a `Durlo` logger is configured, worker lifecycle, database retries, lease loss, and run transitions are emitted as structured records.

## Control Boundary

Cancellation prevents future Durlo state transitions and invalidates a running lease. It cannot forcibly terminate arbitrary JavaScript. Task and workflow code receives an `AbortSignal` and should stop cooperatively.

Public run reads and controls always pass both the owning app id and run id to storage. A run id from another app is treated as missing, including for cancellation and manual retry.

Attempt timeouts use the same cooperative model. The signal reason is the exported `AttemptTimeoutError`. A running cancellation is detected by the worker's next failed lease renewal, so its signal reason is `LostLeaseError`. External effects must remain idempotent because timed-out or lease-lost code may finish late.

## Source Of Truth

To prevent documentation drift:

- public types and adapter contracts: `packages/core/src/types.ts`
- worker behavior: `packages/core/src/worker.ts`
- workflow checkpoints: `packages/core/src/steps.ts`
- Postgres transitions: `packages/postgres/src/adapter.ts`
- database schema: `packages/postgres/src/migrations.ts`
- behavioral guarantees: `docs/EXECUTION_SEMANTICS.md`
- edge-case decisions: `docs/DECISIONS_AND_EDGE_CASES.md`
- release priorities: `docs/ROADMAP.md`
