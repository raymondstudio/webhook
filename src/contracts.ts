/** Shared public v1 contracts. Never serialize signing secrets or database URLs. */
export interface SyntheticEvent {
  id: string;
  type: "payment.succeeded" | "payment.pending";
  orderId: string;
  amount: number;
  currency: string;
}
export interface Delivery {
  eventId: string;
  atMs: number;
  /** Only understood by the explicitly enabled disposable sample. */
  fault?: "http-500-once" | "timeout-after-commit-once";
}
export interface BusinessState {
  status: string;
  fulfilmentCount: number;
}
export interface AssertionConfig {
  name: string;
  url: string;
  expected: BusinessState;
  /** Must remain matched through the observation window; prevents a transient early pass. */
  settleMs: number;
}
export interface ScenarioConfig {
  version: 1;
  name: string;
  seed: string;
  target: string;
  /** Exact origins, e.g. https://sandbox.example.com; empty means loopback only. */
  allowedOrigins: string[];
  signingSecretEnv: string;
  events: SyntheticEvent[];
  deliveries: Delivery[];
  assertions: AssertionConfig[];
  concurrency: number;
  requestTimeoutMs: number;
  deadlineMs: number;
  retry: { maxAttempts: number; delayMs: number };
}
export type Outcome = "passed" | "failed" | "error" | "cancelled";
export interface AttemptResult {
  eventId: string;
  deliveryIndex: number;
  attempt: number;
  plannedAtMs: number;
  startedAt: string;
  durationMs: number;
  status: number | null;
  outcome: "http-success" | "http-failure" | "timeout" | "network-error" | "cancelled";
}
export interface AssertionResult {
  name: string;
  outcome: "passed" | "failed" | "error" | "timed-out" | "cancelled";
  expected: BusinessState;
  actual?: BusinessState;
  observations: number;
  message: string;
}
export interface RunReport {
  schemaVersion: 1;
  toolVersion: string;
  runId: string;
  name: string;
  seed: string;
  startedAt: string;
  finishedAt: string;
  outcome: Outcome;
  environment: { node: string; platform: string };
  /** Sanitized reproducible plan; endpoints contain origin/path only. */
  config: Omit<ScenarioConfig, "signingSecretEnv">;
  attempts: AttemptResult[];
  assertions: AssertionResult[];
  errors: string[];
  limitations: string[];
}
export interface RunOptions {
  secret?: string;
  signal?: AbortSignal;
}
