import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { runScenario } from "../src/engine/index.js";
import { renderHtml } from "../src/report/index.js";
import { startSample } from "../src/sample/index.js";
import { makeScenario } from "../src/scenarios.js";

const secret = randomBytes(32).toString("hex");
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://lab:lab@127.0.0.1:55432/lab";
const measurements: unknown[] = [];
const handlerTimes: number[] = [];
const baseline = createServer(async (req, res) => {
  const started = performance.now();
  for await (const _chunk of req) {
    /* Drain bounded synthetic input. */
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      req.method === "GET" ? { status: "paid", fulfilmentCount: 1 } : { accepted: true },
    ),
  );
  handlerTimes.push(performance.now() - started);
});
await new Promise<void>((resolve) => baseline.listen(0, "127.0.0.1", resolve));
const address = baseline.address();
assert.ok(address && typeof address !== "string");
const app = await startSample({ databaseUrl, mode: "corrected", secret });
try {
  for (const target of ["noop-local-http", "postgres-sample"] as const) {
    for (const concurrency of [1, 8]) {
      for (let repetition = 1; repetition <= 3; repetition++) {
        const baseUrl =
          target === "postgres-sample" ? app.baseUrl : `http://127.0.0.1:${address.port}`;
        const config = makeScenario(
          "concurrent",
          baseUrl,
          `bench-${target}-${concurrency}-${repetition}`,
        );
        config.concurrency = concurrency;
        config.deliveries = Array.from({ length: 50 }, () => ({
          eventId: config.events[0].id,
          atMs: 0,
        }));
        config.assertions[0].settleMs = 50;
        if (target === "postgres-sample") {
          await app.createOrder({ id: config.events[0].orderId, amount: 2500, currency: "NGN" });
        }
        handlerTimes.length = 0;
        const started = performance.now();
        const report = await runScenario(config, { secret });
        const runMs = performance.now() - started;
        assert.equal(report.outcome, "passed", JSON.stringify(report.errors));
        const observed = report.attempts.map((a) => a.durationMs).sort((a, b) => a - b);
        const renderStart = performance.now();
        for (let i = 0; i < 10; i++) renderHtml(report);
        const htmlRenderMs = (performance.now() - renderStart) / 10;
        measurements.push({
          target,
          concurrency,
          repetition,
          deliveries: 50,
          runMs,
          deliveryLatencyP50Ms: observed[Math.floor(observed.length * 0.5)],
          deliveryLatencyP95Ms: observed[Math.floor(observed.length * 0.95)],
          deliveriesPerSecondIncludingAssertionWindow: 50 / (runMs / 1000),
          noopHandlerMeanMs:
            target === "noop-local-http"
              ? handlerTimes.reduce((a, b) => a + b, 0) / handlerTimes.length
              : null,
          htmlRenderMs,
        });
      }
    }
  }
} finally {
  await app.close();
  await new Promise<void>((resolve, reject) =>
    baseline.close((err) => (err ? reject(err) : resolve())),
  );
}
const result = {
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    availableParallelism: os.availableParallelism(),
    maxRunnerRssKiB: process.resourceUsage().maxRSS,
  },
  workload:
    "50 duplicate deliveries of one event, concurrency 1/8, 3 repetitions, 50ms assertion settle, real PostgreSQL17 or no-op loopback HTTP.",
  limitations:
    "No-op results include local network, signing, scheduling and assertions. PostgreSQL results include target processing. No subtraction or claimed universal runner overhead; handler mean is measured only inside the no-op target. HTML measurements average 10 renders per run. Warm machine; not a capacity target.",
  measurements,
};
await mkdir("reports", { recursive: true });
await writeFile("reports/benchmark.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
