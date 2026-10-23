# Webhook Failure Lab

A payment webhook can return 200 and still fulfil an order twice. This local developer tool sends synthetic duplicate, concurrent, delayed and retried notifications, then checks your application's declared business result.

The included demonstration exposes duplicate fulfilment in a deliberately broken PostgreSQL sample and passes the same assertions in corrected mode. It also kills and restarts an owned worker around transaction commit, and tests a separately implemented application through HTTP.

```text
broken-concurrent: failed (expected failed), 10 attempts
corrected-concurrent: passed (expected passed), 10 attempts
corrected-timeout: passed (expected passed), 2 attempts
corrected-crash-before-commit: passed (expected passed), 1 attempts
corrected-crash-after-commit: passed (expected passed), 1 attempts
external-adapter: passed (expected passed), 10 attempts
```

These are observed local demo outcomes. The parent demonstration succeeds only when the expected broken failures and corrected passes are demonstrated. This is a simulation of declared scenarios, not provider infrastructure, proof of payment, production certification or an exactly-once network guarantee. Adoption remains untested.

## Quickstart

Requirements: Node 24 LTS, npm 11, and a disposable PostgreSQL 17 database. Docker is a convenience for local PostgreSQL; the engine and custom applications do not require it. Run commands from this checkout's root.

```sh
npm ci
npm run db:up
npm run build
npm run demo
```

`db:up` creates only a labelled container named `webhook-failure-lab-postgres`, on loopback port 55432, with disposable database/user/password `lab`. Its storage is ephemeral. The sample uses a random isolated schema for each application and removes its own schema, worker and HTTP server after the journey. To use your own **disposable** database instead, skip `db:up` and export `DATABASE_URL` with schema-creation permissions. Never use a production database.

The demo runs 11 journeys, including 3 expected broken failures. Open `reports/demo/corrected-concurrent/report.html` as a local file; JSON and JUnit are alongside it. Reports are static and work in a phone browser after transferring the file. Run the Node CLI on a computer, cloud workspace or CI host. The generated [example report](docs/example-report.html) records one actual local run.

Cleanup: `npm run db:down` removes only the labelled lab container. The demo overwrites its fixed 11 report directories; the CLI overwrites three files in its chosen output directory. Delete generated `reports/` when no longer needed. No hosted history is retained.

## Test your application

A complete independent example is in [examples/external](examples/external/README.md). It imports neither the engine nor the PostgreSQL sample. In one shell:

```sh
export TEST_SIGNING_SECRET='local-synthetic-example-only'
npx tsx examples/external/server.ts
```

In another shell, from this root:

```sh
export TEST_SIGNING_SECRET='local-synthetic-example-only'
node dist/src/cli.js run examples/external/scenario.json --out reports/external
```

Replace the scenario's `target`, events and assertion URL with your own explicitly owned test resources. The runner POSTs the synthetic event as JSON, signed using SHA512 HMAC over **exact raw bytes** in `x-paystack-signature`. The environment binding supplies a dedicated test key of 16–4096 characters. Never use a live provider key. `.env.example` documents variables; the CLI does not automatically load `.env` files.

A read-only assertion endpoint must return:

```json
{ "status": "paid", "fulfilmentCount": 1 }
```

Choose expectations that reflect your actual business invariant. The runner polls after deliveries and requires a continuous matching `settleMs` observation window. A mismatch by deadline fails; invalid JSON, unavailable adapters and timeouts are errors. A transient match is insufficient. Checks cover the declared window, not arbitrary future background work: use an application-defined completion status and a suitable window. Missing assertions are rejected. No arbitrary adapter code is loaded; in-process code you add yourself would be trusted local code.

Exit codes: **0** all assertions passed; **1** valid business state failed expectations; **2** configuration, transport, adapter or execution error; **130** cancellation. Retry attempts and HTTP successes are reported separately from business success. A final delivery error prevents a passing run even when an adapter is healthy.

## Scenario format and bounds

[The external scenario](examples/external/scenario.json) is a complete configuration. Public reusable functions are `parseConfig` and `runScenario` in `src/engine/index.ts`, `makeScenario` in `src/scenarios.ts`, and `writeReports` in `src/report/index.ts`. Shared v1 contracts are in `src/contracts.ts`. Only POST delivery and GET assertion inspection are supported; unexpected fields/methods are rejected.

| Setting | Behavior / enforced bound |
| --- | --- |
| `version`, `name`, `seed` | Version 1; labels 160 characters, seed 128. No random plan generation: explicit identities and schedules plus the seed label reproduce the plan. |
| `events` | 1–100 synthetic events, unique IDs 1–128 characters (`A-Z a-z 0-9 _ . : -`, excluding exact `.`/`..`), `payment.succeeded` or `payment.pending`, positive safe integer minor-unit amount, uppercase 3-letter currency. |
| `deliveries` | 1–500 references to event IDs with explicit `atMs` offsets. At most64KiB per encoded event. |
| `concurrency` | 1–16, default 1. Actual concurrent start/completion order is not deterministic. |
| `retry` | `maxAttempts` 1–5 (including first), default 2; `delayMs` 0–5000, default 50. No uncontrolled retries. |
| `requestTimeoutMs` | 20–10000, default 1000. Response body bounded to64KiB. |
| `deadlineMs` | 100–60000, default 5000; schedules must leave room for a request and observation. |
| `assertions` | 1–16 uniquely named executable checks; `settleMs`50–10000, default 200, shorter than deadline. |
| `allowedOrigins` | Empty by default; explicit exact remote test origins, max 16. Query strings, credentials, fragments and redirects are rejected. |
| `signingSecretEnv` | Name of exported local test signing key, default `LAB_SIGNING_SECRET`; never a value in the scenario. |

The bundled scenarios cover sequential duplicates, concurrent duplicates, delayed/reordered sample state, explicit HTTP500 with retry, and an ambiguous timeout **after a committed side effect**. Timeout injection withholds the acknowledgement until the client times out; it does not pretend a failed connection proves the side effect happened. Controlled crashes are owned-child harness operations, not remotely callable endpoints. Custom applications without opt-in crash control have **unsupported crash testing**; their ordinary HTTP assertions can still run.

## Sample correctness boundary

Sample orders have integer amounts/currency and state `awaiting -> paid`; paid is terminal. A late synthetic pending event cannot regress a paid order. These are this sample's states, not an invented Paystack pending-event schema or universal last-timestamp-wins rule.

Corrected ingress verifies signature and association before storing inbox+job in one PostgreSQL transaction. The child worker locks the pending job and order, writes one order fulfilment, advances state, and completes the job **in the same transaction**. The inbox event identity and unique per-order ledger prevent duplicate local fulfilment. An inconsistent reuse of an event ID returns 409. Before-commit worker termination rolls back changes and leaves durable pending work; after-commit termination preserves completed work.

Broken mode intentionally records a side effect per delivery and allows old pending observations to regress paid state. It is isolated in disposable schemas and never a recommended handler. Exactly-once external shipping/email/money movement would also need an idempotent destination or reconciliation; this local ledger cannot establish that guarantee.

## Security and limitations

Use only your own local/disposable targets. Remote origins require explicit allowlisting; private/reserved, metadata and link-local destinations are blocked. DNS is validated and pinned for each request and redirects are not followed. Loopback access is deliberate: review the exact ports and paths to avoid unrelated local services. An allowlist is not proof of ownership. Never expose this CLI as a public arbitrary-URL service.

Reports include only whitelisted synthetic event metadata, timing, configured outcomes and observed evidence. They omit signing bindings/values, raw headers, arbitrary bodies and URL credentials/queries. All HTML/XML text is escaped. Do not put secrets or customer data into event identifiers or labels. Local config and added in-process adapters are trusted code. See [threat model](docs/threat-model.md) and [primary-source research](docs/research.md).

The separate file-backed example uses a single-process mutex and atomic file replacement; it does not claim PostgreSQL-grade crash consistency or multi-process safety. A CLI pass tests only the supplied expectations within a bounded observation window. Provider adapters beyond the synthetic HMAC convention, remote crash hooks and hosted execution are not included.

## Validate and contribute

```sh
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run test:built
npm run test:ui
npm run demo
npm run benchmark
```

`test:built` repeats the CLI/report journeys against compiled JavaScript and compiled owned workers. Integration tests require real PostgreSQL and fail if it is absent. They assert both expected broken behavior and corrected invariants; no database mocks replace recovery/concurrency checks. UI tests use `/usr/bin/chromium` when available, otherwise install the pinned Playwright browser with `npx playwright install chromium` (Linux dependencies may also be required). CI installs browser dependencies explicitly. [CI](.github/workflows/ci.yml) runs on PRs/main with read-only permissions, SHA-pinned actions, a pinned PostgreSQL image and failure artifacts. Local results do not establish remote CI status.

See [maintainer walkthrough](docs/maintainer-walkthrough.md), [architecture](docs/architecture.md), [checkpoint](docs/checkpoint.md), [measured workloads](docs/measurements.md), [release checklist](docs/release-checklist.md) and [contribution instructions](AGENTS.md). MIT was chosen to permit reuse in proprietary test applications; copyright is Raymond Iorliam's. Dependency licences remain with their respective authors. This initial implementation was developed with AI assistance and independently reviewed by another agent; that is not a human audit.

## Troubleshooting

- **Database setup failure:** ensure `DATABASE_URL` points only to a disposable PostgreSQL database with schema create/drop rights; run `npm run db:up` for the default. Port55432 must be free. `db:down` destroys the lab database.
- **Signing-key error:** export the environment variable named in the scenario in both shells. Values must be 16–4096 characters. Keys are never inferred from HTTP success.
- **Denied target:** check exact allowed origin and DNS destination. Metadata/private ranges and redirects remain blocked even when listed. A URL query/credential is not a supported secret transport.
- **Expected broken failure:** demo prints `failed (expected failed)` for broken business outcomes and exits successfully only when the demonstration behaves as designed. The CLI on a failing assertion exits1.
- **No browser binary:** install the pinned Playwright Chromium or configure CI; no visual verification is claimed when unrun.
- **Child startup/cleanup error:** ensure the host supports owned Node child processes and database connectivity. A cleanup failure retains uncertain resources instead of deleting unrelated data; inspect the reported error before retrying.
