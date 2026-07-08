# Durlo Internal Adapter Spec

Status: Draft
Date: 2026-07-08

Answers: **What must the Postgres adapter implement?**

This document defines the internal storage contract required by `@durlo/core`. It is not a public user API.

## Adapter Role

The adapter owns durable persistence.

Core owns:

- public API objects
- task/workflow registration
- worker orchestration
- calling user code
- retry decision logic
- step context behavior

Adapter owns:

- storing runs
- claiming due work
- storing step checkpoints
- storing timers
- recording attempts
- applying state transitions atomically
- executing writes inside caller-owned transactions

## Requirements

The Postgres adapter must:

- Work without Postgres extensions.
- Work without superuser permissions.
- Work with PgBouncer transaction pooling.
- Use short transactions for claims and state transitions.
- Never hold a transaction open while user code runs.
- Use row locks or equivalent safety for concurrent workers.
- Return existing handles for duplicate idempotency keys.
- Generate a unique lease token for every claim.
- Reject stale completion/failure/extension writes after a worker loses its lease.

## Adapter Shape

Illustrative internal shape:

```ts
interface DurloAdapter {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  createRuns(input: CreateRunInput[]): Promise<RunRecord[]>;

  getRun(id: string): Promise<RunRecord | null>;
  cancelRun(id: string, input: CancelInput): Promise<void>;
  retryRun(id: string, input: RetryInput): Promise<RunRecord>;

  claimRuns(input: ClaimRunsInput): Promise<ClaimedRun[]>;
  extendRunLease(input: ExtendLeaseInput): Promise<boolean>;
  completeRun(input: CompleteRunInput): Promise<void>;
  failRun(input: FailRunInput): Promise<void>;
  releaseRun(input: ReleaseRunInput): Promise<void>;

  getStep(input: GetStepInput): Promise<StepRecord | null>;
  startStep(input: StartStepInput): Promise<StepRecord>;
  completeStep(input: CompleteStepInput): Promise<void>;
  failStep(input: FailStepInput): Promise<void>;

  createTimer(input: CreateTimerInput): Promise<TimerRecord>;
  fireDueTimers(input: FireDueTimersInput): Promise<FiredTimer[]>;

  recordAttempt(input: RecordAttemptInput): Promise<AttemptRecord>;

  withTransaction(client: unknown): TransactionalDurloAdapter;
}
```

Exact TypeScript names may change during implementation. The responsibilities should not.

## Run Creation

`createRun(...)` persists a task or workflow run.

It must:

- Validate idempotency atomically.
- Return the existing run for duplicate idempotency keys.
- Store input, options, schedule time, priority, retry limits, and resource id.
- Default status to `pending`.
- Reject duplicate idempotency keys inside one `createRuns(...)` call in v1.

`createRuns(...)` must be atomic. If one run cannot be created, none are created.

## Transaction Binding

`withTransaction(client)` returns an adapter that writes through a caller-provided transaction client.

It must not:

- start the transaction
- commit the transaction
- roll back the transaction

It must use the same semantics as normal `createRun(...)` and `createRuns(...)`.

## Claiming Runs

`claimRuns(...)` returns claimable runs and marks them running.

Inputs:

- app id
- worker id
- max count
- lease duration
- resource ids registered by this worker

It must:

- claim only due runs
- reclaim expired running runs
- skip locked rows
- respect resource registration
- set `locked_by`
- set a fresh unique `lease_token`
- set `locked_until`
- increment attempt count
- create or update attempt records
- commit before returning work to the worker

Expired running rows are claimable only when `locked_until < now()`. Reclaiming an expired running row must mark the previous active attempt `stalled`, increment `stalled_count`, and then either:

- create a new running attempt when retry budget remains
- move the run to `dead_letter` for tasks or `failed` for workflows when exhausted

Rows moved to terminal status during expired-lease cleanup are not returned to the worker.

## Lease Extension

`extendRunLease(...)` extends a running run's lease.

It should succeed only if:

- run id matches
- worker id owns the lease
- lease token matches
- run is still running
- current lease has not been stolen by another worker

It returns `false` if the worker no longer owns the run.

## Completing Runs

`completeRun(...)` marks a run completed.

It must:

- verify worker ownership where applicable
- verify the current lease token
- store output
- clear lease fields
- set completion timestamps
- mark the active attempt succeeded

If no row matches the worker id and lease token, completion must fail as a lost-lease/stale-write result. It must not silently mark the run completed.

## Failing Runs

`failRun(...)` records an execution failure.

Core decides whether the failure should retry, fail, or dead-letter. The adapter applies the requested transition.

Supported outcomes:

- retry later: `status = pending`, `scheduled_at = retry_at`
- final workflow failure: `status = failed`
- final task exhaustion: `status = dead_letter`

The adapter must store serialized error data and mark the active attempt failed.

Failure writes for a running attempt must verify the current lease token. Retry and final failure transitions clear lease fields.

## Releasing Runs

`releaseRun(...)` is for graceful shutdown before user code starts.

It may move an owned `running` run back to `pending` only if:

- worker id matches
- lease token matches
- run is still `running`
- core has not started user code for that run

It clears lease fields and marks the active attempt `cancelled` or another explicit non-success status chosen by core.

It must not be used after user code has started. Once user code starts, the worker must either complete/fail the attempt, keep extending the lease, or let the lease expire and be treated as stalled.

## Cancellation And Retry

`cancelRun(...)` marks a run cancelled where cancellation is still allowed.

It must be safe to call repeatedly.

Cancellation must prevent future execution for pending, sleeping, and retry-scheduled runs. For running runs, cancellation clears the current lease and makes later stale completion/failure writes fail token checks.

`retryRun(...)` moves a failed or dead-letter run back to pending and creates a new scheduled attempt.

It must preserve prior attempt history.

V1 manual retry is valid only for failed workflow runs and dead-letter task runs.

## Step Checkpoints

`getStep(...)` returns a step by `(run id, step id)`.

`startStep(...)` creates or marks a step running.

If the step already completed, the adapter returns the completed record and core must not run the user function again.

`completeStep(...)` stores the result and marks the step completed.

`failStep(...)` stores error data and marks the step failed or ready for retry according to the transition requested by core.

## Timers

`createTimer(...)` stores a workflow sleep timer for `(run id, step id)`.

It must be idempotent for the same run and step.

`fireDueTimers(...)` marks due timers fired and moves the owning workflow run back to pending.

This must happen atomically.

It must not resume a cancelled or terminal run. It should only update the owning run when the current run status is `sleeping`.

## Attempts

Attempt records are append-only history for dashboard and debugging.

The adapter must record:

- run id
- optional step id
- attempt number
- status
- worker id
- lease token where applicable
- started time
- completed time
- serialized error when applicable

## Dashboard Reads

The adapter should expose read operations for dashboard/API layers:

- list runs
- get run
- list steps for run
- list attempts for run
- list timers for run

These reads are not on the hot execution path and may be added incrementally.

## Out Of Scope

The v1 adapter does not need:

- event storage
- cron storage
- LISTEN/NOTIFY
- advisory locks
- cross-database support
- long-running DB transactions
