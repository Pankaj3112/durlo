# Durlo Roadmap

Status: Active
Updated: 2026-07-15

This is the canonical forward-looking plan for Durlo. It targets a strong TypeScript and Postgres alternative for direct tasks and workflows; it does not target feature parity with Inngest or Temporal.

## Product Goal

Durlo v1 is ready when a TypeScript application can transactionally create a task or workflow in Postgres, run it safely across worker processes, survive crashes and deployments, inspect every attempt, and operate it without hidden failure modes.

## Scope

V1 includes:

- direct tasks and workflows
- Postgres persistence
- Node.js workers
- retries, delays, durable steps, and sleeps
- cancellation and manual retry
- local CLI and dashboard
- raw `pg` transaction-bound run creation

V1 excludes:

- events and event triggers
- cron and schedules
- languages other than TypeScript
- hosted orchestration
- framework and ORM adapters
- distributed global, per-resource, or per-tenant concurrency
- Temporal-style event-history replay

## Current State

The execution foundation is implemented and tested. It covers the public core API, Postgres persistence, lease-safe workers, retries, workflow checkpoints, timers, cancellation, and manual retry.

The project is now in pre-release hardening. Product UI work begins after the execution engine meets the Phase 1 gates.

## Phase 1: Execution Hardening

Status: In Progress

### Progress

- Continuously replenished worker slots and independent timer promotion are implemented.
- Lease heartbeats are serialized so a slow renewal cannot overlap the next renewal.
- `worker.stop()` stops new claims and timer promotion, then `worker.start()` drains active work before returning.
- Claim and timer polling recover independently from transient Postgres failures with bounded exponential backoff and jitter.
- `worker.getHealth()` exposes lifecycle, active-slot, polling-success, and database-failure state.
- Configured loggers receive structured worker lifecycle, database recovery, and run transition records.
- App-scoped controls, sequential-step enforcement, and cooperative termination finalization remain open.

### Outcomes

- Replace batch-shaped worker cycles with continuously replenished concurrency slots.
- Promote due timers and reclaim expired work independently of long-running executions.
- Recover from transient Postgres failures with bounded exponential backoff and jitter.
- Serialize lease heartbeats and prevent renewal overlap.
- Drain active work during graceful shutdown and expose worker health.
- Scope get, cancel, retry, and future dashboard reads by app id and run id.
- Enforce sequential workflow steps in v1.
- Finalize cooperative timeout and cancellation behavior and terminology.
- Connect structured logging to worker lifecycle and run transitions.

### Done When

- One slow run does not leave other worker slots idle.
- Due timers continue to progress while unrelated work is running.
- A temporary database outage does not permanently stop the worker.
- Cross-app run reads and mutations are impossible through public APIs.
- Concurrent step calls fail predictably.
- Shutdown, timeout, cancellation, and late completion have deterministic tests.

## Phase 2: Deployment And Storage Safety

Status: Planned

### Outcomes

- Define a workflow compatibility/version policy for runs spanning deployments.
- Make missing compatible worker code diagnosable instead of silently pending.
- Add explicit input, output, error, batch, and workflow-step limits.
- Add a manual, bounded retention cleanup operation; Durlo will not schedule it itself in v1.
- Define how retention affects idempotency keys.
- Benchmark and improve claim, attempt, and timer queries where measurements require it.
- Publish Postgres pool and worker-concurrency guidance.
- Keep migrations immutable and test supported upgrade paths.

### Done When

- A sleeping workflow resumes only under a documented compatible deployment policy.
- Oversized payloads fail before persistence with actionable errors.
- Operators can bound storage growth without unsafe deletes.
- Load tests establish a documented performance envelope.

## Phase 3: Observability

Status: Planned

### Outcomes

- Add app-scoped, cursor-paginated run listing and filtering.
- Add run-detail reads for steps, attempts, timers, input, output, and errors.
- Build a chronological run timeline from durable records.
- Surface retries, stalls, lease loss, timer lag, and unregistered resources.
- Expose basic worker and backlog health for local operation.

### Done When

- Every run transition can be explained from stored state.
- Read queries are indexed and do not interfere materially with claiming work.
- The read model is stable enough for the CLI and dashboard to consume.

## Phase 4: CLI, Dashboard, And Quickstart

Status: Planned

### Outcomes

- Implement `durlo init`, `durlo migrate`, `durlo worker`, and `durlo dev`.
- Load explicit task and workflow registration from configuration.
- Build a local runs list and run-detail timeline.
- Add safe cancel and manual retry actions.
- Create one polished demo showing transactional workflow start, checkpointing, sleep, retry, crash recovery, and resume.
- Replace the current README status page with a tested sub-ten-minute quickstart.

### Done When

- A new user can install packed packages, run the demo, crash the worker, restart it, and inspect the correct timeline without repository-specific knowledge.

## Phase 5: Beta Release Proof

Status: Planned

### Outcomes

- Run multi-worker contention, crash-window, database-outage, timer-lag, and long-tail concurrency tests.
- Test rolling deployments across supported workflow versions.
- Test every supported Node.js and PostgreSQL boundary.
- Verify migrations, package exports, and the quickstart from release tarballs.
- Operate Durlo in at least two real applications long enough to observe deployments, retries, cancellation, and recovery.
- Publish tested limits, expected duplicate-execution behavior, and operational guidance.

### Done When

- The release audit is repeatable from a clean checkout.
- No known failure can silently strand eligible work.
- The documented guarantees match observed production-like behavior.

## Post-v1: Adapter Ecosystem

Status: Future

Adapter work begins only after the direct `pg` Postgres implementation meets the beta release gates. Durlo will keep one semantic execution contract while allowing applications to connect through their existing database client and, later, use additional storage engines.

### Adapter Foundation

- Stabilize and version the semantic storage contract around claims, leases, retries, steps, timers, idempotency, and transaction-bound run creation.
- Define connection ownership so Durlo never closes a user-owned client or pool.
- Add adapter lifecycle and capability metadata without weakening required execution guarantees.
- Publish an adapter conformance suite covering concurrency, lease fencing, crash recovery, idempotency, timers, and transactions.
- Keep the Postgres state-machine implementation shared so client integrations do not duplicate its correctness logic.

### Postgres Client Integrations

- Add an official Drizzle integration first, allowing users to provide their configured Drizzle client and transaction.
- Add Prisma and Kysely integrations based on demand and the transaction guarantees their clients can expose.
- Keep raw `pg` as the canonical Postgres implementation and the option for applications that do not use an ORM.
- Name and document integrations so both the storage engine and client are clear; Drizzle and Prisma are connection choices, not separate durability engines.

### Additional Storage Engines

- Evaluate an official MongoDB storage adapter after the conformance suite is proven by Postgres.
- Require MongoDB deployments and transaction capabilities that can preserve Durlo's existing atomicity and lease guarantees.
- Model MongoDB as its own durable state engine rather than routing it through the Postgres implementation.
- Do not release any storage adapter that weakens Durlo's documented at-least-once, idempotency, or lease-fencing semantics.

### Community Adapters

- Document how to implement and test third-party adapters.
- Distinguish Durlo-maintained adapters from community-maintained adapters.
- Require published compatibility and conformance results before listing a community adapter as supported.

### Done When

- Postgres passes the same public conformance suite available to adapter authors.
- A Drizzle user can run Durlo and transactionally create runs using an existing configured client without separately managing a Durlo pool.
- Adapter authors can implement the contract without importing Postgres-specific concepts into Durlo core.
- Any additional storage engine demonstrates the same correctness guarantees under contention and crash recovery as Postgres.

## Tracking Model

The roadmap and GitHub serve different purposes:

- This file owns product direction, phase order, scope, and release gates.
- A GitHub `Durlo v1` milestone should own execution tracking.
- Create issues only for work that is ready to implement, ideally one outcome or tested slice per issue.
- Each issue should link to its roadmap phase and contain acceptance criteria.
- Do not copy the entire roadmap into GitHub issues.
- When an issue changes a phase outcome or completes a gate, update this file in the same pull request.

This keeps long-term intent versioned with the code while GitHub handles assignment, discussion, and day-to-day progress.
