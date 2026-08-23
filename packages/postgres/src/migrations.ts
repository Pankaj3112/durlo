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
    `
  },
  {
    version: "0002_resource_versions",
    sql: `
      alter table durlo_runs
        add column resource_version text not null default '1';
      alter table durlo_runs
        add constraint durlo_runs_resource_version_check
        check (char_length(resource_version) >= 1 and char_length(resource_version) <= 128 and resource_version = btrim(resource_version));

      drop index durlo_runs_resource_idx;
      create index durlo_runs_resource_idx
        on durlo_runs (app_id, kind, resource_id, resource_version, status, scheduled_at);
    `
  },
  {
    version: "0003_retention_cleanup",
    sql: `
      create index durlo_runs_retention_idx
        on durlo_runs (app_id, updated_at, id)
        where status in ('completed', 'failed', 'dead_letter', 'cancelled');
    `
  },
  {
    version: "0004_observability_reads",
    sql: `
      create index durlo_runs_list_idx
        on durlo_runs (app_id, created_at desc, id desc);
      create index durlo_runs_status_list_idx
        on durlo_runs (app_id, status, kind, created_at desc, id desc);
      create index durlo_runs_resource_list_idx
        on durlo_runs (app_id, resource_id, resource_version, kind, created_at desc, id desc);
      create index durlo_runs_active_health_idx
        on durlo_runs (app_id, status, scheduled_at, created_at)
        where status in ('pending', 'running', 'sleeping');
      create index durlo_timers_run_idx
        on durlo_timers (run_id, created_at);
    `
  },
  {
    version: "0005_truthful_step_interruptions",
    sql: `
      alter table durlo_steps
        drop constraint durlo_steps_status_check;
      alter table durlo_steps
        add constraint durlo_steps_status_check
        check (status in ('pending', 'running', 'completed', 'failed', 'stalled', 'timed_out', 'cancelled'));

      update durlo_attempts as step_attempt
      set status = run_attempt.status,
          error_json = run_attempt.error_json,
          completed_at = coalesce(run_attempt.completed_at, now())
      from durlo_attempts as run_attempt
      where step_attempt.run_id = run_attempt.run_id
        and step_attempt.kind = 'step'
        and step_attempt.status = 'running'
        and step_attempt.lease_token is not null
        and run_attempt.kind = 'run'
        and run_attempt.lease_token = step_attempt.lease_token
        and run_attempt.status in ('failed', 'timed_out', 'stalled', 'cancelled');

      with interrupted as (
        select distinct on (attempt.run_id, attempt.step_id)
          attempt.run_id,
          attempt.step_id,
          attempt.status,
          attempt.error_json,
          attempt.completed_at
        from durlo_attempts as attempt
        where attempt.kind = 'step'
          and attempt.step_id is not null
          and attempt.status in ('failed', 'timed_out', 'stalled', 'cancelled')
        order by
          attempt.run_id,
          attempt.step_id,
          attempt.attempt_number desc,
          attempt.started_at desc,
          attempt.id desc
      )
      update durlo_steps as step
      set status = interrupted.status,
          result_json = null,
          error_json = interrupted.error_json,
          updated_at = coalesce(interrupted.completed_at, now()),
          completed_at = coalesce(interrupted.completed_at, now())
      from interrupted
      where interrupted.run_id = step.run_id
        and interrupted.step_id = step.step_id
        and step.status <> 'completed'
        and not exists (
          select 1
          from durlo_attempts as active_attempt
          join durlo_runs as active_run
            on active_run.id = active_attempt.run_id
           and active_run.status = 'running'
           and active_run.lease_token = active_attempt.lease_token
          where active_attempt.run_id = step.run_id
            and active_attempt.step_id = step.step_id
            and active_attempt.kind = 'step'
            and active_attempt.status = 'running'
        );
    `
  },
  {
    version: "0006_serialization_versions",
    sql: `
      alter table durlo_runs
        drop constraint durlo_runs_resource_version_check;
      alter table durlo_runs
        add constraint durlo_runs_resource_version_check
        check (
          (
            char_length(resource_version) >= 1
            and char_length(resource_version) <= 128
            and resource_version = btrim(resource_version)
          )
          or
          (
            left(resource_version, 24) = ' @durlo/serialization/2:'
            and char_length(resource_version) >= 25
            and char_length(resource_version) <= 152
            and substring(resource_version from 25) = btrim(substring(resource_version from 25))
          )
        );
    `
  },
  {
    version: "0007_idempotency_comparison_metadata",
    sql: `
      alter table durlo_runs
        add column idempotency_resource_version text,
        add column idempotency_input_json jsonb,
        add column idempotency_execution_options_json jsonb,
        add column idempotency_schedule_json jsonb;
    `
  }
];
