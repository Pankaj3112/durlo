import { mergeConfig, defineConfig } from "vitest/config";
import coverageConfig from "./vitest.coverage.config.js";

export default mergeConfig(
  coverageConfig,
  defineConfig({
    test: {
      outputFile: {
        junit: "test-results/junit.xml"
      },
      reporters: ["default", "junit"]
    }
  })
);
