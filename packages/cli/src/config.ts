import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { DurloConfig, LoadedDurloConfig } from "./types.js";

export const CONFIG_FILENAMES = [
  "durlo.config.ts",
  "durlo.config.mts",
  "durlo.config.js",
  "durlo.config.mjs",
  "durlo.config.cjs"
] as const;

export function defineConfig<const T extends DurloConfig>(config: T): T {
  return config;
}

export async function findConfigPath(cwd: string, explicitPath?: string): Promise<string> {
  if (explicitPath) {
    const candidate = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    if (await exists(candidate)) return candidate;
    throw new Error(`configuration file not found at ${candidate}`);
  }

  for (const filename of CONFIG_FILENAMES) {
    const candidate = resolve(cwd, filename);
    if (await exists(candidate)) return candidate;
  }
  throw new Error(
    `no Durlo configuration found in ${cwd}; run 'durlo init' or pass --config <path>`
  );
}

export async function loadConfig(cwd: string, explicitPath?: string): Promise<LoadedDurloConfig> {
  const path = await findConfigPath(cwd, explicitPath);
  let imported: Record<string, unknown>;
  try {
    imported = (await tsImport(pathToFileURL(path).href, import.meta.url)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(`could not load ${path}: ${errorMessage(error)}`, { cause: error });
  }
  const candidate = imported.default ?? imported.config;
  assertConfig(candidate, path);
  return { config: candidate, path };
}

export async function closeConfig(config: DurloConfig): Promise<void> {
  const adapter = config.durlo.adapter as { close?: () => Promise<void> };
  await adapter.close?.();
}

function assertConfig(value: unknown, path: string): asserts value is DurloConfig {
  if (!isRecord(value)) {
    throw new Error(`${path} must default-export a Durlo configuration`);
  }
  if (!isRecord(value.durlo) || typeof value.durlo.id !== "string" || !value.durlo.adapter) {
    throw new Error(`${path} must provide a Durlo instance as 'durlo'`);
  }
  assertResourceList(value.tasks, "tasks", path, "task");
  assertResourceList(value.workflows, "workflows", path, "workflow");
  if (value.worker !== undefined && !isRecord(value.worker)) {
    throw new Error(`${path} field 'worker' must be an object`);
  }
  if (value.dashboard !== undefined && !isRecord(value.dashboard)) {
    throw new Error(`${path} field 'dashboard' must be an object`);
  }
}

function assertResourceList(
  value: unknown,
  field: string,
  path: string,
  expectedKind: "task" | "workflow"
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${path} field '${field}' must be an array`);
  for (const resource of value) {
    if (
      !isRecord(resource) ||
      resource.kind !== expectedKind ||
      typeof resource.id !== "string" ||
      typeof resource.version !== "string" ||
      !isRecord(resource._durlo)
    ) {
      throw new Error(`${path} field '${field}' contains an invalid ${expectedKind} definition`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
