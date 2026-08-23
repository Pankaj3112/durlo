import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Durlo,
  RunCancelledError,
  RunFailedError,
  RunNotFoundError,
  RunWaitTimeoutError
} from "@durlo/core";
import type { RunHandle, RunRecord, SerializedError } from "@durlo/core";
import type { DurloAdapter } from "../../packages/core/src/types.js";

type WaitSnapshot = {
  run: RunRecord;
  outputKind: "value" | "undefined" | null;
  storedError: SerializedError | null;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("durlo.runs.wait", () => {
  it.each([
    ["value output", "value", { ready: true }, { ready: true }],
    ["null output", "value", null, null],
    ["undefined output", "undefined", null, undefined],
    ["legacy null output", null, null, null]
  ] as const)("resolves completed runs with %s", async (_label, outputKind, output, expected) => {
    const { durlo } = waitDurlo(async () => ({
      run: runRecord({ status: "completed", output }),
      outputKind,
      storedError: null
    }));

    await expect(durlo.runs.wait(handle(), { timeout: "1s" })).resolves.toEqual(expected);
  });

  it.each([
    ["failed", RunFailedError],
    ["dead_letter", RunFailedError],
    ["cancelled", RunCancelledError]
  ] as const)("rejects a %s run with its typed terminal error", async (status, ErrorType) => {
    const storedError = { name: "Error", message: "broken", cause: { code: "E_BROKEN" } };
    const { durlo } = waitDurlo(async () => ({
      run: runRecord({ status, error: storedError }),
      outputKind: null,
      storedError
    }));

    const rejection = durlo.runs.wait(handle(), { timeout: 1_000 });
    await expect(rejection).rejects.toBeInstanceOf(ErrorType);
    if (status !== "cancelled") {
      await expect(rejection).rejects.toMatchObject({
        runId: "run-1",
        status,
        error: storedError
      });
    }
  });

  it("rejects missing and cleaned-up runs", async () => {
    const { durlo } = waitDurlo(async () => null);
    await expect(durlo.runs.wait(handle(), { timeout: 1_000 })).rejects.toEqual(
      new RunNotFoundError("run-1")
    );
  });

  it("polls pending work without starting reads after completion", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<WaitSnapshot | null>>()
      .mockResolvedValueOnce({
        run: runRecord({ status: "pending" }),
        outputKind: null,
        storedError: null
      })
      .mockResolvedValue({
        run: runRecord({ status: "completed", output: "done" }),
        outputKind: "value",
        storedError: null
      });
    const { durlo } = waitDurlo(read);

    const result = durlo.runs.wait(handle(), { timeout: "1s" });
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe("done");
    const settledReads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(settledReads);
  });

  it("validates timeouts and cleans timers and abort listeners on timeout", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({
      run: runRecord({ status: "pending" }),
      outputKind: null,
      storedError: null
    }));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { durlo } = waitDurlo(read);

    expect(() => durlo.runs.wait(handle(), { timeout: 0 })).toThrow();
    expect(() => durlo.runs.wait(handle(), { timeout: Number.POSITIVE_INFINITY })).toThrow();
    const result = durlo.runs.wait(handle(), { signal: controller.signal, timeout: 50 });
    const rejection = expect(result).rejects.toEqual(new RunWaitTimeoutError("run-1", 50));
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(remove).toHaveBeenCalledTimes(1);
    const settledReads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(settledReads);
  });

  it("rejects with an abort reason or AbortError before doing another read", async () => {
    const reason = new Error("stop waiting");
    const preAborted = new AbortController();
    preAborted.abort(reason);
    const firstRead = vi.fn(async () => null);
    const first = waitDurlo(firstRead).durlo.runs.wait(handle(), {
      signal: preAborted.signal
    });
    await expect(first).rejects.toBe(reason);
    expect(firstRead).not.toHaveBeenCalled();

    const controller = new AbortController();
    const read = vi.fn(async () => ({
      run: runRecord({ status: "pending" }),
      outputKind: null,
      storedError: null
    }));
    const result = waitDurlo(read).durlo.runs.wait(handle(), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    const settledReads = read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).toHaveBeenCalledTimes(settledReads);
  });
});

function waitDurlo(read: () => Promise<WaitSnapshot | null>): { durlo: Durlo } {
  const unused = async (): Promise<never> => {
    throw new Error("unused adapter operation");
  };
  const adapter = {
    createRun: unused,
    createRuns: unused,
    getRun: async () => null,
    getRunForWait: read,
    getRunDetails: unused,
    getBacklogHealth: unused,
    listRuns: unused,
    cancelRun: unused,
    retryRun: unused,
    cleanupRuns: unused,
    claimRuns: unused,
    findUnavailableRuns: unused,
    extendRunLease: unused,
    completeRun: unused,
    failRun: unused,
    releaseRun: unused,
    getStep: unused,
    startStep: unused,
    completeStep: unused,
    failStep: unused,
    getTimer: unused,
    sleepRun: unused,
    fireDueTimers: unused
  } as unknown as DurloAdapter;
  return { durlo: new Durlo({ id: "wait-tests", adapter }) };
}

function handle(): RunHandle<unknown> {
  return {
    id: "run-1",
    kind: "task",
    resourceId: "wait-task",
    resourceVersion: "1",
    status: "pending",
    createdAt: new Date("2026-08-23T00:00:00.000Z")
  };
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date("2026-08-23T00:00:00.000Z");
  return {
    id: "run-1",
    appId: "wait-tests",
    kind: "task",
    resourceId: "wait-task",
    resourceVersion: "1",
    status: "pending",
    input: {},
    output: null,
    error: null,
    options: {},
    idempotencyKey: null,
    priority: 0,
    scheduledAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    lockedBy: null,
    leaseToken: null,
    lockedUntil: null,
    stalledCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides
  };
}
