import { Durlo } from "@durlo/core";
import type {
  BatchItem,
  RunHandle,
  StandardSchema,
  TaskDefinitionOptions,
  WorkflowDefinitionOptions
} from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

type ExternalInput = { raw: string };
type HandlerInput = { normalized: string };

const adapter = postgresAdapter({ connectionString: "postgres://unused" });
const durlo = new Durlo({ id: "schema-type-test", adapter });
const schema: StandardSchema<ExternalInput, HandlerInput> = {
  "~standard": {
    version: 1,
    vendor: "type-test",
    validate: (input) => {
      const external = input as ExternalInput;
      return { value: { normalized: external.raw.trim() } };
    }
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

const typedTaskOptions: TaskDefinitionOptions<{ id: string }, number> = {
  id: "typed-options-task",
  run: async (input) => input.id.length
};
const typedWorkflowOptions: WorkflowDefinitionOptions<{ id: string }, number> = {
  id: "typed-options-workflow",
  run: async ({ input }) => input.id.length
};
const typedTask = durlo.task(typedTaskOptions);
const typedWorkflow = durlo.workflow(typedWorkflowOptions);
const typedTaskHandle: Promise<RunHandle<number>> = typedTask.enqueue({ id: "typed" });
const typedWorkflowHandle: Promise<RunHandle<number>> = typedWorkflow.start({ id: "typed" });

const inferredSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "inference-test",
    types: {
      input: undefined as unknown as ExternalInput,
      output: undefined as unknown as HandlerInput
    },
    validate: (input: unknown) => ({
      value: { normalized: (input as ExternalInput).raw.trim() }
    })
  }
};
const inferredTask = durlo.task({
  id: "inferred-task",
  schema: inferredSchema,
  run: async (input) => input.normalized
});
const inferredWorkflow = durlo.workflow({
  id: "inferred-workflow",
  schema: inferredSchema,
  run: async ({ input }) => input.normalized.length
});
const inferredTaskHandle: Promise<RunHandle<string>> = inferredTask.enqueue(external);
const inferredTaskBatch: Promise<Array<RunHandle<string>>> = inferredTask.batchEnqueue([external]);
const inferredWorkflowHandle: Promise<RunHandle<number>> = inferredWorkflow.start(external);
// @ts-expect-error inferred Standard Schema input remains the external input type.
void inferredTask.enqueue({ normalized: "wrong boundary" });
// @ts-expect-error inferred Standard Schema input remains the external input type.
void inferredWorkflow.start({ normalized: "wrong boundary" });
void durlo.transaction(async (transaction) => {
  const inferredTransactionTask: Promise<RunHandle<string>> = transaction.enqueue(
    inferredTask,
    external
  );
  const inferredTransactionBatch: Promise<Array<RunHandle<string>>> = transaction.batchEnqueue(
    inferredTask,
    [external]
  );
  await Promise.all([inferredTransactionTask, inferredTransactionBatch]);
});

void taskHandle;
void taskBatch;
void workflowHandle;
void plainHandle;
void typedTaskHandle;
void typedWorkflowHandle;
void inferredTaskHandle;
void inferredTaskBatch;
void inferredWorkflowHandle;
void adapter;
