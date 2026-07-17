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

const support = await readFile(new URL("../docs/SUPPORT.md", import.meta.url), "utf8");
assert(support.includes("Node.js 22 through 26"), "support policy must declare Node boundaries");
assert(
  support.includes("PostgreSQL 14 through 18"),
  "support policy must declare PostgreSQL boundaries"
);

const roadmap = await readFile(new URL("../docs/ROADMAP.md", import.meta.url), "utf8");
const phaseFive = roadmap.match(/## Phase 5: Beta Release Proof[\s\S]*?(?=\n## )/)?.[0];
assert(phaseFive?.includes("Status: Complete"), "Phase 5 must remain complete in the roadmap");

const betaProof = await readFile(new URL("../docs/BETA_RELEASE_PROOF.md", import.meta.url), "utf8");
assert(/^Status: Complete$/m.test(betaProof), "beta release proof must remain complete");
assert(
  betaProof.includes("pnpm test:local test:reference-apps"),
  "beta release proof must retain its local reference-app command"
);

process.stdout.write(
  "release contract passed: manifests, exports, support boundaries, nightly audit, and Phase 5 proof\n"
);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
