import { z } from "zod";
import type { ScenarioConfig } from "../contracts.js";
import { validateEndpoint, validateOrigin } from "./network.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((value) => value !== "." && value !== "..");
const event = z.strictObject({
  id: identifier,
  type: z.enum(["payment.succeeded", "payment.pending"]),
  orderId: identifier,
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const state = z.strictObject({
  status: z.string().min(1).max(128),
  fulfilmentCount: z.number().int().min(0).max(1_000_000),
});
const schema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1).max(160),
  seed: z.string().min(1).max(128),
  target: z.string().min(1).max(2048),
  allowedOrigins: z.array(z.string().max(2048)).max(16).default([]),
  signingSecretEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)
    .default("LAB_SIGNING_SECRET"),
  events: z.array(event).min(1).max(100),
  deliveries: z
    .array(
      z.strictObject({
        eventId: identifier,
        atMs: z.number().int().min(0).max(59_000),
        fault: z.enum(["http-500-once", "timeout-after-commit-once"]).optional(),
      }),
    )
    .min(1)
    .max(500),
  assertions: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(160),
        url: z.string().min(1).max(2048),
        expected: state,
        settleMs: z.number().int().min(50).max(10_000).default(200),
      }),
    )
    .min(1)
    .max(16),
  concurrency: z.number().int().min(1).max(16).default(1),
  requestTimeoutMs: z.number().int().min(20).max(10_000).default(1000),
  deadlineMs: z.number().int().min(100).max(60_000).default(5000),
  retry: z
    .strictObject({
      maxAttempts: z.number().int().min(1).max(5).default(2),
      delayMs: z.number().int().min(0).max(5000).default(50),
    })
    .default({ maxAttempts: 2, delayMs: 50 }),
});

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Parse a declarative plan. Error messages include locations, never supplied values. */
export function parseConfig(input: unknown): ScenarioConfig {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.map(String).join(".") || "root";
    throw new ConfigurationError(
      `Invalid configuration at ${location}; check the scenario schema and documented bounds.`,
    );
  }
  const config = parsed.data;
  const ids = new Set(config.events.map((item) => item.id));
  if (ids.size !== config.events.length)
    throw new ConfigurationError(
      "Event IDs must be unique in events; duplicate deliveries reference the same event ID.",
    );
  if (new Set(config.assertions.map((item) => item.name)).size !== config.assertions.length) {
    throw new ConfigurationError("Assertion names must be unique.");
  }
  for (const origin of config.allowedOrigins) validateOrigin(origin);
  validateEndpoint(config.target, config.allowedOrigins);
  for (const assertion of config.assertions) {
    validateEndpoint(assertion.url, config.allowedOrigins);
    if (assertion.settleMs >= config.deadlineMs)
      throw new ConfigurationError("Assertion settleMs must be shorter than the run deadline.");
  }
  for (const delivery of config.deliveries) {
    if (!ids.has(delivery.eventId))
      throw new ConfigurationError("Every delivery must reference a declared event ID.");
    if (
      delivery.atMs +
        config.requestTimeoutMs +
        Math.max(...config.assertions.map((item) => item.settleMs)) >=
      config.deadlineMs
    ) {
      throw new ConfigurationError(
        "Delivery schedule must leave room for a request and assertion observation within deadlineMs.",
      );
    }
    if (delivery.fault && !isLiteralLoopbackTarget(config.target)) {
      throw new ConfigurationError(
        "Synthetic fault headers are restricted to literal loopback sample targets.",
      );
    }
  }
  for (const item of config.events) {
    if (Buffer.byteLength(JSON.stringify(item)) > 65_536)
      throw new ConfigurationError("Event exceeds the 64 KiB request bound.");
  }
  return config;
}

function isLiteralLoopbackTarget(value: string): boolean {
  const host = new URL(value).hostname;
  return host === "127.0.0.1" || host === "[::1]" || host === "localhost";
}
