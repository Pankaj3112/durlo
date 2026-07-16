# Durlo AI-Agent QA

These charters are exploratory release checks. They supplement automated tests; they are never a
substitute for them.

## Execution Rules

1. Use a fresh database or isolated schema and a unique Durlo app id.
2. Install packed artifacts produced from the release candidate.
3. Interact through documented public APIs. Direct SQL is read-only unless the charter explicitly
   requests lease/timer fault injection.
4. Record exact commands, package versions, Node/Postgres versions, timestamps, run ids, logs, and
   the final database state.
5. Do not describe a failure as fixed until a deterministic automated regression test exists.
6. Remove test processes, roles, schemas, and containers when finished.

Use `report-template.json` for the final report. Store release reports outside the source tree as CI
or release artifacts; do not commit credentials or connection strings.

Use `production-evidence-template.json` for the separate Phase 5 real-application gate. Automated
tests, repository examples, and synthetic soak runs do not count as real-application evidence.
