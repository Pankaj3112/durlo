# Durlo Storage Limits

Status: Current
Updated: 2026-07-16

Durlo applies explicit limits at its public core boundaries so one run cannot accidentally place an unbounded JSON value or batch into Postgres.

## Defaults

| Limit | Default | Applies to |
| --- | ---: | --- |
| `maxInputBytes` | 1 MiB | One validated task or workflow input |
| `maxOutputBytes` | 1 MiB | One completed task or workflow output |
| `maxErrorBytes` | 64 KiB | One durable run or step error |
| `maxBatchItems` | 1,000 | Items in one `batchEnqueue` call |
| `maxBatchBytes` | 10 MiB | The serialized input array for one batch |
| `maxStepResultBytes` | 1 MiB | One completed `step.run` result |
| `maxWorkflowSteps` | 1,000 | Durable step and sleep records for one workflow run |

Byte limits measure the UTF-8 byte length of Durlo's compact serialized JSON. They are not estimates of PostgreSQL's compressed or on-disk representation.

## Configuration

Limits are configured on the `Durlo` instance. Every override must be a positive safe integer. `maxErrorBytes` must be at least 128 bytes so Durlo can persist a bounded diagnostic when an original error is too large.

```ts
const durlo = new Durlo({
  id: "billing",
  adapter,
  limits: {
    maxInputBytes: 256 * 1024,
    maxOutputBytes: 512 * 1024,
    maxBatchItems: 250
  }
});
```

Run creation persists the output, error, step-result, and workflow-step limits in `options_json`. A delayed, retried, or sleeping run therefore keeps the limits selected when it was created. Runs created before limits were persisted use the executing worker's configured limits, which default to the table above.

## Failure Behavior

- Oversized input rejects `enqueue`, `start`, or transaction-bound creation before the adapter is called.
- Batch item and aggregate-byte limits reject the whole batch before any row is written.
- Oversized output raises `StorageLimitError` inside the attempt and follows the normal retry policy; the oversized output is never stored.
- Oversized step results fail the step and workflow attempt before `result_json` is written.
- The workflow-step count includes both `durlo_steps` and `durlo_timers`. The Postgres adapter checks capacity while holding the owning run lock, so concurrent calls cannot exceed the limit.
- If a thrown error is itself oversized, Durlo stores a small `StorageLimitError` describing the original error size and configured `maxErrorBytes` instead of truncating invalid JSON.

Limit failures consume retry budget like other attempt failures. Retrying without changing the data or code will fail again; operators should fix the payload shape or intentionally create future runs under a different limit.

## Adapter Boundary

The public `Durlo` APIs enforce JSON byte limits before calling persistence. The Postgres adapter additionally enforces workflow-step count because that limit depends on durable rows across workflow re-entry. Direct calls to internal adapter methods are not a supported way to bypass the core contract.
