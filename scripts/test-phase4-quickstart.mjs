import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DURLO_TEST_DATABASE_URL is required for the Phase 4 quickstart test; run 'pnpm test:local'"
  );
}

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const temp = await mkdtemp(join(tmpdir(), "durlo-phase4-quickstart-"));
const tarballs = join(temp, "tarballs");
const consumer = join(temp, "consumer");
const children = new Set();
const pool = new Pool({ connectionString: databaseUrl });

try {
  run(pnpm, ["build"], workspaceRoot, "building workspace packages");
  await Promise.all([mkdir(tarballs), mkdir(consumer)]);
  for (const packageDir of ["packages/core", "packages/postgres", "packages/cli"]) {
    run(
      pnpm,
      ["pack", "--pack-destination", tarballs],
      resolve(workspaceRoot, packageDir),
      `packing ${packageDir}`
    );
  }
  const packed = (await readdir(tarballs))
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(tarballs, name));
  if (packed.length !== 3) throw new Error(`expected 3 tarballs, found ${packed.length}`);

  await cp(
    resolve(workspaceRoot, "examples/quickstart/durlo.config.ts"),
    join(consumer, "durlo.config.ts")
  );
  await cp(resolve(workspaceRoot, "examples/quickstart/src"), join(consumer, "src"), {
    recursive: true
  });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify(
      { name: "durlo-phase4-packed-quickstart", private: true, type: "module" },
      null,
      2
    )
  );
  run(
    npm,
    ["install", ...packed, "pg@8.22.0", "tsx@4.23.0"],
    consumer,
    "installing packed quickstart dependencies"
  );

  const cli = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "durlo.cmd" : "durlo"
  );
  const environment = { ...process.env, DATABASE_URL: databaseUrl };
  run(cli, ["migrate"], consumer, "migrating from the packed CLI", environment);
  await cleanupDatabase();

  const crashWorker = start(cli, ["worker"], consumer, {
    ...environment,
    DURLO_DEMO_PAUSE_AFTER_CHECKPOINT: "1"
  });
  const started = run(
    node,
    ["--import", "tsx", "src/start.ts"],
    consumer,
    "transactionally starting the demo workflow",
    environment
  );
  const runId = started.stdout.match(/^RUN_ID=(.+)$/m)?.[1];
  if (!runId) throw new Error(`quickstart did not print a run id:\n${started.stdout}`);

  await crashWorker.waitFor(new RegExp(`CRASH_READY runId=${escapeRegex(runId)} `), 15_000);
  crashWorker.child.kill("SIGKILL");
  await once(crashWorker.child, "exit");
  children.delete(crashWorker);

  const recovery = start(cli, ["dev", "--port", "0"], consumer, environment);
  const dashboardOutput = await recovery.waitFor(/Dashboard (http:\/\/[^\s]+)/, 15_000);
  const dashboardUrl = dashboardOutput.match(/Dashboard (http:\/\/[^\s]+)/)?.[1];
  if (!dashboardUrl) throw new Error(`could not read dashboard URL from:\n${dashboardOutput}`);

  const details = await waitForCompletion(dashboardUrl, runId, 20_000);
  const types = details.timeline.map((event) => event.type);
  for (const required of [
    "run_attempt_stalled",
    "timer_scheduled",
    "timer_fired",
    "run_attempt_failed",
    "run_retry_started",
    "run_completed"
  ]) {
    if (!types.includes(required)) throw new Error(`recovered timeline is missing ${required}`);
  }
  if (details.diagnostics.leaseLossCount !== 1) {
    throw new Error(`expected one durable lease loss, found ${details.diagnostics.leaseLossCount}`);
  }
  const inventory = await pool.query(
    "select count(*)::integer as count from quickstart_effects where run_id = $1 and effect_key = 'inventory-reserved'",
    [runId]
  );
  if (inventory.rows[0]?.count !== 1) {
    throw new Error(
      `expected one checkpointed inventory effect, found ${inventory.rows[0]?.count}`
    );
  }

  const unsafeCancel = await fetch(`${dashboardUrl}/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { Origin: dashboardUrl, "Content-Type": "application/json" },
    body: "{}"
  });
  if (unsafeCancel.status !== 409) {
    throw new Error(
      `expected completed-run cancellation to return 409, got ${unsafeCancel.status}`
    );
  }

  recovery.child.kill("SIGINT");
  await recovery.waitForExit(10_000);
  children.delete(recovery);
  process.stdout.write(
    "packed Phase 4 quickstart passed: crash recovery, checkpoint reuse, sleep, retry, dashboard timeline, and safe controls\n"
  );
} finally {
  for (const processLog of children) {
    if (processLog.child.exitCode === null && processLog.child.signalCode === null) {
      processLog.child.kill("SIGKILL");
    }
  }
  await Promise.allSettled(
    [...children].map((processLog) =>
      processLog.child.exitCode === null && processLog.child.signalCode === null
        ? once(processLog.child, "exit")
        : Promise.resolve()
    )
  );
  await cleanupDatabase().catch(() => undefined);
  await pool.end();
  await rm(temp, { recursive: true, force: true });
}

async function waitForCompletion(dashboardUrl, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const response = await fetch(`${dashboardUrl}/api/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) throw new Error(`dashboard detail returned ${response.status}`);
    const details = await response.json();
    lastStatus = details.run.status;
    if (lastStatus === "completed") return details;
    if (["failed", "dead_letter", "cancelled"].includes(lastStatus)) {
      throw new Error(`quickstart reached unexpected terminal status ${lastStatus}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`quickstart did not complete in ${timeoutMs}ms; last status was ${lastStatus}`);
}

async function cleanupDatabase() {
  await pool.query("delete from durlo_runs where app_id = 'durlo-quickstart'");
  await pool.query("drop table if exists quickstart_courier_attempts");
  await pool.query("drop table if exists quickstart_effects");
  await pool.query("drop table if exists quickstart_orders");
}

function start(executable, args, cwd, env) {
  const child = spawn(executable, args, { cwd, env, stdio: "pipe" });
  const processLog = {
    child,
    stdout: "",
    stderr: "",
    waitFor(pattern, timeoutMs) {
      if (pattern.test(this.stdout)) return Promise.resolve(this.stdout);
      return new Promise((resolveWait, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `timed out waiting for ${pattern}; stdout:\n${this.stdout}\nstderr:\n${this.stderr}`
            )
          );
        }, timeoutMs);
        const onData = () => {
          if (!pattern.test(this.stdout)) return;
          cleanup();
          resolveWait(this.stdout);
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(
            new Error(
              `process exited before ${pattern} (${code ?? signal}); stdout:\n${this.stdout}\nstderr:\n${this.stderr}`
            )
          );
        };
        const cleanup = () => {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
        };
        child.stdout.on("data", onData);
        child.once("exit", onExit);
      });
    },
    waitForExit(timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolveWait, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`process did not exit after ${timeoutMs}ms; stderr:\n${this.stderr}`));
        }, timeoutMs);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolveWait();
        });
      });
    }
  };
  child.stdout.on("data", (chunk) => (processLog.stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (processLog.stderr += chunk.toString()));
  children.add(processLog);
  return processLog;
}

function run(executable, args, cwd, description, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  if (result.status === 0) return result;
  throw new Error(
    `${description} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
