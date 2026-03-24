import { execute, queryOne } from "./db.js";

export type RateLimitBackend = "memory" | "database";

const RATE_LIMIT_BACKEND_RAW = String(process.env.RATE_LIMIT_BACKEND || "").trim().toLowerCase();
const IS_PRODUCTION = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";

export const DEFAULT_RATE_LIMIT_BACKEND: RateLimitBackend =
  RATE_LIMIT_BACKEND_RAW === "database" || RATE_LIMIT_BACKEND_RAW === "db"
    ? "database"
    : RATE_LIMIT_BACKEND_RAW === "memory"
      ? "memory"
      : (IS_PRODUCTION ? "database" : "memory");

type MemoryEntry = { count: number; resetAt: number };
const memoryStores = new Map<string, Map<string, MemoryEntry>>();

function getMemoryStore(namespace: string): Map<string, MemoryEntry> {
  const safeNamespace = String(namespace || "global").trim() || "global";
  if (!memoryStores.has(safeNamespace)) {
    memoryStores.set(safeNamespace, new Map<string, MemoryEntry>());
  }
  return memoryStores.get(safeNamespace)!;
}

function consumeMemoryRateLimit(args: {
  namespace: string;
  scopeKey: string;
  max: number;
  windowMs: number;
  nowMs: number;
}) {
  const { namespace, scopeKey, max, windowMs, nowMs } = args;
  const store = getMemoryStore(namespace);
  const key = String(scopeKey || "unknown");
  const entry = store.get(key);

  if (!entry || nowMs > entry.resetAt) {
    const resetAt = nowMs + windowMs;
    store.set(key, { count: 1, resetAt });
    return {
      allowed: true,
      count: 1,
      retryAfterSec: 0,
      resetAt,
    };
  }

  entry.count += 1;
  return {
    allowed: entry.count <= max,
    count: entry.count,
    retryAfterSec: Math.max(0, Math.ceil((entry.resetAt - nowMs) / 1000)),
    resetAt: entry.resetAt,
  };
}

async function consumeDistributedRateLimit(args: {
  namespace: string;
  scopeKey: string;
  max: number;
  windowMs: number;
  nowMs: number;
}) {
  const { namespace, scopeKey, max, windowMs, nowMs } = args;
  const safeNamespace = String(namespace || "global").trim() || "global";
  const safeScopeKey = String(scopeKey || "unknown").trim() || "unknown";
  const namespacedKey = `${safeNamespace}:${safeScopeKey}`;
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const resetAtMs = windowStartMs + windowMs;

  const row = await queryOne<{ count: string | number }>(
    `INSERT INTO runtime_rate_limits (scope_key, window_start, window_ms, count, expires_at, updated_at)
     VALUES ($1, TO_TIMESTAMP($2 / 1000.0), $3, 1, TO_TIMESTAMP($4 / 1000.0), NOW())
     ON CONFLICT (scope_key, window_start)
     DO UPDATE SET
       count = runtime_rate_limits.count + 1,
       updated_at = NOW(),
       expires_at = GREATEST(runtime_rate_limits.expires_at, EXCLUDED.expires_at)
     RETURNING count`,
    [namespacedKey, windowStartMs, windowMs, resetAtMs],
  );

  const count = Number(row?.count ?? 0);
  return {
    allowed: count <= max,
    count,
    retryAfterSec: Math.max(0, Math.ceil((resetAtMs - nowMs) / 1000)),
    resetAt: resetAtMs,
  };
}

export async function consumeRateLimit(args: {
  namespace: string;
  scopeKey: string;
  max: number;
  windowMs: number;
  backend?: RateLimitBackend;
}) {
  const { namespace, scopeKey, max, windowMs } = args;
  const backend = args.backend || DEFAULT_RATE_LIMIT_BACKEND;
  const nowMs = Date.now();

  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return {
      allowed: true,
      count: 0,
      retryAfterSec: 0,
      resetAt: nowMs,
    };
  }

  if (backend === "database") {
    return consumeDistributedRateLimit({ namespace, scopeKey, max, windowMs, nowMs });
  }
  return consumeMemoryRateLimit({ namespace, scopeKey, max, windowMs, nowMs });
}

export function cleanupMemoryRateLimits() {
  const now = Date.now();
  for (const store of memoryStores.values()) {
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }
}

export async function cleanupDistributedRateLimits() {
  await execute(
    "DELETE FROM runtime_rate_limits WHERE expires_at < NOW() - INTERVAL '2 minutes'",
  );
}

