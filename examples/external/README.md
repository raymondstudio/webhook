# Connect a separately configured application

This application imports neither the engine nor bundled PostgreSQL sample. It implements a tiny file-backed order system with a payment-event route and a separate read-only test-state route. The CLI sees only HTTP. Use only synthetic data.

From the repository root, set a dedicated test-only signing key in your shell (not a real provider secret), then start the app:

```sh
export TEST_SIGNING_SECRET='local-synthetic-example-only'
npx tsx examples/external/server.ts
```

In another shell with the same test key:

```sh
node dist/src/cli.js run examples/external/scenario.json --out reports/external
```

The application creates `demo-order` with amount 5000 minor units and currency NGN. Duplicate `external-event` deliveries must leave `{ "status": "paid", "fulfilmentCount": 1 }`. Stop the application with Ctrl-C; its owned temporary directory is removed. Each fresh start creates disposable state. To retain state programmatically, supply an existing directory to `startExternal`; the caller then owns cleanup. Do not run two application processes against one directory.

To connect your application, configure `target` to your webhook and replace each assertion URL with your own read-only test endpoint. It must return a JSON object with a string `status` and nonnegative integer `fulfilmentCount`; choose expected values that encode a meaningful business result. A 200 response from the webhook alone does not pass the assertion. Restrict these introspection endpoints to disposable test environments. Remote origins require explicit `allowedOrigins`; local ports and paths must still belong to you.

The signature is a simulation: SHA-512 HMAC over exact raw request bytes, in `x-paystack-signature`. The event body is this project's synthetic schema, not a provider API or proof of payment. File replacement plus a single-process mutex demonstrates a small independent adapter, not PostgreSQL-grade crash consistency or multi-process correctness. This example does not implement worker-crash hooks; crash testing against this custom target is unsupported. The corrected bundled PostgreSQL sample is the reference recovery exercise.
