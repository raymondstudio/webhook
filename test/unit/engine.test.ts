import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ScenarioConfig } from "../../src/contracts.js";
import { parseConfig, runScenario } from "../../src/engine/index.js";
import { isPublicAddress, validateEndpoint } from "../../src/engine/network.js";

const secret = "lab-unit-only-signing-secret-1234";
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const app = createServer(handler);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  return {
    url,
    close: async () => {
      app.closeAllConnections();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    },
  };
}
function fixture(url = "http://127.0.0.1:9000"): ScenarioConfig {
  return {
    version: 1,
    name: "unit journey",
    seed: "unit-seed",
    target: `${url}/webhook`,
    allowedOrigins: [],
    signingSecretEnv: "LAB_SIGNING_SECRET",
    events: [
      {
        id: "event-1",
        type: "payment.succeeded",
        orderId: "order-1",
        amount: 5000,
        currency: "NGN",
      },
    ],
    deliveries: [
      { eventId: "event-1", atMs: 0 },
      { eventId: "event-1", atMs: 0 },
    ],
    assertions: [
      {
        name: "one fulfilment",
        url: `${url}/state`,
        expected: { status: "paid", fulfilmentCount: 1 },
        settleMs: 50,
      },
    ],
    concurrency: 2,
    requestTimeoutMs: 100,
    deadlineMs: 400,
    retry: { maxAttempts: 2, delayMs: 5 },
  };
}

test("configuration rejects missing assertions, unsupported fields and excessive bounds", () => {
  for (const patch of [
    { assertions: [] },
    { method: "DELETE" },
    { concurrency: 17 },
    { deadlineMs: 60_001 },
    { requestTimeoutMs: 0 },
    { retry: { maxAttempts: 6, delayMs: 1 } },
    { events: [] },
    { deliveries: [] },
    { version: 2 },
    { events: [{ ...fixture().events[0], secret: "should-not-be-accepted" }] },
    { events: [{ ...fixture().events[0], amount: 1.1 }] },
  ])
    assert.throws(() => parseConfig({ ...fixture(), ...patch }));
});

test("configuration validates references, unique identities, URLs and enough observation time", () => {
  assert.throws(() =>
    parseConfig({ ...fixture(), events: [fixture().events[0], fixture().events[0]] }),
  );
  assert.throws(() => parseConfig({ ...fixture(), deliveries: [{ eventId: "missing", atMs: 0 }] }));
  assert.throws(() =>
    parseConfig({ ...fixture(), deliveries: [{ eventId: "event-1", atMs: 350 }] }),
  );
  assert.throws(() =>
    parseConfig({ ...fixture(), assertions: [fixture().assertions[0], fixture().assertions[0]] }),
  );
  for (const target of [
    "file:///tmp/test",
    "http://user:password@localhost:9000/",
    "http://localhost:9000/?token=bad",
    "https://example.com/webhook",
  ]) {
    assert.throws(() => parseConfig({ ...fixture(), target }));
  }
  assert.throws(() => parseConfig({ ...fixture(), allowedOrigins: ["https://example.com/"] }));
  assert.doesNotThrow(() =>
    validateEndpoint("https://example.com/webhook", ["https://example.com"]),
  );
  assert.throws(() =>
    parseConfig({
      ...fixture("https://example.com"),
      allowedOrigins: ["https://example.com"],
      deliveries: [{ eventId: "event-1", atMs: 0, fault: "http-500-once" }],
    }),
  );
});

test("network policy blocks metadata, private, reserved, multicast and mapped IPv6 addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.100.100.200",
    "169.254.169.254",
    "168.63.129.16",
    "172.16.1.2",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:169.254.169.254",
    "fe80::1",
    "fd00::1",
    "2001:db8::1",
    "2001:2::1",
    "2002:c000:0201::1",
    "3fff::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
    const encoded = address.includes(":") ? `[${address}]` : address;
    if (address !== "::1")
      assert.throws(
        () => validateEndpoint(`http://${encoded}/webhook`, [`http://${encoded}`]),
        address,
      );
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.doesNotThrow(() => validateEndpoint("http://127.0.0.1:1234/webhook", []));
});

test("raw bytes are HMAC signed; HTTP and business success remain distinct", async () => {
  let deliveries = 0;
  const app = await server((req, res) => {
    if (req.method === "GET") {
      res.end(JSON.stringify({ status: "paid", fulfilmentCount: 1 }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      assert.equal(
        req.headers["x-paystack-signature"],
        createHmac("sha512", secret).update(raw).digest("hex"),
      );
      assert.equal(JSON.parse(raw.toString()).id, "event-1");
      deliveries++;
      res.end("accepted");
    });
  });
  try {
    const report = await runScenario(fixture(app.url), { secret });
    assert.equal(report.outcome, "passed");
    assert.equal(deliveries, 2);
    assert.equal(report.attempts.length, 2);
    assert.ok(report.attempts.every((attempt) => attempt.outcome === "http-success"));
    assert.ok(report.assertions[0] && report.assertions[0].observations >= 2);
    assert.equal(report.seed, "unit-seed");
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal("signingSecretEnv" in report.config, false);
  } finally {
    await app.close();
  }
});

test("acknowledged duplicate fulfilment fails executable outcome assertions", async () => {
  let count = 0;
  const app = await server((req, res) => {
    if (req.method === "GET") res.end(JSON.stringify({ status: "paid", fulfilmentCount: count }));
    else {
      count++;
      req.resume();
      res.end("accepted");
    }
  });
  try {
    const report = await runScenario(fixture(app.url), { secret });
    assert.equal(report.outcome, "failed");
    assert.equal(report.assertions[0]?.actual?.fulfilmentCount, 2);
    assert.equal(report.assertions[0]?.outcome, "failed");
    assert.ok(report.attempts.every((attempt) => attempt.status === 200));
  } finally {
    await app.close();
  }
});

test("assertions require a stable observation window, rather than a transient early match", async () => {
  let reads = 0;
  const app = await server((req, res) => {
    req.resume();
    if (req.method === "GET") {
      reads++;
      res.end(JSON.stringify({ status: "paid", fulfilmentCount: reads === 1 ? 1 : 2 }));
    } else res.end("accepted");
  });
  try {
    assert.equal((await runScenario(fixture(app.url), { secret })).outcome, "failed");
  } finally {
    await app.close();
  }
});

test("bounded retry records explicit failure then successful acknowledgement", async () => {
  let sends = 0;
  const app = await server((req, res) => {
    req.resume();
    if (req.method === "GET") res.end(JSON.stringify({ status: "paid", fulfilmentCount: 1 }));
    else {
      sends++;
      res.statusCode = sends === 1 ? 500 : 200;
      res.end("synthetic");
    }
  });
  try {
    const config = fixture(app.url);
    config.deliveries = config.deliveries.slice(0, 1);
    const report = await runScenario(config, { secret });
    assert.equal(report.outcome, "passed");
    assert.deepEqual(
      report.attempts.map((item) => item.status),
      [500, 200],
    );
  } finally {
    await app.close();
  }
});

test("ambiguous timeout can retry without claiming a business pass until adapter is checked", async () => {
  let sends = 0;
  const app = await server((req, res) => {
    req.resume();
    if (req.method === "GET") res.end(JSON.stringify({ status: "paid", fulfilmentCount: 1 }));
    else {
      sends++;
      if (sends > 1) res.end("accepted after ambiguity");
    }
  });
  try {
    const config = fixture(app.url);
    config.deliveries = config.deliveries.slice(0, 1);
    config.deadlineMs = 700;
    const report = await runScenario(config, { secret });
    assert.equal(report.outcome, "passed");
    assert.deepEqual(
      report.attempts.map((item) => item.outcome),
      ["timeout", "http-success"],
    );
  } finally {
    await app.close();
  }
});

for (const [label, status, body] of [
  ["invalid JSON", 200, "not-json"],
  ["invalid shape", 200, '{"status":"paid","fulfilmentCount":-1}'],
  ["adapter HTTP failure", 503, "{}"],
] as const) {
  test(`${label} cannot become a passing business assertion`, async () => {
    const app = await server((req, res) => {
      req.resume();
      if (req.method === "GET") {
        res.statusCode = status;
        res.end(body);
      } else res.end("accepted");
    });
    try {
      const report = await runScenario(fixture(app.url), { secret });
      assert.equal(report.outcome, "error");
      assert.equal(report.assertions[0]?.outcome, "error");
    } finally {
      await app.close();
    }
  });
}

test("adapter request timeout and oversized response cannot pass", async () => {
  for (const oversized of [false, true]) {
    const app = await server((req, res) => {
      req.resume();
      if (req.method !== "GET") res.end("accepted");
      else if (oversized) res.end("x".repeat(65_537));
    });
    try {
      assert.equal((await runScenario(fixture(app.url), { secret })).outcome, "error");
    } finally {
      await app.close();
    }
  }
});

test("redirects are never followed, even when pointing at another loopback path", async () => {
  let unexpected = 0;
  const app = await server((req, res) => {
    req.resume();
    if (req.url === "/redirected") unexpected++;
    if (req.method === "GET") res.end(JSON.stringify({ status: "paid", fulfilmentCount: 1 }));
    else {
      res.statusCode = 307;
      res.setHeader("location", "/redirected");
      res.end();
    }
  });
  try {
    const report = await runScenario(fixture(app.url), { secret });
    assert.equal(report.outcome, "error");
    assert.equal(unexpected, 0);
  } finally {
    await app.close();
  }
});

test("unreachable target cannot pass through a healthy assertion endpoint", async () => {
  const app = await server((req, res) => {
    req.resume();
    res.end(JSON.stringify({ status: "paid", fulfilmentCount: 1 }));
  });
  const absent = await server((_req, res) => res.end());
  await absent.close();
  try {
    const config = fixture(app.url);
    config.target = `${absent.url}/webhook`;
    const report = await runScenario(config, { secret });
    assert.equal(report.outcome, "error");
    assert.ok(report.errors.length > 0);
    assert.equal(report.assertions[0]?.outcome, "passed");
  } finally {
    await app.close();
  }
});

test("cancellation aborts in-flight requests and cleans run timers", async () => {
  const app = await server((req) => req.resume());
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 40);
  try {
    const config = fixture(app.url);
    config.requestTimeoutMs = 200;
    config.deadlineMs = 1000;
    const report = await runScenario(config, { secret, signal: control.signal });
    assert.equal(report.outcome, "cancelled");
    assert.ok(report.assertions.every((item) => item.outcome === "cancelled"));
    assert.ok(report.attempts.every((item) => item.outcome === "cancelled"));
  } finally {
    clearTimeout(timer);
    await app.close();
  }
});

test("overall delivery deadline produces execution error and no assertion pass", async () => {
  const app = await server((req) => req.resume());
  try {
    const config = fixture(app.url);
    config.deadlineMs = 220;
    const report = await runScenario(config, { secret });
    assert.equal(report.outcome, "error");
    assert.equal(report.assertions[0]?.outcome, "timed-out");
  } finally {
    await app.close();
  }
});

test("missing/weak test secret is an execution error; a secret in scenario labels is redacted", async () => {
  assert.equal((await runScenario(fixture(), { secret: "" })).outcome, "error");
  const weakConfig = fixture();
  weakConfig.name = "bad short-secret";
  const weakReport = await runScenario(weakConfig, { secret: "short-secret" });
  assert.equal(weakReport.outcome, "error");
  assert.equal(JSON.stringify(weakReport).includes("short-secret"), false);
  const config = fixture();
  config.name = `bad ${secret}`;
  const report = await runScenario(config, { secret });
  assert.equal(report.outcome, "error");
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(report.name, "bad [REDACTED]");
});
