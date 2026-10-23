import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const secret = "lab-cli-only-secret-must-not-be-printed";
function config() {
  return {
    version: 1,
    name: "CLI validation",
    seed: "cli-seed",
    target: "http://127.0.0.1:9999/webhook",
    events: [
      {
        id: "event-1",
        type: "payment.succeeded",
        orderId: "order-1",
        amount: 100,
        currency: "NGN",
      },
    ],
    deliveries: [{ eventId: "event-1", atMs: 0 }],
    assertions: [
      {
        name: "one fulfilment",
        url: "http://127.0.0.1:9999/state",
        expected: { status: "paid", fulfilmentCount: 1 },
        settleMs: 50,
      },
    ],
    requestTimeoutMs: 100,
    deadlineMs: 500,
  };
}

async function invoke(raw: string | undefined, filename = "scenario.json") {
  const directory = await mkdtemp(join(tmpdir(), "webhook-lab-cli-validation-"));
  const path = join(directory, filename);
  try {
    if (raw !== undefined) await writeFile(path, raw, "utf8");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "run", path, "--out", join(directory, "reports")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, LAB_SIGNING_SECRET: secret },
        timeout: 5000,
      },
    );
    assert.equal(result.status, 2);
    const output = result.stdout + result.stderr;
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(directory), false);
    return result.stderr;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("CLI explains missing assertions without echoing input labels", async () => {
  const stderr = await invoke(JSON.stringify({ ...config(), name: secret, assertions: [] }));
  assert.match(stderr, /Invalid configuration at assertions/);
});

test("CLI explains invalid concurrency without echoing the supplied value", async () => {
  const stderr = await invoke(JSON.stringify({ ...config(), concurrency: secret }));
  assert.match(stderr, /Invalid configuration at concurrency/);
});

test("CLI explains remote origin policy without echoing the supplied endpoint", async () => {
  const target = `https://example.com/${secret}`;
  const stderr = await invoke(JSON.stringify({ ...config(), target }));
  assert.match(stderr, /Remote test endpoints require an exact allowedOrigins entry/);
  assert.equal(stderr.includes("example.com"), false);
});

test("CLI explains credential policy without echoing URL credentials", async () => {
  const stderr = await invoke(
    JSON.stringify({ ...config(), target: `http://user:${secret}@127.0.0.1:9999/webhook` }),
  );
  assert.match(stderr, /without credentials, query parameters or fragments/);
  assert.equal(stderr.includes("127.0.0.1"), false);
});

test("CLI malformed JSON errors remain generic and do not echo raw input", async () => {
  const stderr = await invoke(`{"name":"${secret}",`);
  assert.match(stderr, /Scenario file could not be read as valid JSON/);
});

test("CLI filesystem failures remain generic and do not echo the supplied path", async () => {
  const stderr = await invoke(undefined, `${secret}.json`);
  assert.match(stderr, /Scenario execution or report writing failed/);
  assert.equal(stderr.includes("ENOENT"), false);
});
