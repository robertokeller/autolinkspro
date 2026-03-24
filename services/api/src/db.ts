import pg from "pg";
import type { PoolClient } from "pg";

const { Pool } = pg;

const IS_PRODUCTION_DB = String(process.env.NODE_ENV || "").toLowerCase() === "production";
if (IS_PRODUCTION_DB && !process.env.POSTGRES_PASSWORD) {
  throw new Error("POSTGRES_PASSWORD é obrigatório em produção. Defina a senha do banco de dados.");
}

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

// Queries taking longer than this threshold are logged for investigation.
const SLOW_QUERY_MS = 2000;

function logSlowQuery(sql: string, durationMs: number): void {
  // Truncate SQL to avoid flooding logs with huge INSERT/UPDATE payloads.
  const truncated = sql.length > 200 ? sql.slice(0, 200) + "…" : sql;
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
