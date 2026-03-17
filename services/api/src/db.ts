import pg from "pg";
import type { PoolClient } from "pg";

const { Pool } = pg;

export const pool = new Pool({
  host:     process.env.POSTGRES_HOST     ?? "localhost",
  port:     Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_DB       ?? "autolinks",
  user:     process.env.POSTGRES_USER     ?? "autolinks",
  password: process.env.POSTGRES_PASSWORD ?? "autolinks",
  max: 35,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Kill any individual query that runs longer than 15 s — prevents runaway
  // queries from holding a pool slot indefinitely under load or during incidents.
  statement_timeout: 15000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<T[]> {
  const result = await pool.query(sql, values);
  return result.rows as T[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function queryOne<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, values);
  return rows[0] ?? null;
}

export async function execute(sql: string, values?: unknown[]): Promise<{ rowCount: number; rows: unknown[] }> {
  const result = await pool.query(sql, values);
  return { rowCount: result.rowCount ?? 0, rows: result.rows };
}

/** Run a set of queries inside a single BEGIN/COMMIT block. Rolls back on error. */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
