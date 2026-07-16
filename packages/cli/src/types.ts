import type {
  Durlo,
  RegisteredTaskDefinition,
  RegisteredWorkflowDefinition,
  WorkerOptions
} from "@durlo/core";

export type DashboardOptions = {
  host?: string;
  port?: number;
};

export type DurloConfig = {
  durlo: Durlo;
  tasks?: readonly RegisteredTaskDefinition[];
  workflows?: readonly RegisteredWorkflowDefinition[];
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
