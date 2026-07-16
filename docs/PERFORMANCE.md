# Postgres Performance Envelope

Status: Current
Updated: 2026-07-16

Durlo ships an opt-in query benchmark for the worker's latency-sensitive Postgres paths. It is a regression envelope, not a production throughput SLA.

## Reproduce It

Run against a disposable PostgreSQL 17 container:

```bash
pnpm benchmark:local
```

Or point it at an existing test database:

```bash
DURLO_TEST_DATABASE_URL=postgres://... pnpm benchmark:postgres
```

The existing database URL must be safe for tests. The benchmark creates and drops an isolated schema, but it still needs schema-creation permission.

These environment variables control the workload:

- `DURLO_BENCHMARK_RUNS` sets the run-row count; the default is 50,000.
- `DURLO_BENCHMARK_SAMPLES` sets measured samples after one warm-up; the default is 5.
- `DURLO_BENCHMARK_MAX_MS` sets the maximum accepted execution time for any measured query; the default is 250 ms.

At 50,000 runs, the seed contains 40,002 attempt rows and 42,000 timer rows. Runs are a fixed mix of retained terminal history, due and future pending work, sleeping workflows, and expired running leases. The four selectors are measured concurrently with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and a claim/timer batch size of 25.

The default acceptance envelope requires every measured execution to remain at or below 250 ms and, at 50,000 or more runs, requires these intended indexes to appear in the plans:

| Path | Required index |
| --- | --- |
| Expired-lease claim | `durlo_runs_lease_idx` |
| Pending claim | `durlo_runs_due_idx` |
| Run-attempt failure count | `durlo_attempts_run_idx` |
| Due-timer selection | `durlo_timers_due_idx` |

## Reference Measurements

Measurements below were collected on 2026-07-16 from an Apple M4 host with 16 GiB RAM. Docker had 10 CPUs and about 7.7 GiB RAM available. The container ran PostgreSQL 17.10 on Alpine/aarch64; the benchmark process ran Node.js 25.2.1 and pnpm 11.10.0. Values are PostgreSQL execution time, excluding client/network latency and data seeding.

| Seed | Query | Median | Maximum |
| ---: | --- | ---: | ---: |
| 50,000 runs | Expired-lease claim | 4.896 ms | 5.304 ms |
| 50,000 runs | Pending claim | 0.127 ms | 0.154 ms |
| 50,000 runs | Attempt failure count | 0.029 ms | 0.033 ms |
| 50,000 runs | Due timers | 8.483 ms | 9.404 ms |
| 500,000 runs | Expired-lease claim | 57.928 ms | 60.436 ms |
| 500,000 runs | Pending claim | 0.169 ms | 0.201 ms |
| 500,000 runs | Attempt failure count | 0.026 ms | 0.067 ms |
| 500,000 runs | Due timers | 20.506 ms | 21.553 ms |

The 500,000-run seed also contains 400,002 attempts and 420,000 timers. It is an additional scaling observation and is not the default pass/fail workload.

## Claim Query Tuning

The original selector combined pending runs and expired leases with an `OR`. At 500,000 runs PostgreSQL used bitmap scans and sorted the full eligible set, producing a 240.795 ms median.

Durlo now selects expired leases first and fills any remaining batch slots from pending work inside the same transaction. This preserves expired-first ordering, `FOR UPDATE SKIP LOCKED`, exact resource-version matching, and one atomic claim operation while allowing each partial index to serve its own queue. On the same seed, expired selection measured 57.928 ms and pending selection 0.169 ms.

## Interpreting The Envelope

The harness measures selector plans against a deterministic data shape. It does not measure task execution, application connection latency, storage hardware, checkpoint payload size, connection-pool saturation, or end-to-end throughput. Production results depend on those factors and on the fraction of rows that are immediately eligible.

Operators should run the benchmark on the same PostgreSQL major version and broadly similar infrastructure intended for production, increase `DURLO_BENCHMARK_RUNS` to the expected retained-row count, and set `DURLO_BENCHMARK_MAX_MS` to their own worker-latency budget. A changed plan or exceeded ceiling should be investigated before deployment rather than hidden by increasing the limit.
