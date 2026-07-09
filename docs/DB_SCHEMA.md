# Durlo Database Schema

Status: Draft
Date: 2026-07-08

Answers: **How is it stored?**

This document defines the v1 Postgres storage model. It intentionally avoids public TypeScript API details and adapter method contracts.

## Principles

- Use normal Postgres tables.
- No Postgres extension required.
- No superuser permission required.
- No mandatory `LISTEN/NOTIFY`.
- Work with PgBouncer transaction pooling.
- Do not hold long transactions while user code runs.
- Store task runs and workflow runs in one run table.
- Store workflow step checkpoints separately.
- Use unique lease tokens so stale workers cannot complete reclaimed work.
- Adapter code sets `updated_at`; no database trigger is required in v1.

Table names use the `durlo_` prefix.

## Tables

V1 tables:

- `durlo_schema_migrations`
- `durlo_runs`
- `durlo_steps`
- `durlo_timers`
- `durlo_attempts`

Events are not stored in v1 because events are not part of the v1 public API.

## `durlo_schema_migrations`

Tracks applied Durlo migrations.

```sql
create table durlo_schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
```

## `durlo_runs`

Stores task and workflow runs.

```sql
create table durlo_runs (
  id text primary key,
  app_id text not null,
  kind text not null check (kind in ('task', 'workflow')),
  resource_id text not null,

  status text not null check (
    status in (
      'pending',
      'running',
      'sleeping',
      'completed',
      'failed',
      'dead_letter',
      'cancelled'
    )
  ),

  input_json jsonb not null,
  output_json jsonb,
  error_json jsonb,
  options_json jsonb not null default '{}'::jsonb,

  idempotency_key text,
  priority integer not null default 0,
  scheduled_at timestamptz not null default now(),

  attempt_count integer not null default 0,
  max_attempts integer not null default 3,

  locked_by text,
  lease_token text,
  locked_until timestamptz,
  stalled_count integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,

  check (attempt_count >= 0),
  check (max_attempts >= 1 and max_attempts <= 100),
  check (stalled_count >= 0),
  check (idempotency_key is null or char_length(idempotency_key) <= 2048),
  check (
    (
      status = 'running'
      and locked_by is not null
      and lease_token is not null
      and locked_until is not null
    )
    or
    (
      status <> 'running'
      and locked_by is null
      and lease_token is null
      and locked_until is null
    )
  )
);
```

Important indexes:

```sql
create index durlo_runs_due_idx
  on durlo_runs (app_id, priority desc, scheduled_at, created_at)
  where status = 'pending';

create index durlo_runs_lease_idx
  on durlo_runs (app_id, locked_until)
  where status = 'running';

create index durlo_runs_resource_idx
  on durlo_runs (app_id, kind, resource_id, status, scheduled_at);

create unique index durlo_runs_idempotency_idx
  on durlo_runs (app_id, kind, resource_id, idempotency_key)
  where idempotency_key is not null;
```

## `durlo_steps`

Stores workflow step checkpoints.

```sql
create table durlo_steps (
  id text primary key,
  run_id text not null references durlo_runs(id) on delete cascade,
  step_id text not null,

  status text not null check (
    status in ('pending', 'running', 'completed', 'failed')
  ),

  result_json jsonb,
  error_json jsonb,
  options_json jsonb not null default '{}'::jsonb,

  attempt_count integer not null default 0,
  max_attempts integer not null default 3,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,

  check (attempt_count >= 0),
  check (max_attempts >= 1 and max_attempts <= 100)
);
```

Important indexes:

```sql
create unique index durlo_steps_run_step_idx
  on durlo_steps (run_id, step_id);

create index durlo_steps_run_idx
  on durlo_steps (run_id, created_at);
```

## `durlo_timers`

Stores workflow sleep timers.

Initial task/workflow delay can live on `durlo_runs.scheduled_at`; sleep state uses this table.

```sql
create table durlo_timers (
  id text primary key,
  run_id text not null references durlo_runs(id) on delete cascade,
  step_id text not null,

  fire_at timestamptz not null,
  status text not null check (status in ('pending', 'fired', 'cancelled')),

  created_at timestamptz not null default now(),
  fired_at timestamptz,
  cancelled_at timestamptz
);
```

Important indexes:

```sql
create unique index durlo_timers_run_step_idx
  on durlo_timers (run_id, step_id);

create index durlo_timers_due_idx
  on durlo_timers (fire_at)
  where status = 'pending';
```

## `durlo_attempts`

Stores run and step attempt history.

```sql
create table durlo_attempts (
  id text primary key,
  run_id text not null references durlo_runs(id) on delete cascade,
  step_id text,

  kind text not null check (kind in ('run', 'step')),
  attempt_number integer not null,
  status text not null check (
    status in ('running', 'succeeded', 'failed', 'timed_out', 'stalled', 'cancelled')
  ),

  worker_id text,
  lease_token text,
  error_json jsonb,

  started_at timestamptz not null default now(),
  completed_at timestamptz,

  check (attempt_number >= 1)
);
```

Important indexes:

```sql
create index durlo_attempts_run_idx
  on durlo_attempts (run_id, started_at);

create index durlo_attempts_step_idx
  on durlo_attempts (run_id, step_id, started_at)
  where step_id is not null;
```

## Claiming Work

The adapter should claim due runs with short transactions and row locks.

Expected Postgres pattern for new due work:

```sql
select id
from durlo_runs
where app_id = $1
  and status = 'pending'
  and scheduled_at <= now()
  and (locked_until is null or locked_until < now())
order by priority desc, scheduled_at asc, created_at asc
for update skip locked
limit $2;
```

Expected Postgres pattern for expired running work:

```sql
select id
from durlo_runs
where app_id = $1
  and status = 'running'
  and locked_until < now()
order by locked_until asc, created_at asc
for update skip locked
limit $2;
```

Expired running rows must not stay `running` forever. The adapter must either:

1. Reclaim the row when the count of failed, timed-out, and stalled run attempts is below `max_attempts`.
2. Move the row to `dead_letter` for tasks or `failed` for workflows if retry budget is exhausted.

When reclaiming expired running rows, the adapter must first mark the previous active attempt `stalled`, increment `stalled_count`, and then create a new running attempt.

`attempt_count` is an execution/claim counter, not the retry-failure counter. This distinction lets workflow sleep resumes create honest attempt history without consuming the workflow's failure retry budget.

The transaction should update claimed rows with:

```txt
status = running
locked_by = worker id
lease_token = new unique token
locked_until = now + lease duration
attempt_count = attempt_count + 1
started_at = coalesce(started_at, now)
updated_at = now
```

Then the transaction commits before user code runs.

## Status Transitions

Task run:

```txt
pending -> running -> completed
pending -> running -> pending
pending -> running -> dead_letter
running -> running   (expired lease reclaimed with new lease_token)
running -> dead_letter (expired lease exhausted)
pending -> cancelled
running -> cancelled
```

Workflow run:

```txt
pending -> running -> sleeping
sleeping -> pending
pending -> running -> completed
pending -> running -> failed
running -> running   (expired lease reclaimed with new lease_token)
running -> failed    (expired lease exhausted)
pending -> cancelled
sleeping -> cancelled
```

Step:

```txt
pending -> running -> completed
pending -> running -> failed
completed -> completed
```

## JSON Storage

Use `jsonb` for:

- run input
- run output
- serialized errors
- run options
- step result
- step options

Values must be serialized before storage. Public serialization details belong in execution semantics or implementation docs, not in the schema.

## Lease Token Safety

Every claim generates a new `lease_token`.

Adapter writes that finish or mutate a running attempt must match:

```txt
run id
worker id
lease token
status = running
```

This prevents worker A from completing a run after worker B reclaimed the same row. `locked_by` alone is not enough because worker ids can be reused across process restarts.

Lease extension must also match the current `lease_token`. If no row is updated, the worker no longer owns the run.

## Timer Firing

Due timers must be fired in the same transaction that moves the owning workflow run from `sleeping` to `pending`.

The update must check:

```txt
timer.status = pending
timer.fire_at <= now
run.status = sleeping
```

If the run is `cancelled`, `completed`, `failed`, or `dead_letter`, the timer must not resume it.

## Retention

V1 can keep rows indefinitely.

Retention cleanup can be added later. If cleanup deletes rows with idempotency keys, those keys no longer deduplicate future calls.
