# Durlo Beta Support Policy

Status: Current
Updated: 2026-07-16

Durlo v1 beta supports Node.js 22 through 26 and PostgreSQL 14 through 18, inclusive. The public
packages declare `node: ">=22 <27"` so a future untested Node major does not silently enter the
support range.

## Release Matrix

Every pull request runs the complete deterministic suite on Node.js 22 and PostgreSQL 17. The
nightly and manually dispatched durability workflow runs the Cartesian product of:

- Node.js 22, 24, and 26
- PostgreSQL 14 and 18

This exercises the minimum and maximum database boundaries on every supported even-numbered Node
line. PostgreSQL 17 remains the ordinary development and pull-request version. Patch releases are
consumed through the corresponding official container and Node setup channels; Durlo does not pin
one database patch release as the only supported patch.

The matrix installs with a frozen lockfile, builds all packages, installs the generated release
tarballs into empty consumers, runs the full suite with coverage, executes the packed
crash-and-resume quickstart, checks a restricted database role, and runs seeded durability stress.
Persistence and pure-core mutation checks run on one boundary cell because their result is not
runtime-version-specific.

## Package Contract

The beta publishes `@durlo/core`, `@durlo/postgres`, and `@durlo/cli`. Each package provides ESM,
CommonJS, and TypeScript declarations from its root export. `@durlo/cli` also provides the `durlo`
binary. Release tests reject missing conditions, unexpected source files, workspace-only imports,
or a CLI that cannot execute after installation from tarballs.

The Postgres adapter targets standard PostgreSQL behavior available at the minimum supported
major. It does not rely on extensions, `LISTEN/NOTIFY`, session affinity, or a transaction held
open during user code. A restricted runtime role is tested separately from the migration role.

## Moving A Boundary

A Node.js or PostgreSQL major enters the support range only after the full boundary matrix passes.
Dropping a boundary requires a documented roadmap decision and a major-version-compatible release
policy; a green test on a newer version does not silently remove an older supported version.

Run `pnpm test:release-contract` to check that public manifests, this policy, and the durability
workflow agree. Run `pnpm test:audit` for the complete local release-candidate audit.
