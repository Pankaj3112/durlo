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
