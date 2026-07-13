import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared.js";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: ["test/core/**/*.test.ts", "test/cli/**/*.test.ts"]
  }
});
