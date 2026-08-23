const releaseOrder = ["@durlo/core", "@durlo/postgres", "@durlo/cli"];

export function validateReleaseMetadata({ tag, rootVersion, packages, changelog }) {
  const expectedTag = `v${rootVersion}`;
  if (tag !== expectedTag || !/^v\d+\.\d+\.\d+-alpha\.\d+$/.test(tag)) {
    throw new Error(`release tag '${tag}' must exactly match alpha package version '${expectedTag}'`);
  }
  if (!Array.isArray(packages) || packages.length !== releaseOrder.length) {
    throw new Error("release package inventory must contain core, postgres, and CLI");
  }
  if (packages.map(({ name }) => name).join(",") !== releaseOrder.join(",")) {
    throw new Error(`release package order must be ${releaseOrder.join(", ")}`);
  }
  for (const item of packages) {
    if (item.version !== rootVersion) {
      throw new Error(`${item.name} version '${item.version}' must match root version '${rootVersion}'`);
    }
    for (const [dependency, range] of Object.entries(item.dependencies ?? {})) {
      if (!releaseOrder.includes(dependency)) continue;
      if (range !== rootVersion && range !== `workspace:${rootVersion}`) {
        throw new Error(`${item.name} dependency ${dependency} must pin ${rootVersion} exactly`);
      }
    }
  }
  if (!changelog.includes(`## [${rootVersion}]`)) {
    throw new Error(`changelog must contain a ${rootVersion} release entry`);
  }
  return rootVersion;
}

export function planRegistryPublication(localPackages, registryPackages) {
  if (localPackages.map(({ name }) => name).join(",") !== releaseOrder.join(",")) {
    throw new Error(`local artifacts must be ordered ${releaseOrder.join(", ")}`);
  }
  let missingArtifactSeen = false;
  return localPackages.map((local) => {
    const remote = registryPackages[local.name];
    if (!remote) {
      missingArtifactSeen = true;
      return { ...local, action: "publish" };
    }
    if (missingArtifactSeen) {
      throw new Error(
        `incompatible partial publication: ${local.name}@${local.version} exists after an unpublished dependency`
      );
    }
    assertMatchingRegistryArtifact(local, remote);
    return { ...local, action: "skip-matching" };
  });
}

export function assertMatchingRegistryArtifact(local, remote) {
  const reasons = [];
  if (remote.name !== local.name) reasons.push("name");
  if (remote.version !== local.version) reasons.push("version");
  if (remote.dist?.integrity !== local.integrity) reasons.push("integrity");
  const localInternal = internalDependencies(local.dependencies);
  const remoteInternal = internalDependencies(remote.dependencies);
  if (JSON.stringify(localInternal) !== JSON.stringify(remoteInternal)) reasons.push("dependencies");
  if (reasons.length > 0) {
    throw new Error(
      `mismatched artifact ${local.name}@${local.version}: ${reasons.join(", ")} differ from the registry`
    );
  }
}

function internalDependencies(dependencies = {}) {
  return Object.fromEntries(
    Object.entries(dependencies)
      .filter(([name]) => releaseOrder.includes(name))
      .toSorted(([left], [right]) => left.localeCompare(right))
  );
}
