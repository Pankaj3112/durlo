# Durlo Retention Cleanup

Status: Current
Updated: 2026-07-16

Durlo v1 provides a manual, bounded cleanup operation. Durlo never schedules or runs retention automatically.

## API

```ts
const result = await durlo.runs.cleanup({
  olderThan: "30d",
  limit: 1_000,
  statuses: ["completed", "failed", "dead_letter", "cancelled"]
});
```

`olderThan` is required and must be greater than zero. PostgreSQL `now()` calculates the cutoff so worker and application clocks do not decide eligibility.

`limit` defaults to 1,000 and must be between 1 and 10,000. `statuses` defaults to every terminal status and may contain any non-empty subset of `completed`, `failed`, `dead_letter`, and `cancelled` without duplicates.

The result contains:

- `deletedRuns`: number of deleted run rows
- `deletedRunIds`: ids in oldest-first cleanup order
- `limitReached`: true when the operation deleted exactly its requested limit; it means the cap was reached, not that another matching row is guaranteed

Call cleanup repeatedly until `limitReached` is false. Operators should pause between batches when database load matters.

## Safety Boundary

Cleanup is scoped to the `Durlo` app id. It considers only terminal rows whose `updated_at` is older than the requested Postgres-clock age. Pending, running, and sleeping runs are never candidates, even if their timestamps are old.

The Postgres adapter selects oldest candidates with `FOR UPDATE SKIP LOCKED` and deletes the bounded set in the same statement. This makes cleanup safe alongside multiple cleanup processes and manual retry:

- if manual retry wins the row lock first, the run becomes pending and cleanup cannot delete it
- if cleanup wins first, manual retry observes that the run no longer exists
- a locked row may be skipped and handled by a later cleanup call

Deleting a run cascades to its steps, timers, and attempt history. Cleanup is irreversible; export or back up history before deleting it when audit requirements demand that.

## Idempotency Keys

The v1 idempotency window lasts exactly as long as the run row. Terminal status alone never releases an idempotency key.

When cleanup deletes a terminal run, its idempotency key is deleted with it. A later enqueue or start using that key may create a new run. This is intentional: retention age is also the minimum deduplication window for cleaned statuses.

Runs excluded by app id, age, status filter, row lock, or batch limit keep their idempotency keys. `limitReached` should therefore be treated as a signal to continue cleanup, not as permission to assume every old key was released.

## Index And Query Shape

Migration `0003_retention_cleanup` adds a partial `(app_id, updated_at, id)` index over terminal rows. Cleanup orders by that key, which keeps batches deterministic and prevents active queue rows from bloating the retention index.
