import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourceAlias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@durlo/core": sourceAlias("./packages/core/src/index.ts"),
      "@durlo/postgres": sourceAlias("./packages/postgres/src/index.ts"),
      durlo: sourceAlias("./packages/cli/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts"],
    passWithNoTests: true
  }
});
