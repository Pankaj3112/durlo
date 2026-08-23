import type { TaskContext, TaskDefinition, WorkflowContext, WorkflowDefinition } from "./types.js";
import { privateRegistry } from "./private-registry.js";

type TaskRegistration = {
  run(input: unknown, context: TaskContext): Promise<unknown>;
};

type WorkflowRegistration = {
  run(context: WorkflowContext<unknown>): Promise<unknown>;
};

export function registerTaskDefinition<TInput, TOutput, THandlerInput>(
  definition: TaskDefinition<TInput, TOutput, THandlerInput>,
  registration: TaskRegistration
): void {
  privateRegistry.taskRegistrations.set(definition, registration);
}

export function registerWorkflowDefinition<TInput, TOutput, THandlerInput>(
  definition: WorkflowDefinition<TInput, TOutput, THandlerInput>,
  registration: WorkflowRegistration
): void {
  privateRegistry.workflowRegistrations.set(definition, registration);
}

export function getTaskRegistration(definition: object): TaskRegistration | undefined {
  return privateRegistry.taskRegistrations.get(definition) as TaskRegistration | undefined;
}

export function getWorkflowRegistration(definition: object): WorkflowRegistration | undefined {
  return privateRegistry.workflowRegistrations.get(definition) as WorkflowRegistration | undefined;
}
