import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.DURLO_TEST_DATABASE_URL) {
  throw new Error("DURLO_TEST_DATABASE_URL is required for persistence mutation checks");
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
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

  for (const target of uniqueTargets(mutations)) {
    const baseline = runTest(target, "./packages/postgres/src/index.ts");
    const assertion = readTargetAssertion(baseline, target);
    if (baseline.status !== 0 || assertion.status !== "passed") {
      throw new Error(
        `persistence mutation baseline failed for '${target.test}':\n${testDiagnostics(baseline)}`
      );
    }
  }

  for (const mutation of mutations) {
    const mutated = replaceOccurrence(
      source,
      mutation.search,
      mutation.replacement,
      mutation.occurrence
    );
    await writeFile(mutationPath, mutated);
    const result = runTest(mutation, "./packages/postgres/src/index.mutation.ts");
    const assertion = readTargetAssertion(result, mutation);
    if (result.status === 0 || assertion.status === "passed") {
      throw new Error(`persistence safety mutation survived: ${mutation.name}`);
    }
    if (assertion.status !== "failed") {
      throw new Error(
        `persistence mutation did not execute '${mutation.test}' for ${mutation.name}:\n` +
          testDiagnostics(result)
      );
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

function uniqueTargets(values) {
  return [
    ...new Map(values.map(({ file, test }) => [`${file}\0${test}`, { file, test }])).values()
  ];
}

function runTest(target, postgresEntry) {
  return spawnSync(
    pnpm,
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.integration.config.ts",
      target.file,
      "-t",
      target.test,
      "--reporter=json"
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DURLO_POSTGRES_TEST_ENTRY: postgresEntry
      }
    }
  );
}

function readTargetAssertion(result, target) {
  if (result.error) {
    throw new Error(`could not run '${target.test}': ${result.error.message}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `could not read Vitest result for '${target.test}':\n${testDiagnostics(result)}`
    );
  }

  const assertions = (report.testResults ?? []).flatMap(({ assertionResults = [] }) =>
    assertionResults.filter(({ fullName }) => fullName?.includes(target.test))
  );
  if (assertions.length !== 1) {
    throw new Error(
      `expected one Vitest result for '${target.test}', found ${assertions.length}:\n` +
        testDiagnostics(result)
    );
  }
  return assertions[0];
}

function testDiagnostics(result) {
  let stdout = result.stdout?.trim();
  if (stdout) {
    try {
      const report = JSON.parse(stdout);
      const failures = (report.testResults ?? []).flatMap((testResult) => [
        testResult.message,
        ...(testResult.assertionResults ?? []).flatMap(({ failureMessages = [] }) => failureMessages)
      ]);
      stdout = [
        `Vitest tests: ${report.numPassedTests ?? 0} passed, ${report.numFailedTests ?? 0} failed, ${report.numPendingTests ?? 0} pending`,
        ...failures.filter(Boolean).slice(0, 3)
      ].join("\n");
    } catch {
      // Preserve non-JSON output for diagnostics when Vitest cannot produce a report.
    }
  }
  return [
    `exit status: ${result.status ?? "none"}${result.signal ? ` (${result.signal})` : ""}`,
    stdout,
    result.stderr?.trim()
  ]
    .filter(Boolean)
    .join("\n");
}
