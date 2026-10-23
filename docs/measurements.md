# Measured bounded workloads

Observed on 2026-10-23T11:40:39.938Z; command `npm run benchmark`. These are local measurements, not performance targets or capacity promises. No remote services/payments were involved. The script asserts every measured run's declared outcome passes before recording it.

Environment: v24.19.0, linux x64, AMD EPYC 9V74 80-Core Processor, 4 available CPU slots; runner maximum RSS 112676KiB (Node+tsx/engine/rendering, excludes PostgreSQL/worker memory). PostgreSQL 17.11 Docker sample. Shared cloud host; other test activity may affect timing. No cache/parallelism optimization was added based on these small observations.

Workload: 50 deliveries of one synthetic payment event, concurrency 1 or 8,3 repetitions each, max 3 attempts (all deliveries acknowledged without retry),500ms request timeout,8s overall deadline,50ms stable business observation window. Target reused across repetitions with a distinct order each time. Four groups/12 runs total. HTML render measurement averages10 renders of each 50-attempt report. All repeated values below are milliseconds.

| Target | Concurrency | Total run, repetitions 1/2/3 | Request latency p95, repetitions 1/2/3 | HTML render mean, repetitions 1/2/3 |
| --- | --- | --- | --- | --- |
| noop-local-http | 1 | 200.10, 170.19, 153.72 | 1.79, 4.04, 1.41 | 0.68, 0.45, 0.22 |
| noop-local-http | 8 | 80.86, 93.79, 76.63 | 5.21, 6.81, 3.44 | 0.21, 0.19, 0.17 |
| postgres-sample | 1 | 335.14, 197.39, 180.78 | 10.60, 3.98, 1.98 | 0.24, 0.17, 0.22 |
| postgres-sample | 8 | 125.12, 102.57, 97.45 | 24.93, 8.93, 6.87 | 0.18, 0.16, 0.16 |

The no-op target isolates a baseline for signing, scheduling, loopback networking and assertions without PostgreSQL work; its in-handler mean ranged 0.06–0.26ms. Its assertion is a deliberately fixed benchmark response, not a business correctness demonstration. PostgreSQL rows include ingress, durable jobs and business observation. Total run time includes the 50ms settle window and polling. Request latency includes target handling and local network/scheduling; no subtraction or universal runner-overhead claim is made. Throughput is recorded in generated JSON but includes observation time, so it is not a server capacity estimate.

Raw current-run evidence is generated at `reports/benchmark.json` (ignored). Run the command to obtain fresh values on your own host; results will differ. The clean-checkout correctness suite is separate from this bounded efficiency experiment.
