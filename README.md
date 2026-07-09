# Durlo

Durlo is a TypeScript-native durable async layer for Postgres-backed apps.

V1 focuses on:

- direct background tasks
- direct multi-step workflows
- retries, delays, sleeps, and cancellation
- Postgres-only durable state
- a normal Node worker process

V1 does not include events, cron, distributed concurrency, hosted cloud, or framework-specific adapters.

Start here:

- [Product spec](docs/PRD.md)
- [Build slices](docs/SLICES.md)
- [API spec](docs/API_SPEC.md)
- [Execution semantics](docs/EXECUTION_SEMANTICS.md)
- [Edge cases](docs/DECISIONS_AND_EDGE_CASES.md)

## Current Status

Slices 1 through 6 are implemented: core APIs, Postgres migrations and persistence, lease-safe workers, task retries, workflow checkpoints, durable timers, cancellation, and manual retry. The CLI, dashboard, and demo in Slice 7 are not implemented yet.

Postgres integration tests run when `DURLO_TEST_DATABASE_URL` is set:

```bash
DURLO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/durlo_test pnpm test
```
