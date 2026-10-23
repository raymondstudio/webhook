# Checkpoint

Repository: raymondstudio/webhook, feature branch feat/webhook-failure-lab. Initial main:206604f. No unrelated repositories touched. Work is local until a successful push is recorded.

M0 foundation committed as2c9c96b: PRD, ADR, threat model, shared contracts and pinned npm dependencies. Node24.19.0/npm11.9.0, Docker28.4.0, PostgreSQL17.11 and system Chromium work. Official provider/dependency research recorded in docs/research.md. Existing Git HTTPS read works; gh authentication check failed, so PR/API access is not established. No credential values printed.

M1 usable journey verified: `npm run demo` completed11 journeys with3 expected broken business failures,5 corrected delivery scenarios,2 corrected owned-worker crash recoveries and1 separate application adapter pass. Both modes use the same outcome expectations. JSON/HTML/JUnit distinguish HTTP success from business outcome. `npm run typecheck`, `npm run build`, 26 unit tests,20 initial integration tests (3 CLI/report journeys plus17 sample tests) and4 system-Chromium checks passed. Additional bounded child-termination tests independently passed within sample worker's20-test suite; coordinator full rerun pending.

Real workers owned nonoverlapping files; separate agent reviewer inspected independently (role instruction only, no enforced read-only sandbox). Findings fixed: weak-secret early-return redaction, partial report evidence, metadata/reserved IPs, prototype-shaped external identifiers, sample/runner schema alignment and failed child-spawn cleanup. Final independent review pending stable integration commit.

Next: commit usable slice, complete reliability/CI evidence, measured workloads, clean-checkout verification, save tested reusable environment instructions, final independent review and authenticated branch/PR handoff if available. Do not claim remote CI or environment publication without evidence.

M1 commit:e4cc735. Coordinator subsequently confirmed26 unit/23 integration/4 Chromium passes, build/lint and compiled CLI help. Reviewer/coordinator cleanup follow-up added retryable close after an unconfirmed child termination; sample worker confirmed21 focused tests (full integration now expected24; not yet coordinator-rerun). No owned sample schemas remained after completed journeys (pg_namespace count0).

M2 reliability and CI prepared: real signature/association negatives, distinct event/order tests, retry/reorder, child termination failures, recovery before/after commit, independent external persistence and report-XSS/partial-evidence coverage. Bounded measurements recorded from12 actual benchmark runs, with raw generated evidence ignored. CI workflow prepared with PostgreSQL and browser checks; no remote CI run claimed. GitHub repository API request returned Forbidden before and after saving api.github.com in the network draft; API/PR publication remains blocked in the current runtime.

M2 commit:0e8c767. Stable integrated source/tests sent to the independent reviewer with permission to run the real suites. M3 documentation includes a working quickstart, external integration instructions, limits, maintainer walkthrough, actual example report, MIT licence, changelog, release/adoption plan and bounded measurements. Clean-checkout verification and final review are in progress; these are not yet claimed complete.
