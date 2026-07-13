/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    "packages/core/src/retry.ts",
    "packages/core/src/serialization.ts",
    "packages/core/src/validation.ts"
  ],
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.ts",
    related: false
  },
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: {
    fileName: "test-results/stryker.json"
  },
  thresholds: {
    high: 90,
    low: 85,
    break: 90
  },
  concurrency: 4,
  timeoutMS: 10_000,
  ignorePatterns: ["coverage", "test/postgres", "test/qa"]
};
