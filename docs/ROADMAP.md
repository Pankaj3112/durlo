# Durlo Roadmap

Status: Active
Updated: 2026-07-20

## Product direction

Durlo should become the most trustworthy Postgres-native background task and direct workflow
library for TypeScript applications. Its wedge is atomic creation of application data and durable
work in one PostgreSQL transaction, combined with honest at-least-once execution and inspectable
workflow checkpoints.

The goal is BullMQ-level trust for a narrower use case, not immediate BullMQ or Inngest feature
parity. Correctness, operability, release quality, and evidence come before events, cron, hosted
execution, or a large adapter ecosystem.

## V1 boundary

V1 includes direct tasks and workflows, PostgreSQL persistence, Node.js workers, retries, delays,
durable steps and sleeps, cancellation, manual retry, local inspection, bounded cleanup, and raw
`pg` transaction integration.

V1 excludes events, schedules, other languages, hosted orchestration, framework adapters,
distributed global/per-resource/per-tenant concurrency, rate limiting, and Temporal-style event
history replay.

## Current state

The repository has a strong execution foundation: lease-token fencing, `FOR UPDATE SKIP LOCKED`,
crash and outage recovery tests, resource-version compatibility, durable workflow checkpoints,
bounded payloads, observability reads, a CLI, a local dashboard, and realistic example
applications.

It is not yet a beta release. The current packages are `0.0.0`, release metadata is incomplete,
throughput is not measured end to end, and the integrity issues below can violate or obscure public
behavior. Earlier Phase 1–5 work remains useful engineering evidence, but the old “Phase 5 complete”
claim is retired.

## Now: Integrity repair

Status: In progress

Repair the promises already exposed before adding product breadth.

1. Replace `durlo.tx(client: unknown)` with an API that cannot mistake a `pg.Pool` or non-active
   client for a transaction. Prove business writes and run creation commit or roll back together.
2. Close or transition workflow step attempts when a lease stalls, a run is cancelled, or an
   attempt times out. Terminal run detail must not contain unexplained active attempts or steps.
3. Validate Standard Schema input once, persist its output, and represent schema input/output types
   correctly. A transforming schema must execute successfully.
4. Replace the unescaped `$durlo.date` representation with collision-safe serialization and test
   round trips for every valid JSON shape.
5. Make sleep and lease-loss sentinels internal or unforgeable so user exceptions always follow
   normal failure persistence.
6. Remove the ambiguous batch item union. Valid task payloads containing `input` and `options` must
   never be interpreted as batch metadata.
7. Make idempotency reuse explicit. Detect incompatible payload/options or return a result that says
   whether a run was created or deduplicated.
8. Track adapter connection ownership so closing Durlo never ends a caller-owned pool.
9. Reject zero polling intervals and retry configurations that can overflow into invalid dates.
10. Ensure worker health cannot report a healthy database while execution persistence repeatedly
    fails.

Done when every issue has a public-API regression test, no known state transition can silently
corrupt input or durable history, and the complete audit passes.

## Next: Public contract and first release

Status: Blocked by integrity repair

1. Narrow the public exports before semver freezes internal adapter types, serializers, `_durlo`,
   and control-flow errors.
2. Add an abortable, timeout-aware, typed `durlo.runs.wait(handle)` or equivalent result API.
3. Add explicit permanent failure and server-directed retry behavior without weakening retry
   accounting.
4. Decide and add the repository license; include package READMEs, license text, repository,
   homepage, issue, keyword, and public publish metadata in every tarball.
5. Derive the CLI version from the package manifest and introduce one version/release process with
   changelog and provenance checks.
6. Publish a non-placeholder prerelease and verify installation from the registry in an empty ESM,
   CommonJS, and strict TypeScript consumer.
7. Document priority ordering and every public option at the point of use.

Done when an outside TypeScript/Postgres user can install one documented prerelease, understand the
support boundary, run a task, wait for its typed result, and identify every failure state without
repository knowledge.

## Then: Production operations and scale proof

Status: Future

1. Make batch creation, run claiming/recovery, and timer promotion set-based with bounded claim
   batches independent of configured worker concurrency.
2. Add end-to-end benchmarks for jobs per second, pickup latency, checkpoint-heavy workflows,
   recovery after outage, pool saturation, retained-history churn, and cleanup pressure.
3. Add durable app/resource pause, worker drain, and bounded bulk retry/cancel controls.
4. Provide standard Prometheus/OpenTelemetry recipes for backlog, polling, persistence failures,
   lease loss, timer lag, pool waiting, and event-loop lag.
5. Add connection-acquisition/query timeout guidance and tests that reserve enough capacity for
   heartbeats under load.
6. Define an online migration procedure for large tables and store migration checksums in the
   database.
7. Bound cleanup by actual child-row work or time, not only the number of parent runs.
8. Decide the supported CPU-work boundary. Either add isolation or explicitly support only
   cooperative I/O-oriented handlers in v1.

Done when capacity claims are reproducible on realistic workloads, operators can stop and recover
work safely, and a worker fleet exposes actionable health rather than process-local hints alone.

## After v1: Adoption bridge

Status: Future

1. Publish standalone copies of the reference applications outside the monorepo package graph.
2. Add a storage-adapter conformance suite before accepting alternate clients or engines.
3. Add Drizzle transaction integration first, then evaluate Kysely, Prisma, and framework helpers
   based on actual demand.
4. Collect independent operating reports and convert every unexpected behavior into a deterministic
   regression test or an explicit limitation.
5. Build contributor, release, security-reporting, and support processes suitable for outside users.

## Post-v1 product breadth

Status: Future

Only after the narrow product is trusted and adopted, evaluate in this order:

1. per-resource and keyed tenant concurrency
2. global concurrency, rate limiting, and throttling
3. durable progress and application logs
4. an authenticated deployable operations surface
5. parent/child fan-out and fan-in flows
6. schedules and cron
7. event ingestion and event-triggered workflows
8. hosted orchestration or additional storage engines

Each addition needs a concrete use case, durable semantics, operational controls, and failure tests.
Feature count alone is not progress.

## Documentation ownership

- `ROADMAP.md` owns future work and ordering.
- `ARCHITECTURE.md` describes the implementation that exists.
- `EXECUTION_SEMANTICS.md` describes public runtime behavior, including current limitations.
- `OPERATIONS.md` owns deployment and PostgreSQL guidance.
- `DECISIONS_AND_EDGE_CASES.md` records durable product decisions and non-goals.

When code changes a promise, update the owning document in the same commit. Do not add a new
top-level document when one of these five already owns the subject.
