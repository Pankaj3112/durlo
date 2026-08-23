import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
        type BatchItem,
        type DurableValue,
        type DurloAdapter,
        type RunCreation,
        type RunHandle,
        type StandardSchema
      } from "@durlo/core";
      import {
        migrations,
        postgresAdapter,
        type PostgresAdapter
      } from "@durlo/postgres";
      import { cliPackageName } from "@durlo/cli";
      const adapter: PostgresAdapter = postgresAdapter({ connectionString: "postgres://unused" });
      const contract: DurloAdapter = adapter;
      const durableValue: DurableValue = new Date();
      const durlo: Durlo = new Durlo({ id: cliPackageName, adapter });
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
      const input: ExternalInput = { raw: " value " };
      const taskHandle: Promise<RunCreation<string>> = task.enqueue(input);
      const batchHandles: Promise<Array<RunCreation<string>>> = task.batchEnqueue([
        { input },
        { input } satisfies BatchItem<ExternalInput>
      ]);
      const workflowHandle: Promise<RunCreation<number>> = workflow.start(input);
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
      void durableValue;
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

function exportAssertions(format) {
  const expected = {
    core: [
      "AttemptTimeoutError",
      "DEFAULT_DURLO_LIMITS",
      "DEFAULT_RETRY_POLICY",
      "Durlo",
      "DurloError",
      "IdempotencyConflictError",
      "MAX_DATE_MS",
      "MAX_TIMER_DELAY_MS",
      "RunStateError",
      "SerializationError",
      "StorageLimitError",
      "ValidationError",
      "Worker",
      "assertByteLimit",
      "assertCountLimit",
      "calculateRetryDelay",
      "deserialize",
      "jsonByteSize",
      "normalizeBackoff",
      "normalizeDurloLimits",
      "normalizeRetryPolicy",
      "parseDuration",
      "parseTimerDuration",
      "serialize",
      "serializeError",
      "serializeErrorWithinLimit"
    ],
    postgres: ["PostgresAdapter", "migrations", "postgresAdapter"],
    cli: [
      "CONFIG_FILENAMES",
      "cliPackageName",
      "cliVersion",
      "closeConfig",
      "configuredWorker",
      "defineConfig",
      "findConfigPath",
      "initProject",
      "loadConfig",
      "migrateConfig",
      "parseConfigFlag",
      "parseDevFlags",
      "runCli",
      "runConfiguredWorker",
      "startDashboard"
    ]
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
      "0007_idempotency_comparison_metadata"
    ])) throw new Error("${format} migration exports changed: " + versions.join(", "));
    if (cli.cliPackageName !== "@durlo/cli") throw new Error("missing ${format} CLI marker");
  `;
}
