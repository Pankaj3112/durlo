import type {
  AppRunInput,
  AttemptKind,
  AttemptRecord,
  AttemptStatus,
  BacklogHealth,
  ClaimedRun,
  ClaimRunsInput,
  CreateRunInput,
  DurloAdapter,
  FailRunInput,
  IdempotencyMismatch,
  JsonValue,
  OwnedRunInput,
  PersistedRunCreation,
  RegisteredResource,
  RawStepRecord,
  RetentionCleanupInput,
  RetentionCleanupResult,
  RunKind,
  RunListInput,
  RunRecord,
  RunStatus,
  RunSummary,
  RawPgTransactionClient,
  SerializationVersion,
  SerializedError,
  StepInput,
  StepRecord,
  StepStatus,
  StoredRunDetails,
  TimerRecord,
  TimerStatus,
  TransactionalDurloAdapter,
  UnavailableRun
} from "@durlo/core";
import {
  deserialize,
  IdempotencyConflictError,
  RunStateError,
  StorageLimitError,
  ValidationError
} from "@durlo/core";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
import { migrations } from "./migrations.js";

export type PostgresAdapterOptions = (PoolConfig & { pool?: never }) | { pool: Pool };

export type PostgresTransactionClient = RawPgTransactionClient;

const TRANSACTION_PROVIDER = Symbol.for("@durlo/core/transaction-provider");
const SERIALIZED_RESOURCE_VERSION_PREFIX = " @durlo/serialization/2:";
const lostLeaseSignals = new WeakSet<object>();

function lostLeaseError(message: string): Error {
  const error = new Error(message);
  lostLeaseSignals.add(error);
  return error;
}

function storedResourceVersion(resourceVersion: string): string {
  return `${SERIALIZED_RESOURCE_VERSION_PREFIX}${resourceVersion}`;
}

function storedResourceVersions(resourceVersion: string): string[] {
  return [resourceVersion, storedResourceVersion(resourceVersion)];
}

function decodeStoredResourceVersion(value: string): {
  resourceVersion: string;
  serializationVersion: SerializationVersion;
} {
  return value.startsWith(SERIALIZED_RESOURCE_VERSION_PREFIX)
    ? {
        resourceVersion: value.slice(SERIALIZED_RESOURCE_VERSION_PREFIX.length),
        serializationVersion: 2
      }
    : { resourceVersion: value, serializationVersion: 1 };
}

function expandRegisteredResources(resources: RegisteredResource[]): RegisteredResource[] {
  return resources.flatMap(({ kind, resourceId, resourceVersion = "1" }) =>
    storedResourceVersions(resourceVersion).map((storedVersion) => ({
      kind,
      resourceId,
      resourceVersion: storedVersion
    }))
  );
}

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
  created?: boolean;
  idempotency_metadata_version?: number | null;
  idempotency_resource_version?: string | null;
  idempotency_input_json?: JsonValue | null;
  idempotency_execution_options_json?: JsonValue | null;
  idempotency_schedule_json?: JsonValue | null;
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

type RunSummaryRow = QueryResultRow & {
  id: string;
  kind: RunKind;
  resource_id: string;
  resource_version: string;
  status: RunStatus;
  priority: number;
  scheduled_at: Date;
  attempt_count: number;
  max_attempts: number;
  stalled_count: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
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

type AttemptRow = QueryResultRow & {
  id: string;
  run_id: string;
  step_id: string | null;
  kind: AttemptKind;
  attempt_number: number;
  status: AttemptStatus;
  worker_id: string | null;
  error_json: SerializedError | null;
  started_at: Date;
  completed_at: Date | null;
};

type BacklogHealthRow = QueryResultRow & {
  checked_at: Date;
  pending: string;
  ready: string;
  delayed: string;
  running: string;
  sleeping: string;
  expired_leases: string;
  oldest_ready_at: Date | null;
  oldest_ready_created_at: Date | null;
  pending_timers: string;
  due_timers: string;
  oldest_due_at: Date | null;
};

type Query = <R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
) => Promise<QueryResult<R>>;

function mapRun(row: RunRow): RunRecord {
  const { resourceVersion, serializationVersion } = decodeStoredResourceVersion(
    row.resource_version
  );
  return {
    id: row.id,
    appId: row.app_id,
    kind: row.kind,
    resourceId: row.resource_id,
    resourceVersion,
    status: row.status,
    input: deserialize(row.input_json, serializationVersion),
    output: row.output_json === null ? null : deserialize(row.output_json, serializationVersion),
    error:
      row.error_json === null
        ? null
        : (deserialize(row.error_json, serializationVersion) as RunRecord["error"]),
    options: deserialize(row.options_json, serializationVersion),
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

function mapClaimedRun(row: RunRow, failureCount: number): ClaimedRun {
  const { resourceVersion, serializationVersion } = decodeStoredResourceVersion(
    row.resource_version
  );
  return {
    id: row.id,
    appId: row.app_id,
    kind: row.kind,
    resourceId: row.resource_id,
    resourceVersion,
    status: "running",
    input: row.input_json,
    output: row.output_json,
    error: row.error_json,
    options: row.options_json,
    idempotencyKey: row.idempotency_key,
    priority: row.priority,
    scheduledAt: row.scheduled_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by!,
    leaseToken: row.lease_token!,
    lockedUntil: row.locked_until!,
    stalledCount: row.stalled_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    failureCount,
    serializationVersion
  };
}

function mapStep(row: StepRow, serializationVersion: SerializationVersion): StepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    status: row.status,
    result: row.result_json === null ? null : deserialize(row.result_json, serializationVersion),
    error:
      row.error_json === null
        ? null
        : (deserialize(row.error_json, serializationVersion) as StepRecord["error"]),
    options: deserialize(row.options_json, serializationVersion),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function mapStepRaw(row: StepRow): RawStepRecord {
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

function mapRunSummary(row: RunSummaryRow): RunSummary {
  const { resourceVersion } = decodeStoredResourceVersion(row.resource_version);
  return {
    id: row.id,
    kind: row.kind,
    resourceId: row.resource_id,
    resourceVersion,
    status: row.status,
    priority: row.priority,
    scheduledAt: row.scheduled_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    stalledCount: row.stalled_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at
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

function mapAttempt(row: AttemptRow, serializationVersion: SerializationVersion): AttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind,
    attemptNumber: row.attempt_number,
    status: row.status,
    workerId: row.worker_id,
    error:
      row.error_json === null
        ? null
        : (deserialize(row.error_json, serializationVersion) as AttemptRecord["error"]),
    startedAt: row.started_at,
    completedAt: row.completed_at
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

const RUN_SUMMARY_COLUMNS = `
  id, kind, resource_id, resource_version, status, priority, scheduled_at,
  attempt_count, max_attempts, stalled_count, created_at, updated_at, started_at,
  completed_at, cancelled_at
`;

const TIMER_COLUMNS = `id, run_id, step_id, fire_at, status, created_at, fired_at, cancelled_at`;
const QUALIFIED_TIMER_COLUMNS = `
  t.id, t.run_id, t.step_id, t.fire_at, t.status, t.created_at, t.fired_at, t.cancelled_at
`;
const ATTEMPT_COLUMNS = `
  id, run_id, step_id, kind, attempt_number, status, worker_id, error_json,
  started_at, completed_at
`;
const IDEMPOTENCY_RUN_COLUMNS = `
  ${RUN_COLUMNS}, idempotency_metadata_version, idempotency_resource_version, idempotency_input_json,
  idempotency_execution_options_json, idempotency_schedule_json
`;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const envelope = record["$durlo"];
    if (
      Object.keys(record).length === 1 &&
      Array.isArray(envelope) &&
      envelope[0] === 2 &&
      envelope[1] === "object" &&
      Array.isArray(envelope[2]) &&
      envelope[2].every(
        (entry: unknown) =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
      )
    ) {
      const entries = [...(envelope[2] as Array<[string, unknown]>)]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `[${JSON.stringify(key)},${canonicalJson(item)}]`)
        .join(",");
      return `{"$durlo":[2,"object",[${entries}]]}`;
    }
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function idempotencyMismatches(input: CreateRunInput, row: RunRow): IdempotencyMismatch[] {
  if (row.idempotency_metadata_version !== 1) {
    return ["legacy_unverifiable"];
  }
  const mismatches: IdempotencyMismatch[] = [];
  const metadata = input.idempotency ?? {
    resourceVersion: input.resourceVersion,
    input: input.input,
    executionOptions: input.options,
    schedule: { type: "immediate" as const }
  };
  if (row.idempotency_resource_version !== metadata.resourceVersion) {
    mismatches.push("resource_version");
  }
  if (canonicalJson(row.idempotency_input_json) !== canonicalJson(metadata.input)) {
    mismatches.push("input");
  }
  if (
    canonicalJson(row.idempotency_execution_options_json) !==
    canonicalJson(metadata.executionOptions)
  ) {
    mismatches.push("execution_options");
  }
  if (canonicalJson(row.idempotency_schedule_json) !== canonicalJson(metadata.schedule)) {
    mismatches.push("schedule");
  }
  return mismatches;
}

export class PostgresAdapter implements DurloAdapter {
  readonly pool: Pool;
  private readonly ownsPool: boolean;
  private closePromise?: Promise<void>;

  constructor(options: PostgresAdapterOptions) {
    if ("pool" in options) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool(options);
      this.ownsPool = true;
      // pg emits idle-client failures on the pool rather than rejecting a query. Keep a transient
      // network failure from becoming an uncaught EventEmitter error. Checked-out clients also emit
      // before their active query rejects, so keep a listener attached across pool acquisitions.
      // Callers can add their own listeners for observability; active operations still reject.
      this.pool.on("error", () => undefined);
      this.pool.on("connect", (client) => client.on("error", () => undefined));
    }
    Object.defineProperty(this, TRANSACTION_PROVIDER, {
      configurable: false,
      enumerable: false,
      value: <TResult>(
        callback: (
          adapter: TransactionalDurloAdapter,
          client: PostgresTransactionClient
        ) => Promise<TResult>
      ) => this.runTransaction(callback),
      writable: false
    });
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
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
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.ownsPool) return;
    this.closePromise ??= this.pool.end();
    await this.closePromise;
  }

  isLeaseLoss(error: unknown): boolean {
    return typeof error === "object" && error !== null && lostLeaseSignals.has(error);
  }

  async createRun(input: CreateRunInput): Promise<PersistedRunCreation> {
    return this.insertRun(this.query(), input);
  }

  async createRuns(inputs: CreateRunInput[]): Promise<PersistedRunCreation[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const query: Query = (text, values) => client.query(text, values);
      const records = await this.insertRuns(query, inputs);
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

  async getRunDetails(input: AppRunInput): Promise<StoredRunDetails | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const runResult = await client.query<RunRow>(
        `select ${RUN_COLUMNS} from durlo_runs where app_id = $1 and id = $2`,
        [input.appId, input.runId]
      );
      const row = runResult.rows[0];
      if (!row) {
        await client.query("commit");
        return null;
      }
      const steps = await client.query<StepRow>(
        `select ${STEP_COLUMNS} from durlo_steps where run_id = $1 order by created_at, id`,
        [input.runId]
      );
      const attempts = await client.query<AttemptRow>(
        `select ${ATTEMPT_COLUMNS} from durlo_attempts where run_id = $1 order by started_at, id`,
        [input.runId]
      );
      const timers = await client.query<TimerRow>(
        `select ${TIMER_COLUMNS} from durlo_timers where run_id = $1 order by created_at, id`,
        [input.runId]
      );
      const clock = await client.query<{ checked_at: Date }>("select now() as checked_at");
      await client.query("commit");
      const { serializationVersion } = decodeStoredResourceVersion(row.resource_version);
      return {
        run: mapRun(row),
        steps: steps.rows.map((step) => mapStep(step, serializationVersion)),
        attempts: attempts.rows.map((attempt) => mapAttempt(attempt, serializationVersion)),
        timers: timers.rows.map(mapTimer),
        checkedAt: clock.rows[0]!.checked_at
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getBacklogHealth(input: { appId: string }): Promise<BacklogHealth> {
    const result = await this.query()<BacklogHealthRow>(
      `
        with clock as (
          select now() as checked_at
        ), run_health as (
          select
            count(*) filter (where status = 'pending')::text as pending,
            count(*) filter (
              where status = 'pending' and scheduled_at <= clock.checked_at
            )::text as ready,
            count(*) filter (
              where status = 'pending' and scheduled_at > clock.checked_at
            )::text as delayed,
            count(*) filter (where status = 'running')::text as running,
            count(*) filter (where status = 'sleeping')::text as sleeping,
            count(*) filter (
              where status = 'running' and locked_until <= clock.checked_at
            )::text as expired_leases,
            min(scheduled_at) filter (
              where status = 'pending' and scheduled_at <= clock.checked_at
            ) as oldest_ready_at,
            min(created_at) filter (
              where status = 'pending' and scheduled_at <= clock.checked_at
            ) as oldest_ready_created_at
          from durlo_runs
          cross join clock
          where app_id = $1 and status in ('pending', 'running', 'sleeping')
          group by clock.checked_at
        ), timer_health as (
          select
            count(*)::text as pending_timers,
            count(*) filter (where t.fire_at <= clock.checked_at)::text as due_timers,
            min(t.fire_at) filter (where t.fire_at <= clock.checked_at) as oldest_due_at
          from durlo_timers t
          join durlo_runs r on r.id = t.run_id
          cross join clock
          where r.app_id = $1 and r.status = 'sleeping' and t.status = 'pending'
          group by clock.checked_at
        )
        select
          clock.checked_at,
          coalesce(run_health.pending, '0') as pending,
          coalesce(run_health.ready, '0') as ready,
          coalesce(run_health.delayed, '0') as delayed,
          coalesce(run_health.running, '0') as running,
          coalesce(run_health.sleeping, '0') as sleeping,
          coalesce(run_health.expired_leases, '0') as expired_leases,
          run_health.oldest_ready_at,
          run_health.oldest_ready_created_at,
          coalesce(timer_health.pending_timers, '0') as pending_timers,
          coalesce(timer_health.due_timers, '0') as due_timers,
          timer_health.oldest_due_at
        from clock
        left join run_health on true
        left join timer_health on true
      `,
      [input.appId]
    );
    const row = result.rows[0]!;
    const pending = Number(row.pending);
    const running = Number(row.running);
    const sleeping = Number(row.sleeping);
    return {
      appId: input.appId,
      checkedAt: row.checked_at,
      runs: {
        active: pending + running + sleeping,
        pending,
        ready: Number(row.ready),
        delayed: Number(row.delayed),
        running,
        sleeping,
        expiredLeases: Number(row.expired_leases),
        oldestReadyAt: row.oldest_ready_at,
        oldestReadyCreatedAt: row.oldest_ready_created_at,
        readyLagMs:
          row.oldest_ready_at === null
            ? 0
            : Math.max(0, row.checked_at.getTime() - row.oldest_ready_at.getTime())
      },
      timers: {
        pending: Number(row.pending_timers),
        due: Number(row.due_timers),
        oldestDueAt: row.oldest_due_at,
        lagMs:
          row.oldest_due_at === null
            ? 0
            : Math.max(0, row.checked_at.getTime() - row.oldest_due_at.getTime())
      }
    };
  }

  async listRuns(input: RunListInput): Promise<RunSummary[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new ValidationError("run list limit must be an integer from 1 to 1000");
    }
    const result = await this.query()<RunSummaryRow>(
      `
        select ${RUN_SUMMARY_COLUMNS}
        from durlo_runs
        where app_id = $1
          and (cardinality($2::text[]) = 0 or status = any($2::text[]))
          and (cardinality($3::text[]) = 0 or kind = any($3::text[]))
          and ($4::text is null or resource_id = $4)
          and (cardinality($5::text[]) = 0 or resource_version = any($5::text[]))
          and ($6::timestamptz is null or created_at > $6)
          and ($7::timestamptz is null or created_at < $7)
          and (
            $8::timestamptz is null
            or (created_at, id) < ($8::timestamptz, $9::text)
          )
        order by created_at desc, id desc
        limit $10
      `,
      [
        input.appId,
        input.statuses,
        input.kinds,
        input.resourceId,
        input.resourceVersion === null ? [] : storedResourceVersions(input.resourceVersion),
        input.createdAfter,
        input.createdBefore,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        input.limit
      ]
    );
    return result.rows.map(mapRunSummary);
  }

  async cleanupRuns(input: RetentionCleanupInput): Promise<RetentionCleanupResult> {
    if (!Number.isFinite(input.olderThan) || input.olderThan <= 0) {
      throw new ValidationError("retention age must be a finite number greater than zero");
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
      throw new ValidationError("retention cleanup limit must be an integer from 1 to 10000");
    }
    const allowedStatuses = new Set(["completed", "failed", "dead_letter", "cancelled"]);
    if (
      input.statuses.length === 0 ||
      new Set(input.statuses).size !== input.statuses.length ||
      input.statuses.some((status) => !allowedStatuses.has(status))
    ) {
      throw new ValidationError("retention cleanup accepts unique terminal statuses");
    }
    const result = await this.query()<QueryResultRow & { id: string }>(
      `
        with candidates as materialized (
          select id, updated_at
          from durlo_runs
          where app_id = $1
            and status in ('completed', 'failed', 'dead_letter', 'cancelled')
            and status = any($2::text[])
            and updated_at < now() - ($3 * interval '1 millisecond')
          order by updated_at, id
          for update skip locked
          limit $4
        ), deleted as (
          delete from durlo_runs r
          using candidates c
          where r.id = c.id
          returning r.id
        )
        select c.id
        from candidates c
        join deleted d on d.id = c.id
        order by c.updated_at, c.id
      `,
      [input.appId, input.statuses, input.olderThan, input.limit]
    );
    const deletedRunIds = result.rows.map(({ id }) => id);
    return {
      deletedRuns: deletedRunIds.length,
      deletedRunIds,
      limitReached: deletedRunIds.length === input.limit
    };
  }

  async claimRuns(input: ClaimRunsInput): Promise<ClaimedRun[]> {
    if (input.resources.length === 0 || input.limit <= 0) return [];
    const storedResources = expandRegisteredResources(input.resources);
    const resourceKinds = storedResources.map(({ kind }) => kind);
    const resourceIds = storedResources.map(({ resourceId }) => resourceId);
    const resourceVersions = storedResources.map(({ resourceVersion }) => resourceVersion!);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const expired = await client.query<RunRow>(
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
            and status = 'running' and locked_until < now()
          order by
            priority desc,
            scheduled_at asc,
            created_at asc
          for update skip locked
          limit $5
        `,
        [input.appId, resourceKinds, resourceIds, resourceVersions, input.limit]
      );
      const remaining = input.limit - expired.rows.length;
      const pending =
        remaining > 0
          ? await client.query<RunRow>(
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
                  and status = 'pending' and scheduled_at <= now()
                order by priority desc, scheduled_at asc, created_at asc
                for update skip locked
                limit $5
              `,
              [input.appId, resourceKinds, resourceIds, resourceVersions, remaining]
            )
          : { rows: [] as RunRow[] };
      const candidates = [...expired.rows, ...pending.rows];
      const claimed: ClaimedRun[] = [];
      for (const candidate of candidates) {
        if (candidate.status === "running") {
          const stalledError = { name: "StalledError", message: "worker lease expired" };
          await client.query(
            `
              update durlo_attempts
              set status = 'stalled', completed_at = now(),
                  error_json = $3::jsonb
              where run_id = $1 and lease_token = $2 and kind = 'run' and status = 'running'
            `,
            [candidate.id, candidate.lease_token, JSON.stringify(stalledError)]
          );
          await this.closeOwnedSteps(
            client,
            candidate.id,
            candidate.lease_token!,
            "stalled",
            stalledError
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
              [candidate.id, JSON.stringify(stalledError)]
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
        claimed.push(mapClaimedRun(row, failureCount));
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
    const storedResources = expandRegisteredResources(input.resources);
    const resourceKinds = storedResources.map(({ kind }) => kind);
    const resourceIds = storedResources.map(({ resourceId }) => resourceId);
    const resourceVersions = storedResources.map(({ resourceVersion }) => resourceVersion!);
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
      if (result.rowCount !== 1) throw lostLeaseError(`lease lost for run ${input.runId}`);
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
      if (result.rowCount !== 1) throw lostLeaseError(`lease lost for run ${input.runId}`);
      await this.closeOwnedSteps(
        client,
        input.runId,
        input.leaseToken,
        input.attemptStatus ?? "failed",
        input.error
      );
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
    const result = await this.query()<StepRow & { run_resource_version: string }>(
      `select step.*, run.resource_version as run_resource_version
       from durlo_steps as step
       join durlo_runs as run on run.id = step.run_id
       where step.run_id = $1 and step.step_id = $2`,
      [runId, stepId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const { serializationVersion } = decodeStoredResourceVersion(row.run_resource_version);
    return mapStep(row, serializationVersion);
  }

  async getStepRaw(runId: string, stepId: string): Promise<RawStepRecord | null> {
    const result = await this.query()<StepRow>(
      `select ${STEP_COLUMNS} from durlo_steps where run_id = $1 and step_id = $2`,
      [runId, stepId]
    );
    return result.rows[0] ? mapStepRaw(result.rows[0]) : null;
  }

  async startStep(
    input: StepInput & { maxAttempts: number; maxSteps: number }
  ): Promise<StepRecord> {
    return this.startStepInternal(input, true);
  }

  async startStepRaw(
    input: StepInput & { maxAttempts: number; maxSteps: number }
  ): Promise<RawStepRecord> {
    return this.startStepInternal(input, false);
  }

  private async startStepInternal(
    input: StepInput & { maxAttempts: number; maxSteps: number },
    decode: true
  ): Promise<StepRecord>;
  private async startStepInternal(
    input: StepInput & { maxAttempts: number; maxSteps: number },
    decode: false
  ): Promise<RawStepRecord>;

  private async startStepInternal(
    input: StepInput & { maxAttempts: number; maxSteps: number },
    decode: boolean
  ): Promise<StepRecord | RawStepRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const runResourceVersion = await this.assertOwnedRun(client, input);
      const { serializationVersion } = decodeStoredResourceVersion(runResourceVersion);
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
        return decode ? mapStep(current, serializationVersion) : mapStepRaw(current);
      }
      const updated = await client.query<StepRow>(
        `
          update durlo_steps
          set status = 'running', attempt_count = attempt_count + 1,
              result_json = null, error_json = null,
              updated_at = now(), started_at = coalesce(started_at, now()),
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
      return decode ? mapStep(row, serializationVersion) : mapStepRaw(row);
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
          set status = 'failed', result_json = null, error_json = $3::jsonb,
              updated_at = now(), completed_at = now()
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
      if (runResult.rowCount !== 1) throw lostLeaseError(`lease lost for run ${input.runId}`);
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
        await this.closeOwnedSteps(client, input.runId, current.lease_token!, "cancelled", null);
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

  private async runTransaction<TResult>(
    callback: (
      adapter: TransactionalDurloAdapter,
      client: PostgresTransactionClient
    ) => Promise<TResult>
  ): Promise<TResult> {
    const client = await this.pool.connect();
    let result: TResult;
    let failed = false;
    let primaryError: unknown;
    let rollbackError: unknown;
    let active = false;
    try {
      await client.query("begin");
      active = true;
      const query: Query = (text, values) => {
        if (!active) {
          return Promise.reject(new Error("transaction is no longer active"));
        }
        return client.query(text, values);
      };
      const transactionClient: PostgresTransactionClient = {
        query
      };
      const transactionAdapter: TransactionalDurloAdapter = {
        createRun: (input) => this.insertRun(query, input),
        createRuns: (inputs) => this.insertRuns(query, inputs)
      };
      result = await callback(transactionAdapter, transactionClient);
      active = false;
      await client.query("commit");
    } catch (error) {
      active = false;
      failed = true;
      primaryError = error;
      try {
        await client.query("rollback");
      } catch (error) {
        rollbackError = error;
        // Preserve the callback, query, or commit error that caused the rollback.
      }
    }
    try {
      client.release(
        rollbackError === undefined
          ? undefined
          : rollbackError instanceof Error
            ? rollbackError
            : true
      );
    } catch (releaseError) {
      if (!failed) {
        failed = true;
        primaryError = releaseError;
      }
    }
    if (failed) throw primaryError;
    return result!;
  }

  private query(): Query {
    return (text, values) => this.pool.query(text, values);
  }

  private async insertRuns(
    query: Query,
    inputs: CreateRunInput[]
  ): Promise<Array<{ run: RunRecord; created: boolean }>> {
    const keys = inputs
      .map((input) => input.idempotencyKey)
      .filter((key): key is string => key !== null);
    if (new Set(keys).size !== keys.length) {
      throw new Error("duplicate idempotency keys in one batch are not allowed");
    }
    const records: Array<{ run: RunRecord; created: boolean }> = [];
    for (const input of inputs) records.push(await this.insertRun(query, input));
    return records;
  }

  private async insertRun(
    query: Query,
    input: CreateRunInput
  ): Promise<{ run: RunRecord; created: boolean }> {
    const metadata = input.idempotency ?? {
      resourceVersion: input.resourceVersion,
      input: input.input,
      executionOptions: input.options,
      schedule: { type: "immediate" as const }
    };
    const result = await query<RunRow>(
      `
        insert into durlo_runs (
          id, app_id, kind, resource_id, resource_version, status, input_json, options_json,
          idempotency_key, priority, scheduled_at, max_attempts,
          idempotency_metadata_version, idempotency_resource_version, idempotency_input_json,
          idempotency_execution_options_json, idempotency_schedule_json
        ) values (
          $1, $2, $3, $4, $5, 'pending', $6::jsonb, $7::jsonb, $8, $9, $10, $11,
          $12, $13, $14::jsonb, $15::jsonb, $16::jsonb
        )
        on conflict (app_id, kind, resource_id, idempotency_key)
          where idempotency_key is not null
        do nothing
        returning ${RUN_COLUMNS}
      `,
      [
        input.id,
        input.appId,
        input.kind,
        input.resourceId,
        storedResourceVersion(input.resourceVersion),
        JSON.stringify(input.input),
        JSON.stringify(input.options),
        input.idempotencyKey,
        input.priority,
        input.scheduledAt,
        input.maxAttempts,
        1,
        metadata.resourceVersion,
        JSON.stringify(metadata.input),
        JSON.stringify(metadata.executionOptions),
        JSON.stringify(metadata.schedule)
      ]
    );
    const row = result.rows[0];
    if (row) return { run: mapRun(row), created: true };
    if (input.idempotencyKey === null) {
      throw new Error("Postgres did not return the created run");
    }
    const existing = await query<RunRow>(
      `
        select ${IDEMPOTENCY_RUN_COLUMNS}
        from durlo_runs
        where app_id = $1 and kind = $2 and resource_id = $3 and idempotency_key = $4
      `,
      [input.appId, input.kind, input.resourceId, input.idempotencyKey]
    );
    const existingRow = existing.rows[0];
    if (!existingRow) throw new Error("Postgres did not return the idempotent run");
    const mismatches = idempotencyMismatches(input, existingRow);
    if (mismatches.length > 0) {
      throw new IdempotencyConflictError(input.idempotencyKey, existingRow.id, mismatches);
    }
    return { run: mapRun(existingRow), created: false };
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

  private async assertOwnedRun(client: PoolClient, input: OwnedRunInput): Promise<string> {
    const result = await client.query<{ resource_version: string }>(
      `
        select resource_version from durlo_runs
        where id = $1 and locked_by = $2 and lease_token = $3 and status = 'running'
        for update
      `,
      [input.runId, input.workerId, input.leaseToken]
    );
    if (result.rowCount !== 1) throw lostLeaseError(`lease lost for run ${input.runId}`);
    return result.rows[0]!.resource_version;
  }

  private async closeOwnedSteps(
    client: PoolClient,
    runId: string,
    leaseToken: string,
    status: "failed" | "timed_out" | "stalled" | "cancelled",
    error: SerializedError | null
  ): Promise<void> {
    await client.query(
      `
        update durlo_attempts
        set status = $3, error_json = $4::jsonb, completed_at = now()
        where run_id = $1 and lease_token = $2 and kind = 'step' and status = 'running'
      `,
      [runId, leaseToken, status, JSON.stringify(error)]
    );
    await client.query(
      `
        update durlo_steps as step
        set status = $3, result_json = null, error_json = $4::jsonb,
            updated_at = now(), completed_at = now()
        where step.run_id = $1 and step.status = 'running'
          and exists (
            select 1
            from durlo_attempts as attempt
            where attempt.run_id = step.run_id
              and attempt.step_id = step.step_id
              and attempt.kind = 'step'
              and attempt.lease_token = $2
              and attempt.status = $3
          )
      `,
      [runId, leaseToken, status, JSON.stringify(error)]
    );
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
