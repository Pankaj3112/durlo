# Durlo Execution Semantics

Status: Current pre-release behavior
Updated: 2026-08-23

This document describes the current public API and its deliberate pre-release boundaries.

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
workflow run. Both return `{ run, created }` after persistence. `run` is the durable handle and
`created` is `true` only when this call inserted the row; a compatible idempotency reuse returns
`created: false`.

Supported options are `delay`, `runAt`, `attempts`, `backoff`, `idempotencyKey`, `priority`, and
`timeout`. `delay` and `runAt` are mutually exclusive. Higher priority values are claimed first;
continuous high-priority work can starve lower priorities.

If creation throws after an uncertain connection failure, use an idempotency key before retrying.
The handle's output type is currently phantom: `runs.get()` returns a `RunRecord` whose output is
`DurableValue` (JSON plus `Date`), and there is no public wait-for-result method.

### Idempotency

The key scope is:

```txt
app id + resource kind + resource id + idempotency key
```

The resource version is part of the compared creation intent, but not part of the uniqueness scope:
a deployment cannot create a second logical run by changing its version. A duplicate key compares
the resource version, transformed durable input, normalized execution options (retry, timeout,
persisted limits, and priority), and canonical schedule intent (`immediate`, `delay(milliseconds)`,
or exact `runAt(timestamp)`). A mismatch throws the exported `IdempotencyConflictError` with the
existing run id and sorted unique mismatch names: `resource_version`, `input`,
`execution_options`, or `schedule`. The conflict performs no mutation.

Rows created before comparison metadata existed are not guessed to be compatible. Reusing their key
throws a conflict containing only `legacy_unverifiable`; operators should choose a new key or
explicitly inspect the legacy row. Object-property ordering does not change a comparison, and the
comparison uses the schema-transformed input that was persisted.

The key remains reserved while the run row exists. Deleting a terminal run through cleanup also
releases its key.

### Batch creation

`task.batchEnqueue(items)` accepts only `ReadonlyArray<{ input: TInput; options?: RunOptions }>`.
Every item is explicit, including when the input itself has `input` or `options` properties. The
method validates all items before persistence, creates the batch in one transaction, and returns
creation results in input order. Duplicate idempotency keys inside one batch are rejected.

When a task has a Standard Schema, every batch item is validated once and its transformed output is
persisted in the corresponding run. Transaction-bound creation uses the same input/output contract.

Plain `TInput[]` is intentionally not accepted by the TypeScript API. Transaction-bound batch
creation uses the same explicit item shape and result contract.

## Transaction-bound creation

`durlo.transaction(callback)` acquires one client from the adapter's raw-`pg` pool and begins a
transaction before invoking the callback. The callback receives `client.query(...)` together with
`enqueue(...)`, `start(...)`, and `batchEnqueue(...)`. All application SQL and Durlo creation calls
inside it use that same client.

Durlo commits only after the callback resolves, then returns the callback result. A thrown or
rejected callback, validation or serialization error, batch error, PostgreSQL error, or failed
commit causes Durlo to attempt rollback. The client is released exactly once on every acquired-client
path. If rollback also fails, the original callback, query, or commit error remains the reported
error.

Callers do not supply or release the transaction client, so a `pg.Pool` or a client outside `BEGIN`
cannot be mistaken for an active transaction. Nested transactions and savepoints are unsupported.
Task and workflow handlers do not run inside the callback transaction. Raw `pg` is the only v1
transaction integration; Drizzle, Prisma, Kysely, and framework adapters are not implemented.

## Validation and serialization

A Standard Schema, when configured, separates the value accepted by `enqueue`/`start` from the value
received by the handler. It runs exactly once during creation, including batch and transaction-bound
creation. Its successful output is serialized, size-checked, and stored as the durable run input.
Workers deserialize that persisted value and pass it directly to the handler; they do not re-run the
schema. Schema issues or rejected validation prevent the run from being persisted, and batch or
transaction creation remains all-or-nothing.

Stored transformed input is part of the definition's compatibility contract. If a deployed schema
changes the persisted output shape incompatibly, publish a new resource version and keep workers for
the previous version available until its active runs finish. Durlo does not revalidate legacy,
manually edited, or corrupted stored rows.

Durlo stores compact JSON plus serialized `Error` objects. Dates and objects use a versioned,
collision-safe `$durlo` envelope: object properties are stored as key/value entry arrays so
PostgreSQL `jsonb` key normalization cannot change their meaning. This preserves every legal JSON
object key, including metadata-looking and prototype-looking names. The same codec is used for run
inputs, outputs, options, workflow step results, and error causes.

Readers remain compatible with dates written by older releases as a one-key `$durlo.date` object.
That legacy shape is inherently ambiguous: an old literal object with exactly that shape cannot be
distinguished from an intended date and therefore continues to decode as a `Date`. New writes use
the versioned envelope and preserve that literal object shape. The codec rejects non-finite
numbers, `BigInt`, `undefined`, functions, symbols, circular objects, invalid dates, and unsupported
class instances.

The PostgreSQL adapter associates one codec generation with the whole run. Existing rows retain
the legacy codec; new rows use codec v2. The generation is carried by an internal storage-routing
token while public resource versions remain unchanged. New workers can claim both generations,
but workers from before codec v2 cannot claim v2 rows. This also lets new readers preserve old
literal objects that happen to resemble the v2 envelope.

## Storage limits

Limits are configured on `Durlo` and measured as compact serialized UTF-8 JSON.

| Limit                | Default | Behavior                                           |
| -------------------- | ------: | -------------------------------------------------- |
| `maxInputBytes`      |   1 MiB | Rejects creation before persistence                |
| `maxOutputBytes`     |   1 MiB | Fails the attempt without storing the output       |
| `maxErrorBytes`      |  64 KiB | Replaces oversized errors with bounded diagnostics |
| `maxBatchItems`      |   1,000 | Rejects the whole batch                            |
| `maxBatchBytes`      |  10 MiB | Rejects the whole batch                            |
| `maxStepResultBytes` |   1 MiB | Fails the step and workflow attempt                |
| `maxWorkflowSteps`   |   1,000 | Counts durable steps and sleeps                    |

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

Handler errors, execution-time serialization failures, and timeouts all follow the same retry
policy. There is currently no supported permanent-error, custom retry decision, `Retry-After`, or
retry-at timestamp exception.

Task exhaustion becomes `dead_letter`; workflow exhaustion becomes `failed`. Manual retry is
allowed only for those respective terminal states. It preserves history and schedules one more
claim without resetting automatic failure history.

Workflow re-entry after successful sleeps increases `attempt_count` without consuming failure
budget. Consequently `context.attempt.number` can exceed `context.attempt.maxAttempts`; the former
is a claim count and the latter a failure budget.

All timer-backed durations are finite and bounded by `2_147_483_647` milliseconds, the safe
Node.js timer range. Poll and lease intervals and retry backoff must be greater than zero; schedule
`delay: 0` remains valid and means immediate execution. Exponential retry calculation saturates at
the timer bound without overflowing. Durations larger than the valid JavaScript date range and
invalid `runAt` values are rejected before persistence.

## Timeouts, cancellation, and user code

Timeouts use `Promise.race` and abort the task/workflow signal with `AttemptTimeoutError`. The
timed-out promise is not terminated; code that ignores the signal can continue and perform late
external effects while a retry starts. Its lease token cannot complete or otherwise mutate the
closed step after ownership changes.

Cancellation is app-scoped and valid for pending, running, or sleeping work. It prevents future
Durlo state transitions, closes the owned active step as `cancelled`, and cancels pending timers.
Running code observes cancellation only after the next failed heartbeat, and arbitrary JavaScript
may continue locally.

Workflow sleep and lease-loss control flow uses module-private identity signals. Their constructors
are not public exports, and an ordinary error with the old name or shape is persisted as a normal
handler failure.

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

The PostgreSQL adapter additionally fences internal serialization generations. That routing detail
does not change the definition version returned by public reads or require application definitions
to bump their version for the codec-v2 rollout.

Keep a version only when new code can read every active input and checkpoint and preserves existing
step meanings, including the transformed input persisted by a Standard Schema. For a breaking
change, deploy new-version workers, switch producers, and retain old workers until old active runs
finish. `worker.getCompatibilityReport()` is bounded and relative to one worker, so it does not
prove fleet-wide unavailability.

## Reads and controls

- `runs.get()` returns one app-scoped run or `null`.
- `runs.list()` returns payload-free newest-first keyset pages; default 50, maximum 200.
- `runs.getDetails()` returns one repeatable-read snapshot plus a derived timeline and diagnostics.
- `runs.getBacklogHealth()` aggregates active state and lag for one app.
- `worker.getHealth()` reports one process's claim, timer, and execution-persistence state. Its
  `database.healthy` flag is true only when `claimFailures`, `timerFailures`, and
  `persistenceFailures` are all zero. `lastSuccessfulPersistenceAt` advances only after a confirmed
  durable run outcome—completion, failure/retry, sleep, or release; polling, lease loss, suppressed
  stale writes, and handler-only failures do not clear persistence failures.
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
