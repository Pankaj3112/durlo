# Durlo Roadmap

Status: Active
Updated: 2026-07-16

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

Phases 1 through 4 are complete. Phase 5's repeatable engineering proof is implemented: production-like durability stress, rolling-version deployment coverage, an explicit runtime/database support matrix, release-tarball verification, and published beta limits and duplicate-execution guidance. The remaining Phase 5 gate is reviewed operating evidence from two real applications.

## Phase 1: Execution Hardening

Status: Complete

### Progress

- Continuously replenished worker slots and independent timer promotion are implemented.
- Lease heartbeats are serialized so a slow renewal cannot overlap the next renewal.
- `worker.stop()` stops new claims and timer promotion, then `worker.start()` drains active work before returning.
- Claim and timer polling recover independently from transient Postgres failures with bounded exponential backoff and jitter.
- `worker.getHealth()` exposes lifecycle, active-slot, polling-success, and database-failure state.
- Configured loggers receive structured worker lifecycle, database recovery, and run transition records.
- Public run reads, cancellation, and manual retry are scoped by both app id and run id.
- Workflow step and sleep calls are runtime-enforced as sequential boundaries; nested and concurrent calls fail predictably.
- Attempt timeout, running cancellation, shutdown draining, and late completion behavior are documented and covered by deterministic tests.

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

Status: Complete

### Progress

- Task and workflow definitions now carry an opaque compatibility version, defaulting to `"1"`.
- Runs persist their resource version and workers claim only exact kind, resource-id, and version matches.
- `worker.getCompatibilityReport()` provides a bounded, read-only view of active runs unavailable to that worker's registrations.
- The rolling-deployment, rollback, workflow-compatibility, and idempotency interaction policy is documented in [Deployment Compatibility](DEPLOYMENT_COMPATIBILITY.md).
- Additive migration `0002_resource_versions` preserves `0001_initial` and has a tested upgrade path that backfills existing runs to version `"1"`.
- Inputs, outputs, errors, batches, step results, and total workflow step/sleep records now have documented configurable limits that fail before oversized JSON is persisted.
- `durlo.runs.cleanup()` manually deletes bounded, app-scoped terminal history with row-lock safety; Durlo does not schedule cleanup itself.
- Retention now explicitly defines the idempotency window: a key remains reserved until its run row is actually deleted.
- A reproducible Postgres benchmark seeds 50,000 runs, verifies the intended claim, attempt, and timer indexes, and enforces a configurable query-latency envelope.
- Claim selection now scans expired leases before pending work inside one transaction, removing the combined eligible-set sort while preserving expired-first ordering and `SKIP LOCKED` safety.
- [Postgres Performance](PERFORMANCE.md) records the 50,000- and 500,000-run measurements; [Postgres Operations](OPERATIONS.md) defines pool, concurrency, polling, lease, and fleet connection guidance.
- Released migration SQL is protected by immutable checksums, with upgrade tests from every Phase 2 schema prefix.

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

Status: Complete

### Progress

- `durlo.runs.list()` provides app-scoped, newest-first keyset pagination with status, kind, resource, version, and creation-time filters.
- Payload-free list summaries and opaque versioned cursors give the CLI and dashboard a bounded stable contract.
- `durlo.runs.getDetails()` reads one consistent run, step, attempt, and timer snapshot without taking row locks.
- The core read model builds a deterministic chronological timeline from durable records without adding an event-history subsystem.
- Detail diagnostics expose retries, failures, timeouts, stalls, durable lease loss, expired current leases, and timer lag.
- `durlo.runs.getBacklogHealth()` reports app-scoped ready/delayed work, running and sleeping work, expired leases, due timers, and database-clocked lag.
- Existing `worker.getHealth()` and `worker.getCompatibilityReport()` complete the local operational view, including bounded unregistered-resource and incompatible-version diagnosis.
- Additive migration `0004_observability_reads` indexes list filters, active backlog reads, and timer detail; its upgrade path and immutable checksum are tested.
- The reproducible 50,000-run benchmark now enforces the intended list, detail, and backlog query indexes and latency envelope.

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

Status: Complete

### Progress

- `@durlo/cli` now installs the `durlo` binary with `init`, `migrate`, `worker`, and `dev` commands.
- TypeScript and JavaScript configs explicitly register exact task and workflow definitions plus worker and dashboard settings.
- Worker commands own signal handling, drain through the existing worker lifecycle, and close their Postgres adapter only after shutdown.
- The loopback-by-default local dashboard provides filtered run pages, backlog/process/compatibility health, complete run records, and the derived timeline.
- Dashboard cancellation and manual retry are confirmed, same-origin, app-scoped actions whose final state validation remains atomic in storage.
- The order-fulfillment demo transactionally starts a workflow, checkpoints an idempotent business effect, supports a deliberate hard crash, resumes after lease expiry, sleeps durably, fails once, retries, and completes.
- The README is now a direct under-ten-minute quickstart instead of a project status page.
- Packed-artifact verification installs an empty consumer, executes the installed CLI, kills and restarts its worker, and asserts the recovered dashboard timeline without workspace source imports.

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

Status: In Progress

### Progress

- Four independent worker pools drain contended work, seeded creation/claim races preserve lease and idempotency invariants, and a blocked long-tail execution does not prevent slot replenishment.
- Child-process crash windows cover death after claim, after an external side effect, and after a committed workflow checkpoint.
- A TCP-level database outage test severs active and idle worker connections, verifies the process remains alive, observes lease loss, restores polling, and reclaims the expired attempt.
- Due-timer lag drains independently while every execution slot is occupied.
- A Postgres integration scenario covers a sleeping old workflow, new-version-only deployment, mixed-version resume, idempotency across the version change, and rollback availability.
- Public packages declare Node.js 22 through 26; PostgreSQL 14 through 18 is the supported database range. Nightly tests Node 22, 24, and 26 against both database boundaries.
- Immutable migrations and every schema-prefix upgrade are tested. Empty ESM, CommonJS, and strict TypeScript consumers verify the exact tarball contents, exports, CLI binary, migrations, and packed crash-and-resume quickstart.
- [Beta Release Proof](BETA_RELEASE_PROOF.md) publishes the clean-checkout audit, regression scales, tested configuration/storage limits, duplicate-execution windows, stranding diagnostics, and real-application evidence protocol.
- No qualifying operating reports from two real applications are recorded yet; repository tests and examples intentionally do not count toward that gate.

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

### Remaining Gate

- Review operating reports from two real, non-demo applications that collectively observe deployments, retries, cancellation, and crash or outage recovery. Convert unexpected findings into deterministic tests or documented accepted beta limits before marking the phase complete.

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
