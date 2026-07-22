# Durlo Roadmap

Status: Active
Updated: 2026-07-23

> **Current focus:** Make transaction-bound run creation safe. Do not start future roadmap work yet.

## At a glance

| Horizon | Outcome | Stages |
| --- | --- | --- |
| **Now** | Publish a trustworthy alpha | Safe transactions → integrity → public API → alpha |
| **Next** | Produce credible operational proof | Production-proof laboratory → supported production envelope |
| **Later** | Earn enough outside trust for v1 | Public beta → independent usage → `1.0` |

Only one GitHub issue should be active at a time. The roadmap shows direction; each issue holds the
implementation detail.

## Product direction and v1 boundary

Durlo should become the most trustworthy Postgres-native background task and direct workflow
library for TypeScript applications. Its wedge is atomic creation of application data and durable
work in one PostgreSQL transaction, combined with honest at-least-once execution and inspectable
workflow checkpoints.

The project should be publicly credible as well as technically correct. Its claims should be
verifiable through installable packages, deterministic tests, failure-injection evidence,
benchmarks, operational guidance, and eventually independent usage.

V1 includes:

- direct tasks and sequential workflows;
- PostgreSQL persistence and Node.js workers;
- retries, delays, durable steps and sleeps;
- cancellation, manual retry, local inspection, and bounded cleanup;
- raw `pg` transaction integration;
- cooperative, I/O-oriented handlers with honest at-least-once execution.

V1 excludes events, schedules, framework adapters, hosted orchestration, distributed concurrency,
rate limiting, fan-out/fan-in, additional languages, additional storage engines, and
Temporal-style event replay.

## Current state

The repository already has lease-token fencing, `FOR UPDATE SKIP LOCKED`, crash and outage recovery
tests, resource-version compatibility, durable workflow checkpoints, bounded payloads,
observability reads, a CLI, a local dashboard, and production-shaped reference applications.

Workflow interruption history now remains truthful across lease stalls, cancellation, and attempt
timeout. The remaining blockers are concentrated around transaction safety, input and serialization
integrity, public API clarity, packaging, and operational proof.

The packages remain at `0.0.0`. Durlo is not yet a beta release or a supported production library.

## Now — Publish a trustworthy alpha

### 1. Make the transaction boundary safe — **IN PROGRESS**

**Why:** Atomic business data plus durable work is Durlo's product wedge. The current
`durlo.tx(client: unknown)` API can silently lose that guarantee.

#### Work

- Replace the unsafe transaction API.
- Make transaction ownership and lifecycle explicit.
- Reject pools and non-transactional clients clearly.
- Prove commit and rollback behavior for tasks, workflows, batches, and idempotent creation.

#### Done when

The documented transaction path is safe by default, misuse fails immediately, and public-API tests
cover commit, rollback, conflict, and failure paths.

### 2. Close the remaining integrity defects

#### Work

- Validate Standard Schema input once and persist the transformed output.
- Use collision-safe serialization for every valid JSON shape.
- Make internal sleep and lease-loss control flow unforgeable by user code.
- Remove ambiguous batch item interpretation.
- Report created versus deduplicated runs and reject incompatible idempotency reuse.
- Never close a caller-owned PostgreSQL pool.
- Reject unsafe polling and retry configurations.
- Keep worker database health truthful when execution persistence fails.

Workflow interruption history is already repaired and must remain covered by regression tests.

#### Done when

No known path can silently corrupt input, ownership, retry behavior, or durable history, and the
complete release audit passes.

### 3. Stabilize the public contract

#### Work

- Remove internal adapter types, serializers, `_durlo`, and control-flow errors from public exports.
- Add an abortable, timeout-aware, typed result-waiting API.
- Add explicit permanent failure and server-directed retry behavior.
- Document every public option, state, error, priority rule, compatibility rule, and limitation.
- Define the compatibility and deprecation promises that begin with `1.0`.

#### Done when

An outside TypeScript/Postgres developer can create work, wait for its result, handle every terminal
outcome, and understand the support boundary without reading Durlo internals.

### 4. Publish an installable alpha

#### Work

- Choose a license and make the source and issue history publicly inspectable.
- Add package READMEs, security reporting, contribution guidance, changelog policy, and complete
  package metadata.
- Use one version and release process across the packages.
- Publish an alpha with provenance.
- Test registry installation in empty ESM, CommonJS, and strict TypeScript consumers.
- Provide one polished quickstart covering transactional creation, worker restart, retry, and
  inspection.

#### Done when

A stranger can discover Durlo, install the published packages, complete the quickstart, and verify
that the documented pre-release limitations match the observed behavior.

## Next — Produce credible operational proof

### 5. Build a production-proof laboratory

This replaces unavailable production dogfooding with honest, controlled evidence. It does not count
as independent adoption.

#### Work

- Run the task and workflow reference applications as independent processes against durable
  PostgreSQL using published or packed packages, never workspace source imports.
- Drive sustained and bursty work through retries, checkpoints, sleeps, cancellation, version
  changes, and cleanup.
- Inject worker termination, database interruption, pool saturation, lease expiry, slow handlers,
  migration upgrades, and rolling deployments.
- Measure throughput, pickup latency, timer lag, recovery time, duplicate-execution windows,
  stranded work, pool pressure, history growth, and cleanup cost.
- Publish the workload, infrastructure, commands, raw results, and limitations.

#### Done when

The environment can run for an extended period without silently losing eligible work, and another
person can reproduce the published failure and recovery results.

### 6. Establish the supported production envelope

#### Work

- Make creation, claiming, recovery, and timer promotion set-based where measurements show a real
  bottleneck.
- Add the pause, drain, bulk retry, and bulk cancellation controls needed for safe operations.
- Publish Prometheus/OpenTelemetry recipes for backlog, persistence failure, lease loss, timer lag,
  pool waiting, polling, and event-loop lag.
- Prove that heartbeats retain sufficient database capacity under load.
- Define online migration, rollback, and migration-checksum procedures.
- Bound cleanup by child-row work or elapsed time.
- Publish the measured workload envelope and the cooperative I/O-handler boundary.

#### Done when

Capacity claims are reproducible, operators can deploy and recover safely, and every operational
claim names its tested conditions and limitations.

## Later — Earn enough outside trust for v1

### 7. Run a public beta

#### Work

- Publish a beta with a clear support boundary and feedback path.
- Present the architecture, failure model, benchmark results, and durability demonstration in a
  concise project site or technical report.
- Help the first TypeScript/Postgres adopters integrate direct tasks and workflows.
- Turn unexpected behavior into regression tests, documented limitations, or deliberate contract
  changes.
- Collect at least one independent operating report covering workload, duration, failures,
  upgrades, and limitations.

#### Done when

At least one application outside the repository has run meaningful work with Durlo and the public
contract has survived integration feedback.

### 8. Release v1

#### Release gate

- No known correctness defect violates a documented guarantee.
- Clean installation, migration, upgrade, rollback, and recovery are repeatable.
- API compatibility and deprecation policy are documented.
- The production envelope and limitations are measured and current.
- At least one independent application has operated meaningful work.
- Security reporting and realistic maintenance and support policies exist.

The launch should make the evidence easy to inspect: packages, architecture documentation,
benchmarks, failure-injection results, a short demonstration, and an honest comparison with
alternatives.

If independent usage does not exist, Durlo remains beta rather than weakening the `1.0` gate.

## After v1

Evaluate later, based on demonstrated demand:

1. storage-adapter conformance suite and Drizzle integration;
2. per-resource and tenant concurrency;
3. global concurrency, rate limiting, and throttling;
4. durable progress and application logs;
5. authenticated deployable operations surface;
6. parent/child fan-out and fan-in;
7. schedules and cron;
8. event-triggered workflows;
9. hosted orchestration or additional storage engines.

Each addition needs a concrete use case, durable semantics, operational controls, and failure tests.

## Documentation ownership

- `ROADMAP.md`: future work, order, and release gates
- `ARCHITECTURE.md`: current implementation
- `EXECUTION_SEMANTICS.md`: public behavior and limitations
- `OPERATIONS.md`: deployment and PostgreSQL guidance
- `DECISIONS_AND_EDGE_CASES.md`: durable product decisions and non-goals
