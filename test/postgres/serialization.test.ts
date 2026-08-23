import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deserialize, Durlo, serialize } from "@durlo/core";
import type { JsonValue } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

type Payload = {
  date: Date;
  literal: Record<string, unknown>;
  legacyLiteral: { "$durlo.date": string };
  envelopeLiteral: { $durlo: [number, string, string] };
  nested: Array<Record<string, unknown>>;
};

describe.runIf(Boolean(databaseUrl)).sequential("collision-safe serialization persistence", () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = postgresAdapter({ connectionString: databaseUrl! });
    await adapter.migrate();
  });

  beforeEach(async () => {
    await adapter.pool.query("truncate durlo_runs cascade");
  });

  afterAll(async () => {
    await adapter.close();
  });

  it("preserves inputs, outputs, options, steps, and error causes through JSONB", async () => {
    const literal = JSON.parse(
      '{"$durlo.date":"2026-01-02T03:04:05.000Z","$durlo":[2,"date","literal"],"__proto__":{"polluted":true},"constructor":"constructor","prototype":"prototype","":"empty","a.b":"dotted","💾":"unicode"}'
    ) as Record<string, unknown>;
    const payload: Payload = {
      date: new Date("2026-01-02T03:04:05.000Z"),
      literal,
      legacyLiteral: { "$durlo.date": "2026-01-02T03:04:05.000Z" },
      envelopeLiteral: { $durlo: [2, "date", "literal"] },
      nested: [literal, { value: "nested" }]
    };
    const durlo = new Durlo({ id: "serialization-postgres", adapter });
    const task = durlo.task<Payload, Payload>({
      id: "codec-task",
      retry: { attempts: 1 },
      run: async (input) => input
    });
    let workflowStepCalls = 0;
    const workflow = durlo.workflow<Payload, Payload>({
      id: "codec-workflow",
      retry: { attempts: 2, backoff: { type: "fixed", delay: 0 } },
      run: async ({ attempt, input, step }) => {
        const checkpoint = await step.run("payload", () => {
          workflowStepCalls += 1;
          return input;
        });
        if (attempt.number === 1) throw new Error("retry after checkpoint");
        return checkpoint;
      }
    });
    const errorTask = durlo.task<Payload, void>({
      id: "codec-error",
      retry: { attempts: 1 },
      run: async () => {
        throw new Error("expected failure", { cause: payload });
      }
    });

    const taskHandle = await task.enqueue(payload);
    const workflowHandle = await workflow.start(payload);
    const errorHandle = await errorTask.enqueue(payload);

    const rawInput = await adapter.pool.query<{ input_json: JsonValue; options_json: JsonValue }>(
      "select input_json, options_json from durlo_runs where id = $1",
      [taskHandle.id]
    );
    expect(rawInput.rows[0]?.input_json).not.toEqual(payload);
    expect(deserialize(rawInput.rows[0]!.input_json)).toEqual(payload);
    expect(deserialize(rawInput.rows[0]!.options_json)).toMatchObject({
      retry: { attempts: 1 },
      limits: expect.objectContaining({ maxOutputBytes: expect.any(Number) })
    });
    expect(await adapter.getRun({ appId: durlo.id, runId: taskHandle.id })).toMatchObject({
      input: payload
    });

    const worker = durlo.worker({
      tasks: [task, errorTask],
      workflows: [workflow],
      workerId: "serialization-worker"
    });
    await expect(worker.runOnce()).resolves.toBe(3);
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(workflowStepCalls).toBe(1);

    const rawOutput = await adapter.pool.query<{ output_json: JsonValue }>(
      "select output_json from durlo_runs where id = $1",
      [taskHandle.id]
    );
    expect(deserialize(rawOutput.rows[0]!.output_json)).toEqual(payload);
    expect(await adapter.getRun({ appId: durlo.id, runId: taskHandle.id })).toMatchObject({
      output: payload
    });

    const rawStep = await adapter.pool.query<{ result_json: JsonValue }>(
      "select result_json from durlo_steps where run_id = $1 and step_id = 'payload'",
      [workflowHandle.id]
    );
    expect(deserialize(rawStep.rows[0]!.result_json)).toEqual(payload);
    expect(await adapter.getStep(workflowHandle.id, "payload")).toMatchObject({ result: payload });
    expect(await adapter.getRun({ appId: durlo.id, runId: workflowHandle.id })).toMatchObject({
      output: payload
    });

    const rawError = await adapter.pool.query<{ error_json: JsonValue }>(
      "select error_json from durlo_runs where id = $1",
      [errorHandle.id]
    );
    expect(deserialize(rawError.rows[0]!.error_json)).toMatchObject({
      name: "Error",
      message: "expected failure",
      cause: payload
    });
    expect(await adapter.getRun({ appId: durlo.id, runId: errorHandle.id })).toMatchObject({
      error: { name: "Error", message: "expected failure", cause: payload }
    });
    expect(Object.prototype.hasOwnProperty.call(literal, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("reads legacy date tags from PostgreSQL rows", async () => {
    const durlo = new Durlo({ id: "serialization-legacy", adapter });
    const task = durlo.task({ id: "legacy-date", run: async () => undefined });
    const handle = await task.enqueue({});
    const legacyDate = "2026-01-02T03:04:05.000Z";

    await adapter.pool.query(
      "update durlo_runs set resource_version = '1', input_json = $2::jsonb where id = $1",
      [handle.id, JSON.stringify({ "$durlo.date": legacyDate })]
    );

    const run = await adapter.getRun({ appId: durlo.id, runId: handle.id });
    expect(run?.input).toEqual(new Date(legacyDate));
  });

  it("preserves legacy v2 lookalikes and replays their completed checkpoints", async () => {
    const literal = {
      $durlo: [2, "date", "2026-01-02T03:04:05.000Z"]
    } as JsonValue;
    const durlo = new Durlo({ id: "serialization-legacy-envelope", adapter });
    let stepCalls = 0;
    const workflow = durlo.workflow<JsonValue, JsonValue>({
      id: "legacy-envelope-workflow",
      version: "legacy-v1",
      run: async ({ step }) =>
        step.run("saved", () => {
          stepCalls += 1;
          return "unexpected";
        })
    });
    const handle = await workflow.start({});
    const stored = await adapter.pool.query<{ options_json: JsonValue }>(
      "select options_json from durlo_runs where id = $1",
      [handle.id]
    );
    const legacyOptions = serialize(deserialize(stored.rows[0]!.options_json, 2), 1);
    await adapter.pool.query(
      `update durlo_runs
       set resource_version = 'legacy-v1', input_json = $2::jsonb, options_json = $3::jsonb
       where id = $1`,
      [handle.id, JSON.stringify(literal), JSON.stringify(legacyOptions)]
    );
    await adapter.pool.query(
      `insert into durlo_steps (id, run_id, step_id, status, result_json, completed_at)
       values ('legacy-envelope-step', $1, 'saved', 'completed', $2::jsonb, now())`,
      [handle.id, JSON.stringify(literal)]
    );

    const worker = durlo.worker({
      workflows: [workflow],
      workerId: "legacy-envelope-worker"
    });
    await expect(worker.runOnce()).resolves.toBe(1);

    expect(stepCalls).toBe(0);
    expect(await adapter.getRun({ appId: durlo.id, runId: handle.id })).toMatchObject({
      resourceVersion: "legacy-v1",
      input: literal,
      output: literal
    });
    expect(await adapter.getStep(handle.id, "saved")).toMatchObject({ result: literal });
  });

  it("keeps v2 runs invisible to legacy resource-version claim predicates", async () => {
    const durlo = new Durlo({ id: "serialization-rollout", adapter });
    const task = durlo.task({
      id: "rollout-task",
      version: "rollout-v1",
      run: async () => "done"
    });
    const handle = await task.enqueue({ value: true });

    const raw = await adapter.pool.query<{ resource_version: string }>(
      "select resource_version from durlo_runs where id = $1",
      [handle.id]
    );
    expect(raw.rows[0]!.resource_version).not.toBe("rollout-v1");
    expect(raw.rows[0]!.resource_version.startsWith(" ")).toBe(true);
    const legacyClaims = await adapter.pool.query<{ id: string }>(
      `select id from durlo_runs
       where app_id = $1 and kind = 'task' and resource_id = 'rollout-task'
         and resource_version = 'rollout-v1' and status = 'pending'`,
      [durlo.id]
    );
    expect(legacyClaims.rows).toEqual([]);
    expect(await adapter.getRun({ appId: durlo.id, runId: handle.id })).toMatchObject({
      resourceVersion: "rollout-v1"
    });

    const worker = durlo.worker({ tasks: [task], workerId: "rollout-v2-worker" });
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(await adapter.getRun({ appId: durlo.id, runId: handle.id })).toMatchObject({
      status: "completed",
      output: "done",
      resourceVersion: "rollout-v1"
    });
  });
});
