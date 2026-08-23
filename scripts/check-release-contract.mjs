import { readFile } from "node:fs/promises";

const nodeRange = ">=22 <27";
const releaseVersion = "0.1.0-alpha.0";
const repositoryUrl = "https://github.com/Pankaj3112/durlo.git";
const homepageUrl = "https://github.com/Pankaj3112/durlo#readme";
const bugsUrl = "https://github.com/Pankaj3112/durlo/issues";
const publicPackages = ["packages/core", "packages/postgres", "packages/cli"];

const root = await readJson("package.json");
assert(root.engines?.node === nodeRange, `root Node engine must be '${nodeRange}'`);
assert(root.name === "@durlo/repo", "root workspace name must remain @durlo/repo");
assert(root.private === true, "root workspace must remain private");
assert(root.version === releaseVersion, `root version must be ${releaseVersion}`);

const manifests = await Promise.all(publicPackages.map((path) => readJson(`${path}/package.json`)));
for (const manifest of manifests) {
  const packageDirectory = publicPackages.find((path) => path.endsWith(manifest.name.split("/")[1]));
  assert(manifest.version === releaseVersion, `${manifest.name} version must be ${releaseVersion}`);
  assert(
    manifest.engines?.node === nodeRange,
    `${manifest.name} Node engine must be '${nodeRange}'`
  );
  assert(manifest.sideEffects === false, `${manifest.name} must remain side-effect free`);
  assert(
    JSON.stringify(manifest.files) === JSON.stringify(["dist", "README.md", "LICENSE"]),
    `${manifest.name} must publish runtime files, README, and LICENSE only`
  );
  assert(manifest.license === "MIT", `${manifest.name} must declare the MIT license`);
  assert(manifest.repository?.type === "git", `${manifest.name} must declare a git repository`);
  assert(manifest.repository?.url === repositoryUrl, `${manifest.name} repository URL is incorrect`);
  assert(
    manifest.repository?.directory === packageDirectory,
    `${manifest.name} repository directory is incorrect`
  );
  assert(manifest.homepage === homepageUrl, `${manifest.name} homepage is incorrect`);
  assert(manifest.bugs?.url === bugsUrl, `${manifest.name} bugs URL is incorrect`);
  assert(manifest.publishConfig?.access === "public", `${manifest.name} must publish publicly`);
  assert(manifest.publishConfig?.provenance === true, `${manifest.name} must publish with provenance`);
  assert(Array.isArray(manifest.keywords) && manifest.keywords.length >= 4, `${manifest.name} needs accurate keywords`);
  for (const forbidden of ["author", "maintainers", "contributors"]) {
    assert(!(forbidden in manifest), `${manifest.name} must omit inferred ${forbidden} metadata`);
  }
  const rootExport = manifest.exports?.["."];
  for (const condition of ["types", "import", "require"]) {
    assert(
      typeof rootExport?.[condition] === "string",
      `${manifest.name} must publish its ${condition} root export`
    );
  }
}

assert(
  new Set(manifests.map(({ version }) => version)).size === 1,
  "all public package versions must match"
);
for (const manifest of manifests) {
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dependency.startsWith("@durlo/")) continue;
    assert(
      range === `workspace:${releaseVersion}`,
      `${manifest.name} must pin ${dependency} to workspace:${releaseVersion}`
    );
  }
}
const cli = manifests.find(({ name }) => name === "@durlo/cli");
assert(cli?.bin?.durlo === "./dist/bin.js", "@durlo/cli must publish the durlo binary");

const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
assert(license.includes("MIT License"), "root LICENSE must contain the MIT license");
assert(
  license.includes("Copyright (c) 2026 Durlo contributors"),
  "root LICENSE must use the confirmed non-personal copyright line"
);

const governance = await Promise.all(
  ["SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"].map(async (name) => [
    name,
    await readFile(new URL(`../${name}`, import.meta.url), "utf8")
  ])
);
const governanceByName = Object.fromEntries(governance);
assert(
  governanceByName["SECURITY.md"].includes("private vulnerability reporting"),
  "SECURITY.md must direct reports to GitHub private vulnerability reporting"
);
assert(
  governanceByName["CONTRIBUTING.md"].includes("Released migrations are immutable"),
  "CONTRIBUTING.md must preserve immutable migrations"
);
assert(
  governanceByName["CHANGELOG.md"].includes(`## [${releaseVersion}]`),
  "CHANGELOG.md must describe the alpha release"
);

for (const packageDirectory of publicPackages) {
  const packageName = packageDirectory.split("/").at(-1);
  const readme = await readFile(
    new URL(`../${packageDirectory}/README.md`, import.meta.url),
    "utf8"
  );
  const packageLicense = await readFile(
    new URL(`../${packageDirectory}/LICENSE`, import.meta.url),
    "utf8"
  );
  assert(readme.includes(`@durlo/${packageName}`), `${packageDirectory} README must name its package`);
  for (const requirement of ["Installation", "Requirements", "Exports", "Alpha status"]) {
    assert(readme.includes(requirement), `${packageDirectory} README must include ${requirement}`);
  }
  assert(packageLicense === license, `${packageDirectory} LICENSE must match the root MIT license`);
}

const workspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
assert(
  /^preferSymlinkedExecutables: true$/m.test(workspace),
  "workspace installs must link the durlo binary before build output exists"
);

const nightly = await readFile(
  new URL("../.github/workflows/nightly.yml", import.meta.url),
  "utf8"
);
assert(/node: \[22, 24, 26\]/.test(nightly), "nightly must test Node 22, 24, and 26");
assert(/postgres: \[14, 18\]/.test(nightly), "nightly must test PostgreSQL 14 and 18 boundaries");
assert(nightly.includes("pnpm test:stress"), "nightly must run the durability stress suite");
assert(nightly.includes("pnpm test:package"), "nightly must install packed artifacts");
assert(nightly.includes("pnpm test:quickstart"), "nightly must run the packed quickstart");
assert(
  nightly.includes("pnpm test:reference-apps"),
  "nightly must run the deployable reference applications"
);

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
assert(readme.includes("Node.js 22 through 26"), "README must declare Node boundaries");
assert(readme.includes("PostgreSQL 14 through 18"), "README must declare PostgreSQL boundaries");
assert(readme.includes("0.1.0-alpha.0"), "README must identify the alpha version");
assert(readme.includes("not a production-support promise"), "README must state the support boundary");

const roadmap = await readFile(new URL("../docs/ROADMAP.md", import.meta.url), "utf8");
const publicContractPhase = roadmap.match(
  /### 3\. Stabilize the public contract[\s\S]*?(?=\n### |\n## )/
)?.[0];
assert(
  publicContractPhase?.includes("**DONE**"),
  "roadmap must identify the public contract as complete"
);
assert(
  roadmap.includes("**Current focus:** Prepare the installable alpha"),
  "roadmap must identify alpha preparation as the current phase"
);

process.stdout.write(
  "repository contract passed: manifests, exports, support boundaries, nightly audit, and roadmap status\n"
);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
