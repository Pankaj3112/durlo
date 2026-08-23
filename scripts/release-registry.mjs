const defaultRegistry = "https://registry.npmjs.org";

export async function readRegistryPackage(name, version, fetchImplementation = fetch) {
  const response = await fetchImplementation(
    `${defaultRegistry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { headers: { Accept: "application/json" } }
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${name}@${version}`);
  }
  return response.json();
}
