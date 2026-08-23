import type { Durlo, WorkerOptions } from "@durlo/core";

type TaskDefinitionReference = {
  readonly id: string;
  readonly version: string;
  readonly kind: "task";
};
type WorkflowDefinitionReference = {
  readonly id: string;
  readonly version: string;
  readonly kind: "workflow";
};

export type DashboardOptions = {
  host?: string;
  port?: number;
};

export type DurloConfig = {
  durlo: Durlo;
  tasks?: readonly TaskDefinitionReference[];
  workflows?: readonly WorkflowDefinitionReference[];
  worker?: Omit<WorkerOptions, "tasks" | "workflows">;
  dashboard?: DashboardOptions;
};

export type LoadedDurloConfig = {
  config: DurloConfig;
  path: string;
};

export type CliIo = {
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export type RunCliOptions = Partial<CliIo>;
