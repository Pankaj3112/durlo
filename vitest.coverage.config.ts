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
        statements: 85,
        branches: 75,
        functions: 90,
        lines: 85
      }
    },
    fileParallelism: false,
    include: ["test/**/*.test.ts"]
  }
});
