import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDurloProvenance } from "./provenance.mjs";
import { readRegistryPackage } from "./release-registry.mjs";
import {
  assertMatchingRegistryArtifact,
  planRegistryPublication,
  validateReleaseMetadata
} from "./release-plan.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDirectories = ["packages/core", "packages/postgres", "packages/cli"];
const [command = "audit", ...argumentsList] = process.argv.slice(2);
const options = parseOptions(argumentsList);
const rootManifest = await readJson(join(workspaceRoot, "package.json"));
const tag = options.tag ?? process.env.GITHUB_REF_NAME ?? `v${rootManifest.version}`;
const outputDirectory = safeOutputDirectory(options.output ?? "release-evidence");

if (!new Set(["audit", "publish"]).has(command)) {
  throw new Error("usage: node scripts/release.mjs <audit|publish> [--prepared] [--tag vX.Y.Z-alpha.N] [--output path]");
}

if (command === "publish") {
  assertCleanCheckout();
  assertPublishEnvironment(tag);
}
if (!options.prepared) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(join(outputDirectory, "tarballs"), { recursive: true });
}

const changelog = await readFile(join(workspaceRoot, "CHANGELOG.md"), "utf8");
const artifacts = options.prepared ? await loadPreparedArtifacts() : await createArtifacts();
const version = validateReleaseMetadata({
  tag,
  rootVersion: rootManifest.version,
  packages: artifacts,
  changelog
});
const registryPackages = await readRegistryPackages(artifacts);
const plan = planRegistryPublication(artifacts, registryPackages);
await writeEvidence("package-inventory.json", {
  tag,
  version,
  generatedAt: new Date().toISOString(),
  packages: artifacts.map(({ artifactPath, ...item }) => item)
});
await writeEvidence("registry-plan.json", {
  tag,
  version,
  generatedAt: new Date().toISOString(),
  packages: plan.map(({ artifactPath, files, ...item }) => item)
});
await writeReleaseNotes(version);

if (command === "publish") {
  await publish(plan, tag, version);
} else {
  process.stdout.write(
    `release audit passed for ${tag}: ${plan.filter(({ action }) => action === "publish").length} package(s) would publish\n`
  );
}

async function createArtifacts() {
  const artifacts = [];
  for (const packageDirectory of packageDirectories) {
    const absoluteDirectory = join(workspaceRoot, packageDirectory);
    const dryRun = runJson(
      "npm",
      ["pack", "--dry-run", "--json", absoluteDirectory],
      workspaceRoot,
      `inventorying ${packageDirectory}`
    );
    const inventory = Array.isArray(dryRun) ? dryRun[0] : dryRun;
    const packed = runJson(
      "pnpm",
      ["--dir", packageDirectory, "pack", "--pack-destination", join(outputDirectory, "tarballs"), "--json"],
      workspaceRoot,
      `packing ${packageDirectory}`
    );
    const artifactPath = resolve(packed.filename);
    const manifest = JSON.parse(
      run("tar", ["-xOf", artifactPath, "package/package.json"], workspaceRoot, `reading ${packageDirectory} manifest`)
        .stdout
    );
    const dryRunFiles = inventory.files.map(({ path }) => path).toSorted();
    const packedFiles = packed.files.map(({ path }) => path).toSorted();
    if (JSON.stringify(dryRunFiles) !== JSON.stringify(packedFiles)) {
      throw new Error(`${manifest.name} npm dry-run and publish artifact inventories differ`);
    }
    const bytes = await readFile(artifactPath);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const executable =
      manifest.name !== "@durlo/cli" ||
      /^-rwx/.test(
        run("tar", ["-tvf", artifactPath, "package/dist/bin.js"], workspaceRoot, "checking CLI mode")
          .stdout
      );
    if (!executable) throw new Error("@durlo/cli dist/bin.js is not executable in the tarball");
    artifacts.push({
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies ?? {},
      integrity,
      shasum: createHash("sha1").update(bytes).digest("hex"),
      artifact: relative(outputDirectory, artifactPath),
      artifactPath,
      files: packedFiles,
      cliBinaryExecutable: manifest.name === "@durlo/cli" ? executable : undefined
    });
  }
  return artifacts;
}

async function loadPreparedArtifacts() {
  if (command !== "publish") throw new Error("--prepared is valid only for publication");
  const evidence = await readJson(join(outputDirectory, "package-inventory.json"));
  if (evidence.tag !== tag || !Array.isArray(evidence.packages)) {
    throw new Error(`prepared package inventory does not match ${tag}`);
  }

  return Promise.all(
    evidence.packages.map(async (item) => {
      const artifactPath = resolve(outputDirectory, item.artifact);
      if (!artifactPath.startsWith(`${outputDirectory}${sep}`)) {
        throw new Error(`${item.name} prepared artifact escapes the evidence directory`);
      }
      const bytes = await readFile(artifactPath);
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      const shasum = createHash("sha1").update(bytes).digest("hex");
      const manifest = JSON.parse(
        run("tar", ["-xOf", artifactPath, "package/package.json"], workspaceRoot, `reading ${item.name} manifest`)
          .stdout
      );
      const files = run("tar", ["-tf", artifactPath], workspaceRoot, `reading ${item.name} inventory`)
        .stdout.split("\n")
        .filter((path) => path.startsWith("package/") && !path.endsWith("/"))
        .map((path) => path.slice("package/".length))
        .toSorted();
      const executable =
        manifest.name !== "@durlo/cli" ||
        /^-rwx/.test(
          run("tar", ["-tvf", artifactPath, "package/dist/bin.js"], workspaceRoot, "checking CLI mode")
            .stdout
        );
      const prepared = {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies ?? {},
        integrity,
        shasum,
        artifact: item.artifact,
        files,
        cliBinaryExecutable: manifest.name === "@durlo/cli" ? executable : undefined
      };
      if (JSON.stringify(prepared) !== JSON.stringify(item)) {
        throw new Error(`${item.name} prepared artifact does not match its audited inventory`);
      }
      return { ...prepared, artifactPath };
    })
  );
}

async function publish(plan, releaseTag, version) {
  const commit = run("git", ["rev-parse", "HEAD"], workspaceRoot, "resolving release commit").stdout.trim();
  const publication = {
    tag: releaseTag,
    version,
    startedAt: new Date().toISOString(),
    packages: []
  };
  await writeEvidence("publication.json", publication);
  for (const item of plan) {
    if (item.action === "publish") {
      run(
        "npm",
        [
          "publish",
          item.artifactPath,
          "--access",
          "public",
          "--tag",
          "alpha",
          "--provenance",
          "--ignore-scripts"
        ],
        workspaceRoot,
        `publishing ${item.name}@${item.version}`,
        "inherit"
      );
      await waitForMatchingRegistryArtifact(item);
    }
    const provenance = await waitForRegistryPackageProvenance(item, releaseTag, commit);
    publication.packages.push({
      name: item.name,
      version: item.version,
      action: item.action,
      integrity: item.integrity,
      url: `https://www.npmjs.com/package/${item.name}/v/${item.version}`,
      provenance
    });
    await writeEvidence("publication.json", publication);
  }
  publication.completedAt = new Date().toISOString();
  await writeEvidence("publication.json", publication);
  process.stdout.write(`release publication completed for ${releaseTag}\n`);
}

async function waitForMatchingRegistryArtifact(local) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const remote = await readRegistryPackage(local.name, local.version);
      if (remote) {
        assertMatchingRegistryArtifact(local, remote);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(
    `${local.name}@${local.version} did not become a matching registry artifact within 120 seconds${
      lastError ? `: ${lastError.message}` : ""
    }`
  );
}

async function readRegistryPackages(localPackages) {
  const entries = await Promise.all(
    localPackages.map(async ({ name, version }) => [name, await readRegistryPackage(name, version)])
  );
  return Object.fromEntries(entries.filter(([, value]) => value));
}

async function verifyRegistryPackageProvenance(item, releaseTag, commit) {
  const consumer = await mkdtemp(join(tmpdir(), "durlo-release-provenance-"));
  try {
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "durlo-release-provenance", private: true })}\n`
    );
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-save", `${item.name}@${item.version}`],
      consumer,
      `installing ${item.name}@${item.version} for provenance verification`
    );
    const audit = runJson(
      "npm",
      ["audit", "signatures", "--include-attestations", "--json"],
      consumer,
      `verifying ${item.name}@${item.version} provenance`
    );
    return verifyDurloProvenance({
      audit,
      expectedPackages: [item],
      repository: "https://github.com/Pankaj3112/durlo",
      workflowPath: "/.github/workflows/release.yml",
      tag: releaseTag,
      commit
    })[0];
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function waitForRegistryPackageProvenance(item, releaseTag, commit) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await verifyRegistryPackageProvenance(item, releaseTag, commit);
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    }
  }
  throw new Error(
    `${item.name}@${item.version} did not expose matching verified provenance within 120 seconds: ${lastError?.message ?? "unknown error"}`
  );
}

function assertPublishEnvironment(releaseTag) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "push" ||
    process.env.GITHUB_REF_TYPE !== "tag" ||
    process.env.GITHUB_REF_NAME !== releaseTag
  ) {
    throw new Error("publication is allowed only for the matching pushed tag in GitHub Actions");
  }
  const tagType = run(
    "git",
    ["cat-file", "-t", `refs/tags/${releaseTag}`],
    workspaceRoot,
    "checking annotated tag"
  ).stdout.trim();
  if (tagType !== "tag") throw new Error(`${releaseTag} must be an annotated Git tag`);
  const taggedCommit = run(
    "git",
    ["rev-list", "-n", "1", releaseTag],
    workspaceRoot,
    "resolving tagged commit"
  ).stdout.trim();
  const head = run("git", ["rev-parse", "HEAD"], workspaceRoot, "resolving release head").stdout.trim();
  if (taggedCommit !== head) throw new Error(`${releaseTag} does not identify the checked-out commit`);
  run(
    "git",
    ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
    workspaceRoot,
    "checking that the release commit is on origin/main"
  );
}

function assertCleanCheckout() {
  const status = run(
    "git",
    ["status", "--porcelain"],
    workspaceRoot,
    "checking release checkout"
  ).stdout.trim();
  if (status) throw new Error("release audit requires a clean tracked checkout");
}

async function writeEvidence(name, value) {
  await writeFile(join(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeReleaseNotes(version) {
  await writeFile(
    join(outputDirectory, "release-notes.md"),
    `# Durlo ${version}\n\n` +
      `First public alpha of Durlo's direct durable tasks and workflows on PostgreSQL.\n\n` +
      `- [@durlo/core ${version}](https://www.npmjs.com/package/@durlo/core/v/${version})\n` +
      `- [@durlo/postgres ${version}](https://www.npmjs.com/package/@durlo/postgres/v/${version})\n` +
      `- [@durlo/cli ${version}](https://www.npmjs.com/package/@durlo/cli/v/${version})\n\n` +
      `The release workflow runs the complete audit before publication and verifies clean registry consumers afterward. See CHANGELOG.md for compatibility and known limitations.\n`
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

function run(executable, args, cwd, description, stdio = "pipe") {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", stdio });
  if (result.status === 0) return result;
  throw new Error(
    `${description} failed (${result.status ?? "no exit code"}):\n${result.stdout ?? ""}\n${result.stderr ?? result.error?.message ?? ""}`
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--prepared") {
      parsed.prepared = true;
      continue;
    }
    if (option !== "--tag" && option !== "--output") throw new Error(`unknown release option '${option}'`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    parsed[option.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function safeOutputDirectory(path) {
  const absolute = resolve(workspaceRoot, path);
  if (absolute === workspaceRoot || !absolute.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error("release evidence output must be a directory inside the workspace");
  }
  if (dirname(absolute) === absolute) throw new Error("release evidence output cannot be a filesystem root");
  return absolute;
}
