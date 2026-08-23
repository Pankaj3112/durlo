import { defineConfig } from "@durlo/cli";
import { durlo, orderWorkflow, recordOrderCreatedTask } from "./src/durlo.js";

export default defineConfig({
  durlo,
  tasks: [recordOrderCreatedTask],
  workflows: [orderWorkflow],
  worker: {
    concurrency: 2,
    pollInterval: "100ms",
    leaseDuration: "2s"
  },
  dashboard: {
    host: "127.0.0.1",
    port: 3210
  }
});
