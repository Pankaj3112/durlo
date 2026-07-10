import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.DURLO_TEST_DATABASE_URL) {
  throw new Error("DURLO_TEST_DATABASE_URL is required for persistence mutation checks");
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const adapterPath = fileURLToPath(new URL("../packages/postgres/src/adapter.ts", import.meta.url));
const mutationPath = fileURLToPath(
  new URL("../packages/postgres/src/adapter.mutation.ts", import.meta.url)
);
const mutationIndexPath = fileURLToPath(
  new URL("../packages/postgres/src/index.mutation.ts", import.meta.url)
);
const source = await readFile(adapterPath, "utf8");

const mutations = [
  {
    name: "complete requires the lease token",
    occurrence: 0,
    search:
      "where id = $1 and locked_by = $2 and lease_token = $3 and status = 'running'\n          returning id",
    replacement: "where id = $1 and locked_by = $2 and status = 'running'\n          returning id",
    file: "test/postgres/index.test.ts",
    test: "rejects every ownership-sensitive write"
  },
  {
    name: "failure requires the lease token",
    occurrence: 1,
    search:
      "where id = $1 and locked_by = $2 and lease_token = $3 and status = 'running'\n          returning id",
    replacement: "where id = $1 and locked_by = $2 and status = 'running'\n          returning id",
    file: "test/postgres/index.test.ts",
    test: "rejects every ownership-sensitive write"
  },
  {
    name: "claims skip locked rows",
    occurrence: 0,
    search: "for update skip locked",
    replacement: "for update",
    file: "test/postgres/index.test.ts",
    test: "skips a claimable row locked"
  },
  {
    name: "only expired running rows are reclaimed",
    occurrence: 0,
    search: "(status = 'running' and locked_until < now())",
    replacement: "(status = 'running' and locked_until > now())",
    file: "test/postgres/index.test.ts",
    test: "reclaims expired leases"
  }
];

try {
  await writeFile(
    mutationIndexPath,
    [
      'export { PostgresAdapter, postgresAdapter } from "./adapter.mutation.js";',
      'export { migrations } from "./migrations.js";',
      'export type { PostgresAdapterOptions } from "./adapter.mutation.js";',
      ""
    ].join("\n")
  );

  for (const mutation of mutations) {
    const mutated = replaceOccurrence(
      source,
      mutation.search,
      mutation.replacement,
      mutation.occurrence
    );
    await writeFile(mutationPath, mutated);
    const result = spawnSync(
      pnpm,
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        mutation.file,
        "-t",
        mutation.test
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: {
          ...process.env,
          DURLO_POSTGRES_TEST_ENTRY: "./packages/postgres/src/index.mutation.ts"
        }
      }
    );
    if (result.status === 0) {
      throw new Error(`persistence safety mutation survived: ${mutation.name}`);
    }
    process.stdout.write(`killed mutation: ${mutation.name}\n`);
  }
} finally {
  await Promise.all([rm(mutationPath, { force: true }), rm(mutationIndexPath, { force: true })]);
}

function replaceOccurrence(value, search, replacement, occurrence) {
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = value.indexOf(search, offset);
    if (found === -1) {
      throw new Error(`could not find mutation target occurrence ${occurrence}: ${search}`);
    }
    if (index === occurrence) {
      return value.slice(0, found) + replacement + value.slice(found + search.length);
    }
    offset = found + search.length;
  }
  throw new Error("unreachable mutation replacement");
}
