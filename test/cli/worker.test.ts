import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Worker } from "@durlo/core";
import { configuredWorker, runConfiguredWorker } from "@durlo/cli";
import type { DurloConfig } from "@durlo/cli";

describe("durlo worker", () => {
  it("registers exactly the configured tasks and workflows with worker options", () => {
    let received: unknown;
    const expected = { id: "worker-1" } as Worker;
    const task = { id: "task", version: "1", kind: "task" };
    const workflow = { id: "workflow", version: "2", kind: "workflow" };
    const config = {
      durlo: {
        worker: (options: unknown) => {
          received = options;
          return expected;
        }
      },
      tasks: [task],
      workflows: [workflow],
      worker: { concurrency: 4, leaseDuration: "45s" }
    } as unknown as DurloConfig;

    expect(configuredWorker(config)).toBe(expected);
    expect(received).toEqual({
      concurrency: 4,
      leaseDuration: "45s",
      tasks: [task],
      workflows: [workflow]
    });
  });

  it("stops on a process signal, waits for worker drain, and removes handlers", async () => {
    const signals = new EventEmitter();
    let finish: (() => void) | undefined;
    let stopped = 0;
    const worker = {
      id: "worker-test",
      start: () => new Promise<void>((resolve) => (finish = resolve)),
      stop: () => {
        stopped += 1;
        finish?.();
      }
    } as Worker;
    const config = {
      durlo: { worker: () => worker },
      tasks: [{ id: "one" }],
      workflows: [{ id: "two" }]
    } as unknown as DurloConfig;
    let output = "";
    const running = runConfiguredWorker(config, {
      signals,
      stdout: {
        write: (chunk: string | Uint8Array) => {
          output += chunk.toString();
          return true;
        }
      }
    });

    await Promise.resolve();
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGTERM");
    await running;

    expect(stopped).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(output).toContain("1 task(s) and 1 workflow(s)");
  });
});
