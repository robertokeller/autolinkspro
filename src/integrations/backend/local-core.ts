/**
 * local-core.ts — self-hosted edition
 *
 * In-memory cache for admin config & runtime control, backed by the
 * self-hosted PostgreSQL API service (via `system_settings` table).
 * Change notifications use a custom DOM event (LOCAL_DB_UPDATED_EVENT)
 * instead of Supabase Realtime — saves open connections and works with
 * the self-hosted stack that has no Realtime server.
 */

import { backend } from "./client";
import {
  saveAdminConfig as _legacySaveAdminConfig,
  loadAdminConfig as _legacyLoadAdminConfig,
} from "./_local-core-legacy";

const _IS_TEST: boolean = (import.meta.env as Record<string, unknown>)?.MODE === "test";

// ─── Event bus (keeps existing subscriber pattern intact) ────────────────────
export const LOCAL_DB_UPDATED_EVENT = "autolinks:local-db-updated";

function emitLocalDbUpdated() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(LOCAL_DB_UPDATED_EVENT, {
    detail: { at: new Date().toISOString() },
  }));
}

// ─── In-memory caches ────────────────────────────────────────────────────────
let _adminConfigCache: Record<string, unknown> | null = null;
let _runtimeControlCache: { enabled: boolean } | null = null;

/**
 * Called once by AuthContext after the user's session is confirmed.
 * Fetches `admin_config` and `runtime_control` from `system_settings` and
 * populates the caches so that synchronous readers get the latest values.
 */
export async function initializeLocalCoreCache(): Promise<void> {
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

  emitLocalDbUpdated();
}

// ─── subscribeLocalDbChanges ─────────────────────────────────────────────────
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

// ─── Admin config ─────────────────────────────────────────────────────────────
/** Synchronous read from cache — may return null until `initializeLocalCoreCache()` completes. */
export function loadAdminConfig(): Record<string, unknown> | null {
  if (_IS_TEST) return _legacyLoadAdminConfig();
  return _adminConfigCache;
}

/** Async write: persists to PostgreSQL, updates cache, emits LOCAL_DB_UPDATED_EVENT. */
export async function saveAdminConfig(config: Record<string, unknown>): Promise<void> {
  if (_IS_TEST) {
    _legacySaveAdminConfig(config);
    _adminConfigCache = config;
    emitLocalDbUpdated();
    return;
  }
  await backend
    .from("system_settings")
    .upsert({ key: "admin_config", value: config }, { onConflict: "key" });

  _adminConfigCache = config;
  emitLocalDbUpdated();
}

// ─── Runtime control ─────────────────────────────────────────────────────────
/** Synchronous read from cache — defaults to enabled:true. */
export function loadRuntimeControl(): { enabled: boolean } {
  return _runtimeControlCache ?? { enabled: true };
}

/** Async write: persists to Supabase, updates cache, emits LOCAL_DB_UPDATED_EVENT. */
export async function saveRuntimeControl(next: { enabled: boolean }): Promise<void> {
  await backend
    .from("system_settings")
    .upsert({ key: "runtime_control", value: next }, { onConflict: "key" });

  _runtimeControlCache = next;
  emitLocalDbUpdated();
}

// ─── Utilities ───────────────────────────────────────────────────────────────
export function randomId(_prefix?: string): string {
  return crypto.randomUUID();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
