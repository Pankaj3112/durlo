import assert from "node:assert/strict";
import test from "node:test";
import {
  planRegistryPublication,
  validateReleaseMetadata
} from "../scripts/release-plan.mjs";

const version = "0.1.0-alpha.0";
const packages = [
  localPackage("@durlo/core", "sha512-core"),
  localPackage("@durlo/postgres", "sha512-postgres", { "@durlo/core": version }),
  localPackage("@durlo/cli", "sha512-cli", { "@durlo/core": version })
];

test("validates the exact annotated-tag version contract", () => {
  assert.equal(
    validateReleaseMetadata({
      tag: `v${version}`,
      rootVersion: version,
      packages: packages.map(({ name, version: packageVersion, dependencies }) => ({
        name,
        version: packageVersion,
        dependencies
      })),
      changelog: `# Changelog\n\n## [${version}] - 2026-08-23\n`
    }),
    version
  );

  for (const invalidTag of [version, "v0.1.0", "v0.1.0-alpha.1", "release-v0.1.0-alpha.0"]) {
    assert.throws(
      () =>
        validateReleaseMetadata({
          tag: invalidTag,
          rootVersion: version,
          packages,
          changelog: `## [${version}]`
        }),
      /tag/
    );
  }
});

test("rejects package version, dependency, and changelog drift", () => {
  assert.throws(
    () =>
      validateReleaseMetadata({
        tag: `v${version}`,
        rootVersion: version,
        packages: [packages[0], { ...packages[1], version: "0.1.0-alpha.1" }, packages[2]],
        changelog: `## [${version}]`
      }),
    /version/
  );
  assert.throws(
    () =>
      validateReleaseMetadata({
        tag: `v${version}`,
        rootVersion: version,
        packages: [
          packages[0],
          { ...packages[1], dependencies: { "@durlo/core": "^0.1.0-alpha.0" } },
          packages[2]
        ],
        changelog: `## [${version}]`
      }),
    /dependency/
  );
  assert.throws(
    () =>
      validateReleaseMetadata({
        tag: `v${version}`,
        rootVersion: version,
        packages,
        changelog: "# Changelog"
      }),
    /changelog/
  );
});

test("plans a first publication in dependency order", () => {
  const plan = planRegistryPublication(packages, {});
  assert.deepEqual(
    plan.map(({ name, action }) => ({ name, action })),
    [
      { name: "@durlo/core", action: "publish" },
      { name: "@durlo/postgres", action: "publish" },
      { name: "@durlo/cli", action: "publish" }
    ]
  );
});

test("continues a matching dependency-ordered partial publication", () => {
  const plan = planRegistryPublication(packages, {
    "@durlo/core": registryPackage(packages[0])
  });
  assert.deepEqual(
    plan.map(({ name, action }) => ({ name, action })),
    [
      { name: "@durlo/core", action: "skip-matching" },
      { name: "@durlo/postgres", action: "publish" },
      { name: "@durlo/cli", action: "publish" }
    ]
  );
});

test("makes an all-matching rerun a no-op", () => {
  const registry = Object.fromEntries(packages.map((item) => [item.name, registryPackage(item)]));
  assert(planRegistryPublication(packages, registry).every(({ action }) => action === "skip-matching"));
});

test("rejects mismatched or dependency-inverted registry state", () => {
  assert.throws(
    () =>
      planRegistryPublication(packages, {
        "@durlo/core": { ...registryPackage(packages[0]), dist: { integrity: "sha512-other" } }
      }),
    /mismatched artifact/
  );
  assert.throws(
    () =>
      planRegistryPublication(packages, {
        "@durlo/core": {
          ...registryPackage(packages[0]),
          dist: { integrity: packages[0].integrity }
        }
      }),
    /provenance/
  );
  assert.throws(
    () =>
      planRegistryPublication(packages, {
        "@durlo/postgres": registryPackage(packages[1])
      }),
    /incompatible partial publication/
  );
});

function localPackage(name, integrity, dependencies = {}) {
  return { name, version, integrity, dependencies };
}

function registryPackage(local) {
  return {
    name: local.name,
    version: local.version,
    dependencies: local.dependencies,
    dist: {
      integrity: local.integrity,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/${local.name}@${local.version}`,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" }
      }
    }
  };
}
