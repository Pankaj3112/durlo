export type Migration = { version: string; sql: string };

export const migrations: readonly Migration[] = [
  {
    version: "0001_initial",
    sql: `
      create table durlo_runs (
        id text primary key,
        app_id text not null,
        kind text not null check (kind in ('task', 'workflow')),
        resource_id text not null,
        status text not null check (status in ('pending', 'running', 'sleeping', 'completed', 'failed', 'dead_letter', 'cancelled')),
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
        check (idempotency_key is null or (char_length(idempotency_key) >= 1 and char_length(idempotency_key) <= 2048)),
        check (
          (status = 'running' and locked_by is not null and lease_token is not null and locked_until is not null)
          or
          (status <> 'running' and locked_by is null and lease_token is null and locked_until is null)
        )
      );

      create index durlo_runs_due_idx on durlo_runs (app_id, priority desc, scheduled_at, created_at) where status = 'pending';
      create index durlo_runs_lease_idx on durlo_runs (app_id, locked_until) where status = 'running';
      create index durlo_runs_resource_idx on durlo_runs (app_id, kind, resource_id, status, scheduled_at);
      create unique index durlo_runs_idempotency_idx
        on durlo_runs (app_id, kind, resource_id, idempotency_key)
        where idempotency_key is not null;

      create table durlo_steps (
        id text primary key,
        run_id text not null references durlo_runs(id) on delete cascade,
        step_id text not null,
        status text not null check (status in ('pending', 'running', 'completed', 'failed')),
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
      create unique index durlo_steps_run_step_idx on durlo_steps (run_id, step_id);
      create index durlo_steps_run_idx on durlo_steps (run_id, created_at);

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
      create unique index durlo_timers_run_step_idx on durlo_timers (run_id, step_id);
      create index durlo_timers_due_idx on durlo_timers (fire_at) where status = 'pending';

      create table durlo_attempts (
        id text primary key,
        run_id text not null references durlo_runs(id) on delete cascade,
        step_id text,
        kind text not null check (kind in ('run', 'step')),
        attempt_number integer not null,
        status text not null check (status in ('running', 'succeeded', 'failed', 'timed_out', 'stalled', 'cancelled')),
        worker_id text,
        lease_token text,
        error_json jsonb,
        started_at timestamptz not null default now(),
        completed_at timestamptz,
        check (attempt_number >= 1)
      );
      create index durlo_attempts_run_idx on durlo_attempts (run_id, started_at);
      create index durlo_attempts_step_idx on durlo_attempts (run_id, step_id, started_at) where step_id is not null;
    `,
  },
];
