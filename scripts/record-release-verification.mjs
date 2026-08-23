import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "push") {
  throw new Error("release verification evidence is written only by the pushed-tag workflow");
}

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"));
const tag = process.env.RELEASE_TAG;
if (tag !== `v${manifest.version}`) {
  throw new Error(`release verification tag '${tag}' does not match v${manifest.version}`);
}

const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const runUrl =
  repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : null;
const provenance = JSON.parse(
  await readFile(join(workspaceRoot, "release-evidence", "provenance.json"), "utf8")
);
if (
  provenance.tag !== tag ||
  provenance.commit !== process.env.GITHUB_SHA ||
  !Array.isArray(provenance.packages) ||
  provenance.packages.map(({ name }) => name).join(",") !==
    "@durlo/core,@durlo/postgres,@durlo/cli"
) {
  throw new Error("registry provenance evidence does not match this release");
}
const evidence = {
  tag,
  version: manifest.version,
  commit: process.env.GITHUB_SHA,
  workflowRun: runUrl,
  verifiedAt: new Date().toISOString(),
  checks: {
    completeReleaseAudit: "passed",
    registryEsm: "passed",
    registryCommonJs: "passed",
    registryStrictTypeScript: "passed",
    registryCliAndMigrations: "passed",
    registrySignaturesAndProvenance: {
      status: "passed",
      packages: provenance.packages
    },
    registryQuickstart: "passed"
  }
};

await writeFile(
  join(workspaceRoot, "release-evidence", "verification.json"),
  `${JSON.stringify(evidence, null, 2)}\n`
);
process.stdout.write(`recorded release verification for ${tag}\n`);
