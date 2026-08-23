import assert from "node:assert/strict";
import test from "node:test";
import { readRegistryPackage } from "../scripts/release-registry.mjs";

test("reads an existing scoped exact version as JSON without the abbreviated metadata header", async () => {
  let request;
  const result = await readRegistryPackage("@durlo/core", "0.1.0-alpha.1", async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ name: "@durlo/core", version: "0.1.0-alpha.1" })
    };
  });

  assert.equal(
    request.url,
    "https://registry.npmjs.org/%40durlo%2Fcore/0.1.0-alpha.1"
  );
  assert.notEqual(
    request.options?.headers?.Accept,
    "application/vnd.npm.install-v1+json"
  );
  assert.equal(result.name, "@durlo/core");
});

test("treats an exact 404 as unpublished", async () => {
  const result = await readRegistryPackage("@durlo/core", "0.1.0-alpha.1", async () => ({
    ok: false,
    status: 404
  }));
  assert.equal(result, undefined);
});

test("reads a real immutable scoped npm version", async () => {
  const result = await readRegistryPackage("@sigstore/sign", "4.1.1");
  assert.equal(result.name, "@sigstore/sign");
  assert.equal(result.version, "4.1.1");
});
