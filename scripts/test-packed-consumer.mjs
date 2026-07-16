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
      import { Durlo } from "@durlo/core";
      import { postgresAdapter } from "@durlo/postgres";
      import { cliPackageName } from "@durlo/cli";
      if (typeof Durlo !== "function") throw new Error("missing ESM Durlo export");
      if (typeof postgresAdapter !== "function") throw new Error("missing ESM postgres export");
      if (cliPackageName !== "@durlo/cli") throw new Error("missing ESM CLI export");
      const adapter = postgresAdapter({ connectionString: "postgres://unused" });
      await adapter.close();
    `
  );
  await writeFile(
    join(consumer, "cjs.cjs"),
    `
      const { Durlo } = require("@durlo/core");
      const { postgresAdapter } = require("@durlo/postgres");
      const { cliPackageName } = require("@durlo/cli");
      if (typeof Durlo !== "function") throw new Error("missing CJS Durlo export");
      if (typeof postgresAdapter !== "function") throw new Error("missing CJS postgres export");
      if (cliPackageName !== "@durlo/cli") throw new Error("missing CJS CLI export");
      const adapter = postgresAdapter({ connectionString: "postgres://unused" });
      adapter.close();
    `
  );
  await writeFile(
    join(consumer, "typecheck.ts"),
    `
      import { Durlo, type DurloAdapter } from "@durlo/core";
      import { postgresAdapter, type PostgresAdapter } from "@durlo/postgres";
      import { cliPackageName } from "@durlo/cli";
      const adapter: PostgresAdapter = postgresAdapter({ connectionString: "postgres://unused" });
      const contract: DurloAdapter = adapter;
      const durlo: Durlo = new Durlo({ id: cliPackageName, adapter: contract });
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
        include: ["typecheck.ts"]
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
  if (result.status === 0) return;
  throw new Error(
    `${description} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
  );
}
