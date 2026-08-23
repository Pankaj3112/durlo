# Durlo Operations

Status: Current `0.1.0-alpha.1` guidance
Updated: 2026-08-24

Durlo has no supported production release yet. This document records the operating behavior that
exists and the boundaries exercised by the repository. Its installation/runtime matrix is not a
production-support promise, SLA, or measured operating envelope.

## Tested environment

- Node.js 22 through 26
- PostgreSQL 14 through 18
- ESM, CommonJS, and strict TypeScript package consumers

CI runs Node 22 with PostgreSQL 17. Nightly tests the boundary cells Node 22, 24, and 26 against
PostgreSQL 14 and 18. These are the published alpha's installation/runtime boundaries, not a
production support commitment.

## Release operations

Releases are one-version, tag-driven publications of `@durlo/core`, `@durlo/postgres`, and
`@durlo/cli` in that dependency order. `.github/workflows/release.yml` is the only supported
publisher. It uses a GitHub-hosted runner, npm trusted publishing/OIDC, and npm provenance; local
checkouts never publish.

Publication, tag creation, npm or GitHub trust/secret changes, GitHub release creation, and enabling
private vulnerability reporting are maintainer-authorized external actions. Preparing or merging a
release-readiness pull request does not authorize any of them.

### Maintainer setup and dry run

The public repository must retain its history and MIT license. Enable GitHub private vulnerability
reporting in the repository Security settings and confirm that the private report form named in
`SECURITY.md` is visible. Do not add a public security email or inferred personal contact.

Before any release tag is pushed, create the protected GitHub environment `npm-release`, require a
maintainer reviewer, prevent self-review, and restrict it to release tags. Protect `main` from
unreviewed direct changes and add a tag ruleset that prevents release-tag updates or deletion. The
publish job pauses at this environment; its checkout has no persisted Git credential, is required
to be an ancestor of `origin/main`, and is the only job granted `id-token: write`. The audit and
registry-verification jobs are read-only, while the separate final job alone receives
`contents: write` to create the GitHub prerelease. These repository settings are external actions
and require fresh maintainer authorization.

Before a tag exists, run the release workflow with `workflow_dispatch` and an exact
`vX.Y.Z-alpha.N` input. A dispatch runs a frozen install, `pnpm test:audit`, package inventories,
tarball construction, and the registry compatibility plan. Dispatches cannot execute the publish
or GitHub-release steps. Download and inspect the retained `release-*` evidence artifact; every
package inventory must contain only its README, MIT license, declarations, runtime files, package
manifest, and the CLI binary/chunk where applicable.

The version must agree across the root, all public package manifests, exact internal dependency
pins, lockfile, changelog, and tag. The publishing tag must be annotated and identify the reviewed
merge commit. Creating and pushing that tag requires explicit maintainer authorization:

```bash
git tag -a v0.1.0-alpha.1 <reviewed-commit> -m "Durlo 0.1.0-alpha.1"
git push origin v0.1.0-alpha.1
```

Do not move, replace, or force-push a release tag.

### First-release bootstrap

The three package records do not exist before the first release, so trusted publishers cannot yet
be attached to them. Immediately before an explicitly authorized first tag, a maintainer may create
one short-lived, least-privilege npm granular access token limited to the `durlo` organization and
package creation/publish. Store it only as the `npm-release` environment secret
`NPM_BOOTSTRAP_TOKEN`; never put it in a local environment file, command argument, repository file,
workflow log, or artifact.

The ordinary tag workflow still performs the complete audit, produces provenance, compares local
tarball integrity with any existing registry artifact, cryptographically verifies each exact SLSA
provenance payload against this repository, workflow, tag, and commit, and publishes core,
Postgres, then CLI. npm versions are immutable, so a matching published prefix is skipped on rerun
and a mismatched or unattested version is a hard failure. Do not manually publish around a failed
workflow.

### Trusted publisher transition

Immediately after all three first-release artifacts exist:

1. Configure a GitHub Actions trusted publisher on each npm package with organization/user
   `Pankaj3112`, repository `durlo`, workflow filename `release.yml`, and `npm publish` permission.
2. Revoke the bootstrap granular token.
3. Delete the `NPM_BOOTSTRAP_TOKEN` Actions secret.
4. Confirm all three package settings show the same trusted publisher and no bootstrap credential
   remains.

Record proof of the three trust settings, token revocation, and secret removal outside public logs
that could expose credential material. npm requires the package to exist before this trust can be
configured. The workflow filename and repository values are case-sensitive.

### Normal OIDC release

Every later release uses the same annotated-tag workflow with no npm token. GitHub grants
`id-token: write`; the pinned Node.js 24.19.0 runner's npm 11.17.0 exchanges the GitHub OIDC
identity for short-lived publish authority
and automatically emits provenance for this public repository and its public packages. The
workflow retains `--provenance` and `--access public` as explicit release invariants.

After publication, the workflow installs exact registry versions into clean ESM, CommonJS, and
strict TypeScript consumers, exercises the CLI and migration inventory, runs the published-package
quickstart, and creates or refreshes the matching GitHub prerelease. Verify the npm provenance UI,
package metadata and dependency links, workflow run, annotated tag, prerelease, and retained
evidence before closing the release issue.

### Partial-publication recovery

If publication stops after core or Postgres, preserve the tag and rerun the failed Actions run. The
release plan fetches each exact registry version, compares its immutable SHA-512 integrity and
internal dependencies, requires registry provenance metadata, and cryptographically verifies the
signed source identity before it skips a matching dependency-ordered prefix and continues with the
first missing package. It fails with actionable output when an artifact differs, provenance is
missing or identifies another source, or a later package exists without an earlier dependency.
Never unpublish, overwrite, retag, or bypass the plan.

The workflow passes each evidence artifact's exact producer name to the next job, so **Re-run
failed jobs** safely reuses a successful upstream audit or publication even though GitHub advances
the run-attempt number. Do not download and substitute artifacts from another workflow run.

If registry propagation delays verification, wait and rerun the same workflow. If an artifact is
mismatched or publication order is incompatible, stop: resolution requires a new version and a
documented compatibility decision.

The `0.1.0-alpha.0` attempt demonstrated that the package installed for `npm audit signatures`
must be saved in its temporary consumer manifest. `0.1.0-alpha.1` fixes that verifier and is the
coherent recovery release; the core-only `alpha.0` artifact remains immutable and superseded.

### Next version

For the next alpha, update the root and all three public manifests together, update every internal
`workspace:<exact-version>` dependency, regenerate the lockfile, add a changelog entry, and update
owned documentation. Run `pnpm test:audit` and the workflow dispatch dry run from the reviewed
commit. After merge and fresh authorization, create one new annotated matching tag; never reuse an
npm name/version or old Git tag.

## Process layout

Use separate application, migration, and worker processes:

```txt
application/API    creates business rows and Durlo runs
migration job      runs `durlo migrate` before new workers
worker processes   run `durlo worker` with explicit registrations
PostgreSQL         stores application and Durlo state
```

`durlo dev` runs migrations, a worker, and the local dashboard together. It is a development
command, not a production deployment shape.

The CLI loads the first `durlo.config.ts`, `.mts`, `.js`, `.mjs`, or `.cjs` in the current directory
unless `--config`/`-c` is provided. A config exports one `Durlo` instance, explicit task/workflow
registrations, and optional worker/dashboard settings.

The supported CLI package API is only `defineConfig` plus the `DurloConfig` and `DashboardOptions`
types. Use the executable for init, migration, worker, and dev process behavior; internal config,
dashboard, and process-lifecycle helpers are not supported imports.

## Migrations

Run `durlo migrate` once as a deployment step with a schema-owner connection before starting
workers that require the new schema. `durlo worker` does not migrate automatically.

Migrations run in one transaction under a transaction-scoped advisory lock. Current index changes
are not created concurrently, and no lock or statement timeout is supplied by Durlo. On large live
tables, review migration SQL and schedule an appropriate maintenance window. Migration versions are
stored, but their checksums are currently enforced by repository tests rather than stored in the
database.

Migration `0005_truthful_step_interruptions` expands the step-status constraint and repairs
attributable stale step history from the matching run attempt and lease. It preserves a currently
active step owned by the parent run's lease and any later completed checkpoint. The constraint
change and backfill take ordinary table locks, so assess the affected table sizes before rollout.

Migration `0006_serialization_versions` permits the reserved PostgreSQL resource-version token used
to route codec-v2 runs. It does not rewrite existing rows. Apply it first, then deploy new workers,
then switch producers to the new package. New workers continue to claim legacy rows; old workers
continue legacy work but cannot claim newly written codec-v2 rows.

Migration `0007_idempotency_comparison_metadata` adds the transformed-input, normalized-execution,
schedule-intent, and resource-version fields used to verify compatible idempotency reuse. Existing
rows without those fields are intentionally not guessed to be compatible; reuse reports
`legacy_unverifiable` and makes no mutation.

Migration `0008_idempotency_metadata_presence` distinguishes complete comparison metadata from SQL
`NULL` and JSONB `null`, so a new run whose durable input is `null` remains idempotently reusable.

Migration `0009_run_output_kind` adds nullable output-kind metadata. New completions record `value`
or `undefined`, allowing typed waiters to distinguish JavaScript `undefined` from JSON `null`.
Existing completed rows remain `NULL` and retain their current decoded output; the migration does
not guess or rewrite them.

The runtime role requires normal read/write access to Durlo tables and sequences but should not own
the schema.

## Connections and concurrency

Two independent limits matter:

1. worker execution slots (`concurrency`, default 10, accepted range 1–1,000);
2. PostgreSQL pool capacity (`max`, controlled by `pg`).

Each worker has a claim loop, a timer loop, and heartbeat/persistence queries for active runs. Pool
connections are shared rather than reserved. A saturated pool can delay heartbeats and cause false
lease loss even when the database is healthy.

Start conservatively:

- keep concurrency near the expected number of simultaneously useful I/O operations;
- give the pool headroom above normal claim, timer, heartbeat, and completion demand;
- budget the sum of every API, worker, migration, dashboard, and administrative pool against the
  PostgreSQL connection limit;
- alert on sustained `pool.waitingCount`, not brief bursts alone;
- configure connection, query, and statement timeouts in the supplied `pg` options where needed.

`postgresAdapter(config)` constructs an owned pool; calling `adapter.close()` more than once is safe
and ends that pool once. `postgresAdapter({ pool })` borrows a caller-supplied `pg.Pool`; closing the
adapter never calls `pool.end()`, so the caller remains responsible for the pool lifecycle. This is
the supported way to share application pool capacity with Durlo.

Each `durlo.transaction(...)` call checks out one client for `BEGIN`, application SQL, Durlo inserts,
and `COMMIT` or `ROLLBACK`, then releases it. Account for that checked-out client when sizing a
shared pool. Do not release the client inside the callback; the exposed surface intentionally omits
`release()`.

Each `runs.wait(...)` poll is one independent app-scoped query. No connection or transaction stays
checked out between polls. Large waiter populations still create query load, so include them in pool
and database capacity planning; Durlo does not use `LISTEN/NOTIFY`, WebSockets, or a push service.

## Polling and latency

The default `pollInterval` is one second. Each worker polls both runs and timers, so idle database
traffic grows linearly with worker replicas. Pickup and timer latency include the polling interval,
pool wait, query time, and available execution capacity.

`pollInterval` and `leaseDuration` must be greater than zero. All timer-backed durations are finite
and at most `2_147_483_647` milliseconds, the safe Node.js timer range. Retry backoff delay and
maximum delay follow the same bound and must be positive. A run schedule may use `delay: 0`, which
is the valid immediate schedule; invalid dates and oversized delays are rejected before insertion.
Durlo provides no pickup-latency or timer-lag SLA.

Polling failures use bounded exponential backoff with jitter. Heartbeat query errors are treated as
immediate lease loss rather than retried under the existing lease.

## Leases and user code

The default `leaseDuration` is 30 seconds and heartbeats occur at roughly one third of it. Choose a
lease long enough to cover normal event-loop delay, pool waiting, network interruption, database
latency, and failover; choose it short enough to meet crash-recovery objectives.

Handlers run in-process. CPU-bound synchronous work blocks heartbeat and timeout timers. Timeouts
and cancellation only abort a signal; work that ignores it can continue and overlap a retry.
External effects must be idempotent.

Graceful shutdown calls `worker.stop()`, stops claims and timer promotion, and waits for active work
through the outstanding `worker.start()` promise. Allow enough process termination grace for the
longest cooperative handler.

## Deployment compatibility

For a Durlo package rollout that introduces a new persisted codec, apply its migration and deploy
new workers before new producers. Codec routing prevents old workers from claiming rows they cannot
decode while allowing new workers to finish legacy work.

Definition versions are exact compatibility tokens. For a breaking change from version `1` to `2`:

1. deploy workers that register version 2;
2. switch producers to the version-2 definition;
3. keep version-1 workers while version-1 work is pending, running, or sleeping;
4. inspect reports from the complete worker fleet before removing old code.

Manual retry preserves the original version. Restore matching code before retrying an old terminal
run. A version bump does not change idempotency scope; an existing key still returns its original
run.

Package versions and resource compatibility versions are separate. Alpha package releases may make
documented breaking changes only when changelog or migration notes call them out. Beginning with
`1.0`, breaking documented exports, configuration, CLI behavior, supported Node.js/PostgreSQL
ranges, or removal of a deprecated API requires the applicable later major release. Dropping a
supported Node.js or PostgreSQL major is breaking.

Never edit a released migration. Add a forward migration and document its rollout order. For
`0009`, deploy schema first, then code that writes and reads output-kind metadata; old rows remain
readable and new code treats absent metadata conservatively. Compatibility policy is not a
production-support, SLA, or exactly-once promise.

## What to monitor

At minimum collect:

- `worker.getHealth()` lifecycle, active slots, claim/timer failures, and last successful polls;
- `durlo.runs.getBacklogHealth()` ready lag, delayed work, expired leases, due timers, and timer lag;
- `worker.getCompatibilityReport()` from every registration set in the fleet;
- structured `run.lease_lost`, `run.persistence_failed`, database retry, and transition logs;
- `pool.totalCount`, `pool.idleCount`, and sustained `pool.waitingCount`;
- PostgreSQL query latency, CPU, I/O, active connections, lock waits, dead tuples, and WAL volume;
- terminal-history growth and cleanup duration.

`worker.getHealth().database.healthy` is true only when consecutive claim, timer, and execution
persistence failures are all zero. Inspect `persistenceFailures` and
`lastSuccessfulPersistenceAt` alongside the polling timestamps. A confirmed durable run
outcome—completion, failure/retry, sleep, or release—resets persistence failures; claim/timer polls,
lease loss, stale-write suppression, and handler-only failures do not. The CLI and local dashboard
serialize these fields in their health JSON.

Run detail and timelines are diagnostic snapshots, not a complete event log. A displayed `running`
step attempt should have a currently running parent run with the same lease; interruption close
events are derived from the retained attempt records.

## Local dashboard security

The dashboard defaults to `127.0.0.1:3210` and exposes full inputs, outputs, errors, health, cancel,
and retry. It has no authentication. Same-origin checks are not authentication, and requests without
an `Origin` header are accepted.

Do not bind it publicly. If access beyond loopback is unavoidable, use an authenticated trusted
reverse proxy, TLS, network restrictions, and application-level payload redaction.

The browser polls list, health, compatibility, and selected-run detail every three seconds; account
for that read traffic during local diagnosis.

## Retention

Durlo never schedules cleanup. Run it from an operator-controlled process:

```ts
await durlo.runs.cleanup({
  olderThan: "30d",
  limit: 1_000,
  statuses: ["completed", "failed", "dead_letter", "cancelled"]
});
```

The operation is app-scoped, terminal-only, oldest-first, and protected with row locks plus
`SKIP LOCKED`. Repeat while `limitReached` is true and pause between batches under load.

Deletion cascades through attempts, steps, and timers and releases idempotency keys. The limit
counts parent runs, not child rows or bytes; one batch can still generate substantial WAL and
autovacuum work. Back up history first when audit retention matters.

## Performance evidence

Run `pnpm benchmark:local` for the query-plan regression harness. Its default deterministic dataset
contains 50,000 runs; `DURLO_BENCHMARK_RUNS`, `DURLO_BENCHMARK_SAMPLES`, and
`DURLO_BENCHMARK_MAX_MS` configure it. At 50,000 or more rows it also asserts the intended claim,
attempt, timer, list, detail, and backlog indexes.

The harness uses `EXPLAIN (ANALYZE, BUFFERS)` for selector/read queries. It excludes network time,
pool waiting, the per-run updates and inserts inside claim transactions, user execution, payload
size, cleanup, and end-to-end throughput. Passing it is not a jobs-per-second or capacity claim.

Before production use, measure realistic retained history, eligible-work distribution, resource
registrations, payloads, connection contention, workflow length, failures, and outage recovery on
the intended infrastructure.

## Incident recovery

After a worker or database interruption:

1. confirm claim, timer, and persistence success timestamps advance again;
2. inspect ready lag, expired leases, and due timer lag;
3. check compatibility across the full worker fleet;
4. inspect stalled attempts and business idempotency records for possible duplicate effects;
5. keep compatible workers running until work is terminal, intentionally delayed, or sleeping on a
   future timer.

A failed heartbeat can leave the stored run `running` until its lease expires. That interval is
expected. Once recovery, timeout, or cancellation commits, the old owned step and attempt should be
terminal. Treat any unexplained active step beneath a terminal run as an integrity incident.
