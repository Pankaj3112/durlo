# Durlo crash-and-resume demo

This demo uses `durlo.transaction(...)` to create an order and its workflow run through one raw
`pg` client. Durlo owns begin, commit, rollback, and release. The workflow then
checkpoints an inventory reservation, pauses so its worker can be killed, recovers after lease
expiry, sleeps without holding compute, fails its first courier call, retries, and completes.

From this directory, with `DATABASE_URL` set:

```bash
pnpm migrate
DURLO_DEMO_PAUSE_AFTER_CHECKPOINT=1 pnpm dev
```

In a second terminal, start an order:

```bash
pnpm start
```

The worker prints `CRASH_READY` with its exact PID after both checkpoints are durable. Kill that
PID with `kill -9 <pid>`, restart with `pnpm dev` (without the pause variable), and open
<http://127.0.0.1:3210>. The timeline shows the stalled lease, reused checkpoints, durable timer,
failed courier attempt, automatic retry, and completion.

The inventory write uses a business-level unique key because Durlo is at-least-once; a run
idempotency key deduplicates run creation, not external effects.
