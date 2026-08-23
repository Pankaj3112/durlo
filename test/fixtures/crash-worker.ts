import { Durlo } from "../../packages/core/src/index.js";
import { postgresAdapter } from "../../packages/postgres/src/adapter.js";

const databaseUrl = requiredEnvironment("DURLO_TEST_DATABASE_URL");
const mode = requiredEnvironment("DURLO_FAULT_MODE");
const appId = process.env.DURLO_FAULT_APP_ID ?? "fault-tests";
const resourceId = requiredEnvironment("DURLO_FAULT_RESOURCE_ID");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`fault worker requires ${name}`);
  return value;
}

const forever = new Promise<never>(() => undefined);

function checkpoint(name: string): void {
  process.stdout.write(`${name}\n`);
}

async function main(): Promise<void> {
  const adapter = postgresAdapter({ connectionString: databaseUrl });

  if (mode === "after-claim") {
    const claimed = await adapter.claimRuns({
      appId,
      workerId: "crashed-worker",
      limit: 1,
      leaseDuration: 30_000,
      resources: [{ kind: "task", resourceId }]
    });
    if (claimed.length !== 1) throw new Error("fault worker could not claim the target run");
    checkpoint("CLAIMED");
    await forever;
  }

  const durlo = new Durlo({ id: appId, adapter });
  if (mode === "after-side-effect") {
    const task = durlo.task({
      id: resourceId,
      run: async (_input: unknown, { run }) => {
        await adapter.pool.query(
          "insert into durlo_test_effects (run_id, phase) values ($1, 'side-effect')",
          [run.id]
        );
        checkpoint("SIDE_EFFECT");
        await forever;
      }
    });
    await durlo
      .worker({ tasks: [task], workerId: "crashed-worker", leaseDuration: 30_000 })
      .runOnce();
    return;
  }

  if (mode === "after-checkpoint") {
    const workflow = durlo.workflow({
      id: resourceId,
      run: async ({ run, step }) => {
        await step.run("durable-step", async () => {
          await adapter.pool.query(
            "insert into durlo_test_effects (run_id, phase) values ($1, 'checkpoint')",
            [run.id]
          );
          return "checkpointed";
        });
        checkpoint("CHECKPOINTED");
        await forever;
      }
    });
    await durlo
      .worker({ workflows: [workflow], workerId: "crashed-worker", leaseDuration: 30_000 })
      .runOnce();
    return;
  }

  throw new Error(`unknown fault mode '${mode}'`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
