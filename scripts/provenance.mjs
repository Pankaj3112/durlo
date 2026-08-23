const slsaPredicate = "https://slsa.dev/provenance/v1";

export function provenanceInstallArguments({ name, version }) {
  return ["install", "--ignore-scripts", "--no-audit", "--save-exact", `${name}@${version}`];
}

export function verifyDurloProvenance({
  audit,
  expectedPackages,
  repository,
  workflowPath,
  tag,
  commit
}) {
  if (!audit || !Array.isArray(audit.verified)) {
    throw new Error("npm returned invalid signature and provenance evidence");
  }
  if ((audit.invalid ?? []).length > 0 || (audit.missing ?? []).length > 0) {
    throw new Error("npm reported invalid or missing registry signatures");
  }

  return expectedPackages.map((expected) => {
    const verified = audit.verified.find(
      ({ name, version }) => name === expected.name && version === expected.version
    );
    const attestation = verified?.attestationBundles?.find(
      ({ predicateType }) => predicateType === slsaPredicate
    );
    if (!verified || !attestation) {
      throw new Error(`missing verified provenance for ${expected.name}@${expected.version}`);
    }

    let statement;
    try {
      statement = JSON.parse(
        Buffer.from(attestation.bundle.dsseEnvelope.payload, "base64").toString("utf8")
      );
    } catch {
      throw new Error(`${expected.name}@${expected.version} provenance payload is invalid`);
    }

    const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
    const resolved = statement.predicate?.buildDefinition?.resolvedDependencies?.find(
      ({ digest }) => digest?.gitCommit === commit
    );
    const expectedSubject = `pkg:npm/${expected.name.replace(/^@/, "%40")}@${expected.version}`;
    const subject = statement.subject?.find(
      ({ name, digest }) =>
        name === expectedSubject && digest?.sha512 === integrityHex(expected.integrity)
    );
    const expectedRef = `refs/tags/${tag}`;
    const repositoryWithoutGit = repository.replace(/\.git$/, "");
    const sourceUri = resolved?.uri?.replace(/\.git@/, "@");
    const expectedSourceUri = `git+${repositoryWithoutGit}@${expectedRef}`;

    if (
      statement.predicateType !== slsaPredicate ||
      !subject ||
      workflow?.repository?.replace(/\.git$/, "") !== repositoryWithoutGit ||
      normalizeWorkflowPath(workflow?.path) !== normalizeWorkflowPath(workflowPath) ||
      workflow?.ref !== expectedRef ||
      sourceUri !== expectedSourceUri
    ) {
      throw new Error(`${expected.name}@${expected.version} provenance does not match the release source`);
    }

    return {
      name: expected.name,
      version: expected.version,
      integrity: expected.integrity,
      attestationUrl: verified.attestations?.url ?? null,
      predicateType: slsaPredicate,
      repository: repositoryWithoutGit,
      workflowPath: normalizeWorkflowPath(workflowPath),
      ref: expectedRef,
      commit
    };
  });
}

function normalizeWorkflowPath(path) {
  return typeof path === "string" ? path.replace(/^\/+/, "") : path;
}

function integrityHex(integrity) {
  const match = /^sha512-(.+)$/.exec(integrity ?? "");
  if (!match) throw new Error(`expected a sha512 integrity, received '${integrity}'`);
  return Buffer.from(match[1], "base64").toString("hex");
}
