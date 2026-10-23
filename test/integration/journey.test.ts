import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startExternal } from "../../examples/external/server.js";
import { runScenario } from "../../src/engine/index.js";
import { writeReports } from "../../src/report/index.js";
import { startSample } from "../../src/sample/index.js";
import { makeScenario } from "../../src/scenarios.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://lab:lab@127.0.0.1:55432/lab";
const secret = randomBytes(32).toString("hex");

test("one declared assertion exposes broken duplicates and passes corrected PostgreSQL processing", async () => {
  for (const mode of ["broken", "corrected"] as const) {
    const app = await startSample({ databaseUrl, mode, secret });
    try {
      const config = makeScenario("concurrent", app.baseUrl, `integration-${mode}`);
      config.deadlineMs = 1800;
      await app.createOrder({ id: config.events[0].orderId, amount: 2500, currency: "NGN" });
      const result = await runScenario(config, { secret });
      assert.equal(result.outcome, mode === "broken" ? "failed" : "passed", JSON.stringify(result));
      assert.equal(result.attempts.length, 10);
      assert.ok(
        result.attempts.every((a) => a.status !== null && a.status >= 200 && a.status < 300),
      );
      assert.equal(result.assertions[0]?.actual?.fulfilmentCount, mode === "broken" ? 10 : 1);
    } finally {
      await app.close();
    }
  }
});

test("CLI runs against a separately configured application and emits real report evidence", async () => {
  const app = await startExternal({ secret });
  const dir = await mkdtemp(path.join(os.tmpdir(), "lab-cli-"));
  try {
    await app.createOrder({ id: "external-order", amount: 2500, currency: "NGN" });
    const config = makeScenario("concurrent", app.baseUrl, "separate");
    config.target = `${app.baseUrl}/payment-events`;
    config.events[0].orderId = "external-order";
    config.assertions[0].url = `${app.baseUrl}/test-state/external-order`;
    const filename = path.join(dir, "scenario.json");
    await writeFile(filename, JSON.stringify(config));
    const execute = (file: string) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            ...(import.meta.url.endsWith(".js")
              ? ["dist/src/cli.js"]
              : ["--import", "tsx", "src/cli.ts"]),
            "run",
            file,
            "--out",
            dir,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, LAB_SIGNING_SECRET: secret },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (buffer) => {
          output += String(buffer);
        });
        child.stderr.on("data", (buffer) => {
          output += String(buffer);
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      });
    const result = await execute(filename);
    assert.equal(result.code, 0, result.output);
    const reportText = await readFile(path.join(dir, "report.json"), "utf8");
    const report = JSON.parse(reportText);
    assert.equal(report.outcome, "passed");
    assert.equal(report.assertions[0].actual.fulfilmentCount, 1);
    assert.equal(report.attempts.length, 10);
    assert.ok(!(await readFile(path.join(dir, "report.html"), "utf8")).includes(secret));
    assert.match(await readFile(path.join(dir, "junit.xml"), "utf8"), /testsuite/);
    config.assertions[0].expected.fulfilmentCount = 99;
    config.deadlineMs = 1400;
    await writeFile(filename, JSON.stringify(config));
    assert.equal((await execute(filename)).code, 1, "mismatch must exit1");
    const invalidConfig = { ...config, assertions: [] };
    await writeFile(filename, JSON.stringify(invalidConfig));
    assert.equal((await execute(filename)).code, 2, "missing assertion must exit2");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("report export reflects failed business assertion despite successful HTTP acknowledgements", async () => {
  const app = await startExternal({ secret });
  const dir = await mkdtemp(path.join(os.tmpdir(), "lab-report-"));
  try {
    await app.createOrder({ id: "negative-order", amount: 2500, currency: "NGN" });
    const config = makeScenario("sequential", app.baseUrl, "wrong-expectation");
    config.target = `${app.baseUrl}/payment-events`;
    config.events[0].orderId = "negative-order";
    config.assertions[0].url = `${app.baseUrl}/test-state/negative-order`;
    config.assertions[0].expected.fulfilmentCount = 2;
    config.deadlineMs = 1400;
    const report = await runScenario(config, { secret });
    assert.equal(report.outcome, "failed");
    const files = await writeReports(report, dir);
    assert.match(await readFile(files.junit, "utf8"), /failure/);
    assert.equal(JSON.parse(await readFile(files.json, "utf8")).outcome, "failed");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
