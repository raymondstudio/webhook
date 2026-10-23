import { randomUUID } from "node:crypto";
import pg from "pg";

export type Mode = "broken" | "corrected";

export function newSchema(): string {
  return `lab_${randomUUID().replaceAll("-", "")}`;
}

export function assertSchema(schema: string): void {
  if (!/^lab_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid owned sample schema");
}

export function scopedPool(databaseUrl: string, schema: string): pg.Pool {
  assertSchema(schema);
  return new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`,
    max: 8,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
  });
}

/** A new random schema is a disposable migration target; existing schemas are never reused. */
export async function migrate(databaseUrl: string, schema: string, mode: Mode): Promise<pg.Pool> {
  assertSchema(schema);
  const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const pool = scopedPool(databaseUrl, schema);
  try {
    await pool.query(`
      CREATE TABLE orders (
        id text PRIMARY KEY,
        amount bigint NOT NULL CHECK (amount > 0),
        currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        status text NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'paid'))
      );
      CREATE TABLE inbox (
        event_id text PRIMARY KEY,
        payload jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE jobs (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id text NOT NULL UNIQUE REFERENCES inbox(event_id),
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE fulfilments (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        order_id text NOT NULL REFERENCES orders(id),
        event_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ${mode === "corrected" ? "CREATE UNIQUE INDEX one_fulfilment_per_order ON fulfilments(order_id);" : ""}
    `);
    return pool;
  } catch (error) {
    await pool.end();
    await dropSchema(databaseUrl, schema);
    throw error;
  }
}

export async function dropSchema(databaseUrl: string, schema: string): Promise<void> {
  assertSchema(schema);
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}
