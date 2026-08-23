import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { verifyDurloProvenance } from "../scripts/provenance.mjs";

const repository = "https://github.com/Pankaj3112/durlo";
const workflowPath = ".github/workflows/release.yml";
const tag = "v0.1.0-alpha.0";
const commit = "0123456789abcdef0123456789abcdef01234567";
const version = tag.slice(1);
const integrity = `sha512-${Buffer.from("ab".repeat(64), "hex").toString("base64")}`;
const expected = [{ name: "@durlo/core", version, integrity }];

test("requires a cryptographically verified Durlo SLSA provenance payload", () => {
  const proof = verifyDurloProvenance({
    audit: auditResult(provenancePayload()),
    expectedPackages: expected,
    repository,
    workflowPath,
    tag,
    commit
  });

  assert.deepEqual(proof, [
    {
      name: "@durlo/core",
      version,
      integrity,
      attestationUrl:
        "https://registry.npmjs.org/-/npm/v1/attestations/%40durlo%2fcore@0.1.0-alpha.0",
      predicateType: "https://slsa.dev/provenance/v1",
      repository,
      workflowPath,
      ref: `refs/tags/${tag}`,
      commit
    }
  ]);
});

test("rejects missing provenance and source, ref, commit, or digest drift", () => {
  assert.throws(
    () =>
      verifyDurloProvenance({
        audit: { invalid: [], missing: [], verified: [] },
        expectedPackages: expected,
        repository,
        workflowPath,
        tag,
        commit
      }),
    /missing verified provenance/
  );

  for (const [field, value] of [
    ["repository", "https://github.com/example/fork"],
    ["ref", "refs/heads/main"],
    ["path", "/.github/workflows/other.yml"],
    ["commit", "f".repeat(40)],
    ["digest", "cd".repeat(64)]
  ]) {
    assert.throws(
      () =>
        verifyDurloProvenance({
          audit: auditResult(provenancePayload({ [field]: value })),
          expectedPackages: expected,
          repository,
          workflowPath,
          tag,
          commit
        }),
      /provenance/
    );
  }
});

function auditResult(payload) {
  return {
    invalid: [],
    missing: [],
    verified: [
      {
        name: "@durlo/core",
        version,
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/%40durlo%2fcore@0.1.0-alpha.0",
          provenance: { predicateType: "https://slsa.dev/provenance/v1" }
        },
        attestationBundles: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(payload)).toString("base64")
              }
            }
          }
        ]
      }
    ]
  };
}

function provenancePayload(overrides = {}) {
  const digest = overrides.digest ?? "ab".repeat(64);
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/%40durlo/core@${version}`, digest: { sha512: digest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: overrides.repository ?? repository,
            path: overrides.path ?? `/${workflowPath}`,
            ref: overrides.ref ?? `refs/tags/${tag}`
          }
        },
        resolvedDependencies: [
          {
            uri: `git+${repository}@refs/tags/${tag}`,
            digest: { gitCommit: overrides.commit ?? commit }
          }
        ]
      }
    }
  };
}
