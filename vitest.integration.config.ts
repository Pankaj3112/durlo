import { defineConfig } from "vitest/config";
import { requireTestDatabase, sharedVitestConfig } from "./vitest.shared.js";

requireTestDatabase();

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    exclude: ["test/postgres/**/*.privileged.test.ts", "test/postgres/**/*.stress.test.ts"],
    fileParallelism: false,
    include: ["test/postgres/**/*.test.ts"]
  }
});
