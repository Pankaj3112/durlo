# Durlo Decisions And Edge Cases

Status: Draft
Date: 2026-07-08

Purpose: record product and architecture decisions that came out of auditing the docs against Trigger.dev, Inngest, BullMQ, and Temporal. This file is the implementation risk register for v1.

## Product Decisions

### V1 Is Task/Workflow-First

Decision: v1 exposes direct tasks and direct workflows.

```txt
task.enqueue(input)
workflow.start(input)
```

Deferred:

- event ingestion
- `durlo.send(...)`
- `eventType(...)`
- event-triggered workflows
- `step.sendEvent(...)`
- `step.waitForEvent(...)`

Reason: events require separate storage, trigger matching, event idempotency, dashboard views, and failure semantics. Direct tasks/workflows solve the initial BullMQ/custom-table pain with less surface area.

### Canonical Naming Is `Durlo`

Use:

- `@durlo/core`
- `@durlo/postgres`
- `@durlo/cli`
- `new Durlo(...)`
- `durlo.task(...)`
- `durlo.workflow(...)`

Do not use:

- `@durable/*`
- `createDurable(...)`
- `createTask(...)`
- `createFunction(...)`
- `durlo.send(...)`

### Default Retry Attempts Are 3

`attempts` includes the first attempt. `attempts: 3` means one initial attempt and up to two retries.

Default:

```txt
attempts: 3
backoff: exponential
base delay: 10 seconds
jitter: 0.2
```

Risk: retries imply at-least-once external side effects. Docs must repeatedly tell users to make side effects idempotent.

### Step-Level Retry Overrides Are Not V1

V1 `step.run(...)` inherits the workflow run retry policy. Per-step retry policies are deferred because they complicate attempt accounting, error propagation, and retry budget reset after successful checkpoints.

## Execution Edge Cases

### Worker Crashes After Claim

Problem: a worker can claim a run, update it to `running`, commit, then die before user code or before completion persistence.

Decision:

- claims use `locked_by`, `lease_token`, and `locked_until`
- `lease_token` is unique per claim
- expired `running` rows are reclaimed or terminally failed
- lease expiry is recorded as a stalled attempt
- stale writes with an old token are rejected

Implementation invariant:

```txt
complete/fail/extend running attempt requires:
run id + worker id + lease token + status = running
```

### Worker Crashes After External Side Effect

Problem: user code may send an email, charge a card, or call an API, then crash before Durlo records success.

Decision: Durlo is at-least-once. It cannot guarantee exactly-once external side effects. Idempotency keys deduplicate run creation only.

Docs must show users how to use business-level idempotency, provider idempotency keys, or transactional side-effect records.

### CPU-Bound Code Blocks Lease Renewal

Problem: a Node worker can block the event loop long enough that lease renewal misses `locked_until`, causing duplicate processing.

Decision:

- document this like BullMQ documents stalled jobs
- expose stalled attempts in dashboard
- let users increase `leaseDuration`
- advise splitting CPU-heavy work or moving it out of the worker process

### Expired Running Rows Must Not Strand

Problem: a claim query that only selects `status = 'pending'` leaves crashed `running` rows stuck forever.

Decision: worker polling must include expired `running` rows and either reclaim them or terminally fail them if retry budget is exhausted.

### Stale Worker Finishes Late

Problem: worker A loses its lease, worker B reclaims the run, then worker A returns and writes completion.

Decision: `locked_by` alone is insufficient because worker ids can be reused. Every claim gets a unique `lease_token`; all running-state writes verify it.

### Cancellation Race

Problem: user cancels a run while JavaScript is already executing.

Decision:

- cancellation is best-effort
- cancellation prevents future execution
- cancellation does not safely interrupt arbitrary JavaScript
- a stale completion after cancellation must be rejected

### Timer Race

Problem: a workflow sleep timer becomes due after the run was cancelled or terminally failed.

Decision: timer firing and run resume are one transaction and only resume when the run is still `sleeping`.

### Batch Idempotency

Problem: batch enqueue with duplicate idempotency keys can produce ambiguous handles.

Decision: duplicate idempotency keys inside one batch are a validation error in v1.

### Manual Retry

Decision:

- manual retry is allowed for `dead_letter` task runs
- manual retry is allowed for `failed` workflow runs
- manual retry is not allowed for completed, cancelled, pending, running, or sleeping runs
- manual retry preserves attempt history
- manual retry does not reset idempotency keys

Manual retry also does not reset automatic failure history. It grants one new execution attempt; a failed manual attempt returns to terminal status and can be retried manually again.

### Workflow Sleeps Do Not Consume Failure Retries

`attempt_count` records every claim, including workflow re-entry after a sleep. Retry exhaustion is calculated from failed, timed-out, and stalled attempt records rather than raw claim count. A workflow may therefore cross more durable sleep boundaries than its configured `attempts` value, while actual failures still obey that retry budget.

## Workflow Edge Cases

### Durlo Is Not Temporal Replay

Durlo does not record a full workflow event history or enforce deterministic replay.

Workflow code is re-entered and completed steps are skipped using stored checkpoints. That means top-level workflow code can run more than once and must be safe to re-run.

### Mutable Outer Variables In Steps

Bad:

```ts
let userId: string | undefined;

await step.run("load-user", async () => {
  userId = await loadUserId();
});

await step.run("send-email", async () => {
  await sendEmail(userId!);
});
```

On resume, `load-user` is skipped and `userId` is undefined.

Good:

```ts
const userId = await step.run("load-user", async () => {
  return loadUserId();
});

await step.run("send-email", async () => {
  await sendEmail(userId);
});
```

### Nested Steps

Bad:

```ts
await step.run("outer", async () => {
  await step.run("inner", async () => {
    return "value";
  });
});
```

Decision: nested `step.*` calls are runtime errors in v1.

### Unstable Step IDs

Bad:

```ts
await step.run(`send-${Date.now()}`, sendEmail);
```

Good:

```ts
await step.run(`send-${userId}`, sendEmail);
```

Step ids must be stable across retries and resumes. If a workflow loops over data, the step id should use a stable business identifier, not array order that can change.

### Non-Durable Branching

Bad:

```ts
const activated = await users.isActivated(input.userId);

if (!activated) {
  await step.run("send-reminder", sendReminder);
}
```

Good:

```ts
const activated = await step.run("check-activation", async () => {
  return users.isActivated(input.userId);
});

if (!activated) {
  await step.run("send-reminder", sendReminder);
}
```

Branching should use input or persisted step results so resumes see the same decision.

## Storage Edge Cases

### Idempotency Window

Decision: v1 has no idempotency TTL. The dedupe window lasts as long as the run row exists.

Terminal runs keep their idempotency keys. Reusing a key after success/failure/cancel returns the existing handle.

Future APIs can add TTL/reset once product needs are clear.

### JSON Serialization

Inputs, outputs, step results, and errors are stored as JSON.

V1 should reject unsupported values before persistence where possible:

- `BigInt`
- functions
- symbols
- circular objects
- class instances that cannot be represented as JSON

Dates and Errors need explicit serializer behavior. Values read from storage are plain data, not original class instances.

### Resource Registration

Workers claim only resource ids they registered at startup.

If storage has a task/workflow id that the worker does not know, the worker skips it. This allows multiple worker processes to own different subsets of work.

## Operational Edge Cases

### Process-Local Concurrency

V1 `worker.concurrency` is local to one worker process.

It is not:

- a distributed global limit
- a per-task limit
- a per-tenant limit
- a queue limit

Distributed concurrency and custom queues are future features.

### PgBouncer Compatibility

Durlo must not hold transactions while user code runs.

The worker uses short transactions for:

- creating runs
- claiming runs
- extending leases
- completing/failing runs
- creating step checkpoints
- firing timers

`LISTEN/NOTIFY` is optional future optimization, not v1's required wakeup path.

### Clock Behavior

Postgres `now()` should be the source of truth for scheduling, lease expiry, and timer due checks. JavaScript clocks can compute requested dates, but persisted eligibility should be compared in Postgres.

### Priority

Priority only orders eligible pending work. Higher priority can starve low-priority work if the queue is constantly full of high-priority runs. V1 does not implement weighted fairness.

## Documentation Invariants

Before implementation starts, searches across `docs/` should show:

- no v1 examples that import `@durable/*`
- no v1 examples that call `createDurable(...)`
- no v1 examples that call `createTask(...)`
- no v1 examples that call `createFunction(...)`
- no v1 examples that call `durlo.send(...)`
- no event storage in the v1 schema
- one retry default: `attempts: 3`
- one public package family in v1 examples: `@durlo/*`
