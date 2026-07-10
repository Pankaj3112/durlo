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
        statements: 88,
        branches: 80,
        functions: 95,
        lines: 90
      }
    },
    fileParallelism: false,
    include: ["test/**/*.test.ts"]
  }
});
