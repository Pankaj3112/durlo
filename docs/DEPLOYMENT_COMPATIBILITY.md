# Durlo Deployment Compatibility

Status: Current
Updated: 2026-07-16

This document defines the v1 compatibility policy for task and workflow runs that outlive a code deployment.

## Compatibility Token

Every task and workflow definition has an opaque `version` string:

```ts
const onboarding = durlo.workflow({
  id: "onboarding",
  version: "2",
  run: async ({ input, step }) => {
    // ...
  }
});
```

The default version is `"1"`. Versions contain 1 to 128 characters, cannot have surrounding whitespace, and do not have to follow semantic versioning.

Durlo stores the definition version on each run at creation time. Workers claim only exact `(kind, resource id, resource version)` matches. Retries, manual retries, delays, lease recovery, and workflow sleep/resume retain the original run version.

## When To Keep Or Change A Version

Keep the same version only when the new code is compatible with every non-terminal run already stored under that version.

For workflows, compatibility means at least:

- existing input remains readable
- stored step result shapes remain readable
- existing step ids keep the same meaning
- already-created sleep ids remain valid
- durable branching still follows the same persisted decisions
- removed or reordered code does not turn an old checkpoint into a different operation

Change the version when any active run could require the old implementation to continue safely. A version change does not migrate runs and does not rewrite their checkpoints; it routes new runs to new code while old runs continue to require old code.

Tasks use the same policy because delayed tasks, retries, and expired leases can also cross deployments.

## Rolling Deployment Procedure

For a breaking change from version `"1"` to `"2"`:

1. Deploy version-2 workers before producers begin creating version-2 runs.
2. Update producers to enqueue or start through the version-2 definition.
3. Keep version-1 workers registered while version-1 runs are pending, running, or sleeping.
4. Check compatibility reports from the complete worker fleet before removing version-1 code.

A rollback must restore workers for every version still present in active storage. Reusing version `"1"` for incompatible rollback code is unsafe; the token describes durable-code compatibility, not merely the deployment name.

Failed workflows and dead-letter tasks are terminal, so they are not included in the active compatibility report. Manual retry preserves their original version. Restore matching code before manually retrying an old-version terminal run, or the retried run will become pending until compatible code is available.

One worker process may register multiple versions of the same resource id when both implementations are available:

```ts
durlo.worker({ workflows: [onboardingV1, onboardingV2] });
```

## Diagnosing Missing Code

`worker.getCompatibilityReport({ limit })` performs a bounded, read-only check. It returns active runs that the worker cannot claim and labels each one as:

- `incompatible_version`: the worker has the same kind and resource id, but not the stored version
- `unregistered_resource`: the worker does not have that kind and resource id at all

The default limit is 100 and the maximum is 1,000. `truncated` reports whether more matches exist beyond the returned page. The report includes pending and sleeping runs plus running runs whose leases have expired. It does not mutate, fail, cancel, or claim those runs.

Reports are relative to one worker's registrations. In a deployment where workers intentionally own different resource subsets, combine the registrations and reports from the complete fleet before concluding that code is globally unavailable.

## Idempotency

Resource version is deliberately not part of the v1 idempotency scope. The scope remains:

```txt
app id + resource kind + resource id + idempotency key
```

If a producer uses an existing idempotency key after changing a definition version, Durlo returns the original run and its original `resourceVersion`. A version bump does not authorize the same business operation twice.

## Existing Runs And Migrations

Migration `0002_resource_versions` adds `resource_version` and backfills existing runs to `"1"`. Migrations are append-only; `0001_initial` remains unchanged. Applications upgrading from the initial schema must treat their pre-upgrade definitions as version `"1"` or keep an equivalent version-1 worker available.
