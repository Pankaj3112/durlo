import type { Worker } from "@durlo/core";
import type { DurloConfig } from "./types.js";

type Output = Pick<NodeJS.WriteStream, "write">;
type SignalName = "SIGINT" | "SIGTERM";
type SignalSource = {
  once: (signal: SignalName, listener: () => void) => unknown;
  off: (signal: SignalName, listener: () => void) => unknown;
};

export type WorkerCommandOptions = {
  stdout?: Output;
  signals?: SignalSource;
};

export function configuredWorker(config: DurloConfig): Worker {
  return config.durlo.worker({
    ...config.worker,
    tasks: [...(config.tasks ?? [])],
    workflows: [...(config.workflows ?? [])]
  });
}

export async function runConfiguredWorker(
  config: DurloConfig,
  options: WorkerCommandOptions = {}
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const signals = options.signals ?? process;
  const worker = configuredWorker(config);
  const stop = (): void => worker.stop();

  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  stdout.write(
    `Worker ${worker.id} registered ${config.tasks?.length ?? 0} task(s) and ${config.workflows?.length ?? 0} workflow(s)\n`
  );
  try {
    await worker.start();
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}
