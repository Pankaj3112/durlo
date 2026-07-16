# Durlo Observability

Status: Current
Updated: 2026-07-16

Durlo exposes an app-scoped read model for local CLIs, dashboards, and operational diagnosis. It is derived from run, step, attempt, and timer records already required for execution. V1 does not add an event stream or a separate event-history table.

`durlo dev` renders this read model through the loopback-by-default local dashboard documented in [CLI And Local Dashboard](CLI_AND_DASHBOARD.md). The dashboard remains a consumer of these public reads and controls; it does not add storage or transition semantics.

## Run Listing

`durlo.runs.list()` returns payload-free summaries ordered newest first by `(created_at, id)`. The id is the deterministic tie-breaker when multiple runs share a creation timestamp.

```ts
const firstPage = await durlo.runs.list({
  statuses: ["pending", "running"],
  kinds: ["task"],
  resourceId: "send-invoice",
  resourceVersion: "2",
  createdAfter: "2026-07-01T00:00:00.000Z",
  limit: 50
});

const nextPage = firstPage.nextCursor
  ? await durlo.runs.list({
      statuses: ["pending", "running"],
      kinds: ["task"],
      resourceId: "send-invoice",
      resourceVersion: "2",
      createdAfter: "2026-07-01T00:00:00.000Z",
      limit: 50,
      cursor: firstPage.nextCursor
    })
  : null;
```

Rules:

- Every query is scoped to the `Durlo` instance's app id.
- Filters across fields use `AND`; values inside `statuses` or `kinds` use `OR`.
- Empty or omitted status and kind arrays do not filter that field.
- `createdAfter` and `createdBefore` are exclusive bounds.
- The default limit is 50 and the maximum is 200.
- `nextCursor` is opaque and versioned. Pass it back unchanged with the same filters.
- Summaries omit input, output, errors, options, idempotency keys, and lease ownership fields.

Pagination is keyset-based, not a long-lived database snapshot. Newer rows created between page requests do not duplicate older pages, but they appear only when listing again from the beginning. Concurrent retention can remove rows before a later page is read.

## Run Details And Timeline

`durlo.runs.getDetails(handleOrId)` returns `null` for a missing or differently scoped run. Otherwise it returns one short repeatable-read snapshot containing:

- the complete run record, including input, output, run error, options, and timestamps
- workflow steps and their results or errors
- run and step attempts, including worker id, status, error, and timing
- workflow timers and their scheduled, fired, or cancelled timestamps
- a chronological `timeline`
- derived `diagnostics`
- `checkedAt`, sourced from the Postgres clock used for the snapshot

The read transaction takes no row locks and commits before the call resolves. Claiming, heartbeats, timers, and completion do not wait for the detail reader's row locks because there are none.

The timeline normalizes durable records into typed entries such as:

- run creation and terminal status
- run and step attempt start and outcome
- step creation and completion or failure
- timer scheduling, firing, or cancellation
- automatic or manual retry starts, plus a currently scheduled retry or graceful-shutdown release

Events with identical database timestamps use a deterministic semantic order and record id tie-breaker. The timeline explains status changes from stored evidence; it is not Temporal-style replay. Durlo does not retain every overwritten scheduling value, so a historical failure followed by another attempt proves that a retry occurred but does not reconstruct the exact old backoff deadline after later transitions.

## Diagnostics

Run detail diagnostics expose:

- `failureCount`: failed, timed-out, and stalled run attempts
- `failedAttempts`, `timedOutAttempts`, and `stalledAttempts`
- `retryCount`: failures followed by, or currently scheduled for, another attempt; the final failure of a currently terminal failed/dead-letter run is excluded
- `leaseLossCount`: durable stalled attempts caused by expired leases
- `hasExpiredLease`: whether the current running lease is already expired at `checkedAt`
- `timerLagMs`: the largest current delay beyond a pending timer's `fireAt`

A worker can observe lease loss before another worker records the old attempt as stalled. During that interval, the structured `run.lease_lost` log describes the local failure; process health continues to describe polling state. `hasExpiredLease` becomes true after the durable lease deadline, and reclaim records the stalled attempt.

## Local Operational Health

Three bounded/read-only views cover different scopes:

```ts
const processHealth = worker.getHealth();
const backlog = await durlo.runs.getBacklogHealth();
const compatibility = await worker.getCompatibilityReport({ limit: 100 });
```

- `worker.getHealth()` is process-local. It reports lifecycle, occupied slots, database polling failures, last successful polls, and the last operational error.
- `durlo.runs.getBacklogHealth()` is app-scoped and database-clocked. It reports active, ready, delayed, running, sleeping, and expired-lease counts; oldest-ready timestamps and lag; and pending/due timer counts and lag.
- `worker.getCompatibilityReport()` is relative to that worker's registrations. It surfaces bounded active runs with `unregistered_resource` or `incompatible_version` reasons.

Compatibility is intentionally worker-relative. A run unavailable to one specialized worker may be available to another worker in the fleet, so the report must not be presented as proof that code is globally absent.

## Query Safety And Indexes

Migration `0004_observability_reads` adds indexes for newest-run pages, status/kind filters, resource/version filters, active backlog aggregation, and run timer detail. Existing run-id, step, attempt, lease, and due-timer indexes serve the remaining reads.

Listing uses bounded keyset pages. Detail uses one run id. The compatibility report is bounded. Backlog health aggregates active rows for one app and should be polled at an operator cadence, not once per worker poll. The reproducible 50,000-run benchmark and required query plans are documented in [Postgres Performance](PERFORMANCE.md).
