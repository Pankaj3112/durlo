import { readFile } from "node:fs/promises";

const nodeRange = ">=22 <27";
const publicPackages = ["packages/core", "packages/postgres", "packages/cli"];

const root = await readJson("package.json");
assert(root.engines?.node === nodeRange, `root Node engine must be '${nodeRange}'`);

const manifests = await Promise.all(publicPackages.map((path) => readJson(`${path}/package.json`)));
for (const manifest of manifests) {
  assert(
    manifest.engines?.node === nodeRange,
    `${manifest.name} Node engine must be '${nodeRange}'`
  );
  assert(manifest.sideEffects === false, `${manifest.name} must remain side-effect free`);
  assert(
    JSON.stringify(manifest.files) === JSON.stringify(["dist"]),
    `${manifest.name} must publish only dist`
  );
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
const cli = manifests.find(({ name }) => name === "@durlo/cli");
assert(cli?.bin?.durlo === "./dist/bin.js", "@durlo/cli must publish the durlo binary");

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
assert(readme.includes("Durlo is pre-release"), "README must state the pre-release status");

const roadmap = await readFile(new URL("../docs/ROADMAP.md", import.meta.url), "utf8");
const currentPhase = roadmap.match(
  /### 2\. Close the remaining integrity defects[\s\S]*?(?=\n### |\n## )/
)?.[0];
assert(
  currentPhase?.includes("**IN PROGRESS**"),
  "roadmap must identify integrity repair as the current phase"
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
