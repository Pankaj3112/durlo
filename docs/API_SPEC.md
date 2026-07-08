# Durlo API Spec

Status: Draft
Date: 2026-07-08

Answers: **What does the user import and call?**

Does not define execution guarantees, database schema, adapter methods, or code architecture.

Durlo v1 is task-first:

```txt
task.enqueue(input)
workflow.start(input)
```

Events are not in the v1 public API.
V1 has no `durlo.send(...)`, `createFunction(...)`, or event trigger registration.

## Install

```bash
npm install @durlo/core @durlo/postgres
```

```bash
npx durlo init
npx durlo dev
npx durlo worker
```

## Imports

```ts
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
```

No default import is required for v1.

## Client

```ts
// src/durlo/client.ts
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

export const durlo = new Durlo({
  id: "my-app",
  adapter: postgresAdapter({
    connectionString: process.env.DATABASE_URL!,
  }),
});
```

```ts
new Durlo({
  id: string;
  adapter: DurloAdapter;
  logger?: Logger | false;
  defaultRetry?: RetryPolicy;
  defaultTimeout?: DurationInput;
});
```

Default retry policy:

```ts
{
  attempts: 3,
  backoff: { type: "exponential", delay: "10s", factor: 2, jitter: 0.2 }
}
```

`attempts` includes the first attempt.

## Tasks

Use tasks for direct background jobs.

```ts
// src/durlo/tasks.ts
import { durlo } from "./client";

export const sendWelcomeEmail = durlo.task({
  id: "send-welcome-email",
  run: async (input: { userId: string; email: string }) => {
    await emails.sendWelcome(input.email);
  },
});
```

```ts
const handle = await sendWelcomeEmail.enqueue(
  { userId: "user_123", email: "a@example.com" },
  {
    idempotencyKey: "welcome-email:user_123",
    attempts: 3,
    backoff: { type: "exponential", delay: "30s" },
  }
);
```

Public calls:

```ts
durlo.task({
  id: string;
  name?: string;
  schema?: StandardSchema<TInput>;
  retry?: RetryPolicy;
  timeout?: DurationInput;
  run: (input: TInput, ctx: TaskContext) => Promise<TOutput> | TOutput;
});

task.enqueue(input, options?) => Promise<RunHandle<TOutput>>;
task.batchEnqueue(items) => Promise<Array<RunHandle<TOutput>>>;
```

Task context:

```ts
type TaskContext = {
  run: RunContext;
  attempt: AttemptContext;
  signal: AbortSignal;
};
```

Batch input:

```ts
type BatchItem<TInput> = {
  input: TInput;
  options?: RunOptions;
};

task.batchEnqueue(items: Array<TInput | BatchItem<TInput>>) => Promise<Array<RunHandle<TOutput>>>;
```

## Workflows

Use workflows for direct durable multi-step jobs.

```ts
// src/durlo/workflows.ts
import { durlo } from "./client";

export const onboarding = durlo.workflow({
  id: "onboarding",
  run: async ({ input, step }: { input: { userId: string; email: string } }) => {
    await step.run("send-welcome-email", () => emails.sendWelcome(input.email));
    await step.sleep("wait-7-days", "7d");

    const activated = await step.run("check-activation", () => {
      return users.isActivated(input.userId);
    });

    if (!activated) {
      await step.run("send-reminder-email", () => emails.sendReminder(input.email));
    }
  },
});
```

```ts
const handle = await onboarding.start({
  userId: "user_123",
  email: "a@example.com",
});
```

Public calls:

```ts
durlo.workflow({
  id: string;
  name?: string;
  schema?: StandardSchema<TInput>;
  retry?: RetryPolicy;
  timeout?: DurationInput;
  run: (ctx: WorkflowContext<TInput>) => Promise<TOutput> | TOutput;
});

workflow.start(input, options?) => Promise<RunHandle<TOutput>>;
```

Workflow context:

```ts
type WorkflowContext<TInput> = {
  input: TInput;
  step: StepTools;
  run: RunContext;
  attempt: AttemptContext;
  signal: AbortSignal;
};
```

## Steps

Available inside workflow `run`.

```ts
await step.run("step-id", async () => result);
await step.sleep("wait-7-days", "7d");
await step.sleepUntil("trial-ends", trialEndsAt);
```

```ts
step.run<T>(id, fn) => Promise<T>;
step.sleep(id, duration) => Promise<void>;
step.sleepUntil(id, date) => Promise<void>;
```

Step rules:

- Step IDs must be stable and unique within a workflow run.
- Duplicate step IDs in one run are a runtime error in v1.
- `step.*` calls inside a `step.run(...)` callback are a runtime error in v1.
- Do not mutate outer variables inside `step.run(...)`; return data from the step and assign it outside the callback.
- Branching should depend on workflow input or persisted step results, not fresh non-durable reads.

## Run Options

Used by `task.enqueue(...)` and `workflow.start(...)`.

```ts
type RunOptions = {
  delay?: DurationInput;
  runAt?: Date | string | number;
  attempts?: number;
  backoff?: BackoffPolicy;
  idempotencyKey?: string;
  priority?: number;
  timeout?: DurationInput;
};

type RetryPolicy = {
  attempts?: number;
  backoff?: BackoffPolicy;
};

type BackoffPolicy =
  | { type: "fixed"; delay: DurationInput; jitter?: number }
  | { type: "exponential"; delay: DurationInput; factor?: number; maxDelay?: DurationInput; jitter?: number };

type DurationInput = number | string;
```

Docs should prefer compact duration strings: `"100ms"`, `"30s"`, `"10m"`, `"2h"`, `"7d"`.

Validation rules:

- `delay` and `runAt` are mutually exclusive.
- `attempts` must be an integer from `1` to `100` in v1.
- `priority` must be an integer from `-1000` to `1000`; higher values run first among eligible rows.
- `jitter` must be between `0` and `1`.
- `idempotencyKey` must be non-empty and at most `2048` characters.
- Inputs, outputs, step results, and errors must be JSON-serializable by Durlo's serializer.

`DurationInput` numbers are milliseconds. String durations use compact units only: `ms`, `s`, `m`, `h`, `d`.

## Runs

```ts
type RunHandle<TOutput = unknown> = {
  id: string;
  kind: "task" | "workflow";
  resourceId: string;
  __output?: TOutput;
};

type RunContext = {
  id: string;
  kind: "task" | "workflow";
  resourceId: string;
};

type AttemptContext = {
  number: number;
  maxAttempts: number;
};
```

`__output` is compile-time only.

Run statuses:

```ts
type RunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "completed"
  | "failed"
  | "dead_letter"
  | "cancelled";
```

```ts
const run = await durlo.runs.get(handle);
await durlo.runs.cancel(handle, { reason: "user cancelled" });
await durlo.runs.retry(handle);
```

```ts
durlo.runs.get(handleOrId) => Promise<Run<TOutput> | null>;
durlo.runs.cancel(handleOrId, options?) => Promise<void>;
durlo.runs.retry(handleOrId) => Promise<void>;
```

`runs.retry(...)` is valid only for `failed` workflow runs and `dead_letter` task runs in v1. It preserves attempt history.

## Transactions

Transaction-aware calls are available through `durlo.tx(tx)`.

```ts
await db.transaction(async (tx) => {
  const user = await users.create(tx, { email: "a@example.com" });

  await durlo.tx(tx).enqueue(sendWelcomeEmail, {
    userId: user.id,
    email: user.email,
  });

  await durlo.tx(tx).start(onboarding, {
    userId: user.id,
    email: user.email,
  });
});
```

```ts
durlo.tx(tx).enqueue(task, input, options?) => Promise<RunHandle<TOutput>>;
durlo.tx(tx).start(workflow, input, options?) => Promise<RunHandle<TOutput>>;
durlo.tx(tx).batchEnqueue(task, items) => Promise<Array<RunHandle<TOutput>>>;
```

V1 transaction support targets raw `pg` transaction clients. Durlo does not start, commit, or roll back the transaction.

Batch rules:

- `batchEnqueue(...)` is atomic.
- Returned handles preserve item order.
- Duplicate idempotency keys inside the same batch are a validation error in v1.
- If any item fails validation or persistence, no new runs are created.

## Worker

```ts
// src/durlo/worker.ts
import { durlo } from "./client";
import { sendWelcomeEmail } from "./tasks";
import { onboarding } from "./workflows";

await durlo.worker({
  tasks: [sendWelcomeEmail],
  workflows: [onboarding],
  concurrency: 10,
  pollInterval: "1s",
  leaseDuration: "30s",
}).start();
```

```ts
const worker = durlo.worker({
  tasks?: Task<any, any>[];
  workflows?: Workflow<any, any>[];
  concurrency?: number;
  pollInterval?: DurationInput;
  leaseDuration?: DurationInput;
  workerId?: string;
  shutdownTimeout?: DurationInput;
});

await worker.start();
await worker.stop();
```

Worker option defaults:

```ts
{
  concurrency: 10,
  pollInterval: "1s",
  leaseDuration: "30s",
  shutdownTimeout: "30s"
}
```

Worker `concurrency` is process-local. It is not a distributed concurrency limit across all workers, tasks, tenants, or resource IDs.

Workers claim only registered task/workflow resource IDs. If a row references an unregistered resource, the worker skips it.

## CLI Config

`npx durlo init` creates:

```txt
durlo.config.ts
src/durlo/client.ts
src/durlo/tasks.ts
src/durlo/workflows.ts
src/durlo/worker.ts
```

```ts
import { defineDurloConfig } from "@durlo/core";

export default defineDurloConfig({
  client: "./src/durlo/client.ts",
  tasks: "./src/durlo/tasks.ts",
  workflows: "./src/durlo/workflows.ts",
});
```

## Public Naming

Use:

- `Durlo`
- `durlo`
- `durlo.task(...)`
- `task.enqueue(...)`
- `durlo.workflow(...)`
- `workflow.start(...)`
- `step.run(...)`
- `step.sleep(...)`
- `durlo.runs.get(...)`
- `durlo.tx(tx).enqueue(...)`
- `durlo.worker(...).start()`

Do not use in v1:

- `createDurable(...)`
- `createTask(...)`
- `createFunction(...)`
- `trigger(...)`
- `sendEvent(...)`
- `eventType(...)`
- `durlo.send(...)`
- `jobId`
