# Slice 1 Repo Foundation Design

Status: Approved for planning
Date: 2026-07-08

## Purpose

Slice 1 creates the Durlo monorepo foundation so later slices can add the public API, Postgres adapter, worker, workflows, and CLI without revisiting basic project structure.

The success condition comes from `docs/SLICES.md`: packages build and a smoke test imports `@durlo/core`.

## Scope

In scope:

- Create a `pnpm` workspace monorepo.
- Add `turbo` for root task orchestration.
- Add package shells for `@durlo/core`, `@durlo/postgres`, and `durlo`.
- Add strict shared TypeScript configuration.
- Add `tsup` package builds that emit JavaScript and declaration files.
- Add `Vitest` with a smoke test importing `@durlo/core`.
- Add `ESLint 9` flat config with `typescript-eslint`.
- Add Prettier formatting.
- Export a minimal `Durlo` class from `@durlo/core` to prove package exports and type declarations work.

Out of scope:

- Real task, workflow, run, worker, retry, serialization, or adapter behavior.
- Postgres migrations or database code.
- Events, cron, distributed concurrency, framework adapters, or code discovery.
- Dashboard or demo application work.

## Tooling

The foundation uses the boring modern TypeScript library stack:

- Package manager: `pnpm` workspaces.
- Task runner: `turbo`.
- Runtime floor: Node.js `>=22`.
- Language: TypeScript in strict mode.
- Package build: `tsup`.
- Tests: `Vitest`.
- Linting: `ESLint 9` flat config with `typescript-eslint`.
- Formatting: Prettier.

Node.js `>=22` keeps the library compatible with current LTS users while avoiding a Node 26 requirement before Node 26 enters LTS in October 2026.

## Package Layout

The repo will use:

```txt
packages/
  core/
  postgres/
  cli/
```

`packages/core` publishes `@durlo/core` and owns the public TypeScript API surface. Slice 1 only exports `Durlo`.

`packages/postgres` publishes `@durlo/postgres` and remains a shell until the Postgres adapter slice.

`packages/cli` publishes the `durlo` executable package and remains a shell until the CLI slice.

Each package gets its own `package.json`, `src/index.ts`, `tsconfig.json`, and build script. Root scripts call package scripts through `turbo`.

## Exports

`@durlo/core` will expose:

```ts
export class Durlo {
  constructor(options: { id: string });

  readonly id: string;
}
```

This is intentionally smaller than the final API in `docs/API_SPEC.md`. Later slices will expand the constructor options and add `task(...)`, `workflow(...)`, `runs`, `tx(...)`, and `worker(...)` through TDD.

`@durlo/postgres` and `durlo` can export minimal no-op symbols so package builds prove the workspace structure, but they must not imply implemented adapter or CLI behavior.

## Tests

The first test verifies package-level behavior rather than runtime semantics:

```ts
import { describe, expect, it } from "vitest";
import { Durlo } from "@durlo/core";

describe("@durlo/core", () => {
  it("exports Durlo", () => {
    const durlo = new Durlo({ id: "test-app" });

    expect(durlo.id).toBe("test-app");
  });
});
```

The implementation plan must follow TDD:

1. Add this failing smoke test first.
2. Run it and confirm it fails because `@durlo/core` is missing.
3. Add the minimal package/export implementation.
4. Run tests and confirm they pass.

## Verification

Slice 1 is complete only when these commands pass from the repo root:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The final verification must include a fresh run of all relevant commands before claiming completion.

## Documentation Alignment

This design follows the v1 constraints in `AGENTS.md`, `docs/SLICES.md`, and `docs/DECISIONS_AND_EDGE_CASES.md`:

- Durlo remains task/workflow-first.
- No events, cron, distributed concurrency, or framework adapters are introduced.
- Runtime semantics such as lease tokens, idempotency, and at-least-once execution remain documented but unimplemented in Slice 1.
- The public package names stay canonical: `@durlo/core`, `@durlo/postgres`, and `durlo`.
