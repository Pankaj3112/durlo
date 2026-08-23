import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Durlo, IdempotencyConflictError } from "@durlo/core";
import { postgresAdapter } from "../helpers/postgres-internal.js";
import type { PostgresAdapter } from "../helpers/postgres-internal.js";

const databaseUrl = process.env.DURLO_TEST_DATABASE_URL;

describe.runIf(Boolean(databaseUrl)).sequential("@durlo/postgres rolling deployments", () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = postgresAdapter({ connectionString: databaseUrl! });
    await adapter.migrate();
  });

  beforeEach(async () => {
    await adapter.pool.query("truncate durlo_runs cascade");
  });

  afterAll(async () => {
    await adapter.close();
  });

  it("keeps old sleeping workflows on their exact version during rollout and rollback", async () => {
    const appId = "rolling-deployment-tests";
    const durlo = new Durlo({ id: appId, adapter });
    let oldCheckpointExecutions = 0;
    const version1 = durlo.workflow<{ orderId: string }, string>({
      id: "versioned-order",
      version: "2026-01",
      run: async ({ input, step }) => {
        const checkpoint = await step.run("reserve-v1", () => {
          oldCheckpointExecutions += 1;
          return `reserved:${input.orderId}`;
        });
        await step.sleep("rollout-window", "1d");
        return checkpoint;
      }
    });
    const version2 = durlo.workflow<{ orderId: string }, string>({
      id: "versioned-order",
      version: "2026-07",
      run: async ({ input, step }) => step.run("reserve-v2", () => `reserved-v2:${input.orderId}`)
    });

    const oldRun = await version1.start(
      { orderId: "order-old" },
      { idempotencyKey: "business-operation" }
    );
    const oldWorker = durlo.worker({
      workflows: [version1],
      workerId: "version-1-worker"
    });
    expect(await oldWorker.runOnce()).toBe(1);
    expect(await durlo.runs.get(oldRun.run)).toMatchObject({
      status: "sleeping",
      resourceVersion: "2026-01"
    });
    expect(oldCheckpointExecutions).toBe(1);

    await expect(
      version2.start(
        { orderId: "must-not-replace-input" },
        { idempotencyKey: "business-operation" }
      )
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const newRun = await version2.start(
      { orderId: "order-new" },
      { idempotencyKey: "business-operation-v2" }
    );
    const newOnlyWorker = durlo.worker({
      workflows: [version2],
      workerId: "version-2-worker"
    });
    await expect(newOnlyWorker.getCompatibilityReport()).resolves.toMatchObject({
      unavailableRuns: [
        expect.objectContaining({
          id: oldRun.run.id,
          resourceVersion: "2026-01",
          reason: "incompatible_version"
        })
      ]
    });
    expect(await newOnlyWorker.runOnce()).toBe(1);
    expect(await durlo.runs.get(newRun.run)).toMatchObject({
      status: "completed",
      output: "reserved-v2:order-new",
      resourceVersion: "2026-07"
    });

    await adapter.pool.query(
      `update durlo_timers set fire_at = now() - interval '1 second' where run_id = $1`,
      [oldRun.run.id]
    );
    expect(await newOnlyWorker.runOnce()).toBe(0);
    expect(await durlo.runs.get(oldRun.run)).toMatchObject({
      status: "pending",
      resourceVersion: "2026-01"
    });
    await expect(newOnlyWorker.getCompatibilityReport()).resolves.toMatchObject({
      unavailableRuns: [expect.objectContaining({ id: oldRun.run.id })]
    });

    const mixedFleetWorker = durlo.worker({
      workflows: [version1, version2],
      workerId: "mixed-version-worker"
    });
    expect(await mixedFleetWorker.runOnce()).toBe(1);
    expect(await durlo.runs.get(oldRun.run)).toMatchObject({
      status: "completed",
      output: "reserved:order-old",
      resourceVersion: "2026-01"
    });
    expect(oldCheckpointExecutions).toBe(1);

    const rollbackRun = await version2.start({ orderId: "order-during-rollback" });
    await expect(oldWorker.getCompatibilityReport()).resolves.toMatchObject({
      unavailableRuns: [
        expect.objectContaining({
          id: rollbackRun.run.id,
          resourceVersion: "2026-07",
          reason: "incompatible_version"
        })
      ]
    });
    expect(await oldWorker.runOnce()).toBe(0);
    expect(await newOnlyWorker.runOnce()).toBe(1);
    expect(await durlo.runs.get(rollbackRun.run)).toMatchObject({ status: "completed" });
  });
});
