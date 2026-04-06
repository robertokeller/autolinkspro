/**
 * local-core.ts - self-hosted edition
 *
 * In-memory cache for admin config & runtime control, backed by the
 * self-hosted PostgreSQL API service (via `system_settings` table).
 * Change notifications use a custom DOM event (LOCAL_DB_UPDATED_EVENT)
 * instead of Supabase Realtime - saves open connections and works with
 * the self-hosted stack that has no Realtime server.
 */

import { backend } from "./client";

// --- Event bus (keeps existing subscriber pattern intact) -------------------
export const LOCAL_DB_UPDATED_EVENT = "autolinks:local-db-updated";

// --- In-memory caches -------------------------------------------------------
let _adminConfigCache: Record<string, unknown> | null = null;
let _runtimeControlCache: { enabled: boolean } | null = null;

// --- Cross-tab sync via BroadcastChannel ------------------------------------
// When the admin saves config/plan changes in one tab, other browser tabs need
// to refresh their in-memory caches. We use BroadcastChannel to signal those
// tabs. The receiver re-fetches from DB (via _refreshCacheFromRemote) and then
// fires LOCAL_DB_UPDATED_EVENT locally so all same-tab subscribers are notified
// without re-posting to the channel (no infinite loops).
const _bc: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("autolinks:db-sync")
    : null;

/** Internal: fetches both settings from the backend and updates module caches.
 *  Does NOT emit any event or post to BroadcastChannel. */
async function _refreshCacheFromRemote(): Promise<void> {
  try {
    const { data } = await backend
      .from("system_settings")
      .select("key, value")
      .in("key", ["admin_config", "runtime_control"]);

    const entries = (data || []) as Array<{ key: string; value: unknown }>;
    const adminEntry = entries.find((e) => e.key === "admin_config");
    const runtimeEntry = entries.find((e) => e.key === "runtime_control");

    _adminConfigCache = adminEntry ? (adminEntry.value as Record<string, unknown>) : null;
    _runtimeControlCache = runtimeEntry
      ? (runtimeEntry.value as { enabled: boolean })
      : { enabled: true };
  } catch {
    // silently keep defaults when offline / during early startup
  }
}

// Single module-level BroadcastChannel receiver: re-fetches cache from DB,
// then fires the window event in this tab so all React subscribers are notified.
// Does NOT re-post to BC - no loop possible.
if (_bc) {
  _bc.onmessage = () => {
    void _refreshCacheFromRemote().then(() => {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(
          new CustomEvent(LOCAL_DB_UPDATED_EVENT, {
            detail: { at: new Date().toISOString(), source: "broadcast" },
          }),
        );
      }
    });
  };
}

function emitLocalDbUpdated() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(
    new CustomEvent(LOCAL_DB_UPDATED_EVENT, { detail: { at: new Date().toISOString() } }),
  );
  // Cross-tab: notify other browser tabs so they can refresh their own caches:
  _bc?.postMessage({ at: new Date().toISOString() });
}

/**
 * Broadcasts a local-db-updated event in this tab AND to all other browser
 * tabs via BroadcastChannel. Use this whenever you mutate data that other
 * tabs' in-memory caches should react to (e.g. plan assignments).
 */
export function broadcastLocalDbChange() {
  emitLocalDbUpdated();
}

/**
 * Called once by AuthContext after the user's session is confirmed.
 * Fetches `admin_config` and `runtime_control` from `system_settings` and
 * populates the caches so that synchronous readers get the latest values.
 */
export async function initializeLocalCoreCache(): Promise<void> {
  await _refreshCacheFromRemote();
  emitLocalDbUpdated();
}

// --- subscribeLocalDbChanges ------------------------------------------------
export function subscribeLocalDbChanges(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => undefined;
  }

  const handler = () => onChange();
  window.addEventListener(LOCAL_DB_UPDATED_EVENT, handler);

  return () => {
    window.removeEventListener(LOCAL_DB_UPDATED_EVENT, handler);
  };
}

// --- Admin config -----------------------------------------------------------
/** Synchronous read from cache - may return null until `initializeLocalCoreCache()` completes. */
export function loadAdminConfig(): Record<string, unknown> | null {
  return _adminConfigCache;
}

/** Async write: persists to PostgreSQL, updates cache, emits LOCAL_DB_UPDATED_EVENT. */
export async function saveAdminConfig(config: Record<string, unknown>): Promise<void> {
  const result = await backend
    .from("system_settings")
    .upsert({ key: "admin_config", value: config }, { onConflict: "key" });

  if (result.error) {
    throw new Error(result.error.message || "Falha ao salvar configuracao admin");
  }

  _adminConfigCache = config;
  emitLocalDbUpdated();
}

// --- Runtime control --------------------------------------------------------
/** Synchronous read from cache - defaults to enabled:true. */
export function loadRuntimeControl(): { enabled: boolean } {
  return _runtimeControlCache ?? { enabled: true };
}

/** Async write: persists to Supabase, updates cache, emits LOCAL_DB_UPDATED_EVENT. */
export async function saveRuntimeControl(next: { enabled: boolean }): Promise<void> {
  const result = await backend
    .from("system_settings")
    .upsert({ key: "runtime_control", value: next }, { onConflict: "key" });

  if (result.error) {
    throw new Error(result.error.message || "Falha ao salvar controle de runtime");
  }

  _runtimeControlCache = next;
  emitLocalDbUpdated();
}
