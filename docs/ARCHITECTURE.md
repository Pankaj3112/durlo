# Durlo Architecture

Status: Draft
Date: 2026-07-08

Answers: **How is the code organized?**

This document describes module boundaries for the v1 implementation. It does not define public API details, execution guarantees, database schema, or exact adapter method signatures.

V1 architecture is task/workflow-first. Events are out of scope until after the core worker, storage, retries, and dashboard are stable.

## Package Layout

V1 packages:

```txt
@durlo/core
@durlo/postgres
durlo CLI
```

`@durlo/core` owns public TypeScript APIs and runtime orchestration.

`@durlo/postgres` owns Postgres persistence.

The CLI wires project files, migrations, local worker, and local dashboard.

## Core Modules

Recommended `@durlo/core` internal modules:

```txt
client/
tasks/
workflows/
steps/
runs/
worker/
retry/
serialization/
config/
adapter/
errors/
validation/
```

### `client`

Builds the `Durlo` class.

Responsibilities:

- store app id and adapter
- expose `task(...)`
- expose `workflow(...)`
- expose `runs`
- expose `tx(...)`
- expose `worker(...)`

### `tasks`

Builds task definition objects.

Responsibilities:

- hold task metadata
- hold task run function
- expose `enqueue(...)`
- expose `batchEnqueue(...)`
- provide input/output types

### `workflows`

Builds workflow definition objects.

Responsibilities:

- hold workflow metadata
- hold workflow run function
- expose `start(...)`
- create workflow execution context

### `steps`

Implements workflow step tools.

Responsibilities:

- `step.run(...)`
- `step.sleep(...)`
- `step.sleepUntil(...)`
- read completed step checkpoints
- persist new step results
- create timers for sleeps

### `runs`

Implements run management APIs.

Responsibilities:

- `runs.get(...)`
- `runs.cancel(...)`
- `runs.retry(...)`
- map adapter records to public run objects

### `worker`

Runs tasks and workflows.

Responsibilities:

- register task and workflow definitions
- claim due work
- reclaim expired leases
- execute user code
- manage leases
- call retry logic
- persist completion/failure
- graceful shutdown
- reject stale completion when a lease token is lost

### `retry`

Computes retry decisions.

Responsibilities:

- normalize retry policies
- calculate next retry time
- apply fixed/exponential backoff
- apply jitter

### `serialization`

Converts values for durable storage.

Responsibilities:

- serialize inputs
- serialize outputs
- serialize errors
- deserialize stored step results
- reject unsupported non-JSON values before persistence where possible

### `adapter`

Defines internal adapter interfaces consumed by core.

Responsibilities:

- keep core independent from Postgres implementation
- define records and transition inputs
- expose transaction-bound adapter shape
- carry lease tokens through claim, extend, complete, and fail operations

### `validation`

Validates API inputs before persistence.

Responsibilities:

- task/workflow ids
- step ids
- duration strings
- retry options
- idempotency key length
- mutually exclusive options like `delay` and `runAt`
- JSON-serializability of inputs before run creation

## Postgres Package

`@durlo/postgres` implements the adapter contract.

Suggested modules:

```txt
connection/
migrations/
runs/
steps/
timers/
attempts/
transactions/
dashboard-reads/
lease-reclaim/
```

The Postgres package should not import user task/workflow code.

It should only know durable records and state transitions.

The Postgres package is responsible for making state transitions atomic. In particular, it must enforce lease-token ownership when extending, completing, failing, or cancelling running work.

## CLI

CLI commands:

```txt
durlo init
durlo dev
durlo worker
```

`init` creates starter files.

`dev` should:

- load config
- run migrations
- start worker
- start dashboard
- print URLs and status

`worker` should:

- load config
- import registered task/workflow files
- start the worker process

## Registration Model

Task and workflow definitions are regular module exports.

Example:

```ts
export const sendWelcomeEmail = durlo.task({ ... });
export const onboarding = durlo.workflow({ ... });
```

The worker receives explicit arrays:

```ts
durlo.worker({
  tasks: [sendWelcomeEmail],
  workflows: [onboarding],
});
```

Core builds a registry:

```txt
kind + resource id -> definition
```

If storage contains a run whose resource id is not registered in the current worker, that worker must not claim it.

V1 has no automatic code discovery in production. The worker gets explicit arrays so bundlers and deployments stay predictable.

## Execution Flow

Task flow:

```txt
application calls task.enqueue
core validates input
adapter creates run
worker claims run
core calls task run function
adapter stores completion or failure
```

Workflow flow:

```txt
application calls workflow.start
core validates input
adapter creates run
worker claims run
core calls workflow run function with step tools
step tools read/write checkpoints and timers
adapter stores completion, sleep, retry, or failure
```

Sleep resume:

```txt
workflow calls step.sleep
adapter creates timer and marks run sleeping
worker stops executing run
later worker fires due timer
run becomes pending
worker claims run again
workflow code re-enters and completed steps are skipped
```

Expired lease reclaim:

```txt
worker claims run with lease token A
worker crashes or stops renewing lease
locked_until passes
another worker locks the expired row
previous attempt is marked stalled
run is either terminally failed or claimed with lease token B
old worker writes using token A are rejected
```

## Dashboard Boundary

The dashboard reads durable state.

It should not execute user code.

It can use adapter read APIs to show:

- runs
- run status
- input/output
- errors
- steps
- attempts
- timers

Manual actions like cancel and retry should call core run APIs or a small command layer that uses the adapter safely.

## Error Boundary

User code errors must be caught by the worker.

Core is responsible for:

- serializing the error
- recording attempt failure
- applying retry policy
- updating run status

Unexpected internal errors should fail the attempt if the run was already claimed, or be logged and retried by the worker loop if no run was claimed.

## Concurrency Boundary

Worker `concurrency` is process-local. It limits how many runs a single worker instance executes at once.

V1 does not provide distributed concurrency limits across all workers, tenants, queues, or resource ids. Custom queues and distributed concurrency are future features.

Sleeping workflows and delayed runs do not consume worker concurrency. They become eligible again through `scheduled_at` or timer firing and must be claimed like any other pending run.

## Durable Code Boundary

Durlo does not run a Temporal-style replay engine. Workflow functions are re-entered after sleep, retry, or crash, and completed steps are skipped by reading stored checkpoints.

Core must make the following developer footguns explicit in docs and runtime validation:

- Step ids must be stable.
- Duplicate step ids in one run are errors.
- Nested `step.*` calls inside `step.run(...)` are errors.
- Mutating outer variables inside `step.run(...)` is unsafe.
- External side effects outside `step.run(...)` may repeat.

## Out Of Scope For V1

- Events
- Cron
- Hosted cloud
- Multi-database adapters
- Serverless framework adapters
- Distributed autoscaling
- Visual workflow builder
- Temporal-style deterministic replay
