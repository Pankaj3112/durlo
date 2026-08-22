import { Durlo } from "@durlo/core";
import type { BatchItem, RunHandle, StandardSchema } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

type ExternalInput = { raw: string };
type HandlerInput = { normalized: string };

const adapter = postgresAdapter({ connectionString: "postgres://unused" });
const durlo = new Durlo({ id: "schema-type-test", adapter });
const schema: StandardSchema<ExternalInput, HandlerInput> = {
  "~standard": {
    version: 1,
    vendor: "type-test",
    validate: (input) => ({ value: { normalized: input.raw.trim() } })
  }
};

const task = durlo.task({
  id: "transforming-task",
  schema,
  run: async (input: HandlerInput) => input.normalized
});
const workflow = durlo.workflow({
  id: "transforming-workflow",
  schema,
  run: async ({ input }) => input.normalized.length
});

const external: ExternalInput = { raw: " value " };
const taskHandle: Promise<RunHandle<string>> = task.enqueue(external);
const taskBatch: Promise<Array<RunHandle<string>>> = task.batchEnqueue([
  external,
  { input: external, options: { priority: 1 } } satisfies BatchItem<ExternalInput>
]);
const workflowHandle: Promise<RunHandle<number>> = workflow.start(external);

// @ts-expect-error enqueue accepts the external schema input, not the transformed handler input.
void task.enqueue({ normalized: "wrong boundary" });
// @ts-expect-error workflow.start accepts the external schema input, not the transformed input.
void workflow.start({ normalized: "wrong boundary" });

void durlo.transaction(async (transaction) => {
  const transactionTask: Promise<RunHandle<string>> = transaction.enqueue(task, external);
  const transactionWorkflow: Promise<RunHandle<number>> = transaction.start(workflow, external);
  const transactionBatch: Promise<Array<RunHandle<string>>> = transaction.batchEnqueue(task, [
    external,
    { input: external }
  ]);
  await Promise.all([transactionTask, transactionWorkflow, transactionBatch]);
});

const plainTask = durlo.task({
  id: "plain-task",
  run: async (input: { id: string }) => input.id.length
});
const plainHandle: Promise<RunHandle<number>> = plainTask.enqueue({ id: "plain" });

void taskHandle;
void taskBatch;
void workflowHandle;
void plainHandle;
void adapter;
