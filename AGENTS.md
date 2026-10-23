# Webhook Failure Lab repository instructions

Scope: this repository and explicitly configured disposable test resources only. No real payment keys, production data, deployments, package publication, or unrelated repositories.

For this initial build, use real subagents for the engine/CLI, PostgreSQL sample/integration example, report interface, and a separate independent review. Use nonoverlapping paths in this shared checkout. Coordinator owns contracts, manifests, lockfile, CI, integration tests and merges. Reviewers do not edit or publish; read-only role instructions are not a tool-enforced sandbox.

Ownership: engine worker `src/engine/**`, `src/cli.ts`, `test/unit/engine*`; sample worker `src/sample/**`, `examples/external/**`, `test/integration/sample*`; interface worker `src/report/**`, `test/unit/report*`, `test/ui/**`. Coordinator owns other paths. Agree contract changes with coordinator before implementation. Report changed paths, actual commands/results, assumptions and limitations. Never weaken checks to make them pass.

Node 24 LTS; npm with package-lock.json. Commands: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`, `npm run demo`, `npm run test:ui`. PostgreSQL integration uses DATABASE_URL for a disposable database only. See README for prerequisites.

Invariants: delivery success and business success are separate; no empty assertion pass; seed records planned schedule, not deterministic network order; corrected sample verifies raw-byte HMAC and validates order/amount/currency before side effects; inbox/job/business updates are durable PostgreSQL transactions. Never claim exactly-once external effects. All run resources must be owned and cleaned up. Remote endpoints require explicit origins; no redirects, URL credentials or metadata/link-local access.

Secrets: inspect variable presence only, never dump environment or credential files. Test signing keys only, never live keys. Keep secrets out of URLs, scenario files, logs, reports and Git. Report rendering must escape untrusted text.

Completion: demonstrate broken failures and corrected passes, concurrency, timeout retry, owned worker crash/restart, real PostgreSQL and external adapter. Run meaningful negative tests and browser checks when available. Maintain docs/checkpoint.md; record only observed outcomes. Create focused milestone commits; push/PR only to this repository if supported authentication works. Do not merge, deploy, or publish packages.
