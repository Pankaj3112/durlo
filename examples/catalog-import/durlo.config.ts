import { defineConfig } from "@durlo/cli";
import { config } from "./src/config.js";
import { catalogImportWorkflow, durlo } from "./src/durlo.js";

export default defineConfig({
  durlo,
  tasks: [],
  workflows: [catalogImportWorkflow],
  worker: {
    concurrency: 4,
    pollInterval: "250ms",
    leaseDuration: config.workerLeaseDuration
  },
  dashboard: {
    host: "127.0.0.1",
    port: 4321
  }
});
