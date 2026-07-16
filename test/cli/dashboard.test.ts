import { describe, expect, it } from "vitest";
import { RunStateError } from "@durlo/core";
import type { Worker } from "@durlo/core";
import { startDashboard } from "@durlo/cli";
import type { DurloConfig } from "@durlo/cli";

describe("local dashboard", () => {
  it("serves an offline UI and app-scoped observability endpoints", async () => {
    const calls: Array<{ operation: string; value?: unknown }> = [];
    const config = fakeConfig(calls);
    const worker = {
      getHealth: () => ({ status: "running", activeRuns: 1, concurrency: 3 }),
      getCompatibilityReport: async () => ({ unavailableRuns: [], truncated: false })
    } as unknown as Worker;
    const server = await startDashboard(config, worker, { port: 0 });
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      const html = await page.text();
      expect(html).toContain("Durlo Dispatch");
      expect(html).toContain("app&lt;unsafe&gt;");
      expect(html).not.toContain("https://");

      const list = await json(
        `${server.url}/api/runs?status=running&kind=workflow&resourceId=onboard&limit=25`
      );
      expect(list.response.status).toBe(200);
      expect(list.body.runs).toHaveLength(1);
      expect(calls).toContainEqual({
        operation: "list",
        value: {
          limit: 25,
          statuses: ["running"],
          kinds: ["workflow"],
          resourceId: "onboard"
        }
      });

      const detail = await json(`${server.url}/api/runs/run-1`);
      expect(detail.response.status).toBe(200);
      expect(detail.body.run.id).toBe("run-1");

      const health = await json(`${server.url}/api/health`);
      expect(health.body.appId).toBe("app<unsafe>");
      expect(health.body.worker?.status).toBe("running");
      expect(health.body.compatibility?.unavailableRuns).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("performs only same-origin POST controls and returns state conflicts", async () => {
    const calls: Array<{ operation: string; value?: unknown }> = [];
    const server = await startDashboard(fakeConfig(calls), undefined, { port: 0 });
    try {
      const rejected = await json(`${server.url}/api/runs/run-1/cancel`, {
        method: "POST",
        headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
        body: "{}"
      });
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.error).toMatch(/cross-origin/);

      const cancelled = await json(`${server.url}/api/runs/run-1/cancel`, {
        method: "POST",
        headers: { Origin: server.url, "Content-Type": "application/json" },
        body: "{}"
      });
      expect(cancelled.response.status).toBe(200);
      expect(calls).toContainEqual({ operation: "cancel", value: "run-1" });

      const conflict = await json(`${server.url}/api/runs/not-retryable/retry`, {
        method: "POST",
        headers: { Origin: server.url, "Content-Type": "application/json" },
        body: "{}"
      });
      expect(conflict.response.status).toBe(409);
      expect(conflict.body.error).toMatch(/cannot manually retry/);
    } finally {
      await server.close();
    }
  });

  it("validates filters and distinguishes missing details", async () => {
    const server = await startDashboard(fakeConfig([]), undefined, { port: 0 });
    try {
      expect((await fetch(`${server.url}/api/runs?status=unknown`)).status).toBe(400);
      expect((await fetch(`${server.url}/api/runs?kind=event`)).status).toBe(400);
      expect((await fetch(`${server.url}/api/runs/missing`)).status).toBe(404);
      expect((await fetch(`${server.url}/api/nope`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("covers default filters, workerless health, retry, error mapping, and server boundaries", async () => {
    await expect(startDashboard(fakeConfig([]), undefined, { host: " ", port: 0 })).rejects.toThrow(
      /host/
    );
    await expect(startDashboard(fakeConfig([]), undefined, { port: 65_536 })).rejects.toThrow(
      /port/
    );

    const calls: Array<{ operation: string; value?: unknown }> = [];
    const config = fakeConfig(calls);
    config.dashboard = { host: "127.0.0.1", port: 0 };
    const server = await startDashboard(config);
    try {
      const list = await json(
        `${server.url}/api/runs?status=running,completed&kind=task,workflow&cursor=next&resourceVersion=2`
      );
      expect(list.response.status).toBe(200);
      expect(calls).toContainEqual({
        operation: "list",
        value: {
          limit: 50,
          statuses: ["running", "completed"],
          kinds: ["task", "workflow"],
          cursor: "next",
          resourceVersion: "2"
        }
      });

      const health = await json(`${server.url}/api/health`);
      expect(health.body.worker).toBeNull();
      expect(health.body.compatibility).toBeNull();

      const retried = await json(`${server.url}/api/runs/run-1/retry`, { method: "POST" });
      expect(retried.response.status).toBe(200);
      expect(calls).toContainEqual({ operation: "retry", value: "run-1" });

      const invalidOrigin = await json(`${server.url}/api/runs/run-1/cancel`, {
        method: "POST",
        headers: { Origin: "://invalid" }
      });
      expect(invalidOrigin.response.status).toBe(400);
      expect((await fetch(`${server.url}/api/runs?limit=1.5`)).status).toBe(400);
      expect((await fetch(`${server.url}/api/runs/structural-validation`)).status).toBe(400);
      expect((await fetch(`${server.url}/api/runs/unexpected-error`)).status).toBe(500);

      await expect(
        startDashboard(fakeConfig([]), undefined, { host: server.host, port: server.port })
      ).rejects.toThrow();
    } finally {
      await server.close();
      await server.close();
    }
  });
});

function fakeConfig(calls: Array<{ operation: string; value?: unknown }>): DurloConfig {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const run = {
    id: "run-1",
    kind: "workflow",
    resourceId: "onboard",
    resourceVersion: "1",
    status: "running",
    input: { userId: "user-1" },
    output: null,
    error: null,
    options: {},
    priority: 0,
    scheduledAt: now,
    attemptCount: 1,
    maxAttempts: 3,
    stalledCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    cancelledAt: null
  };
  return {
    durlo: {
      id: "app<unsafe>",
      runs: {
        list: async (value: unknown) => {
          calls.push({ operation: "list", value });
          return { runs: [run], nextCursor: null };
        },
        getDetails: async (id: string) => {
          calls.push({ operation: "details", value: id });
          if (id === "missing") return null;
          if (id === "structural-validation") throw { name: "ValidationError" };
          if (id === "unexpected-error") throw "unexpected failure";
          return {
            run,
            checkedAt: now,
            steps: [],
            attempts: [],
            timers: [],
            timeline: [],
            diagnostics: {
              failureCount: 0,
              failedAttempts: 0,
              timedOutAttempts: 0,
              stalledAttempts: 0,
              retryCount: 0,
              leaseLossCount: 0,
              hasExpiredLease: false,
              timerLagMs: 0
            }
          };
        },
        getBacklogHealth: async () => ({
          appId: "app<unsafe>",
          checkedAt: now,
          runs: {
            active: 1,
            pending: 0,
            ready: 0,
            delayed: 0,
            running: 1,
            sleeping: 0,
            expiredLeases: 0,
            oldestReadyAt: null,
            oldestReadyCreatedAt: null,
            readyLagMs: 0
          },
          timers: { pending: 0, due: 0, oldestDueAt: null, lagMs: 0 }
        }),
        cancel: async (id: string) => {
          calls.push({ operation: "cancel", value: id });
          return { ...run, status: "cancelled" };
        },
        retry: async (id: string) => {
          calls.push({ operation: "retry", value: id });
          if (id === "not-retryable") {
            throw new RunStateError("cannot manually retry a running workflow run");
          }
          return { ...run, status: "pending" };
        }
      }
    }
  } as unknown as DurloConfig;
}

async function json(
  input: string,
  init?: RequestInit
): Promise<{ response: Response; body: ApiBody }> {
  const response = await fetch(input, init);
  return { response, body: (await response.json()) as ApiBody };
}

type ApiBody = {
  runs: unknown[];
  run: { id: string };
  appId: string;
  worker: { status: string } | null;
  compatibility: { unavailableRuns: unknown[] } | null;
  error: string;
};
