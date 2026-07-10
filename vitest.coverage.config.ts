import { defineConfig } from "vitest/config";
import { requireTestDatabase, sharedVitestConfig } from "./vitest.shared.js";

requireTestDatabase();

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/index.ts"],
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 97,
        lines: 96
      }
    },
    exclude: ["test/postgres/**/*.privileged.test.ts", "test/postgres/**/*.stress.test.ts"],
    fileParallelism: false,
    include: ["test/**/*.test.ts"]
  }
});
