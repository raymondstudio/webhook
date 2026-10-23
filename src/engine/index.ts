import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type {
  AssertionConfig,
  AssertionResult,
  BusinessState,
  Delivery,
  RunOptions,
  RunReport,
  ScenarioConfig,
} from "../contracts.js";
import { parseConfig } from "./config.js";
import { RequestFailure, request } from "./network.js";

export { ConfigurationError, parseConfig } from "./config.js";

const businessState = z.object({
  status: z.string().min(1).max(128),
  fulfilmentCount: z.number().int().min(0).max(1_000_000),
});
const limitations = [
  "Synthetic local test events; this is not provider infrastructure or proof of payment verification.",
  "Only declared scenarios and executable business assertions are tested. HTTP success is separate from business success.",
  "The explicit plan and identities are reproducible; concurrent operating-system/network ordering is not deterministic.",
  "The sample fulfilment ledger does not guarantee exactly-once effects at external destinations.",
  "Only synthetic identifiers, amount/currency and event types are retained; do not put customer data in scenarios.",
];

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RequestFailure("cancelled", "Run stopped."));
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(new RequestFailure("cancelled", "Run stopped."));
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", stop);
        resolve();
      },
      Math.max(0, ms),
    );
    signal.addEventListener("abort", stop, { once: true });
  });
}

function redact(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(secret).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secret)]),
    );
  return value;
}
function matches(actual: BusinessState, assertion: AssertionConfig): boolean {
  return (
    actual.status === assertion.expected.status &&
    actual.fulfilmentCount === assertion.expected.fulfilmentCount
  );
}

/** Execute an owned, bounded test plan. Exhausted transport errors cannot pass. */
export async function runScenario(
  input: ScenarioConfig,
  options: RunOptions = {},
): Promise<RunReport> {
  const config = parseConfig(input);
  const { signingSecretEnv, ...publicConfig } = config;
  const started = performance.now();
  const report: RunReport = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    runId: randomUUID(),
    name: config.name,
    seed: config.seed,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    outcome: "error",
    environment: { node: process.version, platform: process.platform },
    config: publicConfig,
    attempts: [],
    assertions: [],
    errors: [],
    limitations: [...limitations],
  };
  const secret = options.secret ?? process.env[signingSecretEnv];
  if (!secret || secret.length < 16 || secret.length > 4096) {
    report.errors.push(
      "A dedicated test signing secret of 16–4096 characters is required in the configured environment binding.",
    );
    report.finishedAt = new Date().toISOString();
    return secret ? (redact(report, secret) as RunReport) : report;
  }
  if (JSON.stringify(config).includes(secret)) {
    report.errors.push(
      "The signing secret must not appear in a scenario, endpoint, label or event.",
    );
    report.finishedAt = new Date().toISOString();
    return redact(report, secret) as RunReport;
  }
  const control = new AbortController();
  let deadlineExpired = false;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    control.abort();
  }, config.deadlineMs);
  const cancel = () => control.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) control.abort();
  const signal = control.signal;
  const eventById = new Map(config.events.map((event) => [event.id, event]));

  async function deliver(delivery: Delivery, deliveryIndex: number): Promise<void> {
    await wait(delivery.atMs - (performance.now() - started), signal);
    const event = eventById.get(delivery.eventId);
    if (!event) throw new Error("Validated event reference unavailable.");
    const body = Buffer.from(JSON.stringify(event));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(body.length),
      "x-paystack-signature": createHmac("sha512", secret ?? "")
        .update(body)
        .digest("hex"),
    };
    if (delivery.fault) headers["x-lab-fault"] = delivery.fault;
    let successful = false;
    for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt++) {
      if (signal.aborted) break;
      const attemptStarted = performance.now();
      const record: RunReport["attempts"][number] = {
        eventId: delivery.eventId,
        deliveryIndex,
        attempt,
        plannedAtMs: delivery.atMs,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: null,
        outcome: "network-error",
      };
      try {
        const result = await request(config.target, config.allowedOrigins, {
          method: "POST",
          body,
          headers,
          timeoutMs: config.requestTimeoutMs,
          signal,
        });
        record.status = result.status;
        record.outcome =
          result.status >= 200 && result.status < 300 ? "http-success" : "http-failure";
        successful = record.outcome === "http-success";
      } catch (error) {
        record.outcome = error instanceof RequestFailure ? error.kind : "network-error";
      }
      record.durationMs = Math.round((performance.now() - attemptStarted) * 100) / 100;
      report.attempts.push(record);
      if (successful || signal.aborted) break;
      if (attempt < config.retry.maxAttempts) await wait(config.retry.delayMs, signal);
    }
    if (!successful && !signal.aborted)
      report.errors.push(
        `Delivery ${deliveryIndex + 1} exhausted its bounded attempts without an HTTP acknowledgement.`,
      );
  }

  async function assertBusiness(assertion: AssertionConfig): Promise<AssertionResult> {
    const result: AssertionResult = {
      name: assertion.name,
      outcome: "timed-out",
      expected: assertion.expected,
      observations: 0,
      message: "The assertion deadline expired before a stable match.",
    };
    let matchingSince: number | undefined;
    while (!signal.aborted) {
      try {
        const response = await request(assertion.url, config.allowedOrigins, {
          method: "GET",
          timeoutMs: config.requestTimeoutMs,
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          result.outcome = "error";
          result.message = "Assertion adapter returned an unsuccessful HTTP status.";
          return result;
        }
        let body: unknown;
        try {
          body = JSON.parse(response.body.toString("utf8"));
        } catch {
          result.outcome = "error";
          result.message = "Assertion adapter returned invalid JSON.";
          return result;
        }
        const parsed = businessState.safeParse(body);
        if (!parsed.success) {
          result.outcome = "error";
          result.message =
            "Assertion adapter must return status and a nonnegative integer fulfilmentCount.";
          return result;
        }
        result.actual = parsed.data;
        result.observations++;
        if (matches(parsed.data, assertion)) {
          matchingSince ??= performance.now();
          if (performance.now() - matchingSince >= assertion.settleMs) {
            result.outcome = "passed";
            result.message = "Business state matched throughout the declared observation window.";
            return result;
          }
        } else matchingSince = undefined;
        await wait(25, signal);
      } catch (error) {
        if (signal.aborted) break;
        result.outcome = "error";
        result.message =
          error instanceof RequestFailure && error.kind === "timeout"
            ? "Assertion adapter request timed out."
            : "Assertion adapter request failed or was denied.";
        return result;
      }
    }
    if (options.signal?.aborted) {
      result.outcome = "cancelled";
      result.message = "Assertion cancelled.";
    } else if (result.actual && !matches(result.actual, assertion)) {
      result.outcome = "failed";
      result.message = "Business state did not match the declared expectation by the deadline.";
    }
    return result;
  }

  try {
    const planned = config.deliveries
      .map((delivery, index) => ({ delivery, index }))
      .sort((a, b) => a.delivery.atMs - b.delivery.atMs || a.index - b.index);
    let next = 0;
    const pool = Array.from({ length: Math.min(config.concurrency, planned.length) }, async () => {
      while (!signal.aborted) {
        const item = planned[next++];
        if (!item) break;
        try {
          await deliver(item.delivery, item.index);
        } catch {
          if (!signal.aborted) report.errors.push(`Delivery ${item.index + 1} could not execute.`);
        }
      }
    });
    await Promise.all(pool);
    if (!signal.aborted)
      report.assertions = await Promise.all(config.assertions.map(assertBusiness));
    else
      report.assertions = config.assertions.map((assertion) => ({
        name: assertion.name,
        expected: assertion.expected,
        outcome: options.signal?.aborted ? "cancelled" : "timed-out",
        observations: 0,
        message: options.signal?.aborted
          ? "Run cancelled before assertion evaluation."
          : "Run deadline expired before assertion evaluation.",
      }));
    if (options.signal?.aborted) report.outcome = "cancelled";
    else if (
      report.errors.length ||
      report.assertions.some((item) => ["error", "timed-out", "cancelled"].includes(item.outcome))
    )
      report.outcome = "error";
    else if (report.assertions.some((item) => item.outcome === "failed")) report.outcome = "failed";
    else if (
      report.assertions.length === config.assertions.length &&
      report.assertions.every((item) => item.outcome === "passed")
    )
      report.outcome = "passed";
    else report.errors.push("No complete executable business assertion result was produced.");
    if (deadlineExpired && report.outcome === "error")
      report.errors.push("Run exceeded the configured overall deadline.");
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
    control.abort();
    report.finishedAt = new Date().toISOString();
  }
  report.attempts.sort((a, b) => a.deliveryIndex - b.deliveryIndex || a.attempt - b.attempt);
  return redact(report, secret) as RunReport;
}
