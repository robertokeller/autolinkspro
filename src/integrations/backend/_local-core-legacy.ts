import { resolveEffectiveOperationalLimitsByPlanId } from "@/lib/access-control";

interface AuthUserRecord {
  id: string;
  email: string;
  password: string;
  created_at: string;
  user_metadata: Record<string, unknown>;
}

interface LocalDatabase {
  schemaVersion: number;
  /** Admin control plane (plans, access levels, feature rules). Single source of truth — no separate localStorage key. */
  adminConfig: Record<string, unknown> | null;
  /** System runtime on/off toggle. Unified into the main DB — no separate localStorage key. */
  runtimeControl: { enabled: boolean } | null;
  auth: {
    users: AuthUserRecord[];
    session: Session | null;
    recoveryEmail: string | null;
  };
  tables: Record<string, Record<string, unknown>[]>;
  storage: Record<string, Record<string, string>>;
  deletedSeedEmails: string[];
}

type AuthChangeEvent = "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT" | "PASSWORD_RECOVERY" | "USER_UPDATED";

export type LocalAuthError = {
  message: string;
  code?: string;
};

export interface User {
  id: string;
  email: string;
  created_at: string;
  user_metadata: Record<string, unknown>;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  expires_at: number;
  user: User;
}

interface QueryResult<T> {
  data: T | null;
  error: LocalAuthError | null;
  count?: number | null;
}

type Filter =
  | { op: "eq"; column: string; value: unknown }
  | { op: "gte"; column: string; value: unknown }
  | { op: "in"; column: string; value: unknown[] };

const DB_KEY = "autolinks_local_db_v2";
const CONTROL_PLANE_KEY = "autolinks_admin_control_plane_v1";
const RUNTIME_CONTROL_KEY = "autolinks_system_runtime_control_v1";
const DB_VERSION = 5;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOCAL_DB_UPDATED_EVENT = "autolinks:local-db-updated";

// Seed accounts — override via VITE_DEMO_* env vars in .env.local (git-ignored).
const SUPPORT_CONTACT_EMAIL = "suporte@autolinks.pro";
const ROBERTO_ADMIN_EMAIL = (import.meta.env.VITE_DEMO_ADMIN_EMAIL as string | undefined) || "admin@demo.autolinks.local";
const ROBERTO_ADMIN_PASSWORD = (import.meta.env.VITE_DEMO_ADMIN_PASSWORD as string | undefined) || "demo-admin-change-me";
const ROBERTO_ADMIN_NAME = (import.meta.env.VITE_DEMO_ADMIN_NAME as string | undefined) || "Admin Demo";
const ALIANCAS_USER_EMAIL = (import.meta.env.VITE_DEMO_USER_EMAIL as string | undefined) || "usuario@demo.autolinks.local";
const ALIANCAS_USER_PASSWORD = (import.meta.env.VITE_DEMO_USER_PASSWORD as string | undefined) || "demo-user-change-me";
const ALIANCAS_USER_NAME = (import.meta.env.VITE_DEMO_USER_NAME as string | undefined) || "Usuário Demo";
const EXTRA_ADMIN_EMAILS = [ROBERTO_ADMIN_EMAIL];
// Emails legados que devem ser removidos/migrados automaticamente no próximo loadDb()
const LEGACY_REMOVED_EMAILS = [
  "admin@autolinks.local",
  "cliente@autolinks.local",
  "admin@demo.autolinks.local",
  "usuario@demo.autolinks.local",
];

const ADMIN_ROLE = "admin";
const DEFAULT_NOTIFICATION_PREFS = {
  routeErrors: true,
  automationComplete: true,
  sessionDisconnected: true,
  dailyReport: false,
  lowQuotaAlert: true,
  weeklyPerformanceDigest: false,
};

const DEFAULT_MAINTENANCE_FLAGS = {
  maintenance_enabled: false,
  maintenance_title: "Sistema em manutencao",
  maintenance_message: "Estamos realizando melhorias. Tente novamente em alguns minutos.",
  maintenance_eta: null,
  allow_admin_bypass: true,
  updated_by_user_id: "system",
};

const TABLES_WITH_USER_ID = new Set([
  "profiles",
  "user_roles",
  "whatsapp_sessions",
  "telegram_sessions",
  "groups",
  "master_groups",
  "routes",
  "templates",
  "scheduled_posts",
  "history_entries",
  "link_hub_pages",
  "shopee_automations",
  "meli_sessions",
  "api_credentials",
  "admin_audit_logs",
  "user_notifications",
]);

const TABLE_DEFAULTS = [
  "profiles",
  "user_roles",
  "whatsapp_sessions",
  "telegram_sessions",
  "groups",
  "master_groups",
  "master_group_links",
  "routes",
  "route_destinations",
  "templates",
  "scheduled_posts",
  "scheduled_post_destinations",
  "history_entries",
  "link_hub_pages",
  "shopee_automations",
  "meli_sessions",
  "api_credentials",
  "admin_audit_logs",
  "system_announcements",
  "user_notifications",
  "app_runtime_flags",
];

const authListeners = new Map<string, (event: AuthChangeEvent, session: Session | null) => void>();
let localDbBridgeInitialized = false;
const storageFallback = new Map<string, string>();
let recoveryPendingInMemory = false;

// ─── Login rate-limit (F10) ───────────────────────────────────────────────────
// In-memory only: resets when the page is reloaded, which is acceptable for a
// client-side local app.  The goal is to slow down scripted brute-force, not to
// provide hard security guarantees.
const MAX_LOGIN_FAILURES  = 5;
const LOGIN_WINDOW_MS     = 15 * 60 * 1000; // 15 min
const LOGIN_LOCKOUT_MS    = 15 * 60 * 1000; // 15 min

interface LoginFailureRecord {
  count: number;
  firstFailAt: number;
  lockedUntil: number;
}

const loginFailures = new Map<string, LoginFailureRecord>();

function checkLoginRateLimit(email: string): boolean /* blocked */ {
  const now = Date.now();
  const rec = loginFailures.get(email);
  if (!rec) return false;
  // Expire old windows.
  if (now - rec.firstFailAt > LOGIN_WINDOW_MS) { loginFailures.delete(email); return false; }
  return rec.lockedUntil > now;
}

function recordLoginFailure(email: string): void {
  const now = Date.now();
  let rec = loginFailures.get(email);
  if (!rec || now - rec.firstFailAt > LOGIN_WINDOW_MS) {
    rec = { count: 1, firstFailAt: now, lockedUntil: 0 };
  } else {
    rec.count += 1;
    if (rec.count >= MAX_LOGIN_FAILURES) rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
  loginFailures.set(email, rec);
}

function clearLoginFailures(email: string): void {
  loginFailures.delete(email);
}

// ─── SignUp rate-limit ────────────────────────────────────────────────────────
// Prevents scripted bulk account creation.  Window-based, in-memory.
const MAX_SIGNUP_PER_WINDOW  = 5;
const SIGNUP_WINDOW_MS       = 60 * 60 * 1000; // 1 hour

let signupWindowStart = 0;
let signupWindowCount = 0;

function checkSignupRateLimit(): boolean /* blocked */ {
  const now = Date.now();
  if (now - signupWindowStart > SIGNUP_WINDOW_MS) {
    signupWindowStart = now;
    signupWindowCount = 0;
  }
  return signupWindowCount >= MAX_SIGNUP_PER_WINDOW;
}

function recordSignup(): void {
  const now = Date.now();
  if (now - signupWindowStart > SIGNUP_WINDOW_MS) {
    signupWindowStart = now;
    signupWindowCount = 0;
  }
  signupWindowCount += 1;
}

// Storage helpers — in-memory only (test infrastructure; no localStorage persisted).
function readStorage(key: string): string | null {
  return storageFallback.get(key) ?? null;
}

function writeStorage(key: string, value: string): void {
  storageFallback.set(key, value);
}

function removeStorage(key: string): void {
  storageFallback.delete(key);
}

function emitLocalDbUpdated() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(LOCAL_DB_UPDATED_EVENT, {
    detail: { at: new Date().toISOString() },
  }));
}

function ensureLocalDbSyncBridge() {
  // No-op: storage events are not used since data never touches localStorage.
  if (localDbBridgeInitialized) return;
  localDbBridgeInitialized = true;
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isMissing(value: unknown) {
  return value == null || value === "";
}

function ensureNotificationPrefs(value: unknown) {
  const source = asObject(value);
  return {
    routeErrors: source.routeErrors !== false,
    automationComplete: source.automationComplete !== false,
    sessionDisconnected: source.sessionDisconnected !== false,
    dailyReport: source.dailyReport === true,
    lowQuotaAlert: source.lowQuotaAlert !== false,
    weeklyPerformanceDigest: source.weeklyPerformanceDigest === true,
  };
}

function ensureTargetFilter(value: unknown) {
  const source = asObject(value);
  const roles = asStringArray(source.roles).filter((role) => role === "admin" || role === "user");
  const matchMode = source.matchMode === "all" ? "all" : "any";
  return {
    planIds: asStringArray(source.planIds),
    accessLevelIds: asStringArray(source.accessLevelIds),
    roles,
    userIds: asStringArray(source.userIds),
    matchMode,
  };
}

function ensureAppRuntimeFlagsRow(db: LocalDatabase) {
  const rows = db.tables.app_runtime_flags as Record<string, unknown>[];
  let row = rows.find((item) => String(item.id || "") === "global");
  if (!row) {
    row = {
      id: "global",
      created_at: nowIso(),
      updated_at: nowIso(),
      ...DEFAULT_MAINTENANCE_FLAGS,
    };
    rows.push(row);
  }

  row.id = "global";
  row.maintenance_enabled = row.maintenance_enabled === true;
  row.maintenance_title = typeof row.maintenance_title === "string" && row.maintenance_title.trim()
    ? row.maintenance_title.trim()
    : DEFAULT_MAINTENANCE_FLAGS.maintenance_title;
  row.maintenance_message = typeof row.maintenance_message === "string" && row.maintenance_message.trim()
    ? row.maintenance_message.trim()
    : DEFAULT_MAINTENANCE_FLAGS.maintenance_message;
  row.maintenance_eta = typeof row.maintenance_eta === "string" && row.maintenance_eta.trim()
    ? row.maintenance_eta.trim()
    : null;
  row.allow_admin_bypass = row.allow_admin_bypass !== false;
  row.updated_by_user_id = typeof row.updated_by_user_id === "string" && row.updated_by_user_id.trim()
    ? row.updated_by_user_id.trim()
    : "system";
  if (!row.created_at) row.created_at = nowIso();
  if (!row.updated_at) row.updated_at = nowIso();
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(input: string | null): T | null {
  if (!input) return null;
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

// ─── Admin config: prevents loadDb() recursion during migrateDb ───────────────
// undefined = normal context (use loadDb); null = migrating, no config; object = migrating with config
let _migrationAdminConfig: Record<string, unknown> | null | undefined = undefined;

/**
 * Returns the raw admin config object.
 * When called from within migrateDb, returns the cached value to prevent
 * loadDb() re-entrancy. When called normally, reads through loadDb().
 */
function getAdminConfigRaw(): Record<string, unknown> | null {
  if (_migrationAdminConfig !== undefined) return _migrationAdminConfig;
  return loadDb().adminConfig ?? null;
}

function resolveDefaultSignupPlanIdFromControlPlane(): string {
  const fallback = "plan-starter";
  const parsed = getAdminConfigRaw();
  if (!parsed) return fallback;

  const plans = Array.isArray(parsed.plans)
    ? parsed.plans.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];

  const planIds = plans
    .map((plan) => String(plan.id || "").trim())
    .filter(Boolean);
  if (planIds.length === 0) return fallback;

  const preferred = String(parsed.defaultSignupPlanId || "").trim();
  if (preferred && planIds.includes(preferred)) return preferred;

  const firstActive = plans.find((plan) => plan.isActive === true);
  const firstActiveId = String(firstActive?.id || "").trim();
  if (firstActiveId) return firstActiveId;

  return planIds[0] || fallback;
}

function resolveValidPlanIdFromControlPlane(candidate: string): string {
  const fallback = resolveDefaultSignupPlanIdFromControlPlane();
  const parsed = getAdminConfigRaw();
  if (!parsed) return fallback;

  const plans = Array.isArray(parsed.plans)
    ? parsed.plans.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];

  const validPlanIds = new Set(
    plans
      .map((plan) => String(plan.id || "").trim())
      .filter(Boolean),
  );

  const normalized = candidate.trim();
  if (normalized && validPlanIds.has(normalized)) return normalized;
  return fallback;
}

function resolvePlanPeriodFromControlPlane(planId: string): string | null {
  const parsed = getAdminConfigRaw();
  if (!parsed) return null;

  const plans = Array.isArray(parsed.plans)
    ? parsed.plans.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];

  const selectedPlan = plans.find((plan) => String(plan.id || "").trim() === planId);
  if (!selectedPlan) return null;

  const period = String(selectedPlan.period || "").trim();
  return period || null;
}

function parsePlanPeriodToMs(periodRaw: string): number | null {
  const normalized = periodRaw.trim().toLowerCase();
  if (!normalized) return null;

  const monthMs = 30 * 24 * 60 * 60 * 1000;
  const yearMs = 365 * 24 * 60 * 60 * 1000;

  const match = normalized.match(/(\d+)\s*(dia|dias|d|mes|meses|m[eê]s|ano|anos)/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;

    if (unit.startsWith("dia") || unit === "d") {
      return amount * 24 * 60 * 60 * 1000;
    }
    if (unit.startsWith("mes") || unit.startsWith("mês")) {
      return amount * monthMs;
    }
    if (unit.startsWith("ano")) {
      return amount * yearMs;
    }
  }

  if (normalized.includes("/mes") || normalized.includes("mes") || normalized.includes("mês")) {
    return monthMs;
  }
  if (normalized.includes("/ano") || normalized.includes("ano")) {
    return yearMs;
  }

  return null;
}

export function resolvePlanExpirationIsoFromControlPlane(planId: string, startMs = Date.now()): string | null {
  const period = resolvePlanPeriodFromControlPlane(planId);
  if (!period) return null;

  const durationMs = parsePlanPeriodToMs(period);
  if (!durationMs) return null;

  return new Date(startMs + durationMs).toISOString();
}

export function randomId(_prefix = "id") {
  // crypto.randomUUID is available in all modern browsers (Chrome 92+, Firefox 95+, Safari 15.4+)
  // and Node 14.17+. The insecure Math.random fallback has been intentionally removed.
  return crypto.randomUUID();
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isAdminEmail(email: string) {
  const normalized = normalizeEmail(email);
  return EXTRA_ADMIN_EMAILS.some((candidate) => normalizeEmail(candidate) === normalized);
}

// ─── Password hashing (PBKDF2 / WebCrypto) ───────────────────────────────────

const HASH_PREFIX = "pbkdf2:v1:";

function isHashed(stored: string) {
  return stored.startsWith(HASH_PREFIX);
}

/**
 * Derives a PBKDF2-SHA256 hash with a fresh random 16-byte salt.
 * Stored format: "pbkdf2:v1:<saltBase64>:<hashBase64>"
 */
export async function hashPassword(plain: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(plain), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return `${HASH_PREFIX}${saltB64}:${hashB64}`;
}

/**
 * Verifies `plain` against a stored password (hashed or legacy plaintext).
 * Legacy plaintext passwords are migrated by callers after a successful verify.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!isHashed(stored)) {
    // Legacy plaintext — constant-time compare
    const encoder = new TextEncoder();
    const a = encoder.encode(plain);
    const b = encoder.encode(stored);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  const parts = stored.slice(HASH_PREFIX.length).split(":");
  if (parts.length !== 2) return false;
  const [saltB64, storedHashB64] = parts;
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(plain), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(bits)));
  // Constant-time string comparison
  const a = encoder.encode(computed);
  const b = encoder.encode(storedHashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function getUserFromRecord(record: AuthUserRecord): User {
  return {
    id: record.id,
    email: record.email,
    created_at: record.created_at,
    user_metadata: record.user_metadata || {},
  };
}

function createSessionForUser(user: User): Session {
  const expiresIn = 60 * 60 * 24; // 24 hours (reduced from 30 days for security)
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  return {
    access_token: randomId("token"),
    refresh_token: randomId("refresh"),
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: expiresAt,
    user,
  };
}

function ensureTables(db: LocalDatabase) {
  for (const name of TABLE_DEFAULTS) {
    if (!Array.isArray(db.tables[name])) db.tables[name] = [];
  }
}

function ensureUserDefaults(db: LocalDatabase, user: AuthUserRecord, role: "admin" | "user" = "user", planId = "plan-starter") {
  if (!db.tables.profiles.some((row) => row.user_id === user.id)) {
    const planExpiresAt = resolvePlanExpirationIsoFromControlPlane(planId);
    db.tables.profiles.push({
      id: randomId("profile"),
      user_id: user.id,
      name: String(user.user_metadata?.name || "Usuário"),
      email: user.email,
      plan_id: planId,
      plan_expires_at: planExpiresAt,
      notification_prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  for (let i = db.tables.user_roles.length - 1; i >= 0; i -= 1) {
    if (db.tables.user_roles[i].user_id === user.id) {
      db.tables.user_roles.splice(i, 1);
    }
  }

  db.tables.user_roles.push({
    id: randomId("role"),
    user_id: user.id,
    role,
    created_at: nowIso(),
  });
}

function addAuthUser(db: LocalDatabase, input: { email: string; password: string; name: string }, role: "admin" | "user" = "user", planId = "plan-starter") {
  const record: AuthUserRecord = {
    id: randomId("usr"),
    email: normalizeEmail(input.email),
    password: input.password,
    created_at: nowIso(),
    user_metadata: {
      name: input.name,
      account_status: "active",
      status_updated_at: nowIso(),
    },
  };

  db.auth.users.push(record);
  ensureUserDefaults(db, record, role, planId);
  return record;
}

export function deleteUserFromDb(db: LocalDatabase, userId: string) {
  const deletedUser = db.auth.users.find((row) => row.id === userId);
  if (deletedUser) {
    const email = normalizeEmail(deletedUser.email);
    const seedEmails = new Set([normalizeEmail(ALIANCAS_USER_EMAIL)]);
    if (seedEmails.has(email)) {
      if (!Array.isArray(db.deletedSeedEmails)) db.deletedSeedEmails = [];
      if (!db.deletedSeedEmails.includes(email)) db.deletedSeedEmails.push(email);
    }
  }

  db.auth.users = db.auth.users.filter((row) => row.id !== userId);

  const userScopedTables = [
    "profiles",
    "user_roles",
    "whatsapp_sessions",
    "telegram_sessions",
    "groups",
    "master_groups",
    "routes",
    "templates",
    "scheduled_posts",
    "history_entries",
    "link_hub_pages",
    "shopee_automations",
    "meli_sessions",
    "api_credentials",
    "user_notifications",
  ] as const;

  for (const tableName of userScopedTables) {
    db.tables[tableName] = db.tables[tableName].filter((row) => row.user_id !== userId);
  }

  const routeIds = new Set(db.tables.routes.map((row) => String(row.id)));
  db.tables.route_destinations = db.tables.route_destinations.filter((row) => routeIds.has(String(row.route_id)));

  const postIds = new Set(db.tables.scheduled_posts.map((row) => String(row.id)));
  db.tables.scheduled_post_destinations = db.tables.scheduled_post_destinations.filter((row) => postIds.has(String(row.post_id)));

  const masterGroupIds = new Set(db.tables.master_groups.map((row) => String(row.id)));
  const groupIds = new Set(db.tables.groups.map((row) => String(row.id)));
  db.tables.master_group_links = db.tables.master_group_links.filter(
    (row) => masterGroupIds.has(String(row.master_group_id)) && groupIds.has(String(row.group_id)),
  );

  if (db.auth.session?.user?.id === userId) {
    db.auth.session = null;
  }
}

function ensureProfileForUser(db: LocalDatabase, user: AuthUserRecord, planId = "plan-starter") {
  if (db.tables.profiles.some((row) => row.user_id === user.id)) return;
  db.tables.profiles.push({
    id: randomId("profile"),
    user_id: user.id,
    name: String(user.user_metadata?.name || "Usuário"),
    email: user.email,
    plan_id: planId,
    plan_expires_at: resolvePlanExpirationIsoFromControlPlane(planId),
    notification_prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

function applyTableShapeDefaults(table: string, row: Record<string, unknown>) {
  switch (table) {
    case "profiles": {
      if (isMissing(row.name)) row.name = "Usuário";
      if (isMissing(row.email)) row.email = "";
      const currentPlanId = String(row.plan_id || "").trim();
      const validPlanId = resolveValidPlanIdFromControlPlane(currentPlanId || "plan-starter");
      if (currentPlanId !== validPlanId) {
        row.plan_id = validPlanId;
      } else if (isMissing(row.plan_id)) {
        row.plan_id = validPlanId;
      }
      if (isMissing(row.plan_expires_at) || currentPlanId !== validPlanId) {
        row.plan_expires_at = resolvePlanExpirationIsoFromControlPlane(validPlanId);
      }
      row.notification_prefs = ensureNotificationPrefs(row.notification_prefs);
      break;
    }
    case "user_roles": {
      row.role = row.role === "admin" ? "admin" : "user";
      break;
    }
    case "whatsapp_sessions": {
      if (isMissing(row.name)) row.name = "Sessão WhatsApp";
      if (isMissing(row.phone)) row.phone = "";
      row.status = typeof row.status === "string" ? row.status : "offline";
      row.is_default = row.is_default === true;
      row.auth_method = row.auth_method === "pairing" ? "pairing" : "qr";
      row.qr_code = typeof row.qr_code === "string" ? row.qr_code : "";
      row.error_message = typeof row.error_message === "string" ? row.error_message : "";
      row.connected_at = typeof row.connected_at === "string" ? row.connected_at : null;
      row.microservice_url = typeof row.microservice_url === "string" ? row.microservice_url : "";
      break;
    }
    case "telegram_sessions": {
      if (isMissing(row.name)) row.name = "Sessão Telegram";
      if (isMissing(row.phone)) row.phone = "";
      row.status = typeof row.status === "string" ? row.status : "offline";
      row.connected_at = typeof row.connected_at === "string" ? row.connected_at : null;
      row.error_message = typeof row.error_message === "string" ? row.error_message : "";
      row.phone_code_hash = typeof row.phone_code_hash === "string" ? row.phone_code_hash : "";
      row.session_string = typeof row.session_string === "string" ? row.session_string : "";
      break;
    }
    case "groups": {
      if (isMissing(row.name)) row.name = "Grupo";
      row.platform = row.platform === "telegram" ? "telegram" : "whatsapp";
      row.member_count = typeof row.member_count === "number" && Number.isFinite(row.member_count) ? row.member_count : 0;
      row.session_id = typeof row.session_id === "string" ? row.session_id : null;
      row.external_id = typeof row.external_id === "string" ? row.external_id : null;
      row.deleted_at = typeof row.deleted_at === "string" ? row.deleted_at : null;
      break;
    }
    case "master_groups": {
      if (isMissing(row.name)) row.name = "Grupo Mestre";
      row.slug = typeof row.slug === "string" ? row.slug : null;
      row.distribution = typeof row.distribution === "string" ? row.distribution : "balanced";
      row.member_limit = typeof row.member_limit === "number" && Number.isFinite(row.member_limit) ? row.member_limit : 0;
      break;
    }
    case "master_group_links": {
      row.is_active = row.is_active !== false;
      break;
    }
    case "routes": {
      if (isMissing(row.name)) row.name = "Nova rota";
      row.source_group_id = typeof row.source_group_id === "string" ? row.source_group_id : "";
      row.status = typeof row.status === "string" ? row.status : "active";
      row.rules = asObject(row.rules);
      break;
    }
    case "templates": {
      if (isMissing(row.name)) row.name = "Template";
      row.content = typeof row.content === "string" ? row.content : "{link}";
      if (typeof row.category === "string") {
        const normalized = row.category.trim().toLowerCase();
        if (normalized === "general") {
          row.category = "geral";
        } else if (normalized === "oferta" || normalized === "cupom" || normalized === "geral") {
          row.category = normalized;
        } else {
          row.category = "geral";
        }
      } else {
        row.category = "geral";
      }
      row.is_default = row.is_default === true;
      break;
    }
    case "scheduled_posts": {
      row.content = typeof row.content === "string" ? row.content : "";
      row.scheduled_at = typeof row.scheduled_at === "string" ? row.scheduled_at : nowIso();
      row.recurrence = typeof row.recurrence === "string" ? row.recurrence : "none";
      row.status = typeof row.status === "string" ? row.status : "pending";
      row.metadata = asObject(row.metadata);
      break;
    }
    case "history_entries": {
      row.type = typeof row.type === "string" ? row.type : "session_event";
      row.source = typeof row.source === "string" ? row.source : "";
      row.destination = typeof row.destination === "string" ? row.destination : "";
      row.status = typeof row.status === "string" ? row.status : "info";
      row.details = asObject(row.details);
      row.direction = typeof row.direction === "string" ? row.direction : "system";
      row.message_type = typeof row.message_type === "string" ? row.message_type : "text";
      row.processing_status = typeof row.processing_status === "string" ? row.processing_status : "processed";
      row.block_reason = typeof row.block_reason === "string" ? row.block_reason : "";
      row.error_step = typeof row.error_step === "string" ? row.error_step : "";
      break;
    }
    case "link_hub_pages": {
      if (isMissing(row.slug)) row.slug = "";
      if (isMissing(row.title)) row.title = "Link Hub";
      row.is_active = row.is_active !== false;
      row.config = asObject(row.config);
      break;
    }
    case "shopee_automations": {
      if (isMissing(row.name)) row.name = "Automação Shopee";
      row.interval_minutes = typeof row.interval_minutes === "number" && Number.isFinite(row.interval_minutes) ? row.interval_minutes : 60;
      row.min_discount = typeof row.min_discount === "number" && Number.isFinite(row.min_discount) ? row.min_discount : 0;
      row.min_commission = typeof row.min_commission === "number" && Number.isFinite(row.min_commission) ? row.min_commission : 0;
      row.min_price = typeof row.min_price === "number" && Number.isFinite(row.min_price) ? row.min_price : 0;
      row.max_price = typeof row.max_price === "number" && Number.isFinite(row.max_price) ? row.max_price : 9999;
      row.categories = asStringArray(row.categories);
      row.destination_group_ids = asStringArray(row.destination_group_ids);
      row.master_group_ids = asStringArray(row.master_group_ids);
      row.template_id = typeof row.template_id === "string" ? row.template_id : null;
      row.session_id = typeof row.session_id === "string" ? row.session_id : null;
      row.active_hours_start = typeof row.active_hours_start === "string" ? row.active_hours_start : "08:00";
      row.active_hours_end = typeof row.active_hours_end === "string" ? row.active_hours_end : "20:00";
      row.products_sent = typeof row.products_sent === "number" && Number.isFinite(row.products_sent) ? row.products_sent : 0;
      row.last_run_at = typeof row.last_run_at === "string" ? row.last_run_at : null;
      row.is_active = row.is_active !== false;
      row.config = asObject(row.config);
      break;
    }
    case "meli_sessions": {
      if (isMissing(row.name)) row.name = "Sessão ML";
      row.account_name = typeof row.account_name === "string" ? row.account_name : "";
      row.ml_user_id = typeof row.ml_user_id === "string" ? row.ml_user_id : "";
      row.status = typeof row.status === "string" ? row.status : "untested";
      row.last_checked_at = typeof row.last_checked_at === "string" ? row.last_checked_at : null;
      row.error_message = typeof row.error_message === "string" ? row.error_message : "";
      break;
    }
    case "api_credentials": {
      row.provider = typeof row.provider === "string" ? row.provider : "shopee";
      row.app_id = typeof row.app_id === "string" ? row.app_id : "";
      row.secret_key = typeof row.secret_key === "string" ? row.secret_key : "";
      row.region = typeof row.region === "string" ? row.region : "BR";
      break;
    }
    case "admin_audit_logs": {
      row.action = typeof row.action === "string" ? row.action : "";
      row.target_user_id = typeof row.target_user_id === "string" ? row.target_user_id : null;
      row.details = asObject(row.details);
      break;
    }
    case "system_announcements": {
      row.created_by_user_id = typeof row.created_by_user_id === "string" ? row.created_by_user_id : "";
      row.title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Comunicado";
      row.message = typeof row.message === "string" ? row.message : "";
      row.severity = row.severity === "critical" || row.severity === "warning" ? row.severity : "info";
      row.channel = row.channel === "modal" || row.channel === "both" ? row.channel : "bell";
      row.auto_popup_on_login = row.auto_popup_on_login === true;
      row.starts_at = typeof row.starts_at === "string" && row.starts_at.trim() ? row.starts_at.trim() : null;
      row.ends_at = typeof row.ends_at === "string" && row.ends_at.trim() ? row.ends_at.trim() : null;
      row.is_active = row.is_active !== false;
      row.target_filter = ensureTargetFilter(row.target_filter);
      break;
    }
    case "user_notifications": {
      row.announcement_id = typeof row.announcement_id === "string" ? row.announcement_id : "";
      row.status = row.status === "read" || row.status === "dismissed" ? row.status : "unread";
      row.read_at = typeof row.read_at === "string" && row.read_at.trim() ? row.read_at.trim() : null;
      row.dismissed_at = typeof row.dismissed_at === "string" && row.dismissed_at.trim() ? row.dismissed_at.trim() : null;
      row.delivered_at = typeof row.delivered_at === "string" && row.delivered_at.trim() ? row.delivered_at.trim() : nowIso();
      break;
    }
    case "app_runtime_flags": {
      row.id = "global";
      row.maintenance_enabled = row.maintenance_enabled === true;
      row.maintenance_title = typeof row.maintenance_title === "string" && row.maintenance_title.trim()
        ? row.maintenance_title.trim()
        : DEFAULT_MAINTENANCE_FLAGS.maintenance_title;
      row.maintenance_message = typeof row.maintenance_message === "string" && row.maintenance_message.trim()
        ? row.maintenance_message.trim()
        : DEFAULT_MAINTENANCE_FLAGS.maintenance_message;
      row.maintenance_eta = typeof row.maintenance_eta === "string" && row.maintenance_eta.trim()
        ? row.maintenance_eta.trim()
        : null;
      row.allow_admin_bypass = row.allow_admin_bypass !== false;
      row.updated_by_user_id = typeof row.updated_by_user_id === "string" && row.updated_by_user_id.trim()
        ? row.updated_by_user_id.trim()
        : "system";
      break;
    }
  }
}

function migrateDb(raw: LocalDatabase | null): LocalDatabase {
  const db: LocalDatabase = raw && typeof raw === "object"
    ? raw
    : {
        schemaVersion: DB_VERSION,
        adminConfig: null,
        runtimeControl: null,
        auth: { users: [], session: null, recoveryEmail: null },
        tables: {},
        storage: {},
        deletedSeedEmails: [],
      };

  db.schemaVersion = DB_VERSION;
  if (!db.auth) db.auth = { users: [], session: null, recoveryEmail: null };
  if (!Array.isArray(db.auth.users)) db.auth.users = [];
  if (!db.tables || typeof db.tables !== "object") db.tables = {};
  if (!db.storage || typeof db.storage !== "object") db.storage = {};
  if (typeof db.auth.recoveryEmail !== "string") db.auth.recoveryEmail = null;
  if (!Array.isArray(db.deletedSeedEmails)) db.deletedSeedEmails = [];
  if ("meli_automations" in db.tables) delete db.tables.meli_automations;

  // ─── Admin config migration ───────────────────────────────────────────────
  // Migrate from the legacy separate key into db.adminConfig on first load.
  if (typeof db.adminConfig !== "object") db.adminConfig = null;
  if (!db.adminConfig) {
    const legacyConfig = parseJson<Record<string, unknown>>(readStorage(CONTROL_PLANE_KEY));
    if (legacyConfig) {
      db.adminConfig = legacyConfig;
      removeStorage(CONTROL_PLANE_KEY); // clean up old key after one-time migration
    }
  }
  // Cache for all internal resolve calls — prevents loadDb() re-entrancy.
  _migrationAdminConfig = db.adminConfig ?? null;

  // ─── Runtime control migration ────────────────────────────────────────────
  // Migrate from the legacy separate key into db.runtimeControl on first load.
  if (!db.runtimeControl || typeof db.runtimeControl !== "object") db.runtimeControl = null;
  if (!db.runtimeControl) {
    const legacyRuntime = parseJson<{ enabled?: boolean }>(readStorage(RUNTIME_CONTROL_KEY));
    db.runtimeControl = { enabled: legacyRuntime?.enabled !== false };
    removeStorage(RUNTIME_CONTROL_KEY); // clean up old key after one-time migration
  }

  ensureTables(db);

  for (const tableName of TABLE_DEFAULTS) {
    const tableRows = db.tables[tableName];
    if (!Array.isArray(tableRows)) {
      db.tables[tableName] = [];
      continue;
    }

    const normalized = tableRows
      .filter((row) => row && typeof row === "object")
      .map((row) => {
        const next = row as Record<string, unknown>;
        if (!next.id) next.id = randomId(tableName);
        if (!next.created_at) next.created_at = nowIso();
        if (!next.updated_at) next.updated_at = nowIso();
        applyTableShapeDefaults(tableName, next);
        return next;
      });

    db.tables[tableName] = normalized;
  }

  ensureAppRuntimeFlagsRow(db);

  try {
  const robertoEmail = normalizeEmail(ROBERTO_ADMIN_EMAIL);
  const robertoUser = db.auth.users.find((row) => normalizeEmail(row.email) === robertoEmail);

  if (!robertoUser) {
    addAuthUser(db, {
      email: ROBERTO_ADMIN_EMAIL,
      password: ROBERTO_ADMIN_PASSWORD,
      name: ROBERTO_ADMIN_NAME,
    }, "admin", "plan-pro");
  } else if (!isHashed(robertoUser.password)) {
    // Only sync seed password when it is still plaintext (user has never logged in
    // or upgraded the hash). Once the password is hashed via login or UI, the user-
    // supplied value takes precedence and must NOT be silently overwritten.
    robertoUser.password = ROBERTO_ADMIN_PASSWORD;
  }

  const aliancasEmail = normalizeEmail(ALIANCAS_USER_EMAIL);
  const aliancasUser = db.auth.users.find((row) => normalizeEmail(row.email) === aliancasEmail);

  if (!aliancasUser && !db.deletedSeedEmails.includes(aliancasEmail)) {
    addAuthUser(db, {
      email: ALIANCAS_USER_EMAIL,
      password: ALIANCAS_USER_PASSWORD,
      name: ALIANCAS_USER_NAME,
    }, "user", "plan-starter");
  } else if (aliancasUser) {
    if (!isHashed(aliancasUser.password)) {
      // Same rule as the admin seed: only reset while still plaintext.
      aliancasUser.password = ALIANCAS_USER_PASSWORD;
    }
    aliancasUser.user_metadata = {
      ...aliancasUser.user_metadata,
      name: String(aliancasUser.user_metadata?.name || ALIANCAS_USER_NAME),
      account_status: "active",
      status_updated_at: nowIso(),
    };

    for (let i = db.tables.user_roles.length - 1; i >= 0; i -= 1) {
      if (db.tables.user_roles[i].user_id === aliancasUser.id) {
        db.tables.user_roles.splice(i, 1);
      }
    }
    db.tables.user_roles.push({
      id: randomId("role"),
      user_id: aliancasUser.id,
      role: "user",
      created_at: nowIso(),
    });

    const aliancasProfile = db.tables.profiles.find((row) => row.user_id === aliancasUser.id);
    if (aliancasProfile) {
      // Do NOT force-reset plan_id: the admin may have upgraded this user via the
      // AdminUsers panel. Only set it when it is genuinely missing.
      if (isMissing(aliancasProfile.plan_id)) {
        aliancasProfile.plan_id = resolveDefaultSignupPlanIdFromControlPlane();
        aliancasProfile.plan_expires_at = resolvePlanExpirationIsoFromControlPlane(
          String(aliancasProfile.plan_id),
        );
        aliancasProfile.updated_at = nowIso();
      }
    } else {
      ensureProfileForUser(db, aliancasUser, "plan-starter");
    }
  }

  // Remove legacy seeded users that should not exist anymore.
  // Before deletion, rescue admin-owned data (templates, routes, automations…) by
  // re-parenting it to the current active admin so nothing is wiped during an
  // email-address migration (e.g. admin@autolinks.local → admin@demo.autolinks.local).
  const removedEmailSet = new Set(LEGACY_REMOVED_EMAILS.map((email) => normalizeEmail(email)));
  const legacyUsers = db.auth.users.filter((row) => removedEmailSet.has(normalizeEmail(row.email)));
  if (legacyUsers.length > 0) {
    const currentAdminUser = db.auth.users.find((row) => normalizeEmail(row.email) === normalizeEmail(ROBERTO_ADMIN_EMAIL));
    if (currentAdminUser) {
      const rescueTables = [
        "templates", "routes", "shopee_automations", "groups", "master_groups",
        // Note: this comment keeps the structure clear
        "whatsapp_sessions", "telegram_sessions", "api_credentials",
        "link_hub_pages", "meli_sessions", "scheduled_posts",
      ];
      for (const legacyUser of legacyUsers) {
        // Only rescue data that belongs to a legacy admin account.
        const wasAdmin = db.tables.user_roles.some((r) => r.user_id === legacyUser.id && r.role === "admin");
        if (!wasAdmin) continue;
        for (const tableName of rescueTables) {
          const tableRows = db.tables[tableName] as Array<Record<string, unknown>>;
          if (!Array.isArray(tableRows)) continue;
          for (const row of tableRows) {
            if (row.user_id === legacyUser.id) {
              row.user_id = currentAdminUser.id;
            }
          }
        }
      }
    }
    for (const legacyUser of legacyUsers) {
      deleteUserFromDb(db, legacyUser.id);
    }
  }

  for (const user of db.auth.users) {
    const admin = isAdminEmail(user.email);
    if (!db.tables.user_roles.some((row) => row.user_id === user.id)) {
      ensureUserDefaults(db, user, admin ? "admin" : "user", admin ? "plan-pro" : "plan-starter");
      continue;
    }

    ensureProfileForUser(db, user, admin ? "plan-pro" : "plan-starter");
  }

  // Ensure known admin emails keep admin role even if an older role row already exists.
  for (const user of db.auth.users) {
    if (!isAdminEmail(user.email)) continue;
    ensureUserDefaults(db, user, "admin", "plan-pro");
  }

  if (db.auth.session) {
    const stillExists = db.auth.users.some((row) => row.id === db.auth.session?.user.id);
    if (!stillExists) db.auth.session = null;
  }

  // ── Referential integrity pruning ────────────────────────────────────────────
  // Removes orphaned rows in linking/child tables so stale IDs never cause
  // silent mismatches (e.g. route_destinations pointing to deleted routes).
  {
    const validRouteIds = new Set((db.tables.routes as Array<Record<string, unknown>>).map((r) => String(r.id)));
    db.tables.route_destinations = (db.tables.route_destinations as Array<Record<string, unknown>>).filter(
      (row) => validRouteIds.has(String(row.route_id)),
    );

    const validMasterGroupIds = new Set((db.tables.master_groups as Array<Record<string, unknown>>).map((r) => String(r.id)));
    const validGroupIds = new Set((db.tables.groups as Array<Record<string, unknown>>).map((r) => String(r.id)));
    db.tables.master_group_links = (db.tables.master_group_links as Array<Record<string, unknown>>).filter(
      (row) => validMasterGroupIds.has(String(row.master_group_id)) && validGroupIds.has(String(row.group_id)),
    );

    const validPostIds = new Set((db.tables.scheduled_posts as Array<Record<string, unknown>>).map((r) => String(r.id)));
    db.tables.scheduled_post_destinations = (db.tables.scheduled_post_destinations as Array<Record<string, unknown>>).filter(
      (row) => validPostIds.has(String(row.post_id)),
    );

    // Null-out template_id in shopee_automations that reference deleted templates.
    const validTemplateIds = new Set((db.tables.templates as Array<Record<string, unknown>>).map((r) => String(r.id)));
    for (const row of db.tables.shopee_automations as Array<Record<string, unknown>>) {
      if (row.template_id && !validTemplateIds.has(String(row.template_id))) {
        row.template_id = null;
      }
    }
  }

  const historyRows = Array.isArray(db.tables.history_entries)
    ? (db.tables.history_entries as Array<Record<string, unknown>>)
    : [];
  const historyCutoffMs = Date.now() - HISTORY_RETENTION_MS;
  db.tables.history_entries = historyRows.filter((row) => {
    const createdAtMs = Date.parse(String(row.created_at || ""));
    if (Number.isNaN(createdAtMs)) return true;
    return createdAtMs >= historyCutoffMs;
  });

  } finally {
    // Always release the migration lock so subsequent loadDb() calls work normally.
    _migrationAdminConfig = undefined;
  }

  return db;
}

export function loadDb() {
  ensureLocalDbSyncBridge();
  const raw = readStorage(DB_KEY);
  const db = migrateDb(parseJson<LocalDatabase>(raw));
  const serialized = JSON.stringify(db);

  // Persist migrations/defaults silently. Emitting update events during reads can
  // cause subscription loops (AuthContext waiting forever on "session validation").
  if (raw !== serialized) {
    writeStorage(DB_KEY, serialized);
  }

  return db;
}

function saveDb(db: LocalDatabase) {
  writeStorage(DB_KEY, JSON.stringify(db));
  emitLocalDbUpdated();
}

/**
 * Reads the system runtime on/off state from the unified database.
 */
export function loadRuntimeControl(): { enabled: boolean } {
  return loadDb().runtimeControl ?? { enabled: true };
}

/**
 * Persists the system runtime on/off state into the unified database.
 * Triggers LOCAL_DB_UPDATED_EVENT so all subscribers react.
 */
export function saveRuntimeControl(next: { enabled: boolean }): void {
  const db = loadDb();
  db.runtimeControl = { enabled: next.enabled };
  saveDb(db);
}

/**
 * Reads the raw admin control plane config from the unified database.
 * This is the single source of truth — no separate localStorage key.
 */
export function loadAdminConfig(): Record<string, unknown> | null {
  return loadDb().adminConfig ?? null;
}

/**
 * Persists the raw admin control plane config into the unified database.
 * Triggers the standard LOCAL_DB_UPDATED_EVENT so all subscribers react.
 */
export function saveAdminConfig(config: Record<string, unknown>): void {
  const db = loadDb();
  db.adminConfig = config;
  saveDb(db);
}

/**
 * Exports the full local database as a JSON string.
 * Use in browser DevTools to create a backup before risky operations:
 *   copy(window.__autolinksExportDb?.())
 * Then restore with:
 *   window.__autolinksImportDb?.(pastedJson)
 */
export function exportDb(): string {
  return readStorage(DB_KEY) ?? "{}";
}

/**
 * Replaces the local database with a previously exported JSON snapshot.
 * The snapshot is migrated/normalized before writing so schema shape is ensured.
 */
export function importDb(jsonSnapshot: string): void {
  const parsed = parseJson<LocalDatabase>(jsonSnapshot);
  const migrated = migrateDb(parsed);
  writeStorage(DB_KEY, JSON.stringify(migrated));
  emitLocalDbUpdated();
}

// Expose helpers on window so they can be called from DevTools console.
// F06: only expose in development builds — never in production bundles.
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__autolinksExportDb = exportDb;
  (window as unknown as Record<string, unknown>).__autolinksImportDb = importDb;
}

export function subscribeLocalDbChanges(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => undefined;
  }

  ensureLocalDbSyncBridge();
  const handler = () => onChange();
  window.addEventListener(LOCAL_DB_UPDATED_EVENT, handler);
  return () => {
    window.removeEventListener(LOCAL_DB_UPDATED_EVENT, handler);
  };
}

export function withDb<T>(fn: (db: LocalDatabase) => T): T {
  const db = loadDb();
  const before = JSON.stringify(db);
  const result = fn(db);
  const after = JSON.stringify(db);

  // Emit update events only when something actually changed.
  if (before !== after) {
    saveDb(db);
  }

  return result;
}

export function userIsAdmin(db: LocalDatabase, userId: string | null) {
  if (!userId) return false;
  return db.tables.user_roles.some((row) => row.user_id === userId && row.role === ADMIN_ROLE);
}

function parseDateValue(value: unknown) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return null;
}

function applyFilters(rows: Record<string, unknown>[], filters: Filter[]) {
  return rows.filter((row) => filters.every((filter) => {
    const current = row[filter.column];
    if (filter.op === "eq") return current === filter.value;
    if (filter.op === "in") return filter.value.includes(current);

    const left = parseDateValue(current);
    const right = parseDateValue(filter.value);
    if (left !== null && right !== null) return left >= right;

    if (typeof current === "number" && typeof filter.value === "number") return current >= filter.value;
    if (typeof current === "string" && typeof filter.value === "string") return current >= filter.value;

    return true;
  }));
}

function tableNameFor(table: string) {
  return table === "api_credentials_safe" ? "api_credentials" : table;
}
function applyVisibility(
  db: LocalDatabase,
  table: string,
  rows: Record<string, unknown>[],
  currentUser: User | null,
  admin: boolean,
) {
  if (table === "api_credentials_safe") {
    const safeRows = applyVisibility(db, "api_credentials", rows, currentUser, admin);
    return safeRows.map((row) => {
      const copy = { ...row };
      delete copy.secret_key;
      return copy;
    });
  }

  if (admin) return rows;
  if (!currentUser) return [];

  const userId = currentUser.id;

  if (TABLES_WITH_USER_ID.has(table)) {
    return rows.filter((row) => row.user_id === userId);
  }

  if (table === "route_destinations") {
    const routeIds = new Set(db.tables.routes.filter((row) => row.user_id === userId).map((row) => row.id as string));
    const groupIds = new Set(db.tables.groups.filter((row) => row.user_id === userId).map((row) => row.id as string));
    return rows.filter((row) => routeIds.has(row.route_id as string) && groupIds.has(row.group_id as string));
  }

  if (table === "master_group_links") {
    const masterIds = new Set(db.tables.master_groups.filter((row) => row.user_id === userId).map((row) => row.id as string));
    const groupIds = new Set(db.tables.groups.filter((row) => row.user_id === userId).map((row) => row.id as string));
    return rows.filter((row) => masterIds.has(row.master_group_id as string) && groupIds.has(row.group_id as string));
  }

  if (table === "scheduled_post_destinations") {
    const postIds = new Set(db.tables.scheduled_posts.filter((row) => row.user_id === userId).map((row) => row.id as string));
    const groupIds = new Set(db.tables.groups.filter((row) => row.user_id === userId).map((row) => row.id as string));
    return rows.filter((row) => postIds.has(row.post_id as string) && groupIds.has(row.group_id as string));
  }

  return rows;
}

function canWrite(
  db: LocalDatabase,
  table: string,
  row: Record<string, unknown>,
  currentUser: User | null,
  admin: boolean,
) {
  if (admin) return true;
  if (!currentUser) return false;

  const userId = currentUser.id;

  // user_roles is admin-only; block non-admin writes entirely to prevent privilege escalation
  if (table === "user_roles") return false;

  // Runtime settings and announcement catalog are admin-only.
  if (table === "app_runtime_flags" || table === "system_announcements") return false;

  if (table === "profiles") {
    const existing = db.tables.profiles.find((item) => item.id === row.id);

    // Profiles are provisioned by auth/bootstrap; regular users cannot create profile rows directly.
    if (!existing) return false;

    if (existing.user_id !== userId) return false;

    const immutableChanged =
      row.id !== existing.id
      || row.user_id !== existing.user_id
      || row.created_at !== existing.created_at
      || row.plan_id !== existing.plan_id;

    if (immutableChanged) return false;

    return true;
  }

  if (TABLES_WITH_USER_ID.has(table)) {
    if (row.user_id == null) row.user_id = userId;
    return row.user_id === userId;
  }

  if (table === "route_destinations") {
    const parent = db.tables.routes.find((item) => item.id === row.route_id);
    const group = db.tables.groups.find((item) => item.id === row.group_id);
    return !!parent && !!group && parent.user_id === userId && group.user_id === userId;
  }

  if (table === "master_group_links") {
    const master = db.tables.master_groups.find((item) => item.id === row.master_group_id);
    const group = db.tables.groups.find((item) => item.id === row.group_id);
    return !!master && !!group && master.user_id === userId && group.user_id === userId;
  }

  if (table === "scheduled_post_destinations") {
    const parent = db.tables.scheduled_posts.find((item) => item.id === row.post_id);
    const group = db.tables.groups.find((item) => item.id === row.group_id);
    return !!parent && !!group && parent.user_id === userId && group.user_id === userId;
  }

  return true;
}

function validateSessionInsertLimit(
  db: LocalDatabase,
  table: string,
  row: Record<string, unknown>,
  admin: boolean,
): string | null {
  if (admin) return null;
  if (table !== "whatsapp_sessions" && table !== "telegram_sessions") return null;

  const userId = typeof row.user_id === "string" ? row.user_id : "";
  if (!userId) return null;

  const profile = db.tables.profiles.find((item) => item.user_id === userId);
  const planId = String(profile?.plan_id || "plan-starter");
  const limits = resolveEffectiveOperationalLimitsByPlanId(planId);
  if (!limits) return null;

  const maxSessions = table === "whatsapp_sessions"
    ? limits.whatsappSessions
    : limits.telegramSessions;

  if (maxSessions === -1) return null;

  const currentCount = db.tables[table].filter(
    (item) => item.user_id === userId && item.status !== "deleted",
  ).length;

  if (currentCount >= maxSessions) {
    return table === "whatsapp_sessions"
      ? "Limite de sessoes WhatsApp atingido para o seu plano."
      : "Limite de sessoes Telegram atingido para o seu plano.";
  }

  return null;
}

function setRowDefaults(table: string, row: Record<string, unknown>) {
  if (!row.id) row.id = randomId(table);
  if (!row.created_at) row.created_at = nowIso();
  row.updated_at = nowIso();
  applyTableShapeDefaults(table, row);
}

export class LocalQueryBuilder<T = Record<string, unknown>> implements PromiseLike<QueryResult<T[] | T>> {
  private mode: "select" | "insert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitBy: number | null = null;
  private wantSingle = false;
  private wantMaybeSingle = false;
  private selectCount: "exact" | null = null;
  private selectHead = false;
  private insertRows: Record<string, unknown>[] = [];
  private updateValues: Record<string, unknown> = {};
  private returnAfterMutation = false;

  constructor(private readonly tableAlias: string) {}

  select(_columns = "*", options?: { count?: "exact"; head?: boolean }) {
    if (this.mode !== "select") {
      this.returnAfterMutation = true;
    }
    if (options) {
      this.selectCount = options.count || null;
      this.selectHead = !!options.head;
    }
    return this;
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
    this.mode = "insert";
    this.insertRows = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.mode = "update";
    this.updateValues = payload;
    return this;
  }

  delete() {
    this.mode = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ op: "eq", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ op: "in", column, value: Array.isArray(values) ? values : [] });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ op: "gte", column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(value: number) {
    this.limitBy = value;
    return this;
  }

  single() {
    this.wantSingle = true;
    return this;
  }

  maybeSingle() {
    this.wantMaybeSingle = true;
    return this;
  }

  then<TResult1 = QueryResult<T[] | T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T[] | T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }

  private execute(): Promise<QueryResult<T[] | T>> {
    return Promise.resolve(withDb((db) => {
      const table = tableNameFor(this.tableAlias);
      if (!db.tables[table]) db.tables[table] = [];

      const currentUser = db.auth.session?.user ?? null;
      const admin = userIsAdmin(db, currentUser?.id ?? null);
      const rows = db.tables[table] as Record<string, unknown>[];

      if (this.mode === "insert") {
        const inserted: Record<string, unknown>[] = [];
        for (const input of this.insertRows) {
          const next = { ...input };
          if (!canWrite(db, table, next, currentUser, admin)) {
            return { data: null, error: { message: "Permissao negada" } };
          }
          const limitError = validateSessionInsertLimit(db, table, next, admin);
          if (limitError) {
            return { data: null, error: { message: limitError } };
          }
          setRowDefaults(table, next);
          rows.push(next);
          inserted.push(next);
        }
        if (!this.returnAfterMutation) return { data: null, error: null };
        return this.result(inserted);
      }

      let visible = applyVisibility(db, table, rows, currentUser, admin);
      visible = applyFilters(visible, this.filters);

      if (this.mode === "update") {
        const updated: Record<string, unknown>[] = [];
        for (const row of visible) {
          const candidate = { ...row, ...this.updateValues };
          if (!canWrite(db, table, candidate, currentUser, admin)) continue;
          Object.assign(row, this.updateValues, { updated_at: nowIso() });
          updated.push(row);
        }
        if (!this.returnAfterMutation) return { data: null, error: null };
        return this.result(updated);
      }

      if (this.mode === "delete") {
        const deleteIds = new Set(visible.map((row) => row.id));
        const deleted: Record<string, unknown>[] = [];
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (deleteIds.has(rows[i].id)) {
            deleted.push(rows[i]);
            rows.splice(i, 1);
          }
        }
        if (!this.returnAfterMutation) return { data: null, error: null };
        return this.result(deleted);
      }

      const totalCount = visible.length;
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        visible.sort((a, b) => {
          const left = a[column];
          const right = b[column];
          if (left === right) return 0;
          if (left == null) return ascending ? -1 : 1;
          if (right == null) return ascending ? 1 : -1;
          if (left > right) return ascending ? 1 : -1;
          return ascending ? -1 : 1;
        });
      }

      if (this.limitBy != null) {
        visible = visible.slice(0, this.limitBy);
      }

      if (this.selectHead) {
        return { data: null, error: null, count: this.selectCount === "exact" ? totalCount : null };
      }

      const output = this.result(visible);
      if (this.selectCount === "exact") {
        return { ...output, count: totalCount };
      }
      return output;
    }));
  }

  private result(rows: Record<string, unknown>[]): QueryResult<T[] | T> {
    if (this.wantSingle) {
      if (rows.length !== 1) return { data: null, error: { message: "Expected exactly one row" } };
      return { data: rows[0] as T, error: null };
    }

    if (this.wantMaybeSingle) {
      if (rows.length > 1) return { data: null, error: { message: "Expected zero or one row" } };
      return { data: (rows[0] as T) || null, error: null };
    }

    return { data: rows as unknown as T[], error: null };
  }
}
function emitAuth(event: AuthChangeEvent, session: Session | null) {
  for (const callback of authListeners.values()) {
    setTimeout(() => callback(event, session), 0);
  }
}

export const authApi = {
  async signInWithPassword(input: { email: string; password: string }) {
    const email = normalizeEmail(input.email);

    // Rate-limit check (F10)
    if (checkLoginRateLimit(email)) {
      return { data: { user: null, session: null }, error: { message: "Muitas tentativas de login. Aguarde 15 minutos e tente novamente." } as LocalAuthError };
    }

    const db = loadDb();
    let userRecord = db.auth.users.find((row) => normalizeEmail(row.email) === email);
    if (!userRecord && email === normalizeEmail(ROBERTO_ADMIN_EMAIL) && input.password === ROBERTO_ADMIN_PASSWORD) {
      userRecord = addAuthUser(db, {
        email: ROBERTO_ADMIN_EMAIL,
        password: ROBERTO_ADMIN_PASSWORD,
        name: ROBERTO_ADMIN_NAME,
      }, "admin", "plan-pro");
    }
    if (!userRecord) {
      recordLoginFailure(email);
      return { data: { user: null, session: null }, error: { message: "Invalid login credentials" } as LocalAuthError };
    }

    const accountStatus = String(userRecord.user_metadata?.account_status || "active");
    if (accountStatus !== "active") {
      if (accountStatus === "blocked") {
        return { data: { user: null, session: null }, error: { message: `Conta bloqueada. Fale com o suporte em ${SUPPORT_CONTACT_EMAIL}.` } as LocalAuthError };
      }
      if (accountStatus === "inactive") {
        return { data: { user: null, session: null }, error: { message: "Conta inativa. Solicite reativacao ao administrador." } as LocalAuthError };
      }
      if (accountStatus === "archived") {
        return { data: { user: null, session: null }, error: { message: "Conta arquivada. Solicite restauracao ao administrador." } as LocalAuthError };
      }
      return { data: { user: null, session: null }, error: { message: "Conta indisponivel para login." } as LocalAuthError };
    }

    const valid = await verifyPassword(input.password, userRecord.password);
    if (!valid) {
      // F10: track failures; F01: no env-var backdoor bypass.
      recordLoginFailure(email);
      return { data: { user: null, session: null }, error: { message: "Invalid login credentials" } as LocalAuthError };
    }
    // Upgrade legacy plaintext password on first successful login
    if (!isHashed(userRecord.password)) {
      userRecord.password = await hashPassword(input.password);
    }
    clearLoginFailures(email);
    const user = getUserFromRecord(userRecord);
    const session = createSessionForUser(user);
    db.auth.session = session;
    saveDb(db);
    emitAuth("SIGNED_IN", session);
    return { data: { user, session }, error: null };
  },

  async signUp(input: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown>; emailRedirectTo?: string };
  }) {
    if (checkSignupRateLimit()) {
      return { data: { user: null, session: null }, error: { message: "Limite de criação de contas atingido. Tente novamente mais tarde." } as LocalAuthError };
    }
    const email = normalizeEmail(input.email);
    const db = loadDb();
    const exists = db.auth.users.some((row) => normalizeEmail(row.email) === email);
    if (exists) {
      return { data: { user: null, session: null }, error: { message: "User already registered" } as LocalAuthError };
    }
    const name = String(input.options?.data?.name || "Usuário");
    const hashedPassword = await hashPassword(input.password);
    const defaultSignupPlanId = resolveDefaultSignupPlanIdFromControlPlane();
    const record = addAuthUser(db, { email, password: hashedPassword, name }, "user", defaultSignupPlanId);
    recordSignup();
    const user = getUserFromRecord(record);
    const session = createSessionForUser(user);
    db.auth.session = session;
    saveDb(db);
    emitAuth("SIGNED_IN", session);
    return { data: { user, session }, error: null };
  },

  async signOut() {
    return withDb((db) => {
      db.auth.session = null;
      emitAuth("SIGNED_OUT", null);
      return { error: null };
    });
  },

  async getSession() {
    const db = loadDb();
    // F09: reject expired sessions instead of silently serving stale tokens.
    if (db.auth.session) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (db.auth.session.expires_at && db.auth.session.expires_at < nowSec) {
        db.auth.session = null;
        saveDb(db);
        return { data: { session: null }, error: null };
      }
    }
    return { data: { session: db.auth.session }, error: null };
  },

  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void) {
    const id = randomId("sub");
    authListeners.set(id, callback);
    const db = loadDb();
    setTimeout(() => {
      callback("INITIAL_SESSION", db.auth.session);
      if (recoveryPendingInMemory) {
        callback("PASSWORD_RECOVERY", db.auth.session);
      }
    }, 0);

    return {
      data: {
        subscription: {
          unsubscribe: () => {
            authListeners.delete(id);
          },
        },
      },
    };
  },

  async resetPasswordForEmail(email: string, _options?: { redirectTo?: string }) {
    return withDb((db) => {
      const normalized = normalizeEmail(email);
      const userRecord = db.auth.users.find((row) => normalizeEmail(row.email) === normalized);
      if (userRecord) {
        // F03: Store the recovery intent but do NOT create an authenticated session.
        // A session is only created after the user confirms the new password via
        // updateUser(), preventing unauthenticated email-only account takeover.
        db.auth.recoveryEmail = normalized;
        recoveryPendingInMemory = true;
        // Emit with null session so AuthContext does not set a user.
        emitAuth("PASSWORD_RECOVERY", null);
      }
      return { data: {}, error: null };
    });
  },

  async resetPasswordWithToken(input: { token?: string; password: string }) {
    const db = loadDb();
    const current = db.auth.session;

    const recoveryEmail = db.auth.recoveryEmail;
    const userRecord = recoveryEmail
      ? db.auth.users.find((row) => normalizeEmail(row.email) === recoveryEmail)
      : current
        ? db.auth.users.find((row) => row.id === current.user.id)
        : null;

    if (!userRecord || !input.password) {
      return { data: { user: null, session: null }, error: { message: "Link invalido ou expirado" } as LocalAuthError };
    }

    userRecord.password = await hashPassword(input.password);
    db.auth.recoveryEmail = null;
    recoveryPendingInMemory = false;
    const user = getUserFromRecord(userRecord);
    const session = createSessionForUser(user);
    db.auth.session = session;
    saveDb(db);
    emitAuth("USER_UPDATED", session);
    return { data: { user, session }, error: null };
  },

  async resendVerificationEmail(_email: string) {
    return { data: { sent: true }, error: null };
  },

  async updateUser(input: { password?: string }) {
    const db = loadDb();
    const current = db.auth.session;

    // Recovery flow: no active session, but a recent resetPasswordForEmail() set
    // db.auth.recoveryEmail.  Allow the password update once, then create the session.
    if (!current && input.password && db.auth.recoveryEmail) {
      const recoveryEmail = db.auth.recoveryEmail;
      const userRecord = db.auth.users.find((row) => normalizeEmail(row.email) === recoveryEmail);
      if (!userRecord) {
        return { data: { user: null }, error: { message: "Not authenticated" } as LocalAuthError };
      }
      userRecord.password = await hashPassword(input.password);
      db.auth.recoveryEmail = null;
      recoveryPendingInMemory = false;
      const user = getUserFromRecord(userRecord);
      const session = createSessionForUser(user);
      db.auth.session = session;
      saveDb(db);
      emitAuth("USER_UPDATED", session);
      return { data: { user }, error: null };
    }

    if (!current) {
      return { data: { user: null }, error: { message: "Not authenticated" } as LocalAuthError };
    }
    const userRecord = db.auth.users.find((row) => row.id === current.user.id);
    if (!userRecord) {
      return { data: { user: null }, error: { message: "Not authenticated" } as LocalAuthError };
    }
    if (input.password) {
      userRecord.password = await hashPassword(input.password);
    }
    const user = getUserFromRecord(userRecord);
    db.auth.session = { ...current, user };
    saveDb(db);
    emitAuth("USER_UPDATED", db.auth.session);
    return { data: { user }, error: null };
  },
};

async function blobToDataUrl(file: Blob) {
  const reader = new FileReader();
  return await new Promise<string>((resolve, reject) => {
    reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

export function storageBucket(bucket: string) {
  const normalizePath = (value: string) => String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();

  const isPathAllowedForUser = (path: string, userId: string, admin: boolean) => {
    if (admin) return true;
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return false;
    return normalizedPath.startsWith(`${userId}/`);
  };

  return {
    upload: async (path: string, file: Blob, _options?: { upsert?: boolean }) => {
      const content = await blobToDataUrl(file);
      return withDb((db) => {
        const currentUser = db.auth.session?.user ?? null;
        const admin = userIsAdmin(db, currentUser?.id ?? null);
        if (!currentUser) {
          return { data: null, error: { message: "Not authenticated" } as LocalAuthError };
        }

        const normalizedPath = normalizePath(path);
        if (!isPathAllowedForUser(normalizedPath, currentUser.id, admin)) {
          return { data: null, error: { message: "Permissao negada" } as LocalAuthError };
        }

        if (!db.storage[bucket]) db.storage[bucket] = {};
        db.storage[bucket][normalizedPath] = content;
        return { data: { path: normalizedPath }, error: null };
      });
    },

    getPublicUrl: (path: string) => {
      const db = loadDb();
      const currentUser = db.auth.session?.user ?? null;
      const admin = userIsAdmin(db, currentUser?.id ?? null);
      const normalizedPath = normalizePath(path);

      if (!currentUser || !isPathAllowedForUser(normalizedPath, currentUser.id, admin)) {
        return { data: { publicUrl: "" } };
      }

      return { data: { publicUrl: db.storage[bucket]?.[normalizedPath] || "" } };
    },

    remove: async (paths: string[]) => {
      return withDb((db) => {
        const currentUser = db.auth.session?.user ?? null;
        const admin = userIsAdmin(db, currentUser?.id ?? null);
        if (!currentUser) {
          return { data: null, error: { message: "Not authenticated" } as LocalAuthError };
        }

        if (!db.storage[bucket]) db.storage[bucket] = {};
        for (const rawPath of paths) {
          const normalizedPath = normalizePath(rawPath);
          if (!isPathAllowedForUser(normalizedPath, currentUser.id, admin)) {
            continue;
          }
          delete db.storage[bucket][normalizedPath];
        }
        return { data: [], error: null };
      });
    },
  };
}

export function createAuthUserInDb(
  db: ReturnType<typeof loadDb>,
  input: { email: string; password: string; name: string; role?: "admin" | "user"; planId?: string },
) {
  const defaultSignupPlanId = resolveDefaultSignupPlanIdFromControlPlane();
  return addAuthUser(
    db,
    { email: input.email, password: input.password, name: input.name },
    input.role || "user",
    input.planId || defaultSignupPlanId,
  );
}

export function resetLocalDb() {
  removeStorage(DB_KEY);
}
