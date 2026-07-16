import { defineConfig } from "vitest/config";
import { requireTestDatabase, sharedVitestConfig } from "./vitest.shared.js";

requireTestDatabase();

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["test/postgres/**/*.benchmark.test.ts"],
    testTimeout: 120_000
  }
});
