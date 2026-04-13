/**
 * In-memory LRU cache with per-entry TTL.
 *
 * Designed for single-VPS deployments (≤1000 users). Each PM2 worker gets its
 * own cache instance — no cross-process sharing. This is acceptable because:
 * - Mutations bust the cache for the current worker immediately.
 * - Other workers will see fresh data after their TTL expires (seconds, not minutes).
 * - No external dependency (Redis) needed for this scale.
 *
 * For multi-VPS deployments, replace with Redis or Valkey.
 */

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class LRUCache {
  private readonly maxEntries: number;
  private readonly map = new Map<string, CacheEntry<unknown>>();

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
    // Delete first to reset insertion order
    this.map.delete(key);
    // Evict oldest entries if at capacity
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
      else break;
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Delete all entries where the cache key contains ":table:" as a colon-delimited segment.
   * Used for admin-level writes that should invalidate cache entries for ALL users on that table. */
  bustByTable(table: string): number {
    const needle = `:${table}:`;
    let count = 0;
    for (const key of this.map.keys()) {
      if (key.includes(needle)) {
        this.map.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Delete a specific key */
  del(key: string): boolean {
    return this.map.delete(key);
  }

  /** Delete all keys matching a prefix (e.g. "user:<userId>:") */
  bustPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Delete all entries */
  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** Stats for /metrics endpoint */
  stats(): { size: number; maxEntries: number } {
    return { size: this.map.size, maxEntries: this.maxEntries };
  }
}

// ─── Singleton instance ──────────────────────────────────────────────────────
export const cache = new LRUCache(
  Number(process.env.CACHE_MAX_ENTRIES || "") || DEFAULT_MAX_ENTRIES,
);

// ─── Per-table TTL configuration ─────────────────────────────────────────────
const TABLE_TTL_MS: Record<string, number> = {
  profiles:       60_000,   // 60s — rarely changes
  groups:         30_000,   // 30s — moderate change frequency
  routes:         30_000,
  templates:      120_000,  // 2min — very stable
  master_groups:  30_000,
  link_hub_pages: 60_000,
  system_settings: 120_000,
  app_runtime_flags: 120_000,
};

// Tables that should be cached on SELECT (user-owned, read-heavy)
const CACHEABLE_TABLES = new Set(Object.keys(TABLE_TTL_MS));

export function getTtlForTable(table: string): number {
  return TABLE_TTL_MS[table] ?? DEFAULT_TTL_MS;
}

export function isCacheable(table: string): boolean {
  return CACHEABLE_TABLES.has(table);
}

/**
 * Build a cache key for a user-scoped table query.
 * Format: "q:<userId>:<table>:<hash>" where hash is a deterministic
 * representation of the query parameters.
 */
export function buildCacheKey(userId: string, table: string, queryFingerprint: string): string {
  return `q:${userId}:${table}:${queryFingerprint}`;
}

/**
 * Invalidate all cached queries for a given user + table.
 * Called after any INSERT/UPDATE/DELETE/UPSERT on that table.
 */
export function bustTableCache(userId: string, table: string): void {
  if (!CACHEABLE_TABLES.has(table)) return;
  cache.bustPrefix(`q:${userId}:${table}:`);
}

/**
 * Invalidate ALL cached queries for a given table, regardless of which user's session cached it.
 * Use after admin-level writes that affect every user (e.g. setting maintenance mode).
 */
export function bustGlobalTableCache(table: string): void {
  if (!CACHEABLE_TABLES.has(table)) return;
  cache.bustByTable(table);
}

// ─── Hit/miss tracking for /metrics ──────────────────────────────────────────
let _hits = 0;
let _misses = 0;

export function cacheHit(): void { _hits++; }
export function cacheMiss(): void { _misses++; }

export function cacheMetrics(): { hits: number; misses: number; hitRate: string; size: number } {
  const total = _hits + _misses;
  return {
    hits: _hits,
    misses: _misses,
    hitRate: total > 0 ? ((_hits / total) * 100).toFixed(1) + "%" : "0%",
    size: cache.size,
  };
}

// ─── Periodic cleanup of expired entries (every 60s) ─────────────────────────
// This prevents memory from growing with stale entries that are never read again.
setInterval(() => {
  const now = Date.now();
  let purged = 0;
  for (const [key, entry] of (cache as unknown as { map: Map<string, CacheEntry<unknown>> }).map) {
    if (now > entry.expiresAt) {
      (cache as unknown as { map: Map<string, CacheEntry<unknown>> }).map.delete(key);
      purged++;
    }
  }
  // if (purged > 0) {
  //   console.debug(JSON.stringify({
  //     ts: new Date().toISOString(), svc: "api", event: "cache_purge", purged, remaining: cache.size,
  //   }));
  // }
}, 60_000).unref();
