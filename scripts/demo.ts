import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startExternal } from "../examples/external/server.js";
import type { RunReport } from "../src/contracts.js";
import { runScenario } from "../src/engine/index.js";
import { writeReports } from "../src/report/index.js";
import { startSample } from "../src/sample/index.js";
import { makeScenario, scenarioNames } from "../src/scenarios.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://lab:lab@127.0.0.1:55432/lab";
const secret = randomBytes(32).toString("hex");
const root = path.resolve("reports/demo");
const controller = new AbortController();
const onSignal = () => controller.abort();
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
const summaries: { name: string; outcome: string; expected: string; report: string }[] = [];

async function retain(report: RunReport, directory: string, expected: string) {
  const files = await writeReports(report, path.join(root, directory));
  summaries.push({ name: directory, outcome: report.outcome, expected, report: files.html });
  console.log(
    `${directory}: ${report.outcome} (expected ${expected}), ${report.attempts.length} attempts`,
  );
  assert.equal(report.outcome, expected, `${directory}: ${report.errors.join("; ")}`);
}

try {
  for (const mode of ["broken", "corrected"] as const) {
    const app = await startSample({ databaseUrl, mode, secret, enableFaults: true });
    try {
      const cases =
        mode === "broken" ? (["sequential", "concurrent", "timeout"] as const) : scenarioNames;
      for (const name of cases) {
        const config = makeScenario(name, app.baseUrl, "demo");
        if (mode === "broken") config.deadlineMs = 1800;
        await app.createOrder({ id: config.events[0].orderId, amount: 2500, currency: "NGN" });
        const report = await runScenario(config, { secret, signal: controller.signal });
        await retain(report, `${mode}-${name}`, mode === "broken" ? "failed" : "passed");
      }
      if (mode === "corrected") {
        for (const checkpoint of ["before-commit", "after-commit"] as const) {
          await app.stopWorker();
          await app.startWorker({ pauseAt: checkpoint });
          const config = makeScenario("sequential", app.baseUrl, `crash-${checkpoint}`);
          config.name = `Worker crash ${checkpoint}: durable recovery`;
          config.deliveries = config.deliveries.slice(0, 1);
          await app.createOrder({ id: config.events[0].orderId, amount: 2500, currency: "NGN" });
          const pending = runScenario(config, { secret, signal: controller.signal });
          // The harness owns this exact child; no remote crash endpoint exists.
          await app.waitForCheckpoint(3000);
          await app.stopWorker();
          await app.startWorker();
          await app.waitForIdle(3000);
          await retain(await pending, `corrected-crash-${checkpoint}`, "passed");
        }
      }
    } finally {
      await app.close();
    }
  }
  const external = await startExternal({ secret });
  try {
    await external.createOrder({ id: "external-order", amount: 2500, currency: "NGN" });
    const config = makeScenario("concurrent", external.baseUrl, "external");
    config.name = "Separate application: concurrent notifications";
    config.target = `${external.baseUrl}/payment-events`;
    for (const event of config.events) event.orderId = "external-order";
    config.assertions[0].url = `${external.baseUrl}/test-state/external-order`;
    const report = await runScenario(config, { secret, signal: controller.signal });
    await retain(report, "external-adapter", "passed");
  } finally {
    await external.close();
  }
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`);
  console.log(`Verified ${summaries.length} journeys. Reports: reports/demo/<journey>/report.html`);
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
