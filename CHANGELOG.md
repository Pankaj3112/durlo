# Changelog

This file records user-visible API, schema, operational, and compatibility changes. Durlo follows
Semantic Versioning beginning with `1.0`; during alpha, breaking changes are allowed only when the
affected prerelease documents the break and any migration or rollout action.

Each release entry uses the categories Added, Changed, Fixed, Removed, Security, Migration, and
Compatibility as applicable. Released migration files are immutable. Schema changes must name the
forward migration plus the safe schema/code rollout order. Operational changes must call out new
failure modes, recovery steps, or configuration requirements.

## [0.1.0-alpha.0] - 2026-08-23

### Added

- Direct durable tasks and sequential checkpointed workflows on PostgreSQL.
- Atomic application SQL plus task/workflow creation through the owned raw-`pg` transaction
  callback.
- At-least-once workers with retries, directed retry, permanent failure, lease-token fencing,
  durable delays and sleeps, cancellation, manual retry, retention cleanup, and typed result waits.
- Local migration, worker, development, and inspection commands through `@durlo/cli`.
- ESM, CommonJS, and strict TypeScript package entry points for Node.js 22 through 26.

### Compatibility

- Installation/runtime compatibility is Node.js 22 through 26 and PostgreSQL 14 through 18.
- This alpha matrix is not an SLA, measured production envelope, or production-support promise.
- Resource definition versions are separate from package versions and route persisted inputs and
  checkpoints to compatible workers.

### Migration

- Apply every exported migration in order with `durlo migrate` before starting this alpha's
  producers or workers. Never edit a migration after release.

### Known limitations

- Execution is at-least-once; external side effects require business- or provider-level
  idempotency.
- The local dashboard has no authentication and must remain on loopback or behind a trusted,
  authenticated proxy.
- Handlers run in-process and must cooperatively observe cancellation and timeout signals.
- There is no production-support commitment, response-time SLA, events, cron, distributed
  concurrency, framework adapter, hosted service, or production throughput claim.

[0.1.0-alpha.0]: https://github.com/Pankaj3112/durlo/releases/tag/v0.1.0-alpha.0
