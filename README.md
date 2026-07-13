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
- [Testing strategy](docs/TESTING_STRATEGY.md)

## Current Status

Slices 1 through 6 are implemented: core APIs, Postgres migrations and persistence, lease-safe workers, task retries, workflow checkpoints, durable timers, cancellation, and manual retry. The CLI, dashboard, and demo in Slice 7 are not implemented yet.

Run the complete suite with a disposable local PostgreSQL 17 container:

```bash
pnpm test:local
```

Pure unit tests do not require Docker:

```bash
pnpm test:unit
```

Generate full unit-plus-integration coverage with another disposable database:

```bash
pnpm test:local:coverage
```

Heavier durability checks are available separately:

```bash
pnpm test:local:stress
pnpm test:local:mutations
pnpm test:local:privileged
pnpm test:package
```

Run the complete release-candidate audit—including package consumers, core and persistence
mutations, privileged-role checks, and seeded stress—with:

```bash
pnpm test:audit
```

Nightly compatibility tests exercise Node.js 22 and 24 LTS plus Node.js 26 Current against the
oldest and newest supported PostgreSQL bounds, currently PostgreSQL 14 and 18. See the
[Node.js release schedule](https://nodejs.org/en/about/previous-releases) and
[PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/).

To use an existing Postgres database, provide its URL explicitly. The integration command fails
clearly when the URL is missing; it never reports a skipped suite as success.

```bash
DURLO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/durlo_test pnpm test:integration
```
