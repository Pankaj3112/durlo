import { once } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import type { PostgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/crash-worker.ts", import.meta.url));

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres process crashes", () => {
  let adapter: PostgresAdapter;
  const children = new Set<ChildProcessWithoutNullStreams>();

  beforeAll(async () => {
    adapter = postgresAdapter({ connectionString: databaseUrl! });
    await adapter.migrate();
    await adapter.pool.query(`
      create table if not exists durlo_test_effects (
        id bigserial primary key,
        run_id text not null,
        phase text not null,
        created_at timestamptz not null default now()
      )
    `);
  });

  beforeEach(async () => {
    await adapter.pool.query("truncate durlo_test_effects");
    await adapter.pool.query("truncate durlo_runs cascade");
  });

  afterEach(async () => {
    await Promise.all([...children].map((child) => killChild(child)));
    children.clear();
  });

  afterAll(async () => {
    await adapter.pool.query("drop table if exists durlo_test_effects");
    await adapter.close();
  });

  function startFaultWorker(mode: string, resourceId: string): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        DURLO_TEST_DATABASE_URL: databaseUrl!,
        DURLO_FAULT_MODE: mode,
        DURLO_FAULT_APP_ID: "fault-tests",
        DURLO_FAULT_RESOURCE_ID: resourceId
      },
      stdio: "pipe"
    });
    children.add(child);
    return child;
  }

  async function expireLease(runId: string): Promise<void> {
    await adapter.pool.query(
      "update durlo_runs set locked_until = now() - interval '1 second' where id = $1",
      [runId]
    );
  }

  it("reclaims work when a process dies after claim and before user code", async () => {
    const durlo = new Durlo({ id: "fault-tests", adapter });
    const task = durlo.task({
      id: "crash-after-claim",
      retry: { attempts: 2 },
      run: async () => "recovered"
    });
    const handle = await task.enqueue({});
    const child = startFaultWorker("after-claim", task.id);
    await waitForLine(child, "CLAIMED");
    expect(await adapter.getRun({ appId: "fault-tests", runId: handle.run.id })).toMatchObject({
      status: "running",
      lockedBy: "crashed-worker"
    });

    await killChild(child);
    children.delete(child);
    await expireLease(handle.run.id);
    expect(await durlo.worker({ tasks: [task], workerId: "recovery-worker" }).runOnce()).toBe(1);

    expect(await adapter.getRun({ appId: "fault-tests", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "recovered",
      stalledCount: 1
    });
    expect(await runAttemptStatuses(handle.run.id)).toEqual(["stalled", "succeeded"]);
  });

  it("demonstrates at-least-once side effects after a process crash", async () => {
    const producer = new Durlo({ id: "fault-tests", adapter });
    const queuedTask = producer.task({
      id: "crash-after-side-effect",
      retry: { attempts: 2 },
      run: async () => undefined
    });
    const handle = await queuedTask.enqueue({});
    const child = startFaultWorker("after-side-effect", queuedTask.id);
    await waitForLine(child, "SIDE_EFFECT");

    await killChild(child);
    children.delete(child);
    await expireLease(handle.run.id);

    const recovery = new Durlo({ id: "fault-tests", adapter });
    const recoveryTask = recovery.task({
      id: queuedTask.id,
      retry: { attempts: 2 },
      run: async (_input: unknown, { run }) => {
        await adapter.pool.query(
          "insert into durlo_test_effects (run_id, phase) values ($1, 'side-effect')",
          [run.id]
        );
        return "recovered";
      }
    });
    await recovery.worker({ tasks: [recoveryTask], workerId: "recovery-worker" }).runOnce();

    const effects = await adapter.pool.query<{ count: string }>(
      "select count(*)::text as count from durlo_test_effects where run_id = $1",
      [handle.run.id]
    );
    expect(effects.rows[0]?.count).toBe("2");
    expect(await adapter.getRun({ appId: "fault-tests", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "recovered",
      stalledCount: 1
    });
  });

  it("reuses a committed workflow checkpoint after a process crash", async () => {
    const producer = new Durlo({ id: "fault-tests", adapter });
    const queuedWorkflow = producer.workflow({
      id: "crash-after-checkpoint",
      retry: { attempts: 2 },
      run: async () => undefined
    });
    const handle = await queuedWorkflow.start({});
    const child = startFaultWorker("after-checkpoint", queuedWorkflow.id);
    await waitForLine(child, "CHECKPOINTED");
    expect(await adapter.getStep(handle.run.id, "durable-step")).toMatchObject({
      status: "completed",
      result: "checkpointed"
    });

    await killChild(child);
    children.delete(child);
    await expireLease(handle.run.id);

    const recovery = new Durlo({ id: "fault-tests", adapter });
    const recoveryWorkflow = recovery.workflow({
      id: queuedWorkflow.id,
      retry: { attempts: 2 },
      run: async ({ run, step }) => {
        const value = await step.run("durable-step", async () => {
          await adapter.pool.query(
            "insert into durlo_test_effects (run_id, phase) values ($1, 'checkpoint')",
            [run.id]
          );
          return "executed-again";
        });
        return value;
      }
    });
    await recovery.worker({ workflows: [recoveryWorkflow], workerId: "recovery-worker" }).runOnce();

    const effects = await adapter.pool.query<{ count: string }>(
      "select count(*)::text as count from durlo_test_effects where run_id = $1",
      [handle.run.id]
    );
    expect(effects.rows[0]?.count).toBe("1");
    expect(await adapter.getRun({ appId: "fault-tests", runId: handle.run.id })).toMatchObject({
      status: "completed",
      output: "checkpointed",
      stalledCount: 1
    });
    expect(await runAttemptStatuses(handle.run.id)).toEqual(["stalled", "succeeded"]);
  });

  async function runAttemptStatuses(runId: string): Promise<string[]> {
    const attempts = await adapter.pool.query<{ status: string }>(
      `select status from durlo_attempts
       where run_id = $1 and kind = 'run' order by started_at, id`,
      [runId]
    );
    return attempts.rows.map(({ status }) => status);
  }
});

async function waitForLine(
  child: ChildProcessWithoutNullStreams,
  expected: string,
  timeoutMs = 10_000
): Promise<void> {
  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for '${expected}', stderr: ${stderr}`));
    }, timeoutMs);
    timeout.unref();

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`fault worker exited before '${expected}' (${code ?? signal}): ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}
