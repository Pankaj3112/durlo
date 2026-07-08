# Durlo Build Slices

Keep v1 small: direct tasks, direct workflows, Postgres storage, local worker.
Events, cron, distributed concurrency, and framework adapters wait.

## 1. Repo Foundation

Create the monorepo, packages, TypeScript config, test runner, linting, and public exports.

Done when: packages build and a smoke test imports `@durlo/core`.

## 2. Core API

Implement `Durlo`, `durlo.task(...)`, `durlo.workflow(...)`, run handles, option validation, retry normalization, and serialization.

Done when: tasks/workflows can be defined and validated without Postgres.

## 3. Postgres Adapter

Add migrations, run creation, idempotency, batch enqueue, and transaction-bound enqueue/start.

Done when: runs can be inserted atomically with raw `pg` transactions.

## 4. Worker And Tasks

Build polling, claim with `lease_token`, lease extension, task execution, completion, failure, retries, and expired-lease reclaim.

Done when: a crashed worker cannot strand or stale-complete a task.

## 5. Workflow Steps

Add `workflow.start(...)`, `step.run(...)`, checkpoint reads/writes, duplicate step guards, and nested step guards.

Done when: completed steps are not re-run after worker restart.

## 6. Timers And Run Controls

Add `step.sleep(...)`, `step.sleepUntil(...)`, timer firing, sleeping resume, cancellation, and manual retry.

Done when: workflows can sleep, resume, cancel, and retry correctly.

## 7. CLI, Dashboard, Demo

Add `durlo init`, `durlo dev`, local dashboard, retry/cancel actions, examples, and the demo app.

Done when: a new user can run the quickstart and inspect a full workflow timeline.
