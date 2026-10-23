# Threat model

Trusted: local scenario author, local CLI process, sample harness and database administrator. Untrusted: target HTTP responses, assertion data, report labels and event content. This is a local single-user tool, not a hosted arbitrary-URL service; do not upload untrusted plugins or run untrusted config without review.

Network: target and adapter URLs are exact configured endpoints, loopback by default. Remote test origins require explicit allowlisting. Reject credentials, non-HTTP(S), link-local/metadata/reserved destinations and redirects. Resolve and validate DNS at request time; bind the validated address to the connection to avoid rebinding. Local access is deliberate and cannot distinguish every unrelated service at the same host; review configured ports/paths and run only against owned disposable endpoints. Remote allowlisting is authorization configuration, not proof of ownership.

Secrets: test-only signing environment binding; no values in config/reports/logs. HMAC over raw bytes and timing-safe comparison precede side effects. Database URLs stay in the process environment. Reports omit request bodies/headers and scrub URLs. A report may still include synthetic order identifiers; do not use customer data.

Abuse/resource risks: schema bounds all schedules, requests, attempts, concurrency, duration and payload size. Bound response reads; abort on cancellation/deadline; cleanup child processes, server sockets and owned schemas. Never expose a remote kill/reset endpoint. Retention is user-controlled report output; cap files for demo history and document cleanup.

Correctness risks: HTTP 200 with lost processing, duplicate side effects, race on distinct events for one order, ambiguous response loss, malformed/errored assertions, regression on reordered events and crash around commit. Test each with real PostgreSQL. Prevent report XSS by escaping all text; no injected raw HTML or inline data execution.

Residual: arbitrary trusted local configuration can target an unintended loopback service. A local fulfilment ledger does not guarantee external side effects. Synthetic HMAC fixtures do not verify real payments or emulate provider infrastructure.
