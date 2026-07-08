# AGENTS.md

- Build Durlo v1 as direct tasks and direct workflows on Postgres.
- Do not add events, cron, distributed concurrency, or framework adapters in v1.
- Keep docs and code aligned with `docs/SLICES.md` and `docs/DECISIONS_AND_EDGE_CASES.md`.
- Prefer small, tested slices over broad refactors.
- Preserve lease-token safety, idempotency semantics, and at-least-once honesty.
