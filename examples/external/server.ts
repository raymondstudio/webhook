/** Separate test-application integration: file-backed state, no sample or runner imports. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Order = { id: string; amount: number; currency: string };
type StoredOrder = Order & { status: string; fulfilmentCount: number };
type State = { orders: Record<string, StoredOrder>; events: Record<string, string> };

export interface ExternalHandle {
  baseUrl: string;
  createOrder(order: Order): Promise<void>;
  close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > 65_536) throw new Error("Request too large");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

export async function startExternal(options: {
  secret: string;
  directory?: string;
  port?: number;
}): Promise<ExternalHandle> {
  if (options.secret.length < 12) throw new Error("Use a dedicated synthetic test secret");
  const ownedDirectory = !options.directory;
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "webhook-external-")));
  const filename = join(directory, "application-state.json");
  let state: State;
  try {
    state = JSON.parse(await readFile(filename, "utf8")) as State;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    state = { orders: {}, events: {} };
    await writeFile(filename, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  }
  // Single-process mutex protects the read/modify/atomic-replace boundary.
  // This example is deliberately not a substitute for a multi-process transaction database.
  let lock: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = lock.then(operation);
    lock = current.catch(() => undefined);
    return current;
  }
  async function persist(next: State): Promise<void> {
    await writeFile(`${filename}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${filename}.tmp`, filename);
    state = next;
  }
  const server = createServer((request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && path.startsWith("/test-state/")) {
        const id = path.slice("/test-state/".length);
        const order = Object.hasOwn(state.orders, id) ? state.orders[id] : undefined;
        if (!order) return reply(404, { error: "Unknown test order" });
        return reply(200, { status: order.status, fulfilmentCount: order.fulfilmentCount });
      }
      if (request.method !== "POST" || path !== "/payment-events")
        return reply(404, { error: "Not found" });
      const raw = await body(request);
      const signature = request.headers["x-paystack-signature"];
      if (
        typeof signature !== "string" ||
        !/^[a-f0-9]{128}$/i.test(signature) ||
        !timingSafeEqual(
          createHmac("sha512", options.secret).update(raw).digest(),
          Buffer.from(signature, "hex"),
        )
      ) {
        return reply(401, { error: "Invalid synthetic signature" });
      }
      const input: unknown = JSON.parse(raw.toString("utf8"));
      if (
        typeof input !== "object" ||
        input === null ||
        !("id" in input) ||
        !("orderId" in input) ||
        !("amount" in input) ||
        !("currency" in input) ||
        !("type" in input) ||
        Object.keys(input).length !== 5 ||
        typeof input.id !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.id) ||
        typeof input.orderId !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.orderId) ||
        !["payment.succeeded", "payment.pending"].includes(String(input.type))
      ) {
        return reply(400, { error: "Invalid synthetic event" });
      }
      const event = input as {
        id: string;
        orderId: string;
        amount: number;
        currency: string;
        type: string;
      };
      return serialized(async () => {
        const order = Object.hasOwn(state.orders, event.orderId)
          ? state.orders[event.orderId]
          : undefined;
        if (!order || event.amount !== order.amount || event.currency !== order.currency)
          return reply(422, { error: "Order mismatch" });
        const fingerprint = JSON.stringify([
          event.orderId,
          event.amount,
          event.currency,
          event.type,
        ]);
        const previous = Object.hasOwn(state.events, event.id) ? state.events[event.id] : undefined;
        if (previous && previous !== fingerprint)
          return reply(409, { error: "Event identity conflict" });
        if (!previous) {
          const next = structuredClone(state);
          const updated = next.orders[event.orderId];
          if (!updated) throw new Error("Order vanished");
          if (event.type === "payment.succeeded" && updated.status !== "paid") {
            updated.status = "paid";
            updated.fulfilmentCount += 1;
          }
          Object.defineProperty(next.events, event.id, {
            value: fingerprint,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          await persist(next);
        }
        reply(200, { accepted: true });
      });
    })().catch(() => {
      if (!response.destroyed && !response.headersSent)
        reply(400, { error: "Invalid test application request" });
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 100;
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        done();
      });
    });
  } catch (error) {
    if (ownedDirectory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local address");
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    createOrder(order) {
      if (
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(order.id) ||
        !Number.isSafeInteger(order.amount) ||
        order.amount <= 0 ||
        !/^[A-Z]{3}$/.test(order.currency)
      ) {
        throw new Error("Invalid synthetic order");
      }
      return serialized(async () => {
        if (Object.hasOwn(state.orders, order.id))
          throw new Error("Synthetic order already exists");
        const next = structuredClone(state);
        Object.defineProperty(next.orders, order.id, {
          value: { ...order, status: "awaiting", fulfilmentCount: 0 },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        await persist(next);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const stopped = new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      server.closeAllConnections();
      await stopped;
      await lock;
      if (ownedDirectory) await rm(directory, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const secret = process.env.TEST_SIGNING_SECRET;
  if (!secret) throw new Error("Set TEST_SIGNING_SECRET to a dedicated synthetic test secret");
  const app = await startExternal({ secret, port: 7100 });
  await app.createOrder({ id: "demo-order", amount: 5000, currency: "NGN" });
  console.log("Separate disposable test application listening on port 7100");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
