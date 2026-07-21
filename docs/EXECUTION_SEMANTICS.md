# Durlo Execution Semantics

Status: Current pre-release behavior
Updated: 2026-07-20

This document describes what the current public API does, including known defects. It is not a
promise that roadmap work is already implemented.

## Guarantee model

- Run persistence is durable after its database transaction commits.
- Worker execution is at-least-once.
- Idempotency keys deduplicate run creation, not user-code execution or external side effects.
- A current lease token fences durable writes after another claim rotates ownership.
- Completed workflow step results are reused after re-entry.
- Delays and sleeps survive worker restarts.
- Workers claim only exact resource kind, id, and compatibility-version matches.
- Durlo does not provide exactly-once effects, process isolation, deterministic replay, or a hosted
  control plane.

## Run creation

`task.enqueue(input, options?)` creates a task run. `workflow.start(input, options?)` creates a
workflow run. Both return a `RunHandle` after persistence.

Supported options are `delay`, `runAt`, `attempts`, `backoff`, `idempotencyKey`, `priority`, and
`timeout`. `delay` and `runAt` are mutually exclusive. Higher priority values are claimed first;
continuous high-priority work can starve lower priorities.

If creation throws after an uncertain connection failure, use an idempotency key before retrying.
The handle's output type is currently phantom: `runs.get()` returns a `RunRecord` whose output is
`JsonValue`, and there is no public wait-for-result method.

### Idempotency

The key scope is:

```txt
app id + resource kind + resource id + idempotency key
```

The resource version is intentionally outside the scope. A duplicate key returns the existing run,
including its original version. The current conflict path does not compare input, options, or
version and does not report whether creation was deduplicated. Callers must not reuse one key for
different logical work.

The key remains reserved while the run row exists. Deleting a terminal run through cleanup also
releases its key.

### Batch creation

`task.batchEnqueue(items)` validates all items before persistence and creates the batch in one
transaction. Returned handles preserve order. Duplicate idempotency keys inside one batch are
rejected.

The current `Array<TInput | { input: TInput; options?: RunOptions }>` API is ambiguous. An object
input whose only keys are `input` and `options` is interpreted as batch metadata. Avoid that payload
shape until the API is replaced.

## Transaction-bound creation

`durlo.tx(client).enqueue(...)`, `.start(...)`, and `.batchEnqueue(...)` issue run writes through the
provided object's `query()` method. Durlo never begins, commits, or rolls back that transaction.

Atomic application data plus run creation is achieved only when the caller passes a checked-out raw
`pg` client that is already inside `BEGIN` and later commits or rolls back that same client. The
current API accepts `unknown` and checks only for `query()`, so it also accepts `pg.Pool` and clients
outside a transaction. Passing either silently loses atomicity. Treat this API as unsafe until the
roadmap transaction repair lands.

## Validation and serialization

A Standard Schema, when configured, is run before creation. Its returned value is serialized and
stored. The worker currently deserializes that value and runs the same schema again before user
code. Transforming schemas must therefore accept their own output or execution can fail after a
successful enqueue. This double-validation behavior is a known defect.

Durlo stores compact JSON plus tagged `Date` values and serialized `Error` objects. It rejects
non-finite numbers, `BigInt`, `undefined`, functions, symbols, circular objects, invalid dates, and
unsupported class instances.

The current date tag is a one-key object named `$durlo.date`. A valid user object with that exact
shape is deserialized as a `Date`; there is no escape mechanism. Do not use that shape in inputs or
results until collision-safe serialization lands.

## Storage limits

Limits are configured on `Durlo` and measured as compact serialized UTF-8 JSON.

| Limit | Default | Behavior |
| --- | ---: | --- |
| `maxInputBytes` | 1 MiB | Rejects creation before persistence |
| `maxOutputBytes` | 1 MiB | Fails the attempt without storing the output |
| `maxErrorBytes` | 64 KiB | Replaces oversized errors with bounded diagnostics |
| `maxBatchItems` | 1,000 | Rejects the whole batch |
| `maxBatchBytes` | 10 MiB | Rejects the whole batch |
| `maxStepResultBytes` | 1 MiB | Fails the step and workflow attempt |
| `maxWorkflowSteps` | 1,000 | Counts durable steps and sleeps |

Output, error, step-result, and workflow-step limits are persisted in run options so later workers
use the creation-time values. Runs created before persisted limits use worker defaults.

## Worker ownership and recovery

A claim stores `locked_by`, `lease_token`, and `locked_until`. Heartbeats extend an unexpired lease
roughly every third of `leaseDuration`. Any failed renewal is treated conservatively as lease loss:
the attempt signal is aborted and final persistence is suppressed.

After expiry, another worker can claim the run. Reclaim marks the old run attempt `stalled`, counts
it against the failure budget, and either creates a new attempt or moves an exhausted task to
`dead_letter` and an exhausted workflow to `failed`.

Durable completion/failure currently checks token, worker, and `running` status but not lease time.
A worker may finish after the deadline if no competing claimant has rotated the token. Once another
claim wins, the stale token cannot write.

### Workflow interruption history

Lease reclaim closes the old run attempt and any step attempt owned by the same lease as `stalled`.
Attempt timeout uses `timed_out`, cancellation uses `cancelled`, and ordinary failure fallback uses
`failed`. Each transition also closes the matching step row with its causal error and completion
time in the same transaction as the run transition.

An interrupted workflow may re-enter and call the step again. That creates a distinct step attempt
and increments `attemptCount`; a successful checkpoint from any later attempt remains reusable.
Completed checkpoints are not downgraded by interruption handling.

## Retries and failure

`attempts` includes the first failure-bearing attempt and defaults to 3. The default backoff is
exponential from 10 seconds with factor 2 and jitter 0.2. Run options override definition options,
which override client defaults.

Thrown errors, validation failures at execution, serialization failures, and timeouts all follow
the same retry policy. There is currently no supported permanent-error, custom retry decision,
`Retry-After`, or retry-at timestamp exception.

Task exhaustion becomes `dead_letter`; workflow exhaustion becomes `failed`. Manual retry is
allowed only for those respective terminal states. It preserves history and schedules one more
claim without resetting automatic failure history.

Workflow re-entry after successful sleeps increases `attempt_count` without consuming failure
budget. Consequently `context.attempt.number` can exceed `context.attempt.maxAttempts`; the former
is a claim count and the latter a failure budget.

Backoff factor and delay currently have no practical combined ceiling. Extreme exponential
settings can overflow into an invalid retry date.

## Timeouts, cancellation, and user code

Timeouts use `Promise.race` and abort the task/workflow signal with `AttemptTimeoutError`. The
timed-out promise is not terminated; code that ignores the signal can continue and perform late
external effects while a retry starts. Its lease token cannot complete or otherwise mutate the
closed step after ownership changes.

Cancellation is app-scoped and valid for pending, running, or sleeping work. It prevents future
Durlo state transitions, closes the owned active step as `cancelled`, and cancels pending timers.
Running code observes cancellation only after the next failed heartbeat, and arbitrary JavaScript
may continue locally.

`WorkflowSleepError` and `LostLeaseError` are currently public exports used as internal worker
sentinels. If user code throws them, the worker can suppress ordinary failure persistence. Do not
throw these classes from application code.

## Workflow checkpoints and sleeps

`step.run(id, fn)` reserves a stable step id, returns an existing completed result on re-entry, or
executes and persists a new result. Step and sleep calls must be sequential and cannot be nested.

Workflow branching must depend on input or prior durable step results. Mutable outer variables,
current time, unordered data, and non-checkpointed reads can differ after re-entry. Step ids must
remain stable across compatible deployments.

`step.sleep` and `step.sleepUntil` create one timer for `(run id, step id)`, move the run to
`sleeping`, and release the worker. Due timer promotion and moving the run back to `pending` happen
in one database transaction and only while the run is still sleeping.

## Compatibility versions

Definition versions are opaque strings, defaulting to `"1"`. Runs retain their creation version
through delays, retries, sleeps, lease recovery, and manual retry. Workers claim exact matches.

Keep a version only when new code can read every active input and checkpoint and preserves existing
step meanings. For a breaking change, deploy new-version workers, switch producers, and retain old
workers until old active runs finish. `worker.getCompatibilityReport()` is bounded and relative to
one worker, so it does not prove fleet-wide unavailability.

## Reads and controls

- `runs.get()` returns one app-scoped run or `null`.
- `runs.list()` returns payload-free newest-first keyset pages; default 50, maximum 200.
- `runs.getDetails()` returns one repeatable-read snapshot plus a derived timeline and diagnostics.
- `runs.getBacklogHealth()` aggregates active state and lag for one app.
- `worker.getHealth()` reports one process's claim and timer polling state.
- `worker.getCompatibilityReport()` returns at most 1,000 worker-relative unavailable runs.
- `runs.cancel()` and `runs.retry()` perform app-scoped state transitions.
- `runs.cleanup()` deletes bounded terminal history.

The timeline is derived from current durable records, not a complete event history. Its existing
`step_attempt_stalled`, `step_attempt_timed_out`, and `step_attempt_cancelled` events come from the
closed attempt records rather than from a second lifecycle-event store.

## Retention

`runs.cleanup({ olderThan, limit?, statuses? })` deletes only terminal runs older than a
PostgreSQL-clock cutoff. The default limit is 1,000 and maximum is 10,000. It uses row locks and
`SKIP LOCKED`, then cascades to steps, timers, and attempts.

The operation is bounded by parent-run count, not child rows, bytes, WAL, or elapsed time. A run
with extensive history can therefore make a nominally small cleanup expensive. Durlo does not
schedule cleanup automatically.

## Deliberate v1 non-goals

V1 does not guarantee exactly-once effects, process isolation, event or cron triggers, parent-child
flows, distributed concurrency, rate limiting, authenticated production UI, or deterministic
workflow replay.
