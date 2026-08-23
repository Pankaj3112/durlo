import type { TaskContext, TaskDefinition, WorkflowContext, WorkflowDefinition } from "./types.js";

type TaskRegistration = {
  run(input: unknown, context: TaskContext): Promise<unknown>;
};

type WorkflowRegistration = {
  run(context: WorkflowContext<unknown>): Promise<unknown>;
};

const taskRegistrations = new WeakMap<object, TaskRegistration>();
const workflowRegistrations = new WeakMap<object, WorkflowRegistration>();

export function registerTaskDefinition<TInput, TOutput, THandlerInput>(
  definition: TaskDefinition<TInput, TOutput, THandlerInput>,
  registration: TaskRegistration
): void {
  taskRegistrations.set(definition, registration);
}

export function registerWorkflowDefinition<TInput, TOutput, THandlerInput>(
  definition: WorkflowDefinition<TInput, TOutput, THandlerInput>,
  registration: WorkflowRegistration
): void {
  workflowRegistrations.set(definition, registration);
}

export function getTaskRegistration(definition: object): TaskRegistration | undefined {
  return taskRegistrations.get(definition);
}

export function getWorkflowRegistration(definition: object): WorkflowRegistration | undefined {
  return workflowRegistrations.get(definition);
}
