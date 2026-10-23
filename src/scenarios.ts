import type { AssertionConfig, Delivery, ScenarioConfig, SyntheticEvent } from "./contracts.js";

export const scenarioNames = [
  "sequential",
  "concurrent",
  "reordered",
  "http-retry",
  "timeout",
] as const;
export type ScenarioName = (typeof scenarioNames)[number];

/** Fully explicit schedules: identities and offsets reproduce; observed network order does not. */
export function makeScenario(
  name: ScenarioName,
  baseUrl: string,
  seed = "lab-2026",
): ScenarioConfig & {
  events: [SyntheticEvent, ...SyntheticEvent[]];
  assertions: [AssertionConfig, ...AssertionConfig[]];
} {
  const orderId = `${seed}-${name}`;
  const eventId = `${orderId}-paid`;
  const firstDelivery: Delivery = { eventId, atMs: 0 };
  const config: ScenarioConfig & {
    events: [SyntheticEvent, ...SyntheticEvent[]];
    assertions: [AssertionConfig, ...AssertionConfig[]];
  } = {
    version: 1,
    name: `${name}: one payment, one fulfilment`,
    seed,
    target: `${baseUrl}/webhook`,
    allowedOrigins: [],
    signingSecretEnv: "LAB_SIGNING_SECRET",
    events: [{ id: eventId, orderId, type: "payment.succeeded", amount: 2500, currency: "NGN" }],
    deliveries: [firstDelivery],
    assertions: [
      {
        name: "Paid order is fulfilled once",
        url: `${baseUrl}/orders/${orderId}`,
        expected: { status: "paid", fulfilmentCount: 1 },
        settleMs: 150,
      },
    ],
    concurrency: 1,
    requestTimeoutMs: 500,
    deadlineMs: 8000,
    retry: { maxAttempts: 3, delayMs: 30 },
  };
  if (name === "sequential") {
    config.deliveries = Array.from({ length: 10 }, (_, i) => ({ eventId, atMs: i * 5 }));
  } else if (name === "concurrent") {
    config.deliveries = Array.from({ length: 10 }, () => ({ eventId, atMs: 0 }));
    config.concurrency = 10;
  } else if (name === "reordered") {
    const pendingId = `${orderId}-pending`;
    config.events.push({ ...config.events[0], id: pendingId, type: "payment.pending" });
    config.deliveries.push({ eventId: pendingId, atMs: 100 });
  } else if (name === "http-retry") {
    firstDelivery.fault = "http-500-once";
  } else if (name === "timeout") {
    firstDelivery.fault = "timeout-after-commit-once";
  }
  return config;
}
