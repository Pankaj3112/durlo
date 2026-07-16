import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONFIG_FILENAMES } from "./config.js";

const CONFIG_TEMPLATE = `import { Durlo } from "@durlo/core";
import { defineConfig } from "@durlo/cli";
import { postgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

export const adapter = postgresAdapter({ connectionString: databaseUrl });

export const durlo = new Durlo({
  id: "my-app",
  adapter
});

export const hello = durlo.task({
  id: "hello",
  run: async (input: { name: string }) => ({
    message: \`Hello, \${input.name}!\`
  })
});

export default defineConfig({
  durlo,
  tasks: [hello],
  workflows: [],
  worker: {
    concurrency: 10,
    pollInterval: "1s",
    leaseDuration: "30s"
  },
  dashboard: {
    host: "127.0.0.1",
    port: 3210
  }
});
`;

export type InitResult = { path: string; created: boolean };

export async function initProject(cwd: string, force = false): Promise<InitResult> {
  const path = resolve(cwd, CONFIG_FILENAMES[0]);
  try {
    await writeFile(path, CONFIG_TEMPLATE, {
      encoding: "utf8",
      flag: force ? "w" : "wx"
    });
    return { path, created: true };
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error(`${path} already exists; pass --force to replace it`);
    }
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
