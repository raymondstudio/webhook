import type { RunReport } from "../../src/contracts.js";

export function reportFixture(): RunReport {
  return {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    runId: "fixture-run",
    name: "Concurrent payment duplicates",
    seed: "fixture-seed",
    startedAt: "2026-10-23T12:00:00.000Z",
    finishedAt: "2026-10-23T12:00:01.000Z",
    outcome: "passed",
    environment: { node: "24.19.0", platform: "linux" },
    config: {
      version: 1,
      name: "Concurrent payment duplicates",
      seed: "fixture-seed",
      target: "http://127.0.0.1:3000/webhook",
      allowedOrigins: [],
      events: [
        {
          id: "evt-1",
          type: "payment.succeeded",
          orderId: "order-1",
          amount: 1200,
          currency: "NGN",
        },
      ],
      deliveries: [
        { eventId: "evt-1", atMs: 0 },
        { eventId: "evt-1", atMs: 0 },
      ],
      assertions: [
        {
          name: "Order fulfilled once",
          url: "http://127.0.0.1:3000/state/order-1",
          expected: { status: "paid", fulfilmentCount: 1 },
          settleMs: 100,
        },
      ],
      concurrency: 2,
      requestTimeoutMs: 500,
      deadlineMs: 2000,
      retry: { maxAttempts: 2, delayMs: 50 },
    },
    attempts: [
      {
        eventId: "evt-1",
        deliveryIndex: 0,
        attempt: 1,
        plannedAtMs: 0,
        startedAt: "2026-10-23T12:00:00.001Z",
        durationMs: 8,
        status: 200,
        outcome: "http-success",
      },
      {
        eventId: "evt-1",
        deliveryIndex: 1,
        attempt: 1,
        plannedAtMs: 0,
        startedAt: "2026-10-23T12:00:00.002Z",
        durationMs: 9,
        status: 200,
        outcome: "http-success",
      },
    ],
    assertions: [
      {
        name: "Order fulfilled once",
        outcome: "passed",
        expected: { status: "paid", fulfilmentCount: 1 },
        actual: { status: "paid", fulfilmentCount: 1 },
        observations: 3,
        message: "State remained matched for the observation window.",
      },
    ],
    errors: [],
    limitations: ["Synthetic events only; concurrent ordering is not deterministic."],
  };
}

export function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Report fixture must contain evidence");
  return item;
}
