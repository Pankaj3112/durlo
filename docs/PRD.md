# PRD: TypeScript-Native Durable Async for Postgres

Status: Draft
Date: 2026-07-08

## 1. Product Summary

Build a TypeScript-native durable async library that lets developers run background jobs, delayed work, retries, and simple multi-step workflows using their existing Postgres database.

The v1 product should feel like:

```txt
Trigger.dev/BullMQ task ergonomics + Inngest-style step tools + Postgres-only infrastructure
```

Durlo v1 is not trying to replace Temporal. It replaces the common stack of:

```txt
BullMQ + Redis + cron + retry tables + ad-hoc workflow state
```

with:

```txt
TypeScript app + Postgres + Durlo worker + local dashboard
```

The v1 API is task/workflow-first. Event ingestion and event-triggered workflows are intentionally deferred.

## 2. Target User

Primary user:

- TypeScript backend developer
- Already uses Postgres
- Building a SaaS, internal tool, AI product, or B2B app
- Currently using BullMQ, cron jobs, custom job tables, or one-off retry code
- Does not want to deploy Redis, Temporal, Inngest, or another workflow platform

Secondary user:

- Next.js, Express, Fastify, Hono, or NestJS developer
- Wants simple background jobs and delayed tasks
- May later need multi-step durable workflows

## 3. Core Problem

Developers need reliable async execution for common app workflows:

- Send emails after signup
- Retry failed webhooks
- Schedule reminders
- Run AI jobs in the background
- Process uploaded files
- Wait a few days, then check state
- Cancel scheduled work when business state changes

Today they often use BullMQ + Redis, which creates extra infrastructure and a split-brain state model:

```txt
Postgres stores business data.
Redis stores job state.
App code must keep both consistent.
```

The biggest pain is the dual-write problem:

```ts
await db.user.create(...);
await queue.add("send-welcome-email", { userId });
```

If the DB write succeeds but queue enqueue fails, the business object exists without the async job.

## 4. Product Goal

Create the easiest way for TypeScript developers to add durable background jobs, delays, retries, and simple workflows to a Postgres-backed app.

V1 success means a developer can:

1. Install the package.
2. Connect Postgres.
3. Define a task or workflow.
4. Enqueue/start it from app code, optionally inside the same Postgres transaction as business data.
5. Run a worker locally.
6. See runs, steps, failures, retries, delayed jobs, and sleeping workflows in a local dashboard.
7. Deploy the worker as a normal Node process.

## 5. Non-Goals for V1

Do not build these in v1:

- Event ingestion or `durlo.send(...)`
- Event-triggered workflows
- Cron schedules
- Multi-database adapters
- Hosted cloud platform
- Visual workflow builder
- Complex DAG editor
- Full Temporal-style deterministic replay engine
- Multi-language SDKs
- Advanced human approval flows
- Distributed worker autoscaling
- Distributed per-task or per-tenant concurrency limits
- Enterprise RBAC
- Advanced multi-tenant dashboard
- Postgres extension
- Mandatory `LISTEN/NOTIFY`
- NestJS-specific primary API
- Kubernetes operator
- Billing or monetization

## 6. Positioning

Primary positioning:

> Durable background jobs, delays, and simple workflows for TypeScript apps, powered by Postgres.

Sharper positioning:

> Replace BullMQ, Redis, retry tables, and simple workflow glue with one TypeScript-native Postgres async layer.

The v1 product should be sold as a practical async layer, not as an academic durable execution framework.

## 7. V1 Scope

V1 includes two public primitives:

### 7.1 Tasks

Developers can enqueue direct background jobs.

```ts
export const sendWelcomeEmail = durlo.task({
  id: "send-welcome-email",
  run: async (input: { userId: string; email: string }) => {
    await emails.sendWelcome(input.email);
  },
});

await sendWelcomeEmail.enqueue(
  { userId: user.id, email: user.email },
  {
    idempotencyKey: `welcome-email:${user.id}`,
    attempts: 3,
    backoff: { type: "exponential", delay: "30s" },
  }
);
```

Tasks support:

- Immediate execution
- Delayed execution
- Retries
- Dead-letter status after automatic attempts are exhausted
- Idempotency key
- Manual retry from dashboard
- Cancellation before future execution

### 7.2 Simple Workflows

Developers can define direct multi-step durable jobs.

```ts
export const onboarding = durlo.workflow({
  id: "onboarding",
  run: async ({ input, step }) => {
    await step.run("send-welcome-email", async () => {
      await emails.sendWelcome(input.email);
    });

    await step.sleep("wait-7-days", "7d");

    const activated = await step.run("check-activation", async () => {
      return users.isActivated(input.userId);
    });

    if (!activated) {
      await step.run("send-reminder-email", async () => {
        await emails.sendReminder(input.email);
      });
    }
  },
});

await onboarding.start({
  userId: user.id,
  email: user.email,
});
```

Supported workflow features in v1:

- Step checkpointing
- Workflow-level retries
- Sleep/delay
- Resume after worker crash
- Final success/failure state
- Best-effort cancellation
- Execution timeline in dashboard

Not supported in v1:

- Event triggers
- Signals
- Waiting for external events
- Child workflows
- Parallel fan-out
- Compensation/sagas
- Cron workflows
- Complex deterministic replay
- Step-specific retry overrides

## 8. Developer Experience

The v1 quickstart should be the product's main feature.

### 8.1 Install

```bash
npm install @durlo/core @durlo/postgres
```

### 8.2 Initialize

```bash
npx durlo init
```

This creates:

```txt
durlo.config.ts
src/durlo/client.ts
src/durlo/tasks.ts
src/durlo/workflows.ts
src/durlo/worker.ts
```

### 8.3 Create Client

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

### 8.4 Define Work

```ts
// src/durlo/tasks.ts
import { durlo } from "./client";

export const helloEmail = durlo.task({
  id: "hello-email",
  run: async (input: { email: string }) => {
    await emails.send(input.email, "Hello from Durlo");
  },
});
```

```ts
// src/durlo/workflows.ts
import { durlo } from "./client";

export const helloWorkflow = durlo.workflow({
  id: "hello-workflow",
  run: async ({ input, step }: { input: { email: string } }) => {
    await step.sleep("wait-1-second", "1s");

    return step.run("send-email", async () => {
      await emails.send(input.email, "Hello from Durlo");
      return { sent: true };
    });
  },
});
```

### 8.5 Run Worker Locally

```bash
npx durlo dev
```

This should:

- Check database connection
- Apply migrations
- Start local worker
- Start local dashboard
- Show dashboard URL

Example output:

```txt
Durlo dev server running

Dashboard: http://localhost:8288
Worker: active
Database: connected
Tasks: 1 registered
Workflows: 1 registered
```

### 8.6 Enqueue Work

```ts
await helloEmail.enqueue({ email: "test@example.com" });

await helloWorkflow.start({
  email: "test@example.com",
});
```

### 8.7 Inspect Run

Dashboard should show:

```txt
Run: hello-workflow
Status: completed

Timeline:
run started
sleep wait-1-second
step send-email
workflow completed
```

## 9. Required API Surface

### 9.1 Core Client

```ts
const durlo = new Durlo({
  id: "my-app",
  adapter,
});
```

### 9.2 Task

```ts
const sendEmail = durlo.task({
  id: "send-email",
  run: async (input) => {
    await emails.send(input);
  },
});

await sendEmail.enqueue(input, {
  delay: "10m",
  attempts: 3,
  idempotencyKey: "welcome-email:user_123",
});
```

### 9.3 Workflow

```ts
const onboarding = durlo.workflow({
  id: "onboarding",
  run: async ({ input, step }) => {
    await step.run("send-welcome-email", async () => {
      await emails.sendWelcome(input.email);
    });

    await step.sleep("wait-7-days", "7d");
  },
});

await onboarding.start(input);
```

### 9.4 Step Run

```ts
const result = await step.run("step-id", async () => {
  return value;
});
```

Behavior:

- Step result is persisted after success.
- If workflow resumes, completed step is not re-executed.
- If a worker crashes after the side effect but before the result is persisted, the step may run again.
- Step IDs must be stable and unique within a workflow run.

### 9.5 Step Sleep

```ts
await step.sleep("sleep-id", "3d");
await step.sleepUntil("sleep-until-id", date);
```

Behavior:

- Workflow pauses.
- Timer is persisted in Postgres.
- Worker releases the run while sleeping.
- Worker resumes at or after the due time.

### 9.6 Worker

```ts
await durlo.worker({
  tasks,
  workflows,
  concurrency: 10,
}).start();
```

CLI equivalent:

```bash
npx durlo worker
```

## 10. Postgres Requirements

V1 should use normal Postgres tables.

No Postgres extension required.

No superuser permission required.

No mandatory `LISTEN/NOTIFY`.

Base mode should work with:

- Local Postgres
- Supabase Postgres
- Neon Postgres
- Railway Postgres
- RDS Postgres
- Render Postgres
- PgBouncer transaction pooling

Optional future optimization:

- `LISTEN/NOTIFY` for faster wakeups when PgBouncer/session constraints allow it

## 11. Storage Model

Minimum tables:

```txt
durlo_schema_migrations
durlo_runs
durlo_steps
durlo_timers
durlo_attempts
```

Tasks and workflows share `durlo_runs`. V1 does not have separate event, queue, or lock tables.

### 11.1 `durlo_runs`

Stores task and workflow execution.

Required concepts:

```txt
id
app_id
kind
resource_id
status
input_json
output_json
error_json
options_json
idempotency_key
priority
scheduled_at
attempt_count
max_attempts
locked_by
lease_token
locked_until
stalled_count
created_at
updated_at
started_at
completed_at
cancelled_at
```

Statuses:

```txt
pending
running
sleeping
completed
failed
dead_letter
cancelled
```

### 11.2 `durlo_steps`

Stores workflow step checkpoints.

Statuses:

```txt
pending
running
completed
failed
```

### 11.3 `durlo_timers`

Stores workflow sleep timers.

Statuses:

```txt
pending
fired
cancelled
```

### 11.4 `durlo_attempts`

Stores append-only run and step attempt history for dashboard/debugging.

Statuses:

```txt
running
succeeded
failed
timed_out
stalled
cancelled
```

## 12. Worker Behavior

The worker should:

1. Poll for due pending runs.
2. Reclaim expired running runs whose leases were not renewed.
3. Poll for due timers.
4. Claim work using lease-based locking.
5. Execute the task or workflow.
6. Persist step results.
7. Retry failures based on retry policy.
8. Move exhausted tasks to `dead_letter`.
9. Move exhausted workflows to `failed`.
10. Release or extend locks.

Use leases instead of relying on long transactions.

Lease fields:

```txt
locked_by
lease_token
locked_until
```

`lease_token` must be unique per claim. Completion, failure, and lease extension must verify the current token so an old worker cannot finish a run after another worker reclaimed it.

This keeps v1 portable and PgBouncer-friendly.

## 13. Transactional Enqueue

This is a key differentiator.

V1 should support transactional enqueue/start for raw Postgres transactions.

Example:

```ts
await db.transaction(async (tx) => {
  const user = await users.create(tx, { email });

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

For v1, support:

- Raw `pg` transaction client

For soon after v1:

- Prisma
- Drizzle
- Kysely

## 14. Dashboard Requirements

V1 dashboard should be local-first.

Command:

```bash
npx durlo dev
```

Dashboard pages:

### 14.1 Overview

Show:

- Total runs
- Pending
- Running
- Sleeping
- Failed
- Dead-letter
- Completed today

### 14.2 Runs

Show list of task and workflow runs.

Columns:

```txt
Run ID
Kind
Resource
Status
Started
Duration
Error
```

### 14.3 Run Detail

Show timeline:

```txt
run created
run claimed by worker
step send-email completed
sleep wait-7-days until 2026-07-15 10:00
step check-activation pending
```

Required actions:

- Retry failed/dead-letter run
- Cancel run
- Copy run input
- Copy error

### 14.4 Tasks

Show direct task jobs.

Required actions:

- Retry
- Cancel
- View payload
- View error

### 14.5 Workflows

Show workflow runs, step checkpoints, timers, and attempt history.

## 15. Error Handling

Default retry behavior:

```txt
attempts: 3
backoff: exponential
base delay: 10 seconds
jitter: 0.2
```

`attempts` includes the first attempt. `attempts: 3` means one initial execution plus up to two retries.

Task/workflow override:

```ts
durlo.task({
  id: "send-email",
  retry: {
    attempts: 5,
    backoff: { type: "exponential", delay: "30s" },
  },
  run: async (input) => {
    await emails.send(input);
  },
});
```

Run-level override:

```ts
await sendEmail.enqueue(input, {
  attempts: 1,
});
```

Step-level retry override is v1.1, not v1. In v1, `step.run(...)` inherits the workflow run retry policy.

## 16. Idempotency

V1 should support idempotency keys for tasks and workflows.

Example:

```ts
await sendWelcomeEmail.enqueue(
  { userId, email },
  {
    idempotencyKey: `welcome-email:${userId}`,
  }
);
```

Behavior:

- Duplicate idempotency key should not create duplicate work.
- Existing run handle should be returned.
- Scope is `app_id + kind + resource_id + idempotency_key`.
- The key deduplicates run creation, not external side effects.
- V1 has no idempotency TTL. The dedupe window lasts as long as the run row is retained.
- Failed, dead-letter, completed, and cancelled runs retain the key.
- Enqueuing the same work after terminal status requires a different key or a future reset API.

## 17. Framework Support in V1

Core should be framework-independent.

V1 should include examples for:

- Next.js
- Express

Actual package support required in v1:

```txt
@durlo/core
@durlo/postgres
@durlo/cli
```

Nice-to-have in v1:

```txt
@durlo/next
@durlo/express
```

Do not block v1 on every framework adapter.

## 18. Deployment Model

V1 deployment should be simple.

The app has two processes:

```txt
web process
worker process
```

Same codebase, different command.

Example:

```bash
npm run start:web
npm run start:worker
```

Docker example:

```yaml
services:
  web:
    build: .
    command: npm run start:web

  worker:
    build: .
    command: npm run start:worker
```

The worker connects to the same Postgres database.

## 19. V1 Demo App

Build one polished demo app.

Demo flow:

```txt
User signs up
Application creates user and starts onboarding workflow transactionally
Workflow sends welcome email
Workflow sleeps for 1 minute
Workflow checks activation
Workflow sends reminder if not activated
Dashboard shows the full timeline
```

Use a fake email provider in demo to avoid external setup.

## 20. Acceptance Criteria

V1 is shippable when:

1. A new user can install and run the quickstart in under 10 minutes.
2. A task can be enqueued directly.
3. A workflow can be started directly.
4. A delayed task runs after its delay.
5. A workflow can run step, sleep, then resume.
6. A completed step is not re-executed after worker restart.
7. A failed task retries and eventually dead-letters.
8. An exhausted workflow becomes failed.
9. An expired running lease is reclaimed or terminally failed without stranding the run.
10. A stale worker cannot complete a run after losing its lease.
11. Dashboard shows runs, steps, attempts, failures, delayed jobs, and sleeping workflows.
12. Worker can be deployed as a separate Node process.
13. No Redis, Temporal, hosted service, or Postgres extension is required.
14. Core API is TypeScript-native and framework-independent.
15. Transactional enqueue/start works with raw Postgres transactions.

## 21. V1 Milestones

### Milestone 1: Core Storage and Worker

Build:

- Postgres schema
- Migrations
- Task/workflow run insert
- Worker polling
- Lease claiming with unique lease tokens
- Expired lease reclaim
- Retry logic

Result:

- Direct tasks can run reliably.

### Milestone 2: Durable Workflows

Build:

- `durlo.workflow(...)`
- Run records
- Step records
- `step.run`
- Step checkpointing

Result:

- Multi-step workflows can resume without re-running completed steps.

### Milestone 3: Sleep and Timers

Build:

- `step.sleep`
- `step.sleepUntil`
- Timer table
- Timer polling
- Resume sleeping runs

Result:

- Workflows can wait and resume.

### Milestone 4: CLI and Dev Server

Build:

- `npx durlo init`
- `npx durlo dev`
- Auto migrations
- Local dashboard shell

Result:

- Developer can run everything locally.

### Milestone 5: Dashboard

Build:

- Runs list
- Run detail timeline
- Tasks list
- Workflows list
- Retry/cancel actions
- Error details

Result:

- Product becomes inspectable and useful.

### Milestone 6: Quickstart and Demo

Build:

- Next.js quickstart
- Express quickstart
- Demo app
- README
- Deployment guide

Result:

- Product is launchable.

## 22. What Makes This Easier Than Existing Options

V1 should win on:

- No Redis
- No Temporal cluster
- No hosted dependency
- No Postgres extension
- No SQL workflow DSL
- No framework lock-in
- TypeScript-first API
- Inngest-like step ergonomics
- Trigger.dev-like task objects
- BullMQ-like job option vocabulary
- Postgres transactional enqueue/start
- Local dashboard from day one

## 23. V1 Tagline

> Reliable background jobs and simple workflows for TypeScript apps, powered by your Postgres.

## 24. Launch Scope

Launch as open source.

Launch assets:

- GitHub repo
- README with 5-minute quickstart
- Next.js guide
- Express guide
- Demo video or GIF
- Comparison page: vs BullMQ
- Comparison page: vs Inngest
- Comparison page: vs Temporal

Do not launch with cloud hosting yet.

## 25. V2 Ideas

Save these for later:

- Event ingestion and `durlo.send(...)`
- Event-triggered workflows
- Typed event helpers
- Prisma transaction adapter
- Drizzle transaction adapter
- Kysely transaction adapter
- Cron jobs
- Signals
- Wait for external event
- Parallel steps
- Child workflows
- Step-level retry overrides
- Distributed concurrency limits
- Worker queues
- OpenTelemetry
- Hosted dashboard
- Team auth
- Multi-database adapters
- AI-agent workflow helpers
- Human approval steps
- Usage analytics
