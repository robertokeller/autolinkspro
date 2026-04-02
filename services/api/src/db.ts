import pg from "pg";
import type { PoolClient } from "pg";

const { Pool } = pg;

const IS_PRODUCTION_DB = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const forceSsl = String(process.env.DB_SSL || (IS_PRODUCTION_DB ? "true" : "false")).toLowerCase() !== "false";

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: forceSsl ? { rejectUnauthorized: false } : false,
  // Supabase has tighter connection budgets; keep pool conservative.
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
  // Prevent runaway queries from holding pool slots indefinitely.
  statement_timeout: 15000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err);
});

// Queries taking longer than this threshold are logged for investigation.
const SLOW_QUERY_MS = 2000;

function logSlowQuery(sql: string, durationMs: number): void {
  const truncated = sql.length > 200 ? `${sql.slice(0, 200)}...` : sql;
  console.warn(JSON.stringify({
    ts: new Date().toISOString(),
    svc: "api",
    event: "slow_query",
    durationMs,
    sql: truncated,
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<T[]> {
  const start = Date.now();
  const result = await pool.query(sql, values);
  const elapsed = Date.now() - start;
  if (elapsed >= SLOW_QUERY_MS) logSlowQuery(sql, elapsed);
  return result.rows as T[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function queryOne<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, values);
  return rows[0] ?? null;
}

export async function execute(sql: string, values?: unknown[]): Promise<{ rowCount: number; rows: unknown[] }> {
  const start = Date.now();
  const result = await pool.query(sql, values);
  const elapsed = Date.now() - start;
  if (elapsed >= SLOW_QUERY_MS) logSlowQuery(sql, elapsed);
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
