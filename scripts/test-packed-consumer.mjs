import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const temp = await mkdtemp(join(tmpdir(), "durlo-packed-consumer-"));
const tarballs = join(temp, "tarballs");
const consumer = join(temp, "consumer");

try {
  run(pnpm, ["build"], workspaceRoot, "building workspace packages");
  await Promise.all([mkdir(tarballs), mkdir(consumer)]);

  const packageDirs = ["packages/core", "packages/postgres", "packages/cli"];
  for (const packageDir of packageDirs) {
    const inventory = run(
      pnpm,
      ["pack", "--dry-run", "--json"],
      resolve(workspaceRoot, packageDir),
      `inspecting ${packageDir}`
    );
    inspectPackage(packageDir, JSON.parse(inventory.stdout));
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
  if (packed.length !== packageDirs.length) {
    throw new Error(`expected ${packageDirs.length} tarballs, found ${packed.length}`);
  }

  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "durlo-packed-consumer", private: true, type: "module" }, null, 2)
  );
  await writeFile(
    join(consumer, "esm.mjs"),
    `
      import * as core from "@durlo/core";
      import * as postgres from "@durlo/postgres";
      import * as cli from "@durlo/cli";
      ${exportAssertions("ESM")}
      const adapter = postgres.postgresAdapter({ connectionString: "postgres://unused" });
      await adapter.close();
    `
  );
  await writeFile(
    join(consumer, "cjs.cjs"),
    `
      const core = require("@durlo/core");
      const postgres = require("@durlo/postgres");
      const cli = require("@durlo/cli");
      ${exportAssertions("CommonJS")}
      const adapter = postgres.postgresAdapter({ connectionString: "postgres://unused" });
      adapter.close().catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
      });
    `
  );
  await writeFile(
    join(consumer, "typecheck.ts"),
    `
      import {
        Durlo,
        Worker,
        DEFAULT_RETRY_POLICY,
        DEFAULT_DURLO_LIMITS,
        DurloError,
        ValidationError,
        SerializationError,
        StorageLimitError,
        RunStateError,
        AttemptTimeoutError,
        IdempotencyConflictError,
        RunWaitTimeoutError,
        RunNotFoundError,
        RunFailedError,
        RunCancelledError,
        PermanentError,
        RetryError,
        type AttemptContext,
        type AttemptKind,
        type AttemptRecord,
        type AttemptStatus,
        type BacklogHealth,
        type BackoffPolicy,
        type BatchItem,
        type DurloLimits,
        type DurloOptions,
        type DurloTransaction,
        type DurationInput,
        type ExponentialBackoffPolicy,
        type FixedBackoffPolicy,
        type JsonPrimitive,
        type JsonValue,
        type Logger,
        type RawPgTransactionClient,
        type RetentionCleanupOptions,
        type RetentionCleanupResult,
        type RunCreation,
        type RunContext,
        type RunDetails,
        type RunDiagnostics,
        type RunHandle,
        type RunKind,
        type RunListOptions,
        type RunListPage,
        type RunOptions,
        type RunRecord,
        type RunStatus,
        type RunSummary,
        type RunTimelineEvent,
        type RunTimelineEventType,
        type RetryPolicy,
        type SerializedError,
        type StandardSchemaResult,
        type StandardSchema,
        type StepRecord,
        type StepStatus,
        type StepTools,
        type TaskContext,
        type TaskDefinition,
        type TaskDefinitionOptions,
        type TerminalRunStatus,
        type TimerRecord,
        type TimerStatus,
        type UnavailableRun,
        type UnavailableRunReason,
        type WorkerCompatibilityReport,
        type WorkerHealth,
        type WorkerOptions,
        type WorkflowContext,
        type WorkflowDefinition,
        type WorkflowDefinitionOptions
      } from "@durlo/core";
      import {
        migrations,
        PostgresAdapter,
        postgresAdapter,
        type PostgresAdapterOptions,
        type PostgresTransactionClient
      } from "@durlo/postgres";
      import { defineConfig, type DashboardOptions, type DurloConfig } from "@durlo/cli";
      // @ts-expect-error Adapter contracts are internal to Durlo.
      import type { DurloAdapter } from "@durlo/core";
      // @ts-expect-error Serialization helpers are not supported entry-point exports.
      import { serialize } from "@durlo/core";
      // @ts-expect-error Programmatic CLI helpers are internal; use the executable.
      import { runCli } from "@durlo/cli";
      // @ts-expect-error PostgreSQL implementation-only row types are not public.
      import type { RunRow } from "@durlo/postgres";
      const adapterOptions: PostgresAdapterOptions = { connectionString: "postgres://unused" };
      const adapter = postgresAdapter(adapterOptions);
      const adapterFromConstructor = new PostgresAdapter(adapterOptions);
      const durlo: Durlo = new Durlo({ id: "packed-consumer", adapter });
      type ExternalInput = { raw: string };
      type HandlerInput = { normalized: string };
      const schema: StandardSchema<ExternalInput, HandlerInput> = {
        "~standard": {
          version: 1,
          vendor: "packed-consumer",
          validate: (input) => ({
            value: { normalized: (input as ExternalInput).raw.trim() }
          })
        }
      };
      const task = durlo.task({
        id: "packed-transform-task",
        schema,
        run: async (input: HandlerInput) => input.normalized
      });
      const workflow = durlo.workflow({
        id: "packed-transform-workflow",
        schema,
        run: async ({ input }) => input.normalized.length
      });
      const voidTask = durlo.task({ id: "packed-void-task", run: async () => undefined });
      const nullTask = durlo.task({ id: "packed-null-task", run: async (): Promise<null> => null });
      const input: ExternalInput = { raw: " value " };
      const taskHandle: Promise<RunCreation<string>> = task.enqueue(input);
      const batchHandles: Promise<Array<RunCreation<string>>> = task.batchEnqueue([
        { input },
        { input } satisfies BatchItem<ExternalInput>
      ]);
      const workflowHandle: Promise<RunCreation<number>> = workflow.start(input);
      taskHandle.then(({ run }) => {
        const waited: Promise<string> = durlo.runs.wait(run, { timeout: "5s" });
        void waited;
      });
      workflowHandle.then(({ run }) => {
        const waited: Promise<number> = durlo.runs.wait(run, { signal: new AbortController().signal });
        void waited;
      });
      voidTask.enqueue({}).then(({ run }) => {
        const waited: Promise<void> = durlo.runs.wait(run);
        void waited;
      });
      nullTask.enqueue({}).then(({ run }) => {
        const waited: Promise<null> = durlo.runs.wait(run);
        void waited;
      });
      // @ts-expect-error Waiting accepts a typed handle, not a bare run id.
      durlo.runs.wait("run-id", { timeout: 1_000 });
      const config: DurloConfig = defineConfig({ durlo, tasks: [task], workflows: [workflow] });
      const dashboard: DashboardOptions = { host: "127.0.0.1", port: 3210 };
      const permanent = new PermanentError("stop", { cause: new Error("cause") });
      const retryAfter = new RetryError({ after: "30s", message: "retry later" });
      const retryAt = new RetryError({ at: new Date(), cause: { status: 429 } });
      const normalizedRetryAt: Date = retryAfter.retryAt;
      // @ts-expect-error RetryError takes one schedule object, not positional arguments.
      new RetryError("1s");
      // @ts-expect-error Directed retry schedules are mutually exclusive.
      new RetryError({ after: "1s", at: new Date() });
      // @ts-expect-error Public outcome state is readonly.
      retryAt.retryAt = new Date();
      if (false) {
        void durlo.transaction(async ({ client }) => client.query("select 1"));
        void durlo.transaction(async (transaction) => {
          await transaction.enqueue(task, input);
          await transaction.start(workflow, input);
          await transaction.batchEnqueue(task, [{ input }]);
        });
        // @ts-expect-error The unsafe caller-supplied transaction API must stay unavailable.
        durlo.tx(adapter.pool);
      }
      const migrationVersions: string[] = migrations.map(({ version }) => version);
      void migrationVersions;
      void taskHandle;
      void batchHandles;
      void workflowHandle;
      void config;
      void dashboard;
      void adapterFromConstructor;
      void permanent;
      void normalizedRetryAt;
      void durlo;
    `
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: false
        },
        include: ["typecheck.ts", "durlo.config.ts"]
      },
      null,
      2
    )
  );

  run(npm, ["install", ...packed], consumer, "installing packed artifacts");
  inspectDeclarationExports(consumer);
  run(node, ["esm.mjs"], consumer, "loading packed ESM artifacts");
  run(node, ["cjs.cjs"], consumer, "loading packed CJS artifacts");
  run(
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? "durlo.cmd" : "durlo"),
    ["--help"],
    consumer,
    "running the packed CLI binary"
  );
  run(
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? "durlo.cmd" : "durlo"),
    ["init"],
    consumer,
    "scaffolding with the packed CLI"
  );
  run(
    join(workspaceRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"),
    ["--project", join(consumer, "tsconfig.json")],
    consumer,
    "typechecking packed artifacts"
  );
  process.stdout.write("packed ESM, CJS, and TypeScript consumer checks passed\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(executable, args, cwd, description) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status === 0) return result;
  throw new Error(
    `${description} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
  );
}

function inspectPackage(packageDir, inventory) {
  if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.files)) {
    throw new Error(`${packageDir} returned an invalid pack inventory`);
  }
  const paths = inventory.files.map(({ path }) => path);
  for (const required of ["package.json", "dist/index.js", "dist/index.cjs", "dist/index.d.ts"]) {
    if (!paths.includes(required)) throw new Error(`${packageDir} tarball is missing ${required}`);
  }
  if (paths.some((path) => path !== "package.json" && !path.startsWith("dist/"))) {
    throw new Error(`${packageDir} tarball contains files outside dist: ${paths.join(", ")}`);
  }
  if (packageDir === "packages/cli" && !paths.includes("dist/bin.js")) {
    throw new Error("@durlo/cli tarball is missing dist/bin.js");
  }
}

function inspectDeclarationExports(consumerDirectory) {
  const expected = {
    core: [
      "AttemptContext",
      "AttemptKind",
      "AttemptRecord",
      "AttemptStatus",
      "AttemptTimeoutError",
      "BacklogHealth",
      "BackoffPolicy",
      "BatchItem",
      "DEFAULT_DURLO_LIMITS",
      "DEFAULT_RETRY_POLICY",
      "Durlo",
      "DurloError",
      "DurloLimits",
      "DurloOptions",
      "DurloTransaction",
      "DurationInput",
      "ExponentialBackoffPolicy",
      "FixedBackoffPolicy",
      "IdempotencyConflictError",
      "JsonPrimitive",
      "JsonValue",
      "Logger",
      "PermanentError",
      "RawPgTransactionClient",
      "RetentionCleanupOptions",
      "RetentionCleanupResult",
      "RetryError",
      "RetryPolicy",
      "RunCancelledError",
      "RunContext",
      "RunCreation",
      "RunDetails",
      "RunDiagnostics",
      "RunFailedError",
      "RunHandle",
      "RunKind",
      "RunListOptions",
      "RunListPage",
      "RunNotFoundError",
      "RunOptions",
      "RunRecord",
      "RunStateError",
      "RunStatus",
      "RunSummary",
      "RunTimelineEvent",
      "RunTimelineEventType",
      "RunWaitTimeoutError",
      "SerializationError",
      "SerializedError",
      "StandardSchema",
      "StandardSchemaResult",
      "StepRecord",
      "StepStatus",
      "StepTools",
      "StorageLimitError",
      "TaskContext",
      "TaskDefinition",
      "TaskDefinitionOptions",
      "TerminalRunStatus",
      "TimerRecord",
      "TimerStatus",
      "UnavailableRun",
      "UnavailableRunReason",
      "ValidationError",
      "Worker",
      "WorkerCompatibilityReport",
      "WorkerHealth",
      "WorkerOptions",
      "WorkflowContext",
      "WorkflowDefinition",
      "WorkflowDefinitionOptions"
    ],
    postgres: [
      "PostgresAdapter",
      "PostgresAdapterOptions",
      "PostgresTransactionClient",
      "migrations",
      "postgresAdapter"
    ],
    cli: ["DashboardOptions", "DurloConfig", "defineConfig"]
  };
  const files = Object.fromEntries(
    Object.keys(expected).map((name) => [
      name,
      join(consumerDirectory, "node_modules", "@durlo", name, "dist", "index.d.ts")
    ])
  );
  const program = ts.createProgram(Object.values(files), {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: false
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      `packed declarations are invalid:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => consumerDirectory,
        getCanonicalFileName: (name) => name,
        getNewLine: () => "\n"
      })}`
    );
  }
  const checker = program.getTypeChecker();
  for (const [name, path] of Object.entries(files)) {
    const source = program.getSourceFile(path);
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) throw new Error(`could not inspect ${name} declaration exports`);
    const actual = checker
      .getExportsOfModule(symbol)
      .map(({ name: exportName }) => exportName)
      .sort();
    const wanted = expected[name].toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(`${name} declaration exports changed: ${actual.join(", ")}`);
    }
  }
}

function exportAssertions(format) {
  const expected = {
    core: [
      "AttemptTimeoutError",
      "DEFAULT_DURLO_LIMITS",
      "DEFAULT_RETRY_POLICY",
      "Durlo",
      "DurloError",
      "IdempotencyConflictError",
      "PermanentError",
      "RetryError",
      "RunCancelledError",
      "RunFailedError",
      "RunNotFoundError",
      "RunStateError",
      "RunWaitTimeoutError",
      "SerializationError",
      "StorageLimitError",
      "ValidationError",
      "Worker"
    ],
    postgres: ["PostgresAdapter", "migrations", "postgresAdapter"],
    cli: ["defineConfig"]
  };
  return `
    const expected = ${JSON.stringify(expected)};
    for (const [name, actual] of Object.entries({ core, postgres, cli })) {
      const keys = Object.keys(actual).sort();
      if (JSON.stringify(keys) !== JSON.stringify(expected[name])) {
        throw new Error("${format} " + name + " exports changed: " + keys.join(", "));
      }
    }
    const versions = postgres.migrations.map(({ version }) => version);
    if (JSON.stringify(versions) !== JSON.stringify([
      "0001_initial",
      "0002_resource_versions",
      "0003_retention_cleanup",
      "0004_observability_reads",
      "0005_truthful_step_interruptions",
      "0006_serialization_versions",
      "0007_idempotency_comparison_metadata",
      "0008_idempotency_metadata_presence",
      "0009_run_output_kind"
    ])) throw new Error("${format} migration exports changed: " + versions.join(", "));
    if (typeof cli.defineConfig !== "function") throw new Error("missing ${format} defineConfig");
  `;
}
