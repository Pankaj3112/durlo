# `@durlo/core`

The runtime package for Durlo definitions, run creation, workers, retries, workflows, reads,
controls, and public TypeScript types. Pair it with [`@durlo/postgres`](../postgres/README.md) for
the supported persistence adapter.

## Installation

```bash
npm install @durlo/core@0.1.0-alpha.1 @durlo/postgres@0.1.0-alpha.1 pg
```

## Requirements

- Node.js 22 through 26
- PostgreSQL 14 through 18 when used with `@durlo/postgres`
- ESM, CommonJS, and strict TypeScript consumers

These are alpha installation/runtime boundaries, not a production-support promise, SLA, or measured
operating envelope. See the [root README](../../README.md) for the project overview.

## Minimal usage

```ts
import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

const adapter = postgresAdapter({ connectionString: process.env.DATABASE_URL! });
const durlo = new Durlo({ id: "billing", adapter });

const sendInvoice = durlo.task({
  id: "send-invoice",
  run: async (input: { invoiceId: string }) => {
    await deliverInvoice(input.invoiceId);
  }
});

const creation = await sendInvoice.enqueue({ invoiceId: "inv_42" });
const worker = durlo.worker({ tasks: [sendInvoice] });
await worker.start();
```

Creating a run does not execute it. A separately running worker must register the same definition
id and version. For the full transactional-creation example, see the [root README](../../README.md).

## Exports

The package root exports `Durlo`, `Worker`, retry defaults, public errors and outcomes, and the
documented public types. Adapter protocols, serializers, registration state, and execution storage
controls are internal. See [execution semantics](../../docs/EXECUTION_SEMANTICS.md) for the exact
public contract.

## Alpha status

Version `0.1.0-alpha.1` is pre-release. Worker execution is at-least-once; application and provider
side effects need their own idempotency. Alpha APIs may break only with changelog or migration-note
disclosure. This package is not a production-support commitment.

License: [MIT](../../LICENSE). Security reports use the repository's
[security policy](../../SECURITY.md).
