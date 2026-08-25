# Contributing to Durlo

Durlo is an alpha TypeScript library for direct tasks and workflows on PostgreSQL. Contributions
should stay inside the current roadmap stage and preserve its honest at-least-once model.

## Setup

Use Node.js 22 through 26, pnpm 11, and a running Docker daemon:

```bash
pnpm install --frozen-lockfile
pnpm test:unit
pnpm test:local
```

`pnpm test:local` creates and removes a disposable PostgreSQL 17 container. Start with `README.md`,
then read the relevant document under `docs/` before changing public behavior.

## Repository constraints

- Keep v1 focused on direct tasks, direct workflows, Node.js, and PostgreSQL.
- Do not add events, cron, distributed concurrency, hosted services, or framework adapters.
- Preserve lease-token fencing, idempotency semantics, and explicit at-least-once limitations.
- Keep code, public types, package documentation, and the owned documents aligned.
- Do not infer author, maintainer, personal contact, or support-SLA metadata.
- Keep the root README focused on installation and first use; put detailed behavior in the owned
  document under `docs/` rather than copying it into multiple READMEs.

Released migrations are immutable. Add a forward migration and document its schema/code rollout
order instead of editing any released migration file.

## Change shape

Prefer a focused issue and a small, tested vertical change over a broad refactor. Add a behavioral
test at a stable public seam before changing behavior, and keep unrelated cleanup out of the pull
request. User-visible API, schema, operational, and compatibility changes—including prerelease
breaks—must update `CHANGELOG.md` in the same pull request.

## Verification

Run the narrowest relevant checks while developing, then run the complete release gate before
requesting review:

```bash
pnpm test:release-contract
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:package
pnpm test:audit
git diff --check
```

Database-backed changes must also pass the appropriate disposable-PostgreSQL suite. Package or
release changes must retain machine-readable pack inventories and must never publish from a local
checkout.
