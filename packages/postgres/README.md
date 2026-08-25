# `@durlo/postgres`

The PostgreSQL persistence adapter and ordered Durlo schema migrations.

## Installation

```bash
npm install @durlo/core@0.1.0-alpha.1 @durlo/postgres@0.1.0-alpha.1 pg
```

## Requirements

- Node.js 22 through 26
- PostgreSQL 14 through 18
- ESM, CommonJS, and strict TypeScript consumers

These are alpha installation/runtime boundaries, not a production-support promise, SLA, or measured
operating envelope. See the [root README](../../README.md) for the project overview.

## Minimal usage

```ts
import { postgresAdapter } from "@durlo/postgres";

const adapter = postgresAdapter({ connectionString: process.env.DATABASE_URL! });
await adapter.migrate();

// Pass adapter to new Durlo({ id, adapter }).
await adapter.close();
```

Adapters created from connection options own their pool. `postgresAdapter({ pool })` borrows the
caller's `pg.Pool`; closing the adapter never closes that pool. Run migrations as a deployment step
before starting workers that require the new schema.

## Exports

The package root exports `PostgresAdapter`, `postgresAdapter`, the immutable `migrations` inventory,
and the supported adapter and transaction-client types. Row shapes and lease-fenced execution
storage methods are internal. See [operations](../../docs/OPERATIONS.md) for pool sizing,
migrations, and rollout guidance.

## Alpha status

Version `0.1.0-alpha.1` is pre-release and not a production-support commitment. Apply migrations
before new producers or workers, never edit a released migration, and keep compatible old workers
until their work finishes. Durlo remains at-least-once.

License: [MIT](../../LICENSE). Security reports use the repository's
[security policy](../../SECURITY.md).
