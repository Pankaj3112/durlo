# Charter: Packed Public API Quickstart

Goal: determine whether a new user can install the release tarballs and complete one task and one
sleeping workflow using only the published documentation.

- Start from an empty directory and fresh Postgres schema.
- Install the packed `@durlo/core`, `@durlo/postgres`, and `durlo` artifacts.
- Follow the documented migration, enqueue/start, worker, get, cancel, and retry APIs.
- Exercise ESM and CommonJS consumers and strict TypeScript compilation.
- Deliberately provide malformed ids, options, and unserializable inputs; assess error clarity.
- Verify no workspace source path or undeclared type dependency is required.
