import { defineConfig } from "@durlo/cli";
import { deliverWebhook, durlo } from "./src/durlo.js";

export default defineConfig({
  durlo,
  tasks: [deliverWebhook],
  workflows: [],
  worker: {
    concurrency: 8,
    pollInterval: "250ms",
    leaseDuration: "30s"
  },
  dashboard: {
    host: "127.0.0.1",
    port: 4311
  }
});
