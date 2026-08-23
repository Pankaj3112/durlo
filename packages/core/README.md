# `@durlo/core`

Durlo's public definitions, creation client, worker, retry controls, workflow tools, read/control
API, and public types.

## Installation

```bash
npm install @durlo/core@0.1.0-alpha.1 @durlo/postgres@0.1.0-alpha.1 pg
```

## Requirements

- Node.js 22 through 26
- PostgreSQL 14 through 18 when used with `@durlo/postgres`
- ESM, CommonJS, and strict TypeScript consumers are supported

This matrix describes alpha installation/runtime compatibility. It is not an SLA, measured
production envelope, or production-support promise.

## Minimal usage

```ts
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

const adapter = postgresAdapter({ connectionString: process.env.DATABASE_URL! });
const durlo = new Durlo({ id: "billing", adapter });

const sendInvoice = durlo.task({
  id: "send-invoice",
  run: async (input: { invoiceId: string }, { signal }) => {
    await deliverInvoice(input.invoiceId, signal);
  }
});

const creation = await sendInvoice.enqueue({ invoiceId: "inv_42" });
const result = await durlo.runs.wait(creation.run, { timeout: "30s" });
```

Creating a run does not execute it. Register the same definition in a separately running worker.

## Exports

The package root exports `Durlo`, `Worker`, retry defaults, public error and outcome classes, and
the documented public types. Adapter protocols, serializers, registration state, and execution
storage controls are internal. See the repository's `docs/EXECUTION_SEMANTICS.md` for the exact
allowlist and behavior.

## Alpha status

Version `0.1.0-alpha.1` is pre-release and not a production-support commitment. Worker execution is
at-least-once; application and provider side effects need their own idempotency. Alpha APIs may
break only with changelog or migration-note disclosure.

License: MIT. Security reports use the repository's GitHub private vulnerability reporting form
once enabled.
