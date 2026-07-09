import type {
  CreateRunInput,
  DurloAdapter,
  JsonValue,
  RunKind,
  RunRecord,
  RunStatus,
  SerializedError,
  TransactionalDurloAdapter,
} from "@durlo/core";
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

type Query = <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<R>>;

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    appId: row.app_id,
    kind: row.kind,
    resourceId: row.resource_id,
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
    cancelledAt: row.cancelled_at,
  };
}

const RUN_COLUMNS = `
  id, app_id, kind, resource_id, status, input_json, output_json, error_json, options_json,
  idempotency_key, priority, scheduled_at, attempt_count, max_attempts, locked_by,
  lease_token, locked_until, stalled_count, created_at, updated_at, started_at,
  completed_at, cancelled_at
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
          [migration.version],
        );
        if (applied.rowCount === 0) {
          await client.query(migration.sql);
          await client.query("insert into durlo_schema_migrations (version) values ($1)", [migration.version]);
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
    const keys = inputs.map((input) => input.idempotencyKey).filter((key): key is string => key !== null);
    if (new Set(keys).size !== keys.length) throw new Error("duplicate idempotency keys in one batch are not allowed");
    if (this.boundClient) return Promise.all(inputs.map((input) => this.insertRun(this.query(), input)));

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

  async getRun(id: string): Promise<RunRecord | null> {
    const result = await this.query()<RunRow>(`select ${RUN_COLUMNS} from durlo_runs where id = $1`, [id]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async cancelRun(id: string): Promise<RunRecord> {
    void id;
    throw new Error("cancelRun is implemented in Slice 6");
  }

  async retryRun(id: string): Promise<RunRecord> {
    void id;
    throw new Error("retryRun is implemented in Slice 6");
  }

  withTransaction(client: unknown): TransactionalDurloAdapter {
    if (!client || typeof client !== "object" || !("query" in client) || typeof client.query !== "function") {
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
          id, app_id, kind, resource_id, status, input_json, options_json, idempotency_key,
          priority, scheduled_at, max_attempts
        ) values ($1, $2, $3, $4, 'pending', $5::jsonb, $6::jsonb, $7, $8, $9, $10)
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
        JSON.stringify(input.input),
        JSON.stringify(input.options),
        input.idempotencyKey,
        input.priority,
        input.scheduledAt,
        input.maxAttempts,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Postgres did not return the created run");
    return mapRun(row);
  }
}

export function postgresAdapter(options: PostgresAdapterOptions): PostgresAdapter {
  return new PostgresAdapter(options);
}
