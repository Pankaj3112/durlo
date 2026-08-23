# `@durlo/postgres`

The PostgreSQL persistence adapter and ordered Durlo schema migrations.

## Installation

```bash
npm install @durlo/core@0.1.0-alpha.1 @durlo/postgres@0.1.0-alpha.1 pg
```

## Requirements

- Node.js 22 through 26
- PostgreSQL 14 through 18
- ESM, CommonJS, and strict TypeScript consumers are supported

This matrix describes alpha installation/runtime compatibility. It is not an SLA, measured
production envelope, or production-support promise.

## Minimal usage

```ts
import { postgresAdapter } from "@durlo/postgres";

const adapter = postgresAdapter({ connectionString: process.env.DATABASE_URL! });
await adapter.migrate();
// Pass adapter to new Durlo({ id, adapter }).
await adapter.close();
```

Adapters created from connection options own their pool. `postgresAdapter({ pool })` borrows the
caller's `pg.Pool`, which remains the caller's responsibility.

## Exports

The package root exports `postgresAdapter`, `PostgresAdapter`, the ordered `migrations` inventory,
and the supported adapter option/transaction client types. Row shapes and lease-fenced execution
storage methods are internal.

## Alpha status

Version `0.1.0-alpha.1` is pre-release and not a production-support commitment. Apply migrations
before new code, never edit a released migration, and keep old compatible workers until their work
finishes. Durlo remains at-least-once.

License: MIT. Security reports use the repository's GitHub private vulnerability reporting form
once enabled.
