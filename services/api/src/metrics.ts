/**
 * Lightweight in-process metrics collection.
 * No external dependencies (Prometheus, Datadog, etc.) — suitable for
 * single-VPS deployments monitored via ops-control or manual curl.
 *
 * Tracks:
 * - Request count and latency per route bucket (1min, 5min, 15min windows)
 * - Cache hit/miss rates
 * - DB pool utilization
 * - Rate-limit trigger counts
 */

// ─── Rolling window counters ────────────────────────────────────────────────

interface RouteBucket {
  count: number;
  totalMs: number;
  maxMs: number;
  latencies: number[]; // last N for percentile calculation
}

const ROUTE_BUCKETS = new Map<string, RouteBucket>();
const MAX_LATENCY_SAMPLES = 200; // per route, rolling

function normalizeRoute(method: string, path: string): string {
  // Collapse UUIDs and numeric IDs to prevent cardinality explosion
  return `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id").replace(/\/\d+/g, "/:n")}`;
}

export function recordRequest(method: string, path: string, durationMs: number): void {
  const key = normalizeRoute(method, path);
  let bucket = ROUTE_BUCKETS.get(key);
  if (!bucket) {
    bucket = { count: 0, totalMs: 0, maxMs: 0, latencies: [] };
    ROUTE_BUCKETS.set(key, bucket);
  }
  bucket.count++;
  bucket.totalMs += durationMs;
  if (durationMs > bucket.maxMs) bucket.maxMs = durationMs;
  bucket.latencies.push(durationMs);
  if (bucket.latencies.length > MAX_LATENCY_SAMPLES) {
    bucket.latencies.shift();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Rate-limit trigger counter ─────────────────────────────────────────────
let _rateLimitTriggers = 0;
export function recordRateLimitTrigger(): void { _rateLimitTriggers++; }

// ─── Snapshot ───────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  uptime_seconds: number;
  routes: Record<string, {
    count: number;
    avg_ms: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    max_ms: number;
  }>;
  cache: { hits: number; misses: number; hitRate: string; size: number };
  db_pool: { total: number; idle: number; waiting: number };
  rate_limit_triggers: number;
  instance: string;
}

export function getMetricsSnapshot(
  cacheStats: { hits: number; misses: number; hitRate: string; size: number },
  poolStats: { totalCount: number; idleCount: number; waitingCount: number },
): MetricsSnapshot {
  const routes: MetricsSnapshot["routes"] = {};
  for (const [key, bucket] of ROUTE_BUCKETS) {
    const sorted = [...bucket.latencies].sort((a, b) => a - b);
    routes[key] = {
      count: bucket.count,
      avg_ms: Math.round(bucket.totalMs / (bucket.count || 1)),
      p50_ms: Math.round(percentile(sorted, 50)),
      p95_ms: Math.round(percentile(sorted, 95)),
      p99_ms: Math.round(percentile(sorted, 99)),
      max_ms: Math.round(bucket.maxMs),
    };
  }

  return {
    uptime_seconds: Math.round(process.uptime()),
    routes,
    cache: cacheStats,
    db_pool: {
      total: poolStats.totalCount,
      idle: poolStats.idleCount,
      waiting: poolStats.waitingCount,
    },
    rate_limit_triggers: _rateLimitTriggers,
    instance: process.env.NODE_APP_INSTANCE ?? "0",
  };
}

// ─── Periodic reset (every 15 min) to prevent unbounded memory growth ───────
setInterval(() => {
  for (const [, bucket] of ROUTE_BUCKETS) {
    bucket.count = 0;
    bucket.totalMs = 0;
    bucket.maxMs = 0;
    bucket.latencies = [];
  }
  _rateLimitTriggers = 0;
}, 15 * 60 * 1000).unref();
