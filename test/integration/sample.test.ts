import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startExternal } from "../../examples/external/server.js";
import type { SyntheticEvent } from "../../src/contracts.js";
import { type SampleHandle, startSample } from "../../src/sample/index.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://lab:lab@127.0.0.1:55432/lab";
const secret = "disposable-sample-integration-test-key";
const event: SyntheticEvent = {
  id: "payment-1",
  type: "payment.succeeded",
  orderId: "order-1",
  amount: 5000,
  currency: "NGN",
};

function post(
  baseUrl: string,
  input: SyntheticEvent = event,
  options: { secret?: string; fault?: string; signal?: AbortSignal; path?: string } = {},
) {
  const raw = JSON.stringify(input);
  return fetch(`${baseUrl}${options.path ?? "/webhook"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paystack-signature": createHmac("sha512", options.secret ?? secret)
        .update(raw)
        .digest("hex"),
      ...(options.fault ? { "x-lab-fault": options.fault } : {}),
    },
    body: raw,
    signal: options.signal ?? AbortSignal.timeout(5000),
  });
}

async function sample(
  mode: "broken" | "corrected",
  callback: (app: SampleHandle) => Promise<void>,
  enableFaults = false,
) {
  const app = await startSample({ databaseUrl, mode, secret, enableFaults });
  try {
    await app.createOrder({ id: event.orderId, amount: event.amount, currency: event.currency });
    await callback(app);
  } finally {
    await app.close();
  }
}

for (const mode of ["broken", "corrected"] as const) {
  test(`${mode}: sequential duplicate exposes or prevents repeated fulfilment`, async () => {
    await sample(mode, async (app) => {
      for (let index = 0; index < 3; index++) assert.equal((await post(app.baseUrl)).status, 200);
      await app.waitForIdle();
      assert.deepEqual(await app.inspect(event.orderId), {
        status: "paid",
        fulfilmentCount: mode === "corrected" ? 1 : 3,
      });
      const response = await fetch(`${app.baseUrl}/orders/${event.orderId}`);
      assert.deepEqual(await response.json(), await app.inspect(event.orderId));
    });
  });

  test(`${mode}: ten concurrent deliveries expose or prevent duplicate side effects`, async () => {
    await sample(mode, async (app) => {
      const responses = await Promise.all(Array.from({ length: 10 }, () => post(app.baseUrl)));
      assert.ok(responses.every((response) => response.status === 200));
      await app.waitForIdle();
      assert.deepEqual(await app.inspect(event.orderId), {
        status: "paid",
        fulfilmentCount: mode === "corrected" ? 1 : 10,
      });
    });
  });

  test(`${mode}: ambiguous timeout is after a business commit, then bounded retry`, async () => {
    await sample(
      mode,
      async (app) => {
        await assert.rejects(
          post(app.baseUrl, event, {
            fault: "timeout-after-commit-once",
            signal: AbortSignal.timeout(200),
          }),
        );
        await app.waitForIdle();
        assert.equal(
          (await app.inspect(event.orderId)).fulfilmentCount,
          1,
          "first request committed before its acknowledgement was lost",
        );
        assert.equal(
          (await post(app.baseUrl, event, { fault: "timeout-after-commit-once" })).status,
          200,
        );
        await app.waitForIdle();
        assert.equal(
          (await app.inspect(event.orderId)).fulfilmentCount,
          mode === "corrected" ? 1 : 2,
        );
      },
      true,
    );
  });
}

test("corrected: distinct valid events and orders are not globally deduplicated", async () => {
  await sample("corrected", async (app) => {
    await app.createOrder({ id: "order-2", amount: 5000, currency: "NGN" });
    const events = [
      event,
      { ...event, id: "payment-2", orderId: "order-2" },
      { ...event, id: "payment-3" },
    ];
    assert.ok(
      (await Promise.all(events.map((input) => post(app.baseUrl, input)))).every(
        (response) => response.status === 200,
      ),
    );
    await app.waitForIdle();
    assert.equal((await app.inspect("order-1")).fulfilmentCount, 1);
    assert.equal((await app.inspect("order-2")).fulfilmentCount, 1);
  });
});

test("corrected: rejects signature, amount, currency, order association and conflicting identities without side effects", async () => {
  await sample("corrected", async (app) => {
    assert.equal((await post(app.baseUrl, event, { secret: "wrong-synthetic-key" })).status, 401);
    for (const id of [".", ".."]) {
      await assert.rejects(() => app.createOrder({ id, amount: 5000, currency: "NGN" }));
      assert.equal((await post(app.baseUrl, { ...event, id })).status, 400);
    }
    for (const invalid of [
      { ...event, amount: 4999 },
      { ...event, currency: "USD" },
      { ...event, orderId: "missing-order" },
    ])
      assert.equal((await post(app.baseUrl, invalid)).status, 422);
    assert.equal((await post(app.baseUrl, { ...event, amount: -1 })).status, 400);
    assert.deepEqual(await app.inspect(event.orderId), { status: "awaiting", fulfilmentCount: 0 });
    assert.equal((await post(app.baseUrl)).status, 200);
    await app.createOrder({ id: "different-order", amount: 5000, currency: "NGN" });
    assert.equal((await post(app.baseUrl, { ...event, orderId: "different-order" })).status, 409);
    await app.waitForIdle();
    assert.equal((await app.inspect("different-order")).fulfilmentCount, 0);
    assert.equal((await app.inspect(event.orderId)).fulfilmentCount, 1);
  });
});

test("corrected: signature covers raw bytes, not parsed or reserialized JSON", async () => {
  await sample("corrected", async (app) => {
    const raw = JSON.stringify(event, null, 2);
    const compactSignature = createHmac("sha512", secret)
      .update(JSON.stringify(event))
      .digest("hex");
    const rejected = await fetch(`${app.baseUrl}/webhook`, {
      method: "POST",
      body: raw,
      headers: { "x-paystack-signature": compactSignature },
    });
    assert.equal(rejected.status, 401);
    const accepted = await fetch(`${app.baseUrl}/webhook`, {
      method: "POST",
      body: raw,
      headers: { "x-paystack-signature": createHmac("sha512", secret).update(raw).digest("hex") },
    });
    assert.equal(accepted.status, 200);
    await app.waitForIdle();
    assert.equal((await app.inspect(event.orderId)).fulfilmentCount, 1);
  });
});

test("corrected: reordered old pending event cannot regress terminal paid", async () => {
  await sample("corrected", async (app) => {
    assert.equal((await post(app.baseUrl)).status, 200);
    await app.waitForIdle();
    assert.equal(
      (await post(app.baseUrl, { ...event, id: "old-pending", type: "payment.pending" })).status,
      200,
    );
    await app.waitForIdle();
    assert.deepEqual(await app.inspect(event.orderId), { status: "paid", fulfilmentCount: 1 });
  });
});

test("corrected: injected HTTP failure precedes all side effects and succeeds once on retry", async () => {
  await sample(
    "corrected",
    async (app) => {
      assert.equal((await post(app.baseUrl, event, { fault: "http-500-once" })).status, 500);
      assert.deepEqual(await app.inspect(event.orderId), {
        status: "awaiting",
        fulfilmentCount: 0,
      });
      assert.equal((await post(app.baseUrl, event, { fault: "http-500-once" })).status, 200);
      await app.waitForIdle();
      assert.equal((await app.inspect(event.orderId)).fulfilmentCount, 1);
    },
    true,
  );
});

test("sample failure injection is disabled unless explicitly enabled", async () => {
  await sample("corrected", async (app) => {
    assert.equal((await post(app.baseUrl, event, { fault: "http-500-once" })).status, 400);
    assert.deepEqual(await app.inspect(event.orderId), { status: "awaiting", fulfilmentCount: 0 });
    assert.equal((await fetch(`${app.baseUrl}/kill`, { method: "POST" })).status, 404);
  });
});

for (const checkpoint of ["before-commit", "after-commit"] as const) {
  test(`corrected: actual owned worker crash ${checkpoint} recovers without duplicate fulfilment`, async () => {
    await sample("corrected", async (app) => {
      await app.stopWorker();
      await app.startWorker({ pauseAt: checkpoint });
      assert.equal((await post(app.baseUrl)).status, 200);
      assert.deepEqual(await app.waitForCheckpoint(), { checkpoint, eventId: event.id });
      const beforeCrash = await app.inspect(event.orderId);
      assert.equal(beforeCrash.fulfilmentCount, checkpoint === "before-commit" ? 0 : 1);
      await app.stopWorker();
      await app.startWorker();
      await app.waitForIdle();
      // Redelivery after restart tests inbox durability as well as the unfinished job.
      assert.equal((await post(app.baseUrl)).status, 200);
      await app.waitForIdle();
      assert.deepEqual(await app.inspect(event.orderId), { status: "paid", fulfilmentCount: 1 });
    });
  });
}

test("sample close is idempotent and closes its owned HTTP service", async () => {
  const app = await startSample({ databaseUrl, mode: "corrected", secret });
  await app.close();
  await app.close();
  await assert.rejects(fetch(`${app.baseUrl}/health`, { signal: AbortSignal.timeout(500) }));
});

test("separate file-backed application persists duplicate identity and read-only adapter across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "external-persistence-test-"));
  let app = await startExternal({ secret, directory });
  try {
    await app.createOrder({ id: event.orderId, amount: event.amount, currency: event.currency });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => post(app.baseUrl, event, { path: "/payment-events" })),
    );
    assert.ok(responses.every((response) => response.status === 200));
    await app.close();
    app = await startExternal({ secret, directory });
    assert.equal((await post(app.baseUrl, event, { path: "/payment-events" })).status, 200);
    const state = await fetch(`${app.baseUrl}/test-state/${event.orderId}`);
    assert.deepEqual(await state.json(), { status: "paid", fulfilmentCount: 1 });
    assert.equal(
      (await post(app.baseUrl, event, { path: "/payment-events", secret: "bad-signature-secret" }))
        .status,
      401,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate adapter treats prototype-shaped identifiers as stored data", async () => {
  const app = await startExternal({ secret });
  try {
    for (const id of [".", ".."]) {
      await assert.rejects(async () => app.createOrder({ id, amount: 5000, currency: "NGN" }));
    }
    await app.createOrder({ id: "__proto__", amount: 5000, currency: "NGN" });
    const prototypeEvent: SyntheticEvent = { ...event, id: "__proto__", orderId: "__proto__" };
    for (let index = 0; index < 2; index++)
      assert.equal(
        (await post(app.baseUrl, prototypeEvent, { path: "/payment-events" })).status,
        200,
      );
    const response = await fetch(`${app.baseUrl}/test-state/__proto__`);
    assert.deepEqual(await response.json(), { status: "paid", fulfilmentCount: 1 });
  } finally {
    await app.close();
  }
});

test("failed child termination retains schema, closes HTTP and permits a later cleanup retry", async () => {
  const { ChildProcess } = await import("node:child_process");
  const { default: pg } = await import("pg");
  const inspector = new pg.Pool({ connectionString: databaseUrl });
  const schemas = async () =>
    (
      await inspector.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'lab_%'",
      )
    ).rows.map((row) => row.nspname);
  const app = await startSample({ databaseUrl, mode: "corrected", secret });
  const ownedSchema = app.schemaName;
  assert.match(ownedSchema, /^lab_[a-f0-9]{32}$/);
  const actualKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = () => false; // Exercise a real worker whose signal could not be sent.
  try {
    const firstClose = app.close();
    const concurrentClose = app.close();
    const results = await Promise.allSettled([firstClose, concurrentClose]);
    assert.ok(results.every((result) => result.status === "rejected"));
    const failure = results[0];
    assert.ok(failure?.status === "rejected" && /schema retained/.test(String(failure.reason)));
    assert.ok(
      (await schemas()).includes(ownedSchema),
      "uncertain child may still mutate its schema",
    );
    await assert.rejects(
      fetch(`${app.baseUrl}/health`, { signal: AbortSignal.timeout(500) }),
      "HTTP listener closes even while worker termination is uncertain",
    );
    await assert.rejects(app.startWorker(), /Stop the owned worker|closing/);
  } finally {
    ChildProcess.prototype.kill = actualKill;
    await app.close();
    await app.close();
    try {
      assert.ok(
        !(await schemas()).includes(ownedSchema),
        "retry removed only the owned schema after confirmed child exit",
      );
    } finally {
      await inspector.end();
    }
  }
});

test("database URI startup options cannot escape the owned schema or override required bounds", async () => {
  const { default: pg } = await import("pg");
  const { newSchema, samplePoolConfig, scopedPool } = await import("../../src/sample/database.js");
  const decoy = newSchema();
  const inspector = new pg.Pool(samplePoolConfig(databaseUrl));
  const escapedUrl = new URL(databaseUrl);
  escapedUrl.searchParams.set(
    "options",
    `-c search_path=${decoy} -c statement_timeout=0 -c lock_timeout=0`,
  );
  escapedUrl.searchParams.set("search_path", decoy);
  escapedUrl.searchParams.set("statement_timeout", "0");
  escapedUrl.searchParams.set("lock_timeout", "0");
  escapedUrl.searchParams.set("connectionTimeoutMillis", "0");
  escapedUrl.searchParams.set("connectionString", "postgresql://unused:unused@127.0.0.1:1/unused");
  let app: SampleHandle | undefined;
  let decoyCreated = false;
  try {
    await inspector.query(`CREATE SCHEMA ${decoy}`);
    decoyCreated = true;
    await inspector.query(`CREATE TABLE ${decoy}.sentinel(value text NOT NULL)`);
    await inspector.query(`INSERT INTO ${decoy}.sentinel(value) VALUES('unchanged')`);
    app = await startSample({ databaseUrl: escapedUrl.href, mode: "corrected", secret });
    const sampleSchema = app.schemaName;
    assert.notEqual(sampleSchema, decoy);
    const tables = async (schema: string) =>
      (
        await inspector.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
          [schema],
        )
      ).rows.map((row) => row.tablename);
    assert.deepEqual(await tables(sampleSchema), ["fulfilments", "inbox", "jobs", "orders"]);
    assert.deepEqual(await tables(decoy), ["sentinel"]);
    const scoped = scopedPool(escapedUrl.href, sampleSchema);
    try {
      const settings = await scoped.query<{ schema: string; statement: string; lock: string }>(
        "SELECT current_schema() AS schema, current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock",
      );
      assert.deepEqual(settings.rows[0], { schema: sampleSchema, statement: "10s", lock: "5s" });
    } finally {
      await scoped.end();
    }
    await app.createOrder({ id: event.orderId, amount: event.amount, currency: event.currency });
    assert.equal((await post(app.baseUrl)).status, 200);
    await app.waitForIdle();
    assert.deepEqual(await app.inspect(event.orderId), { status: "paid", fulfilmentCount: 1 });
    await app.close();
    app = undefined;
    assert.deepEqual(await tables(sampleSchema), []);
    assert.deepEqual(await tables(decoy), ["sentinel"]);
    assert.deepEqual((await inspector.query(`SELECT value FROM ${decoy}.sentinel`)).rows, [
      { value: "unchanged" },
    ]);
  } finally {
    try {
      await app?.close();
      // Only a schema whose successful creation was observed belongs to this test.
      if (decoyCreated) await inspector.query(`DROP SCHEMA ${decoy} CASCADE`);
    } finally {
      await inspector.end();
    }
  }
});

test("sanitized database config preserves TLS identity while ignoring connection/query overrides", async () => {
  const { newSchema, samplePoolConfig } = await import("../../src/sample/database.js");
  const schema = newSchema();
  const config = samplePoolConfig(
    "postgresql://test-user:test-password@db.example:6432/test-db?sslmode=verify-full&sslnegotiation=direct&application_name=lab-test&options=-c%20search_path%3Dother&connectionString=postgresql%3A%2F%2Funused%2Funused&statement_timeout=0&lock_timeout=0&connectionTimeoutMillis=0&query_timeout=0",
    schema,
  );
  assert.equal(config.connectionString, undefined);
  assert.equal(config.host, "db.example");
  assert.equal(config.port, 6432);
  assert.equal(config.user, "test-user");
  assert.equal(config.password, "test-password");
  assert.equal(config.database, "test-db");
  assert.ok(typeof config.ssl === "object" && config.ssl !== null);
  // verify-full enables TLS with Node's default certificate and hostname checks.
  assert.deepEqual(Object.keys(config.ssl), []);
  assert.equal(config.sslnegotiation, "direct");
  assert.equal(config.application_name, "lab-test");
  assert.equal(config.connectionTimeoutMillis, 5000);
  assert.equal(config.statement_timeout, 10000);
  assert.equal(config.lock_timeout, 5000);
  assert.equal(config.query_timeout, undefined);
  assert.equal(
    config.options,
    `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`,
  );
  assert.equal(config.sslnegotiation, "direct");
  assert.ok(
    typeof config.ssl === "object" &&
      config.ssl !== null &&
      config.ssl.rejectUnauthorized !== false,
  );
  const plaintext = samplePoolConfig("postgresql://test-user@db.example/test-db?sslmode=disable");
  assert.equal(plaintext.ssl, false);
  assert.match(plaintext.options ?? "", /search_path=pg_catalog/);
});
