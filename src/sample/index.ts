import { type ChildProcess, fork } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { BusinessState, SyntheticEvent } from "../contracts.js";
import { dropSchema, type Mode, migrate, newSchema } from "./database.js";
import { terminateOwnedChild } from "./process.js";
import type { Checkpoint } from "./worker.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((value) => value !== "." && value !== "..");
const money = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const currency = z.string().regex(/^[A-Z]{3}$/);
const orderSchema = z.object({ id: identifier, amount: money, currency }).strict();
const eventSchema = z
  .object({
    id: identifier,
    type: z.enum(["payment.succeeded", "payment.pending"]),
    orderId: identifier,
    amount: money,
    currency,
  })
  .strict();

export interface SampleOptions {
  databaseUrl: string;
  mode: Mode;
  secret: string;
  enableFaults?: boolean;
}
export interface SampleHandle {
  /** Local harness ownership evidence; never exposed by an HTTP endpoint. */
  readonly schemaName: string;
  baseUrl: string;
  createOrder(order: { id: string; amount: number; currency: string }): Promise<void>;
  inspect(orderId: string): Promise<BusinessState>;
  stopWorker(): Promise<void>;
  startWorker(options?: { pauseAt?: Checkpoint }): Promise<void>;
  waitForCheckpoint(timeoutMs?: number): Promise<{ checkpoint: Checkpoint; eventId: string }>;
  resumeWorker(): void;
  waitForIdle(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > 65_536) throw new HttpError(413, "Payload exceeds 64 KiB");
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

function verify(body: Buffer, signature: string | string[] | undefined, secret: string): boolean {
  if (typeof signature !== "string" || !/^[a-fA-F0-9]{128}$/.test(signature)) return false;
  const expected = createHmac("sha512", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sameEvent(left: SyntheticEvent, right: SyntheticEvent): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.orderId === right.orderId &&
    left.amount === right.amount &&
    left.currency === right.currency
  );
}

/** Starts only loopback services and a new owned disposable schema. Never use a production database. */
export async function startSample(options: SampleOptions): Promise<SampleHandle> {
  if (!options.secret || options.secret.length < 12)
    throw new Error("Use a dedicated test secret of at least 12 characters");
  const schema = newSchema();
  let pool: Awaited<ReturnType<typeof migrate>>;
  try {
    pool = await migrate(options.databaseUrl, schema, options.mode);
  } catch {
    throw new Error(
      "Sample database setup failed; verify disposable DATABASE_URL and schema permissions",
    );
  }
  let worker: ChildProcess | undefined;
  let workerFailed = false;
  let closing = false;
  let closed = false;
  let closeInProgress: Promise<void> | undefined;
  let poolEnded = false;
  let lastCheckpoint: { checkpoint: Checkpoint; eventId: string } | undefined;
  const faulted = new Set<string>();

  async function inspect(orderId: string): Promise<BusinessState> {
    const result = await pool.query<{ status: string; count: string }>(
      `
      SELECT orders.status, count(fulfilments.id)::text AS count
      FROM orders LEFT JOIN fulfilments ON fulfilments.order_id=orders.id
      WHERE orders.id=$1 GROUP BY orders.id
    `,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Unknown synthetic order");
    return { status: row.status, fulfilmentCount: Number(row.count) };
  }

  async function accept(event: SyntheticEvent): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ amount: string; currency: string }>(
        "SELECT amount,currency FROM orders WHERE id=$1 FOR UPDATE",
        [event.orderId],
      );
      const order = result.rows[0];
      if (!order || Number(order.amount) !== event.amount || order.currency !== event.currency) {
        throw new HttpError(422, "Event does not match its synthetic order");
      }
      if (options.mode === "broken") {
        // Deliberate defect: each delivery creates another business side effect.
        if (event.type === "payment.succeeded") {
          await client.query("INSERT INTO fulfilments(order_id,event_id) VALUES($1,$2)", [
            event.orderId,
            event.id,
          ]);
          await client.query("UPDATE orders SET status='paid' WHERE id=$1", [event.orderId]);
        } else {
          // Deliberate defect: old pending observations regress completed state.
          await client.query("UPDATE orders SET status='awaiting' WHERE id=$1", [event.orderId]);
        }
      } else {
        const inserted = await client.query(
          "INSERT INTO inbox(event_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id",
          [event.id, event],
        );
        const stored = await client.query<{ payload: SyntheticEvent }>(
          "SELECT payload FROM inbox WHERE event_id=$1",
          [event.id],
        );
        const previous = stored.rows[0];
        if (!previous || !sameEvent(previous.payload, event))
          throw new HttpError(409, "Event identity was reused with different data");
        // Inbox and job creation commit atomically. A duplicate must not touch a
        // job row held by the worker while ingress holds the order row lock.
        if (inserted.rowCount === 1) {
          await client.query("INSERT INTO jobs(event_id) VALUES($1)", [event.id]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function waitForIdle(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closing) throw new Error("Sample is closing");
      if (workerFailed) throw new Error("Sample worker exited unexpectedly");
      const jobs = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM jobs WHERE state='pending'",
      );
      if (jobs.rows[0]?.count === "0") return;
      await sleep(15);
    }
    throw new Error("Sample jobs did not complete before deadline");
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (closing) throw new HttpError(503, "Sample is closing");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        await pool.query("SELECT 1");
        send(response, workerFailed ? 503 : 200, {
          status: workerFailed ? "worker-error" : "ok",
          mode: options.mode,
        });
        return;
      }
      if (request.method === "GET" && /^\/orders\/[A-Za-z0-9_.:-]+$/.test(url.pathname)) {
        send(response, 200, await inspect(url.pathname.slice("/orders/".length)));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/webhook")
        throw new HttpError(404, "Not found");
      const body = await rawBody(request);
      if (!verify(body, request.headers["x-paystack-signature"], options.secret))
        throw new HttpError(401, "Invalid test signature");
      let decoded: unknown;
      try {
        decoded = JSON.parse(body.toString("utf8"));
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }
      const parsed = eventSchema.safeParse(decoded);
      if (!parsed.success) throw new HttpError(400, "Invalid synthetic event");
      const event = parsed.data;
      const fault = request.headers["x-lab-fault"];
      if (
        fault &&
        (!options.enableFaults ||
          typeof fault !== "string" ||
          !["http-500-once", "timeout-after-commit-once"].includes(fault))
      ) {
        throw new HttpError(400, "Fault injection is disabled or unsupported");
      }
      const faultKey = `${event.id}:${fault}`;
      const firstFault = Boolean(fault) && !faulted.has(faultKey);
      if (firstFault) faulted.add(faultKey);
      if (firstFault && fault === "http-500-once")
        throw new HttpError(500, "Injected failure before side effect");
      await accept(event);
      if (firstFault && fault === "timeout-after-commit-once") {
        // Wait for actual business commit, then deliberately lose acknowledgement.
        await waitForIdle();
        return;
      }
      send(response, 200, { accepted: true });
    })().catch((error: unknown) => {
      if (!response.destroyed && !response.headersSent) {
        send(response, error instanceof HttpError ? error.status : 500, {
          error: error instanceof HttpError ? error.message : "Sample processing failed",
        });
      }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 100;

  async function stopWorker(): Promise<void> {
    const owned = worker;
    if (!owned) return;
    await terminateOwnedChild(owned);
    // Keep the reference on timeout: close() must not drop a schema a child could still write.
    if (worker === owned) worker = undefined;
    workerFailed = false;
  }

  async function startWorker(workerOptions: { pauseAt?: Checkpoint } = {}): Promise<void> {
    if (options.mode !== "corrected") throw new Error("Broken mode has no background worker");
    if (worker) throw new Error("Stop the owned worker before restarting it");
    if (closing) throw new Error("Sample is closing");
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const child = fork(new URL(`./worker.${extension}`, import.meta.url), [], {
      execArgv: extension === "ts" ? ["--import", "tsx"] : [],
      env: {
        ...process.env,
        LAB_DATABASE_URL: options.databaseUrl,
        LAB_SCHEMA: schema,
        LAB_PAUSE_AT: workerOptions.pauseAt ?? "",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    worker = child;
    workerFailed = false;
    lastCheckpoint = undefined;
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      if (
        "checkpoint" in message &&
        "eventId" in message &&
        (message.checkpoint === "before-commit" || message.checkpoint === "after-commit") &&
        typeof message.eventId === "string"
      ) {
        lastCheckpoint = { checkpoint: message.checkpoint, eventId: message.eventId };
      }
      if ("workerError" in message) workerFailed = true;
    });
    child.on("error", () => {
      workerFailed = true;
    });
    child.on("exit", () => {
      if (worker === child) workerFailed = true;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Sample worker startup timed out"));
        }, 5000);
        const message = (value: unknown) => {
          if (typeof value === "object" && value !== null && "ready" in value) {
            cleanup();
            resolve();
          }
        };
        const failed = () => {
          cleanup();
          reject(new Error("Sample worker failed to start"));
        };
        function cleanup() {
          clearTimeout(timer);
          child.off("message", message);
          child.off("exit", failed);
          child.off("error", failed);
        }
        child.on("message", message);
        child.once("exit", failed);
        child.once("error", failed);
      });
    } catch (error) {
      await stopWorker();
      throw error;
    }
  }

  function close(): Promise<void> {
    if (closed) return Promise.resolve();
    if (closeInProgress) return closeInProgress;
    // Closing remains true after a failure: HTTP work and worker restarts stay disabled,
    // but cleanup itself can be retried once the owned child's state is known.
    closing = true;
    closeInProgress = (async () => {
      // Stop accepting HTTP work even if process termination cannot be confirmed.
      if (server.listening) {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await stopped;
      }
      await stopWorker();
      if (!poolEnded) {
        await pool.end();
        poolEnded = true;
      }
      await dropSchema(options.databaseUrl, schema);
      closed = true;
    })().finally(() => {
      closeInProgress = undefined;
    });
    return closeInProgress;
  }

  try {
    if (options.mode === "corrected") await startWorker();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    await close();
    throw new Error(
      "Sample startup failed; check disposable database and local child-process support",
    );
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Sample has no local address");
  }
  return {
    schemaName: schema,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async createOrder(order) {
      const parsed = orderSchema.parse(order);
      await pool.query("INSERT INTO orders(id,amount,currency) VALUES($1,$2,$3)", [
        parsed.id,
        parsed.amount,
        parsed.currency,
      ]);
    },
    inspect,
    stopWorker,
    startWorker,
    async waitForCheckpoint(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (lastCheckpoint) return lastCheckpoint;
        if (workerFailed) throw new Error("Sample worker exited before checkpoint");
        await sleep(10);
      }
      throw new Error("Sample worker checkpoint timed out");
    },
    resumeWorker() {
      if (!worker?.connected) throw new Error("Owned worker is not connected");
      worker.send({ resume: true });
    },
    waitForIdle,
    close,
  };
}
