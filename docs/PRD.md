# Product requirements

A local developer tool for testing declared payment-notification outcomes under duplicate, concurrent, delayed, retried and interrupted processing. Primary user: a developer implementing a payment webhook; secondary user: a maintainer running regression checks in CI.

First journey: start disposable PostgreSQL; run the bundled demo; observe duplicate fulfilment in broken mode, one fulfilment in corrected mode, and a report that separates HTTP acknowledgements from actual business assertions. A separate test application demonstrates the read-only JSON assertion contract without importing sample code.

M0: record capabilities, architecture, threat model and shared interfaces, pinned toolchain and CI. M1: run a sequential-duplicate vertical slice with persistent state, executable assertions and HTML/JSON evidence. M2: exercise concurrency, synthetic ordering, HTTP failure, ambiguous timeout and controlled worker restart; validate negative paths and external adapter. M3: readable responsive report, quickstart, bounded config validation and CI. M4: independent review, clean-checkout reproduction, measurements, release checklist and reviewable commits/PR if authenticated writes are available.

Acceptance: same assertions fail for intentionally broken duplicates and pass for corrected processing; distinct orders process independently; wrong signature, association, amount/currency cannot fulfil; terminal paid state does not regress; persisted work survives worker restart at defined checkpoints; adapter/transport/config/cancellation failures never become green; malicious report content is text; fresh migrations and separately configured app work. All checks use synthetic local state. CI configuration is not evidence of an executed remote CI run.

Non-goals: production certification, universal provider emulation, network exactly-once guarantees, live payments, hosted arbitrary-target execution, accounts, billing, AI integration or paid services. Phone browsers can view reports; Node services run on a computer/cloud/CI host. Adoption and demand remain untested.
