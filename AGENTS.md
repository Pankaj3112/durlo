# Coding gotchas

- Durlo is at-least-once. A handler can perform an external effect and crash before completion is
  saved; use business/provider idempotency for emails, payments, and HTTP calls.
- A lease token fences every durable write. Never bypass the worker/storage transition APIs or let a
  stale worker write completion, failure, checkpoints, or sleeps.
- `durlo.transaction(...)` is only for creation. Use its `client` for application SQL and its
  `enqueue`/`start`/`batchEnqueue` methods; handlers run later, outside that transaction.
- `task.enqueue()` and `workflow.start()` persist work but do not execute it. Workers must register
  the exact kind, id, and version.
- Workflow functions re-enter from the top. Keep `step.run`/`step.sleep` calls sequential, do not
  nest them, keep step ids stable, and branch only on input or stored step results.
- A schema runs once at creation. Its transformed output is what the worker receives; do not
  revalidate stored input in the worker.
- Idempotency is about run creation, not execution. Batch items must be explicit
  `{ input, options? }` objects, and incompatible reuse must remain a conflict.
- A definition version is a compatibility token. Keep old-version workers running until their
  active runs finish; package versions and definition versions are separate.
- Pools from connection config are owned by Durlo; caller-supplied pools are borrowed. Do not close
  a borrowed pool from an adapter.
- Released migrations are immutable. Add a forward migration and test the code/schema rollout order.
- V1 is direct tasks/workflows on PostgreSQL: no events, cron, framework adapters, or distributed
  concurrency.
