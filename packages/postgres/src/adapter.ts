import type {
  AppRunInput,
  ClaimedRun,
  ClaimRunsInput,
  CreateRunInput,
  DurloAdapter,
  FailRunInput,
  JsonValue,
  OwnedRunInput,
  RegisteredResource,
  RunKind,
  RunRecord,
  RunStatus,
  SerializedError,
  StepInput,
  StepRecord,
  StepStatus,
  TimerRecord,
  TimerStatus,
  TransactionalDurloAdapter,
  UnavailableRun
} from "@durlo/core";
import { LostLeaseError, RunStateError, StorageLimitError, ValidationError } from "@durlo/core";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
import { migrations } from "./migrations.js";

export type PostgresAdapterOptions = PoolConfig & {
  connectionString?: string;
};

type RunRow = QueryResultRow & {
  id: string;
  app_id: string;
  kind: RunKind;
  resource_id: string;
  resource_version: string;
  status: RunStatus;
  input_json: JsonValue;
  output_json: JsonValue | null;
  error_json: SerializedError | null;
  options_json: JsonValue;
  idempotency_key: string | null;
  priority: number;
  scheduled_at: Date;
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  lease_token: string | null;
  locked_until: Date | null;
  stalled_count: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
};

type StepRow = QueryResultRow & {
  id: string;
  run_id: string;
  step_id: string;
  status: StepStatus;
  result_json: JsonValue | null;
  error_json: SerializedError | null;
  options_json: JsonValue;
  attempt_count: number;
  max_attempts: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

type TimerRow = QueryResultRow & {
  id: string;
  run_id: string;
  step_id: string;
  fire_at: Date;
  status: TimerStatus;
  created_at: Date;
  fired_at: Date | null;
  cancelled_at: Date | null;
};

type Query = <R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
) => Promise<QueryResult<R>>;

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    appId: row.app_id,
    kind: row.kind,
    resourceId: row.resource_id,
    resourceVersion: row.resource_version,
    status: row.status,
    input: row.input_json,
    output: row.output_json,
    error: row.error_json,
    options: row.options_json,
    idempotencyKey: row.idempotency_key,
    priority: row.priority,
    scheduledAt: row.scheduled_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    leaseToken: row.lease_token,
    lockedUntil: row.locked_until,
    stalledCount: row.stalled_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at
  };
}

function mapStep(row: StepRow): StepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    status: row.status,
    result: row.result_json,
    error: row.error_json,
    options: row.options_json,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function mapTimer(row: TimerRow): TimerRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    fireAt: row.fire_at,
    status: row.status,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    cancelledAt: row.cancelled_at
  };
}

const RUN_COLUMNS = `
  id, app_id, kind, resource_id, resource_version, status, input_json, output_json, error_json, options_json,
  idempotency_key, priority, scheduled_at, attempt_count, max_attempts, locked_by,
  lease_token, locked_until, stalled_count, created_at, updated_at, started_at,
  completed_at, cancelled_at
`;

const STEP_COLUMNS = `
  id, run_id, step_id, status, result_json, error_json, options_json,
  attempt_count, max_attempts, created_at, updated_at, started_at, completed_at
`;

const TIMER_COLUMNS = `id, run_id, step_id, fire_at, status, created_at, fired_at, cancelled_at`;
const QUALIFIED_TIMER_COLUMNS = `
  t.id, t.run_id, t.step_id, t.fire_at, t.status, t.created_at, t.fired_at, t.cancelled_at
`;

export class PostgresAdapter implements DurloAdapter {
  readonly pool: Pool;
  private readonly boundClient?: PoolClient;

  constructor(options: PostgresAdapterOptions | Pool, boundClient?: PoolClient) {
    this.pool = options instanceof Pool ? options : new Pool(options);
    if (boundClient) this.boundClient = boundClient;
  }

  async migrate(): Promise<void> {
    const client = this.boundClient ?? (await this.pool.connect());
    const release = this.boundClient ? undefined : () => client.release();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('durlo:migrations'))");
      await client.query(`
        create table if not exists durlo_schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      for (const migration of migrations) {
        const applied = await client.query<{ version: string }>(
          "select version from durlo_schema_migrations where version = $1",
          [migration.version]
        );
        if (applied.rowCount === 0) {
          await client.query(migration.sql);
          await client.query("insert into durlo_schema_migrations (version) values ($1)", [
            migration.version
          ]);
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      release?.();
    }
  }

  async close(): Promise<void> {
    if (!this.boundClient) await this.pool.end();
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    return this.insertRun(this.query(), input);
  }

  async createRuns(inputs: CreateRunInput[]): Promise<RunRecord[]> {
    const keys = inputs
      .map((input) => input.idempotencyKey)
      .filter((key): key is string => key !== null);
    if (new Set(keys).size !== keys.length)
      throw new Error("duplicate idempotency keys in one batch are not allowed");
    if (this.boundClient)
      return Promise.all(inputs.map((input) => this.insertRun(this.query(), input)));

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const query: Query = (text, values) => client.query(text, values);
      const records: RunRecord[] = [];
      for (const input of inputs) records.push(await this.insertRun(query, input));
      await client.query("commit");
      return records;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(input: AppRunInput): Promise<RunRecord | null> {
    const result = await this.query()<RunRow>(
      `select ${RUN_COLUMNS} from durlo_runs where app_id = $1 and id = $2`,
      [input.appId, input.runId]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async claimRuns(input: ClaimRunsInput): Promise<ClaimedRun[]> {
    if (input.resources.length === 0 || input.limit <= 0) return [];
    const resourceKinds = input.resources.map(({ kind }) => kind);
    const resourceIds = input.resources.map(({ resourceId }) => resourceId);
    const resourceVersions = input.resources.map(({ resourceVersion }) => resourceVersion ?? "1");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const candidates = await client.query<RunRow>(
        `
          select ${RUN_COLUMNS}
          from durlo_runs
          where app_id = $1
            and exists (
              select 1
              from unnest($2::text[], $3::text[], $4::text[])
                as resource(kind, resource_id, resource_version)
              where resource.kind = durlo_runs.kind
                and resource.resource_id = durlo_runs.resource_id
                and resource.resource_version = durlo_runs.resource_version
            )
            and (
              (status = 'pending' and scheduled_at <= now())
              or (status = 'running' and locked_until < now())
            )
          order by
            case when status = 'running' then 0 else 1 end,
            priority desc,
            scheduled_at asc,
            created_at asc
          for update skip locked
          limit $5
        `,
        [input.appId, resourceKinds, resourceIds, resourceVersions, input.limit]
      );
      const claimed: ClaimedRun[] = [];
      for (const candidate of candidates.rows) {
        if (candidate.status === "running") {
          await client.query(
            `
              update durlo_attempts
              set status = 'stalled', completed_at = now(),
                  error_json = $3::jsonb
              where run_id = $1 and lease_token = $2 and kind = 'run' and status = 'running'
            `,
            [
              candidate.id,
              candidate.lease_token,
              JSON.stringify({ name: "StalledError", message: "worker lease expired" })
            ]
          );
          const failureResult = await client.query<{ count: string }>(
            `
              select count(*)::text as count from durlo_attempts
              where run_id = $1 and kind = 'run' and status in ('failed', 'timed_out', 'stalled')
            `,
            [candidate.id]
          );
          const failureCount = Number(failureResult.rows[0]?.count ?? 0);
          if (failureCount >= candidate.max_attempts) {
            await client.query(
              `
                update durlo_runs
                set status = case when kind = 'task' then 'dead_letter' else 'failed' end,
                    error_json = $2::jsonb,
                    stalled_count = stalled_count + 1,
                    locked_by = null, lease_token = null, locked_until = null,
                    updated_at = now(), completed_at = now()
                where id = $1
              `,
              [
                candidate.id,
                JSON.stringify({ name: "StalledError", message: "worker lease expired" })
              ]
            );
            continue;
          }
        }

        const failureResult = await client.query<{ count: string }>(
          `
            select count(*)::text as count from durlo_attempts
            where run_id = $1 and kind = 'run' and status in ('failed', 'timed_out', 'stalled')
          `,
          [candidate.id]
        );
        const failureCount = Number(failureResult.rows[0]?.count ?? 0);

        const leaseToken = randomUUID();
        const updated = await client.query<RunRow>(
          `
            update durlo_runs
            set status = 'running',
                locked_by = $2,
                lease_token = $3,
                locked_until = now() + ($4 * interval '1 millisecond'),
                attempt_count = attempt_count + 1,
                stalled_count = stalled_count + $5,
                started_at = coalesce(started_at, now()),
                updated_at = now()
            where id = $1
            returning ${RUN_COLUMNS}
          `,
          [
            candidate.id,
            input.workerId,
            leaseToken,
            input.leaseDuration,
            candidate.status === "running" ? 1 : 0
          ]
        );
        const row = updated.rows[0];
        if (!row) continue;
        await client.query(
          `
            insert into durlo_attempts (
              id, run_id, kind, attempt_number, status, worker_id, lease_token
            ) values ($1, $2, 'run', $3, 'running', $4, $5)
          `,
          [randomUUID(), row.id, row.attempt_count, input.workerId, leaseToken]
        );
        claimed.push({ ...mapRun(row), failureCount } as ClaimedRun);
      }
      await client.query("commit");
      return claimed;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async findUnavailableRuns(input: {
    appId: string;
    resources: RegisteredResource[];
    limit: number;
  }): Promise<UnavailableRun[]> {
    if (input.limit <= 0) return [];
    const resourceKinds = input.resources.map(({ kind }) => kind);
    const resourceIds = input.resources.map(({ resourceId }) => resourceId);
    const resourceVersions = input.resources.map(({ resourceVersion }) => resourceVersion ?? "1");
    const result = await this.query()<RunRow>(
      `
        select ${RUN_COLUMNS}
        from durlo_runs
        where app_id = $1
          and (
            status in ('pending', 'sleeping')
            or (status = 'running' and locked_until < now())
          )
          and not exists (
            select 1
            from unnest($2::text[], $3::text[], $4::text[])
              as resource(kind, resource_id, resource_version)
            where resource.kind = durlo_runs.kind
              and resource.resource_id = durlo_runs.resource_id
              and resource.resource_version = durlo_runs.resource_version
          )
        order by
          case status when 'running' then 0 when 'pending' then 1 else 2 end,
          scheduled_at,
          created_at
        limit $5
      `,
      [input.appId, resourceKinds, resourceIds, resourceVersions, input.limit]
    );
    const registeredIds = new Set(
      input.resources.map(({ kind, resourceId }) => `${kind}\u0000${resourceId}`)
    );
    return result.rows.map((row) => {
      const run = mapRun(row);
      return {
        id: run.id,
        kind: run.kind,
        resourceId: run.resourceId,
        resourceVersion: run.resourceVersion,
        status: run.status,
        scheduledAt: run.scheduledAt,
        createdAt: run.createdAt,
        reason: registeredIds.has(`${run.kind}\u0000${run.resourceId}`)
          ? "incompatible_version"
          : "unregistered_resource"
      };
    });
  }

  async extendRunLease(input: OwnedRunInput & { leaseDuration: number }): Promise<boolean> {
    const result = await this.query()(
      `
        update durlo_runs
        set locked_until = now() + ($4 * interval '1 millisecond'), updated_at = now()
        where id = $1 and locked_by = $2 and lease_token = $3
          and status = 'running' and locked_until > now()
      `,
      [input.runId, input.workerId, input.leaseToken, input.leaseDuration]
    );
    return result.rowCount === 1;
  }

  async completeRun(input: OwnedRunInput & { output: JsonValue }): Promise<void> {
    await this.finishOwnedRun(async (client) => {
      const result = await client.query(
        `
          update durlo_runs
          set status = 'completed', output_json = $4::jsonb, error_json = null,
              locked_by = null, lease_token = null, locked_until = null,
              updated_at = now(), completed_at = now()
          where id = $1 and locked_by = $2 and lease_token = $3 and status = 'running'
          returning id
        `,
        [input.runId, input.workerId, input.leaseToken, JSON.stringify(input.output)]
      );
      if (result.rowCount !== 1) throw new LostLeaseError(`lease lost for run ${input.runId}`);
      await client.query(
        `update durlo_attempts set status = 'succeeded', completed_at = now()
         where run_id = $1 and lease_token = $2 and kind = 'run' and status = 'running'`,
        [input.runId, input.leaseToken]
      );
    });
  }

  async failRun(input: FailRunInput): Promise<void> {
    await this.finishOwnedRun(async (client) => {
      const scheduledAt = input.outcome.status === "pending" ? input.outcome.scheduledAt : null;
      const result = await client.query(
        `
          update durlo_runs
          set status = $4,
              scheduled_at = coalesce($5, scheduled_at),
              error_json = $6::jsonb,
              locked_by = null, lease_token = null, locked_until = null,
              updated_at = now(),
              completed_at = case when $4 in ('failed', 'dead_letter') then now() else null end
          where id = $1 and locked_by = $2 and lease_token = $3 and status = 'running'
          returning id
        `,
        [
          input.runId,
          input.workerId,
          input.leaseToken,
          input.outcome.status,
          scheduledAt,
          JSON.stringify(input.error)
        ]
      );
      if (result.rowCount !== 1) throw new LostLeaseError(`lease lost for run ${input.runId}`);
      await client.query(
        `
          update durlo_attempts
          set status = $3, error_json = $4::jsonb, completed_at = now()
          where run_id = $1 and lease_token = $2 and kind = 'run' and status = 'running'
        `,
        [
          input.runId,
          input.leaseToken,
          input.attemptStatus ?? "failed",
          JSON.stringify(input.error)
        ]
      );
    });
  }

  async releaseRun(input: OwnedRunInput): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `
          update durlo_runs
          set status = 'pending', scheduled_at = now(),
              locked_by = null, lease_token = null, locked_until = null,
              updated_at = now()
          where id = $1 and locked_by = $2 and lease_token = $3 and status = 'running'
          returning id
        `,
        [input.runId, input.workerId, input.leaseToken]
      );
      if (result.rowCount === 1) {
        await client.query(
          `
            update durlo_attempts set status = 'cancelled', completed_at = now()
            where run_id = $1 and kind = 'run' and lease_token = $2 and status = 'running'
          `,
          [input.runId, input.leaseToken]
        );
      }
      await client.query("commit");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getStep(runId: string, stepId: string): Promise<StepRecord | null> {
    const result = await this.query()<StepRow>(
      `select ${STEP_COLUMNS} from durlo_steps where run_id = $1 and step_id = $2`,
      [runId, stepId]
    );
    return result.rows[0] ? mapStep(result.rows[0]) : null;
  }

  async startStep(
    input: StepInput & { maxAttempts: number; maxSteps: number }
  ): Promise<StepRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.assertOwnedRun(client, input);
      let selected = await client.query<StepRow>(
        `select ${STEP_COLUMNS} from durlo_steps where run_id = $1 and step_id = $2 for update`,
        [input.runId, input.stepId]
      );
      if (!selected.rows[0]) {
        await this.assertStepCapacity(client, input.runId, input.maxSteps);
        await client.query(
          `
            insert into durlo_steps (id, run_id, step_id, status, max_attempts)
            values ($1, $2, $3, 'pending', $4)
          `,
          [randomUUID(), input.runId, input.stepId, input.maxAttempts]
        );
        selected = await client.query<StepRow>(
          `select ${STEP_COLUMNS} from durlo_steps where run_id = $1 and step_id = $2 for update`,
          [input.runId, input.stepId]
        );
      }
      const current = selected.rows[0];
      if (!current) throw new Error(`step '${input.stepId}' could not be created`);
      if (current.status === "completed") {
        await client.query("commit");
        return mapStep(current);
      }
      const updated = await client.query<StepRow>(
        `
          update durlo_steps
          set status = 'running', attempt_count = attempt_count + 1,
              error_json = null, updated_at = now(), started_at = coalesce(started_at, now()),
              completed_at = null
          where id = $1
          returning ${STEP_COLUMNS}
        `,
        [current.id]
      );
      const row = updated.rows[0];
      if (!row) throw new Error(`step '${input.stepId}' could not be started`);
      await client.query(
        `
          insert into durlo_attempts (
            id, run_id, step_id, kind, attempt_number, status, worker_id, lease_token
          ) values ($1, $2, $3, 'step', $4, 'running', $5, $6)
        `,
        [
          randomUUID(),
          input.runId,
          input.stepId,
          row.attempt_count,
          input.workerId,
          input.leaseToken
        ]
      );
      await client.query("commit");
      return mapStep(row);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeStep(input: StepInput & { result: JsonValue }): Promise<void> {
    await this.finishOwnedRun(async (client) => {
      await this.assertOwnedRun(client, input);
      const result = await client.query(
        `
          update durlo_steps
          set status = 'completed', result_json = $3::jsonb, error_json = null,
              updated_at = now(), completed_at = now()
          where run_id = $1 and step_id = $2 and status = 'running'
        `,
        [input.runId, input.stepId, JSON.stringify(input.result)]
      );
      if (result.rowCount !== 1) throw new Error(`step '${input.stepId}' is not running`);
      await client.query(
        `
          update durlo_attempts set status = 'succeeded', completed_at = now()
          where run_id = $1 and step_id = $2 and kind = 'step'
            and lease_token = $3 and status = 'running'
        `,
        [input.runId, input.stepId, input.leaseToken]
      );
    });
  }

  async failStep(input: StepInput & { error: SerializedError }): Promise<void> {
    await this.finishOwnedRun(async (client) => {
      await this.assertOwnedRun(client, input);
      const result = await client.query(
        `
          update durlo_steps
          set status = 'failed', error_json = $3::jsonb, updated_at = now(), completed_at = now()
          where run_id = $1 and step_id = $2 and status = 'running'
        `,
        [input.runId, input.stepId, JSON.stringify(input.error)]
      );
      if (result.rowCount !== 1) throw new Error(`step '${input.stepId}' is not running`);
      await client.query(
        `
          update durlo_attempts
          set status = 'failed', error_json = $4::jsonb, completed_at = now()
          where run_id = $1 and step_id = $2 and kind = 'step'
            and lease_token = $3 and status = 'running'
        `,
        [input.runId, input.stepId, input.leaseToken, JSON.stringify(input.error)]
      );
    });
  }

  async getTimer(runId: string, stepId: string): Promise<TimerRecord | null> {
    const result = await this.query()<TimerRow>(
      `select ${TIMER_COLUMNS} from durlo_timers where run_id = $1 and step_id = $2`,
      [runId, stepId]
    );
    return result.rows[0] ? mapTimer(result.rows[0]) : null;
  }

  async sleepRun(input: StepInput & { fireAt: Date; maxSteps: number }): Promise<TimerRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.assertOwnedRun(client, input);
      let selected = await client.query<TimerRow>(
        `select ${TIMER_COLUMNS} from durlo_timers where run_id = $1 and step_id = $2 for update`,
        [input.runId, input.stepId]
      );
      if (!selected.rows[0]) {
        await this.assertStepCapacity(client, input.runId, input.maxSteps);
        await client.query(
          `
            insert into durlo_timers (id, run_id, step_id, fire_at, status)
            values ($1, $2, $3, $4, 'pending')
          `,
          [randomUUID(), input.runId, input.stepId, input.fireAt]
        );
        selected = await client.query<TimerRow>(
          `select ${TIMER_COLUMNS} from durlo_timers where run_id = $1 and step_id = $2 for update`,
          [input.runId, input.stepId]
        );
      }
      const timer = selected.rows[0];
      if (!timer) throw new Error(`timer '${input.stepId}' could not be created`);
      if (timer.status === "fired") {
        await client.query("commit");
        return mapTimer(timer);
      }
      if (timer.status === "cancelled") {
        throw new RunStateError(`timer '${input.stepId}' is cancelled`);
      }
      const runResult = await client.query(
        `
          update durlo_runs
          set status = 'sleeping', locked_by = null, lease_token = null, locked_until = null,
              updated_at = now()
          where id = $1 and locked_by = $2 and lease_token = $3 and status = 'running'
        `,
        [input.runId, input.workerId, input.leaseToken]
      );
      if (runResult.rowCount !== 1) throw new LostLeaseError(`lease lost for run ${input.runId}`);
      await client.query(
        `
          update durlo_attempts set status = 'succeeded', completed_at = now()
          where run_id = $1 and kind = 'run' and lease_token = $2 and status = 'running'
        `,
        [input.runId, input.leaseToken]
      );
      await client.query("commit");
      return mapTimer(timer);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async fireDueTimers(input: { appId: string; limit: number }): Promise<TimerRecord[]> {
    if (input.limit <= 0) return [];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<TimerRow>(
        `
          select ${QUALIFIED_TIMER_COLUMNS}
          from durlo_timers t
          join durlo_runs r on r.id = t.run_id
          where r.app_id = $1 and r.status = 'sleeping'
            and t.status = 'pending' and t.fire_at <= now()
          order by t.fire_at, t.created_at
          for update of t, r skip locked
          limit $2
        `,
        [input.appId, input.limit]
      );
      const fired: TimerRecord[] = [];
      for (const timer of selected.rows) {
        const updated = await client.query<TimerRow>(
          `
            update durlo_timers
            set status = 'fired', fired_at = now()
            where id = $1 and status = 'pending'
            returning ${TIMER_COLUMNS}
          `,
          [timer.id]
        );
        const row = updated.rows[0];
        if (!row) continue;
        const resumed = await client.query(
          `
            update durlo_runs set status = 'pending', scheduled_at = now(), updated_at = now()
            where id = $1 and status = 'sleeping'
          `,
          [timer.run_id]
        );
        if (resumed.rowCount === 1) fired.push(mapTimer(row));
      }
      await client.query("commit");
      return fired;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelRun(input: AppRunInput): Promise<RunRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const selected = await client.query<RunRow>(
        `select ${RUN_COLUMNS} from durlo_runs where app_id = $1 and id = $2 for update`,
        [input.appId, input.runId]
      );
      const current = selected.rows[0];
      if (!current) throw new RunStateError(`run '${input.runId}' was not found`);
      if (current.status === "cancelled") {
        await client.query("commit");
        return mapRun(current);
      }
      if (!["pending", "running", "sleeping"].includes(current.status)) {
        throw new RunStateError(`cannot cancel a ${current.status} run`);
      }
      if (current.status === "running") {
        await client.query(
          `
            update durlo_attempts set status = 'cancelled', completed_at = now()
            where run_id = $1 and kind = 'run' and lease_token = $2 and status = 'running'
          `,
          [input.runId, current.lease_token]
        );
        await client.query(
          `
            update durlo_attempts set status = 'cancelled', completed_at = now()
            where run_id = $1 and kind = 'step' and lease_token = $2 and status = 'running'
          `,
          [input.runId, current.lease_token]
        );
      }
      await client.query(
        `
          update durlo_timers set status = 'cancelled', cancelled_at = now()
          where run_id = $1 and status = 'pending'
        `,
        [input.runId]
      );
      const updated = await client.query<RunRow>(
        `
          update durlo_runs
          set status = 'cancelled', locked_by = null, lease_token = null, locked_until = null,
              updated_at = now(), cancelled_at = now()
          where app_id = $1 and id = $2
          returning ${RUN_COLUMNS}
        `,
        [input.appId, input.runId]
      );
      await client.query("commit");
      return mapRun(updated.rows[0]!);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async retryRun(input: AppRunInput): Promise<RunRecord> {
    const result = await this.query()<RunRow>(
      `
        update durlo_runs
        set status = 'pending', scheduled_at = now(), error_json = null,
            locked_by = null, lease_token = null, locked_until = null,
            updated_at = now(), completed_at = null
        where app_id = $1 and id = $2
          and ((kind = 'task' and status = 'dead_letter') or (kind = 'workflow' and status = 'failed'))
        returning ${RUN_COLUMNS}
      `,
      [input.appId, input.runId]
    );
    const row = result.rows[0];
    if (row) return mapRun(row);
    const current = await this.getRun(input);
    if (!current) throw new RunStateError(`run '${input.runId}' was not found`);
    throw new RunStateError(`cannot manually retry a ${current.status} ${current.kind} run`);
  }

  withTransaction(client: unknown): TransactionalDurloAdapter {
    if (
      !client ||
      typeof client !== "object" ||
      !("query" in client) ||
      typeof client.query !== "function"
    ) {
      throw new TypeError("transaction client must be a raw pg client");
    }
    return new PostgresAdapter(this.pool, client as PoolClient);
  }

  private query(): Query {
    const target = this.boundClient ?? this.pool;
    return (text, values) => target.query(text, values);
  }

  private async insertRun(query: Query, input: CreateRunInput): Promise<RunRecord> {
    const result = await query<RunRow>(
      `
        insert into durlo_runs (
          id, app_id, kind, resource_id, resource_version, status, input_json, options_json,
          idempotency_key, priority, scheduled_at, max_attempts
        ) values ($1, $2, $3, $4, $5, 'pending', $6::jsonb, $7::jsonb, $8, $9, $10, $11)
        on conflict (app_id, kind, resource_id, idempotency_key)
          where idempotency_key is not null
        do update set id = durlo_runs.id
        returning ${RUN_COLUMNS}
      `,
      [
        input.id,
        input.appId,
        input.kind,
        input.resourceId,
        input.resourceVersion,
        JSON.stringify(input.input),
        JSON.stringify(input.options),
        input.idempotencyKey,
        input.priority,
        input.scheduledAt,
        input.maxAttempts
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Postgres did not return the created run");
    return mapRun(row);
  }

  private async finishOwnedRun(operation: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await operation(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertOwnedRun(client: PoolClient, input: OwnedRunInput): Promise<void> {
    const result = await client.query(
      `
        select id from durlo_runs
        where id = $1 and locked_by = $2 and lease_token = $3 and status = 'running'
        for update
      `,
      [input.runId, input.workerId, input.leaseToken]
    );
    if (result.rowCount !== 1) throw new LostLeaseError(`lease lost for run ${input.runId}`);
  }

  private async assertStepCapacity(
    client: PoolClient,
    runId: string,
    maxSteps: number
  ): Promise<void> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      throw new ValidationError("maxSteps must be a positive safe integer");
    }
    const result = await client.query<{ count: string }>(
      `
        select (
          (select count(*) from durlo_steps where run_id = $1) +
          (select count(*) from durlo_timers where run_id = $1)
        )::text as count
      `,
      [runId]
    );
    const actual = Number(result.rows[0]?.count ?? 0) + 1;
    if (actual > maxSteps) {
      throw new StorageLimitError(
        `workflow step count would be ${actual}; maxWorkflowSteps is ${maxSteps}`,
        "maxWorkflowSteps",
        actual,
        maxSteps
      );
    }
  }
}

export function postgresAdapter(options: PostgresAdapterOptions): PostgresAdapter {
  return new PostgresAdapter(options);
}
