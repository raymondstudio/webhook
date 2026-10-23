# Build Webhook Failure Lab with executable business assertions

A webhook acknowledgement can hide duplicate or missing fulfilment. This change adds a local TypeScript CLI that sends bounded synthetic duplicate, concurrent, reordered and retried events, then polls a developer's read-only business assertion endpoint. Static JSON/HTML/JUnit reports distinguish HTTP delivery from observed business outcomes.

The disposable PostgreSQL sample deliberately fails duplicate assertions in broken mode and passes them in corrected mode using durable inbox/jobs and transactional per-order fulfilment. An owned child-process harness verifies recovery before/after commit. A separate file-backed application demonstrates integration through HTTP without sample/engine imports. Network restrictions, cancellation, strict bounds, signature/association checks, escaping and partial-evidence rejection are included.

Validation from a fresh checkout: frozen npm install; lint/typecheck/build; 32 unit, 26 real PostgreSQL/CLI integration, 3 compiled CLI journey and4 Chromium UI tests passed; all 11 demo journeys verified, including 3 expected broken business failures. Separate agent review found and verified fixes including database-URL isolation, redaction and partial report evidence. Pinned PR/main CI reproduces the workflow; remote CI status is not inferred from local results.

Boundaries: synthetic scenarios only, bounded observation windows, no real payments or exactly-once external-effect guarantee. External file storage is single-process, and its crash testing is unsupported. No deployment or npm publication. README includes quickstart, independent adapter, measured workloads, security limits and maintainer walkthrough.
