import { defineConfig } from "vitest/config";
import { requireTestDatabase, sharedVitestConfig } from "./vitest.shared.js";

requireTestDatabase();

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    fileParallelism: false,
    include: ["test/postgres/**/*.stress.test.ts"],
    testTimeout: 60_000
  }
});
