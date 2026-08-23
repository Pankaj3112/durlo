# `@durlo/cli`

Durlo's executable for configuration scaffolding, migrations, workers, and local inspection.

## Installation

```bash
npm install @durlo/cli@0.1.0-alpha.1 @durlo/core@0.1.0-alpha.1 \
  @durlo/postgres@0.1.0-alpha.1 pg
npx durlo --help
```

## Requirements

- Node.js 22 through 26
- PostgreSQL 14 through 18 for migration, worker, and dashboard commands
- ESM, CommonJS, and strict TypeScript configuration consumers are supported

This matrix describes alpha installation/runtime compatibility. It is not an SLA, measured
production envelope, or production-support promise.

## Minimal usage

```bash
npx durlo init
npx durlo migrate
npx durlo worker
npx durlo dev
```

`durlo dev` runs migrations, a worker, and the local dashboard. The dashboard has no authentication
and exposes payloads and controls; keep it on loopback or behind an authenticated trusted proxy.

## Exports

The executable provides `init`, `migrate`, `worker`, and `dev`. The package root exports only
`defineConfig` plus the `DurloConfig` and `DashboardOptions` types. Process lifecycle and dashboard
helpers are internal.

## Alpha status

Version `0.1.0-alpha.1` is pre-release and not a production-support commitment. CLI behavior may
break during alpha only with changelog or migration-note disclosure.

License: MIT. Security reports use the repository's GitHub private vulnerability reporting form
once enabled.
