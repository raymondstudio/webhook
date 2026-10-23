import { setTimeout as sleep } from "node:timers/promises";
import type { SyntheticEvent } from "../contracts.js";
import { scopedPool } from "./database.js";

export type Checkpoint = "before-commit" | "after-commit";

async function main(): Promise<void> {
  const databaseUrl = process.env.LAB_DATABASE_URL;
  const schema = process.env.LAB_SCHEMA;
  if (!databaseUrl || !schema || !process.send)
    throw new Error("Owned worker configuration missing");
  const pool = scopedPool(databaseUrl, schema);
  const pauseAt = process.env.LAB_PAUSE_AT;
  let pausedOnce = false;
  let running = true;
  process.on("disconnect", () => process.exit(0));
  process.on("SIGTERM", () => {
    running = false;
  });

  async function checkpoint(checkpoint: Checkpoint, eventId: string): Promise<void> {
    if (pauseAt !== checkpoint || pausedOnce) return;
    pausedOnce = true;
    const resumed = new Promise<void>((resolve) => {
      const listener = (message: unknown) => {
        if (typeof message === "object" && message !== null && "resume" in message) {
          process.off("message", listener);
          resolve();
        }
      };
      process.on("message", listener);
    });
    process.send?.({ checkpoint, eventId });
    await resumed;
  }

  try {
    await pool.query("SELECT 1");
    process.send?.({ ready: true });
    while (running) {
      const client = await pool.connect();
      let worked = false;
      try {
        await client.query("BEGIN");
        const result = await client.query<{ id: string; payload: SyntheticEvent }>(`
          SELECT jobs.id, inbox.payload FROM jobs JOIN inbox USING(event_id)
          WHERE jobs.state = 'pending' ORDER BY jobs.id
          LIMIT 1 FOR UPDATE OF jobs SKIP LOCKED
        `);
        const job = result.rows[0];
        if (job) {
          worked = true;
          const event = job.payload;
          // The row lock also serializes distinct event identities for the same order.
          const order = await client.query<{ amount: string; currency: string }>(
            "SELECT amount, currency FROM orders WHERE id=$1 FOR UPDATE",
            [event.orderId],
          );
          const association = order.rows[0];
          if (
            !association ||
            Number(association.amount) !== event.amount ||
            association.currency !== event.currency
          )
            throw new Error("Persisted event does not match its order");
          if (event.type === "payment.succeeded") {
            await client.query(
              "INSERT INTO fulfilments(order_id,event_id) VALUES($1,$2) ON CONFLICT(order_id) DO NOTHING",
              [event.orderId, event.id],
            );
            await client.query("UPDATE orders SET status='paid' WHERE id=$1", [event.orderId]);
          }
          // A pending event records observation only; paid is terminal in this sample.
          await client.query("UPDATE jobs SET state='done' WHERE id=$1", [job.id]);
          await checkpoint("before-commit", event.id);
          await client.query("COMMIT");
          await checkpoint("after-commit", event.id);
        } else {
          await client.query("COMMIT");
        }
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (!worked) await sleep(15);
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // Database errors can embed connection details. Parent observes the nonzero exit, never raw text.
  process.send?.({ workerError: true });
  process.exit(1);
});
