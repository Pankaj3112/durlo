import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { verifyDurloProvenance } from "./provenance.mjs";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const source = process.argv[2] === "--registry" ? "registry" : "packed";
if (process.argv.length > 2 && process.argv[2] !== "--registry") {
  throw new Error(`unknown consumer source '${process.argv[2]}'`);
}
const version = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")).version;
const temp = await mkdtemp(join(tmpdir(), `durlo-${source}-consumer-`));
const tarballs = join(temp, "tarballs");
const consumer = join(temp, "consumer");

try {
  const packageDirs = ["packages/core", "packages/postgres", "packages/cli"];
  await mkdir(consumer);
  let packageSpecs = packageDirs.map((packageDir) => {
    const name = packageDir.split("/").at(-1);
    return `@durlo/${name}@${version}`;
  });
  if (source === "packed") {
    run(pnpm, ["build"], workspaceRoot, "building workspace packages");
    await mkdir(tarballs);
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
    packageSpecs = (await readdir(tarballs))
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => join(tarballs, name));
    if (packageSpecs.length !== packageDirs.length) {
      throw new Error(`expected ${packageDirs.length} tarballs, found ${packageSpecs.length}`);
    }
  }

  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: `durlo-${source}-consumer`, private: true, type: "module" }, null, 2)
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
    join(consumer, "mixed.mjs"),
    `
      import { createRequire } from "node:module";
      import * as esm from "@durlo/core";

      const cjs = createRequire(import.meta.url)("@durlo/core");
      const now = new Date("2026-08-23T00:00:00.000Z");
      if (esm.Durlo !== cjs.Durlo || esm.PermanentError !== cjs.PermanentError) {
        throw new Error("ESM and CommonJS did not load the canonical core implementation");
      }
      if (globalThis[Symbol.for("@durlo/core/private-registry/v1")] !== undefined) {
        throw new Error("core exposed its private provenance registry globally");
      }

      const forgedTask = { id: "forged", version: "1", kind: "task", options: {} };
      let rejectedForgery = false;
      try {
        new esm.Worker("mixed-formats", {}, { tasks: [forgedTask] });
      } catch {
        rejectedForgery = true;
      }
      if (!rejectedForgery) throw new Error("worker accepted a forged task definition");

      async function runCrossFormatOutcome(id, createError) {
        let failure;
        const adapter = {
          fireDueTimers: async () => [],
          claimRuns: async () => [{
            id: "run-" + id,
            appId: "mixed-formats",
            kind: "task",
            resourceId: id,
            resourceVersion: "1",
            status: "running",
            input: {},
            output: null,
            error: null,
            options: { retry: { attempts: 3, backoff: { type: "fixed", delay: 1, jitter: 0 } } },
            idempotencyKey: null,
            priority: 0,
            scheduledAt: now,
            attemptCount: 1,
            maxAttempts: 3,
            lockedBy: "mixed-worker",
            leaseToken: "lease-" + id,
            lockedUntil: new Date(now.getTime() + 30_000),
            stalledCount: 0,
            failureCount: 0,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            completedAt: null,
            cancelledAt: null
          }],
          extendRunLease: async () => true,
          failRun: async (input) => { failure = input; }
        };
        const cjsDurlo = new cjs.Durlo({ id: "mixed-formats", adapter });
        const task = cjsDurlo.task({ id, run: async () => { throw createError(); } });
        const worker = new esm.Worker("mixed-formats", adapter, {
          tasks: [task],
          workerId: "mixed-worker"
        });
        await worker.runOnce();
        if (!failure) throw new Error("mixed-format worker did not persist a failure");
        return failure.outcome;
      }

      const permanent = await runCrossFormatOutcome(
        "mixed-permanent",
        () => new cjs.PermanentError("stop")
      );
      if (permanent.status !== "dead_letter") {
        throw new Error("mixed-format PermanentError lost its provenance");
      }

      const retryAt = new Date(Date.now() + 60_000);
      const retry = await runCrossFormatOutcome(
        "mixed-retry",
        () => new cjs.RetryError({ at: retryAt })
      );
      if (retry.status !== "pending" || retry.scheduledAt.getTime() !== retryAt.getTime()) {
        throw new Error("mixed-format RetryError lost its directed schedule");
      }
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
      // @ts-expect-error Execution storage controls are private to Durlo.
      adapter.createRun;
      // @ts-expect-error Claim controls are private to Durlo workers.
      adapter.claimRuns;
      // @ts-expect-error Lease-fenced completion is not a public adapter control.
      adapter.completeRun;
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

  run(
    npm,
    ["install", ...packageSpecs, "typescript@5.9.3"],
    consumer,
    `installing ${source} artifacts`
  );
  await inspectInstalledPackageManifests(consumer);
  inspectDeclarationExports(consumer);
  run(node, ["esm.mjs"], consumer, `loading ${source} ESM artifacts`);
  run(node, ["cjs.cjs"], consumer, `loading ${source} CommonJS artifacts`);
  run(node, ["mixed.mjs"], consumer, `mixing ${source} ESM and CommonJS objects`);
  run(
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? "durlo.cmd" : "durlo"),
    ["--help"],
    consumer,
    `running the ${source} CLI binary`
  );
  const installedCliVersion = run(
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? "durlo.cmd" : "durlo"),
    ["--version"],
    consumer,
    `reading the ${source} CLI version`
  ).stdout.trim();
  if (installedCliVersion !== version) {
    throw new Error(`${source} CLI version is ${installedCliVersion}, expected ${version}`);
  }
  run(
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? "durlo.cmd" : "durlo"),
    ["init"],
    consumer,
    `scaffolding with the ${source} CLI`
  );
  run(
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"),
    ["--project", join(consumer, "tsconfig.json")],
    consumer,
    `typechecking ${source} artifacts`
  );
  if (source === "registry") {
    const audit = runJson(
      npm,
      ["audit", "signatures", "--include-attestations", "--json"],
      consumer,
      "verifying registry signatures and provenance"
    );
    const lockfile = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
    const expectedPackages = ["core", "postgres", "cli"].map((packageName) => {
      const entry = lockfile.packages?.[`node_modules/@durlo/${packageName}`];
      if (!entry?.integrity) throw new Error(`registry lockfile has no integrity for @durlo/${packageName}`);
      return { name: `@durlo/${packageName}`, version, integrity: entry.integrity };
    });
    const commit =
      process.env.GITHUB_SHA ??
      run("git", ["rev-parse", "HEAD"], workspaceRoot, "resolving verification commit").stdout.trim();
    const packages = verifyDurloProvenance({
      audit,
      expectedPackages,
      repository: "https://github.com/Pankaj3112/durlo",
      workflowPath: ".github/workflows/release.yml",
      tag: `v${version}`,
      commit
    });
    await mkdir(join(workspaceRoot, "release-evidence"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "release-evidence", "provenance.json"),
      `${JSON.stringify({ tag: `v${version}`, commit, packages }, null, 2)}\n`
    );
  }
  process.stdout.write(`${source} ESM, CJS, TypeScript, CLI, and migration checks passed\n`);
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

function runJson(executable, args, cwd, description) {
  const result = run(executable, args, cwd, description);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${description} returned invalid JSON: ${result.stdout}`);
  }
}

function inspectPackage(packageDir, inventory) {
  if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.files)) {
    throw new Error(`${packageDir} returned an invalid pack inventory`);
  }
  const paths = inventory.files.map(({ path }) => path).toSorted();
  for (const required of ["package.json", "dist/index.js", "dist/index.cjs", "dist/index.d.ts"]) {
    if (!paths.includes(required)) throw new Error(`${packageDir} tarball is missing ${required}`);
  }
  for (const required of ["README.md", "LICENSE"]) {
    if (!paths.includes(required)) throw new Error(`${packageDir} tarball is missing ${required}`);
  }
  const common = [
    "LICENSE",
    "README.md",
    "dist/index.cjs",
    "dist/index.d.cts",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json"
  ];
  if (packageDir === "packages/cli" && !paths.includes("dist/bin.js")) {
    throw new Error("@durlo/cli tarball is missing dist/bin.js");
  }
  const expected =
    packageDir === "packages/cli"
      ? [
          ...common,
          "dist/bin.cjs",
          "dist/bin.d.cts",
          "dist/bin.d.ts",
          "dist/bin.js",
          ...paths.filter((path) => /^dist\/chunk-[A-Z0-9]+\.js$/.test(path))
        ].toSorted()
      : common.toSorted();
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    throw new Error(`${packageDir} tarball inventory changed: ${paths.join(", ")}`);
  }
  if (
    packageDir === "packages/cli" &&
    paths.filter((path) => path.startsWith("dist/chunk-")).length !== 1
  ) {
    throw new Error("@durlo/cli tarball must contain exactly one generated runtime chunk");
  }
}

async function inspectInstalledPackageManifests(consumerDirectory) {
  for (const packageName of ["core", "postgres", "cli"]) {
    const manifest = JSON.parse(
      await readFile(
        join(consumerDirectory, "node_modules", "@durlo", packageName, "package.json"),
        "utf8"
      )
    );
    if (manifest.version !== version) {
      throw new Error(
        `${source} @durlo/${packageName} version is ${manifest.version}, expected ${version}`
      );
    }
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@durlo/") && range !== version) {
        throw new Error(
          `${source} @durlo/${packageName} dependency ${dependency} is not pinned exactly`
        );
      }
      if (typeof range === "string" && range.startsWith("workspace:")) {
        throw new Error(
          `${source} @durlo/${packageName} contains workspace-only dependency ${dependency}`
        );
      }
    }
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

  const coreDeclaration = program.getSourceFile(files.core)?.text ?? "";
  if (/interface DurloAdapter\b/.test(coreDeclaration)) {
    throw new Error("core declarations expose the internal generic adapter contract");
  }
  if (!/readonly adapter: object;/.test(coreDeclaration)) {
    throw new Error("Durlo.adapter must remain opaque in core declarations");
  }
  if (!/constructor\(appId: string, adapter: object,/.test(coreDeclaration)) {
    throw new Error("Worker's storage adapter must remain opaque in core declarations");
  }

  const postgresSource = program.getSourceFile(files.postgres);
  const postgresModule = postgresSource && checker.getSymbolAtLocation(postgresSource);
  const postgresAdapterSymbol = postgresModule
    ? checker.getExportsOfModule(postgresModule).find(({ name }) => name === "PostgresAdapter")
    : undefined;
  if (!postgresAdapterSymbol) throw new Error("missing PostgresAdapter declaration");
  const postgresAdapterMembers = checker
    .getDeclaredTypeOfSymbol(postgresAdapterSymbol)
    .getProperties()
    .map(({ name }) => name)
    .sort();
  const expectedPostgresAdapterMembers = ["close", "migrate", "pool"];
  if (JSON.stringify(postgresAdapterMembers) !== JSON.stringify(expectedPostgresAdapterMembers)) {
    throw new Error(
      `PostgresAdapter instance surface changed: ${postgresAdapterMembers.join(", ")}`
    );
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
