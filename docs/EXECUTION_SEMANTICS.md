# Durlo Execution Semantics

Status: Current
Updated: 2026-07-15

Answers: **What guarantees do the public calls provide?**

This document describes runtime behavior for the v1 task/workflow API. It does not define storage tables or adapter method names.

## Core Model

Durlo provides durable scheduling and state tracking. It does not provide exactly-once execution of arbitrary user code.

The v1 guarantee model:

- Enqueue/start persistence is durable once committed.
- Worker execution is at-least-once.
- User code must be safe to retry.
- Idempotency keys deduplicate run creation, not external side effects.
- `step.run(...)` checkpoints successful workflow steps.
- Sleeps and delays survive worker restarts.
- Transactions can commit business rows and Durlo runs together.
- Expired running leases are reclaimed or terminally failed; they must not remain stranded forever.
- Stale workers cannot complete or fail a run after losing the current lease token.

## Run Creation

`task.enqueue(input, options?)` creates a task run.

`workflow.start(input, options?)` creates a workflow run.

If the call resolves, Durlo has persisted a run and returned a `RunHandle`.

If the call throws, the caller must treat the result as unknown unless an `idempotencyKey` was used. Retrying the same call with the same idempotency key should return the same run if it was already created.

## Idempotency

`idempotencyKey` is scoped to:

```txt
app id + resource kind + resource id + idempotency key
```

For duplicate keys, Durlo returns the existing `RunHandle`.

Idempotency does not mean the run body executes once. It only prevents duplicate run rows for the same key.

Rows retained in Durlo storage define the deduplication window. V1 has no idempotency TTL or reset API.

Failed, dead-letter, completed, and cancelled runs keep their idempotency key. Starting new work with the same logical business key after terminal status requires a different idempotency key until a future reset API exists.

## Transactions

`durlo.tx(tx).enqueue(...)` and `durlo.tx(tx).start(...)` write through a caller-owned transaction client.

Guarantee:

```txt
business data and Durlo run commit together, or neither commits
```

Durlo does not start, commit, or roll back the transaction. The application owns the transaction lifecycle.

V1 supports raw `pg` transaction clients.

## Worker Execution

Workers claim due runs with lease-based locking.

Rules:

- A claimed run has `locked_by` and `locked_until`.
- A claimed run also has a unique `lease_token` generated for that claim.
- A worker may extend the lease while executing.
- Heartbeat renewals for one run are serialized; Durlo does not start another renewal while the previous renewal is unresolved.
- If a worker crashes, the lease eventually expires.
- Another worker may reclaim expired work.
- User code can therefore execute more than once.
- Completion, failure, cancellation, and lease extension must verify the current lease token when acting on a running attempt.
- If lease extension returns false, the worker has lost ownership. It should stop scheduling more Durlo work for that run and any final completion write must be rejected by the adapter.
- Worker concurrency slots are replenished individually as runs finish.
- Timer promotion continues independently while execution slots are occupied.
- Graceful stop prevents new claims and waits for already active runs to settle.
- Transient claim and timer query failures are retried with bounded exponential backoff and jitter; either loop can recover without restarting the worker.

Durlo must not hold a database transaction open while user code runs.

Lease expiry is treated as a stalled attempt. It is recorded in attempt history and consumes retry budget. If retry budget is exhausted, an expired task moves to `dead_letter` and an expired workflow moves to `failed`.

`attempt_count` counts claims and workflow re-entries. Retry exhaustion is based on failed, timed-out, and stalled attempt history, so successful sleep/resume boundaries do not consume the workflow's failure retry budget.

## Task Semantics

A task run executes the task `run(input, ctx)` function.

On success:

- Output is persisted.
- Run status becomes `completed`.

On thrown error:

- Error is persisted.
- Attempt count has already increased when the run was claimed.
- Durlo either schedules a retry or moves the run to terminal failure.

If a worker crashes after user code performs an external side effect but before Durlo persists completion, the task may run again.

## Workflow Semantics

A workflow run executes `workflow.run({ input, step, run })`.

Workflow code may be re-entered after worker crash, retry, or sleep resume. Durable side effects should be wrapped in `step.run(...)`.

Top-level workflow code outside `step.run(...)` can run more than once.

Durlo does not replay workflow history like Temporal. It re-enters the workflow function and uses stored step/timer records to skip completed durable boundaries. Workflow code should therefore be deterministic with respect to the original input and persisted step results.

Unsafe examples:

- Reading current database state outside `step.run(...)` and branching on it.
- Calling external APIs outside `step.run(...)`.
- Mutating outer variables inside `step.run(...)` and expecting them to exist on resume.
- Generating random step IDs.

## Step Semantics

`step.run(id, fn)` persists a successful result under `(run id, step id)`.

If the step already completed, Durlo returns the persisted result and does not call `fn` again.

If `fn` throws, Durlo applies retry policy and records the failure.

If a worker crashes after `fn` performs an external side effect but before the step result is persisted, Durlo may call `fn` again.

Step ids must be stable for the lifetime of a workflow definition.

V1 step rules:

- Duplicate step ids in one workflow run are runtime errors.
- `step.*` calls inside a `step.run(...)` callback are runtime errors.
- Step-level retry overrides are not public in v1; step failures use the workflow run retry policy.
- Completed steps return the stored result without calling `fn`.

## Sleep Semantics

`step.sleep(id, duration)` and `step.sleepUntil(id, date)` persist a timer.

The workflow pauses and the worker is released.

When the timer is due, a worker resumes the workflow. Resume is at-least-once, but the sleep step itself should not create duplicate timers for the same `(run id, step id)`.

Timer firing must be atomic with moving the owning run from `sleeping` to `pending`. A cancelled or terminal run must not be resumed by a due timer.

## Delay Semantics

`delay` and `runAt` on `task.enqueue(...)` or `workflow.start(...)` control when a run first becomes eligible.

They do not guarantee exact wall-clock execution time. A run becomes eligible at or after its scheduled time, then waits for an available worker.

## Retry Semantics

`attempts` includes the first attempt.

Default attempts: `3`.

Retry precedence:

1. Run option override.
2. Task or workflow definition retry.
3. Client default retry.
4. Durlo default retry.

Backoff decides when the next attempt becomes eligible. Jitter may shift retry time to reduce synchronized retries.

Default retry:

```txt
attempts: 3
backoff: exponential
base delay: 10 seconds
jitter: 0.2
```

Task exhaustion moves the run to `dead_letter`. Workflow exhaustion moves the run to `failed`.

## Cancellation

`durlo.runs.cancel(handleOrId)` is best-effort.

The lookup and mutation are scoped to the `Durlo` instance's app id. A run belonging to another app is not visible or cancellable through that instance.

Cancellation must prevent future execution for pending, sleeping, delayed, and retry-scheduled runs.

Cancellation may not interrupt JavaScript already executing. If a running attempt finishes after cancellation, Durlo should avoid scheduling further work for that run.

For running runs, cancellation changes the run to `cancelled` and clears the lease only if the adapter can do so atomically. A stale worker completion after cancellation must not move the run back to `completed`.

## Manual Retry

`durlo.runs.retry(handleOrId)` creates a new attempt for a failed or dead-letter run.

The lookup and mutation are scoped to the `Durlo` instance's app id. A run belonging to another app is treated as missing.

Manual retry does not clear history. Attempts remain visible for debugging.

Manual retry schedules one new claim without resetting the automatic retry budget. If that manual attempt fails, the run returns to `dead_letter` or `failed`; another manual retry may be requested afterward.

Manual retry is allowed for `failed` workflow runs and `dead_letter` task runs. V1 does not manually retry `completed`, `cancelled`, `pending`, `running`, or `sleeping` runs.

## Batch Enqueue

`task.batchEnqueue(items)` should be atomic by default.

If any item fails validation or persistence, no items are enqueued.

The returned handles preserve item order.

Duplicate idempotency keys inside the same batch are a validation error in v1.

## Schema Validation

If a task or workflow has a schema:

- Input is validated before run creation.
- Input is validated again before execution.

Validation failure before persistence rejects the caller.

Validation failure at execution time fails the run without calling user code.

## Serialization

Durlo stores inputs, outputs, step results, and errors as JSON.

V1 should support JSON-compatible values plus explicit Durlo handling for `Date` and `Error`.

V1 should reject unsupported values before persistence where possible:

- `BigInt`
- functions
- symbols
- circular objects
- class instances that cannot be represented as JSON

Values read back from storage are plain data. Class prototypes and methods are not preserved.

## Timeouts

Timeouts are attempt-level limits.

If an attempt exceeds its timeout, Durlo records a timeout failure and applies retry policy.

Timeouts are cooperative where possible. Durlo cannot safely terminate all arbitrary JavaScript in-process without runtime support.

Timeout failure consumes an attempt and follows the same retry/exhaustion rules as thrown errors.

## Terminal Statuses

Terminal run statuses:

- `completed`
- `failed`
- `dead_letter`
- `cancelled`

Non-terminal run statuses:

- `pending`
- `running`
- `sleeping`

`dead_letter` means automatic attempts are exhausted and manual retry is still possible.

## Non-Goals

V1 does not guarantee:

- Exactly-once execution of user code.
- Exactly-once external side effects.
- Deterministic replay like Temporal.
- Interruption of already-running JavaScript.
- Cron scheduling.
- Event-driven workflow triggers.
- Distributed global concurrency limits.
