import pg from "pg";
import type { PoolClient } from "pg";

const { Pool } = pg;

const IS_PRODUCTION_DB = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const forceSsl = String(process.env.DB_SSL || (IS_PRODUCTION_DB ? "true" : "false")).toLowerCase() !== "false";
// Some managed Postgres providers can present intermediate chains that are not
// available in slim container images. Default to relaxed verification to keep
// connectivity stable, and allow strict mode via DB_SSL_REJECT_UNAUTHORIZED=true.
const sslRejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "false").toLowerCase() !== "false";

// ─── Pool sizing ─────────────────────────────────────────────────────────────
// CRITICAL: In PM2 cluster mode each worker has its own pool.
// Total connections = DB_POOL_MAX * API_INSTANCES.
// Keep total well below Postgres max_connections (typically 60–100).
// Rule: DB_POOL_MAX * API_INSTANCES + ~15 (internal) ≤ max_connections.
// Default: 5 per worker → 4 workers × 5 = 20 total (safe for any plan).
// Override with DB_POOL_MAX=N env variable.
const DB_POOL_MAX = (() => {
  const parsed = Number(process.env.DB_POOL_MAX ?? "");
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 5;
})();

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: forceSsl ? { rejectUnauthorized: sslRejectUnauthorized } : false,
  max: DB_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
  // Keep-alive prevents idle connections from being silently dropped by VPS
  // firewalls or Supabase's connection pooler idle-timeout.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // Prevent runaway queries from holding pool slots indefinitely.
  // Configurable via env to allow vitrine syncs with large catalogs.
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || "30000"),
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err);
});

// After the DB migration/swap, some roles may have a non-public default
// search_path. Force public to keep unqualified table queries stable.
pool.on("connect", (client) => {
  client
    .query("SET search_path TO public")
    .catch((err) => {
      console.warn("[db] Failed to set search_path=public on connect:", err?.message || err);
    });
});

console.info(JSON.stringify({
  ts: new Date().toISOString(),
  svc: "api",
  event: "db_pool_init",
  poolMax: DB_POOL_MAX,
  sslEnabled: forceSsl,
  sslRejectUnauthorized,
  instance: process.env.NODE_APP_INSTANCE ?? "0",
  hint: `Total DB connections from this node: up to ${DB_POOL_MAX}. In PM2 cluster: multiply by API_INSTANCES.`,
}));

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
