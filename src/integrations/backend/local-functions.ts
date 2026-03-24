import {
  createAuthUserInDb,
  deleteUserFromDb,
  hashPassword,
  loadDb,
  normalizeEmail,
  randomId,
  resolvePlanExpirationIsoFromControlPlane,
  userIsAdmin,
  withDb,
  type LocalAuthError,
} from "./_local-core-legacy";
import type { ShopeeProduct } from "@/components/shopee/ProductCard";
import { applyPlaceholders, extractLinks } from "@/lib/marketplace-utils";
import { buildTemplatePlaceholderData } from "@/lib/template-placeholders";
import { formatMessageForPlatform } from "@/lib/rich-text";
import { SHOPEE_CATEGORIES } from "@/lib/shopee-categories";
import { resolveEffectiveLimitsByPlanId, resolveEffectiveOperationalLimitsByPlanId } from "@/lib/access-control";
import { loadAdminControlPlaneState } from "@/lib/admin-control-plane";

function nowIso() {
  return new Date().toISOString();
}

function fail(message: string) {
  return { data: null, error: { message } as LocalAuthError };
}

function isPlanExpiredForUser(db: ReturnType<typeof loadDb>, userId: string): boolean {
  const profile = db.tables.profiles.find((row) => row.user_id === userId);
  if (!profile) return false;

  const expiresAtRaw = typeof profile.plan_expires_at === "string" ? profile.plan_expires_at.trim() : "";
  if (!expiresAtRaw) return false;

  const expiresAtMs = Date.parse(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= Date.now();
}

const PLAN_EXPIRY_ALLOWED_FUNCTIONS = new Set([
  "account-plan",
  "admin-users",
  "link-hub-public",
  "admin-announcements",
  "user-notifications",
  "admin-maintenance",
]);
const ADMIN_PANEL_PLAN_ID = "admin";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

type RecurrenceMode = "none" | "daily" | "weekly";

function parseScheduleMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function parseScheduledImageFromMeta(meta: Record<string, unknown>): OutboundMediaPayload | null {
  const raw = meta.media;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const media = raw as Record<string, unknown>;
  if (media.kind !== "image") return null;
  const base64 = typeof media.base64 === "string" ? media.base64.trim() : "";
  if (!base64) return null;

  const mimeType = typeof media.mimeType === "string" && media.mimeType.startsWith("image/")
    ? media.mimeType
    : "image/jpeg";
  const fileName = typeof media.fileName === "string" && media.fileName.trim()
    ? media.fileName.trim()
    : "schedule_image.jpg";

  return {
    kind: "image",
    base64,
    mimeType,
    fileName,
  };
}

function scheduleRequiresMandatoryImage(meta: Record<string, unknown>): boolean {
  const policy = String(meta.imagePolicy || "").trim().toLowerCase();
  if (policy === "required") return true;
  const source = String(meta.scheduleSource || "").trim().toLowerCase();
  return source === "shopee_catalog";
}

function extractScheduleProductImageUrl(meta: Record<string, unknown>): string {
  const candidates = [
    meta.productImageUrl,
    meta.imageUrl,
    meta.product_image_url,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (/^https?:\/\//i.test(value)) return value;
  }
  return "";
}

function parseScheduleTemplateData(meta: Record<string, unknown>): Record<string, string> {
  const raw = meta.templateData;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (typeof value === "string") {
      parsed[key] = value;
      continue;
    }
    if (value == null) {
      parsed[key] = "";
      continue;
    }
    parsed[key] = String(value);
  }

  // Legacy safety: scheduled template data might still contain image URLs.
  // {imagem} is attachment-only and must never be emitted into message text.
  parsed["{imagem}"] = "";
  parsed["{{imagem}}"] = "";

  return parsed;
}

function markScheduleMediaCleanup(meta: Record<string, unknown>, nowMs: number): Record<string, unknown> {
  if (!parseScheduledImageFromMeta(meta)) return meta;
  return {
    ...meta,
    mediaCleanupAt: new Date(nowMs + 120_000).toISOString(),
  };
}

const SCHEDULE_MEDIA_CLEANUP_TIMERS = new Map<string, number>();

function cleanupPostMediaIfExpired(db: ReturnType<typeof loadDb>, userId: string, postId: string, nowMs: number): void {
  const row = db.tables.scheduled_posts.find((item) => item.id === postId && item.user_id === userId);
  if (!row) return;

  const meta = parseScheduleMeta(row.metadata);
  const cleanupAt = typeof meta.mediaCleanupAt === "string" ? new Date(meta.mediaCleanupAt).getTime() : NaN;
  if (!Number.isFinite(cleanupAt) || cleanupAt > nowMs) return;
  if (row.status !== "sent" && row.status !== "cancelled" && row.status !== "failed") return;
  if (!Object.prototype.hasOwnProperty.call(meta, "media")) return;

  const nextMeta = { ...meta };
  delete nextMeta.media;
  delete nextMeta.mediaCleanupAt;
  row.metadata = nextMeta;
  row.updated_at = nowIso();
}

function schedulePostMediaCleanup(userId: string, postId: string, meta: Record<string, unknown>): void {
  const cleanupAt = typeof meta.mediaCleanupAt === "string" ? new Date(meta.mediaCleanupAt).getTime() : NaN;
  if (!Number.isFinite(cleanupAt)) return;

  const timerKey = `${userId}:${postId}`;
  const existing = SCHEDULE_MEDIA_CLEANUP_TIMERS.get(timerKey);
  if (typeof existing === "number") {
    window.clearTimeout(existing);
  }

  const delayMs = Math.max(cleanupAt - Date.now(), 0);
  const handle = window.setTimeout(() => {
    withDb((db) => {
      cleanupPostMediaIfExpired(db, userId, postId, Date.now());
    });
    SCHEDULE_MEDIA_CLEANUP_TIMERS.delete(timerKey);
  }, delayMs);

  SCHEDULE_MEDIA_CLEANUP_TIMERS.set(timerKey, handle);
}

function cleanupExpiredScheduledMedia(db: ReturnType<typeof loadDb>, nowMs: number): void {
  for (const row of db.tables.scheduled_posts) {
    const meta = parseScheduleMeta(row.metadata);
    const cleanupAt = typeof meta.mediaCleanupAt === "string" ? new Date(meta.mediaCleanupAt).getTime() : NaN;
    if (!Number.isFinite(cleanupAt) || cleanupAt > nowMs) continue;

    if (row.status !== "sent" && row.status !== "cancelled" && row.status !== "failed") continue;

    if (!Object.prototype.hasOwnProperty.call(meta, "media")) continue;
    const nextMeta = { ...meta };
    delete nextMeta.media;
    delete nextMeta.mediaCleanupAt;
    row.metadata = nextMeta;
    row.updated_at = nowIso();
  }
}

function cleanupExpiredHistoryEntries(db: ReturnType<typeof loadDb>, nowMs: number): void {
  const retentionMs = 7 * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - retentionMs;

  db.tables.history_entries = db.tables.history_entries.filter((row) => {
    const createdAtMs = new Date(String(row.created_at || "")).getTime();
    if (!Number.isFinite(createdAtMs)) return true;
    return createdAtMs >= cutoffMs;
  });
}

function normalizeRecurrence(value: unknown): RecurrenceMode {
  if (value === "daily" || value === "weekly") {
    return value;
  }
  if (value === "once" || value === "monthly") return "none";
  return "none";
}

function normalizeTime(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) return "";
  const [hhRaw, mmRaw] = trimmed.split(":");
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return "";
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function dateKeyLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseRecurrenceTimes(metadata: Record<string, unknown>, scheduledAt: string): string[] {
  const raw = Array.isArray(metadata.recurrenceTimes)
    ? metadata.recurrenceTimes
    : [];
  const normalized = raw
    .map((item) => normalizeTime(item))
    .filter(Boolean);

  if (normalized.length > 0) {
    return Array.from(new Set(normalized)).sort();
  }

  const baseDate = new Date(scheduledAt);
  if (Number.isNaN(baseDate.getTime())) return [];
  return [`${String(baseDate.getHours()).padStart(2, "0")}:${String(baseDate.getMinutes()).padStart(2, "0")}`];
}

function parseWeekDays(metadata: Record<string, unknown>, baseDate: Date): string[] {
  if (Array.isArray(metadata.weekDays)) {
    const values = metadata.weekDays.filter((item): item is string => typeof item === "string");
    if (values.length > 0) return values;
  }

  const dayMap = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return [dayMap[baseDate.getDay()] || "sun"];
}

function getLatestTimeSlotOnDate(times: string[], now: Date): string | null {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let best: string | null = null;

  for (const value of times) {
    const [hhRaw, mmRaw] = value.split(":");
    const minutes = Number(hhRaw) * 60 + Number(mmRaw);
    if (minutes <= nowMinutes) {
      if (!best || minutes > (Number(best.split(":")[0]) * 60 + Number(best.split(":")[1]))) {
        best = value;
      }
    }
  }

  return best;
}

function getDueSlotKey(post: Record<string, unknown>, nowMs: number): string | null {
  const recurrence = normalizeRecurrence(post.recurrence);
  const scheduledAt = String(post.scheduled_at || "");
  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) return null;
  if (scheduledDate.getTime() > nowMs) return null;

  const metadata = parseScheduleMeta(post.metadata);
  const lastDispatchSlot = typeof metadata.lastDispatchSlot === "string" ? metadata.lastDispatchSlot : "";

  const now = new Date(nowMs);
  if (recurrence === "none") {
    return `once:${scheduledAt}`;
  }

  const times = parseRecurrenceTimes(metadata, scheduledAt);
  if (times.length === 0) return null;

  if (recurrence === "daily") {
    const slot = getLatestTimeSlotOnDate(times, now);
    if (!slot) return null;
    const key = `daily:${dateKeyLocal(now)}@${slot}`;
    return key === lastDispatchSlot ? null : key;
  }

  if (recurrence === "weekly") {
    const weekDays = parseWeekDays(metadata, scheduledDate);
    const dayMap = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const today = dayMap[now.getDay()] || "sun";
    if (!weekDays.includes(today)) return null;
    const slot = getLatestTimeSlotOnDate(times, now);
    if (!slot) return null;
    const key = `weekly:${dateKeyLocal(now)}@${slot}`;
    return key === lastDispatchSlot ? null : key;
  }

  return null;
}

function computeNextRecurringScheduledAt(post: Record<string, unknown>, nowMs: number): string {
  const recurrence = normalizeRecurrence(post.recurrence);
  const scheduledAt = String(post.scheduled_at || "");
  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) return nowIso();
  if (recurrence === "none") return scheduledAt;

  const metadata = parseScheduleMeta(post.metadata);
  const times = parseRecurrenceTimes(metadata, scheduledAt);
  if (times.length === 0) return scheduledAt;

  const weekDays = parseWeekDays(metadata, scheduledDate);
  const dayMap = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const now = new Date(nowMs);

  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const candidateDate = new Date(now);
    candidateDate.setHours(0, 0, 0, 0);
    candidateDate.setDate(candidateDate.getDate() + dayOffset);

    if (recurrence === "weekly") {
      const key = dayMap[candidateDate.getDay()] || "sun";
      if (!weekDays.includes(key)) continue;
    }

    for (const value of times) {
      const [hhRaw, mmRaw] = value.split(":");
      const candidate = new Date(candidateDate);
      candidate.setHours(Number(hhRaw), Number(mmRaw), 0, 0);
      if (candidate.getTime() > nowMs) {
        return candidate.toISOString();
      }
    }
  }

  return scheduledAt;
}

function isRecurringSchedule(post: Record<string, unknown>): boolean {
  const recurrence = normalizeRecurrence(post.recurrence);
  return recurrence === "daily" || recurrence === "weekly";
}

function appendAudit(db: ReturnType<typeof loadDb>, action: string, actorId: string, targetUserId: string | null, details: Record<string, unknown>) {
  db.tables.admin_audit_logs.push({
    id: randomId("audit"),
    user_id: actorId,
    action,
    target_user_id: targetUserId,
    details,
    created_at: nowIso(),
  });
}

type AnnouncementMatchMode = "any" | "all";

interface AnnouncementTargetFilter {
  planIds: string[];
  accessLevelIds: string[];
  roles: Array<"admin" | "user">;
  userIds: string[];
  matchMode: AnnouncementMatchMode;
}

function normalizeTargetFilter(value: unknown): AnnouncementTargetFilter {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

  const planIds = Array.isArray(source.planIds)
    ? source.planIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  const accessLevelIds = Array.isArray(source.accessLevelIds)
    ? source.accessLevelIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  const roles = Array.isArray(source.roles)
    ? source.roles
      .filter((item): item is string => item === "admin" || item === "user")
      .map((item) => (item === "admin" ? "admin" : "user"))
    : [];
  const userIds = Array.isArray(source.userIds)
    ? source.userIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];

  return {
    planIds,
    accessLevelIds,
    roles,
    userIds,
    matchMode: source.matchMode === "all" ? "all" : "any",
  };
}

function resolveUserAccessLevelMap() {
  const controlPlane = loadAdminControlPlaneState();
  const planToAccessLevel = new Map<string, string>();
  for (const plan of controlPlane.plans) {
    const planId = String(plan.id || "").trim();
    const accessLevelId = String(plan.accessLevelId || "").trim();
    if (planId && accessLevelId) {
      planToAccessLevel.set(planId, accessLevelId);
    }
  }
  return { controlPlane, planToAccessLevel };
}

function userMatchesAnnouncementFilter(
  user: { userId: string; planId: string; role: "admin" | "user"; accessLevelId: string },
  filter: AnnouncementTargetFilter,
) {
  const checks: boolean[] = [];

  if (filter.planIds.length > 0) {
    checks.push(filter.planIds.includes(user.planId));
  }
  if (filter.accessLevelIds.length > 0) {
    checks.push(filter.accessLevelIds.includes(user.accessLevelId));
  }
  if (filter.roles.length > 0) {
    checks.push(filter.roles.includes(user.role));
  }
  if (filter.userIds.length > 0) {
    checks.push(filter.userIds.includes(user.userId));
  }

  // Safe default: with no filter set, target all active client users.
  if (checks.length === 0) {
    return user.role === "user";
  }

  return filter.matchMode === "all"
    ? checks.every(Boolean)
    : checks.some(Boolean);
}

function isAnnouncementActiveNow(announcement: Record<string, unknown>, nowMs: number) {
  if (announcement.is_active === false) return false;

  const startsAt = typeof announcement.starts_at === "string" && announcement.starts_at.trim()
    ? Date.parse(announcement.starts_at)
    : Number.NaN;
  const endsAt = typeof announcement.ends_at === "string" && announcement.ends_at.trim()
    ? Date.parse(announcement.ends_at)
    : Number.NaN;

  if (Number.isFinite(startsAt) && nowMs < startsAt) return false;
  if (Number.isFinite(endsAt) && nowMs > endsAt) return false;
  return true;
}

function resolveMaintenanceFlags(db: ReturnType<typeof loadDb>) {
  const row = db.tables.app_runtime_flags.find((item) => String(item.id || "") === "global") || null;
  return {
    maintenance_enabled: row?.maintenance_enabled === true,
    maintenance_title: typeof row?.maintenance_title === "string" && row.maintenance_title.trim()
      ? row.maintenance_title.trim()
      : "Sistema em manutencao",
    maintenance_message: typeof row?.maintenance_message === "string" && row.maintenance_message.trim()
      ? row.maintenance_message.trim()
      : "Estamos realizando melhorias. Tente novamente em alguns minutos.",
    maintenance_eta: typeof row?.maintenance_eta === "string" && row.maintenance_eta.trim() ? row.maintenance_eta.trim() : null,
    allow_admin_bypass: row?.allow_admin_bypass !== false,
    updated_by_user_id: typeof row?.updated_by_user_id === "string" && row.updated_by_user_id.trim() ? row.updated_by_user_id.trim() : "system",
  };
}

const DELIVER_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between re-deliveries

function deliverAnnouncementToInbox(
  db: ReturnType<typeof loadDb>,
  announcement: Record<string, unknown>,
) {
  const announcementId = String(announcement.id || "").trim();
  if (!announcementId) return { delivered: 0, matchedUsers: 0 };

  const nowMs = Date.now();
  if (!isAnnouncementActiveNow(announcement, nowMs)) {
    return { delivered: 0, matchedUsers: 0 };
  }

  const filter = normalizeTargetFilter(announcement.target_filter);
  const { planToAccessLevel } = resolveUserAccessLevelMap();

  let delivered = 0;
  let matchedUsers = 0;

  for (const authUser of db.auth.users) {
    const userId = String(authUser.id || "").trim();
    if (!userId) continue;

    const status = String(authUser.user_metadata?.account_status || "active");
    if (status !== "active") continue;

    const roleRow = db.tables.user_roles.find((row) => row.user_id === userId);
    const role: "admin" | "user" = roleRow?.role === "admin" ? "admin" : "user";
    const profile = db.tables.profiles.find((row) => row.user_id === userId);
    const planId = role === "admin"
      ? ADMIN_PANEL_PLAN_ID
      : (String(profile?.plan_id || "plan-starter").trim() || "plan-starter");
    const accessLevelId = planToAccessLevel.get(planId) || "";

    if (!userMatchesAnnouncementFilter({ userId, planId, role, accessLevelId }, filter)) {
      continue;
    }

    matchedUsers += 1;

    const existing = db.tables.user_notifications.find(
      (row) => row.user_id === userId && row.announcement_id === announcementId,
    );
    if (existing) continue;

    const now = nowIso();
    db.tables.user_notifications.push({
      id: randomId("notif"),
      created_at: now,
      updated_at: now,
      user_id: userId,
      announcement_id: announcementId,
      status: "unread",
      read_at: null,
      dismissed_at: null,
      delivered_at: now,
    });
    delivered += 1;
  }

  if (delivered > 0 || matchedUsers > 0) {
    announcement.last_delivered_at = nowIso();
    announcement.updated_at = nowIso();
  }

  return { delivered, matchedUsers };
}

const WHATSAPP_MICROSERVICE_URL = String(import.meta.env.VITE_WHATSAPP_MICROSERVICE_URL || "http://127.0.0.1:3111").replace(/\/+$/, "");
const TELEGRAM_MICROSERVICE_URL = String(import.meta.env.VITE_TELEGRAM_MICROSERVICE_URL || "http://127.0.0.1:3112").replace(/\/+$/, "");
const SHOPEE_MICROSERVICE_URL = String(import.meta.env.VITE_SHOPEE_MICROSERVICE_URL || "http://127.0.0.1:3113").replace(/\/+$/, "");
const MELI_RPA_URL = String(import.meta.env.VITE_MELI_RPA_URL || "http://127.0.0.1:3114").replace(/\/+$/, "");
const OPS_CONTROL_URL = (() => {
  const raw = String(import.meta.env.VITE_OPS_CONTROL_URL || "").trim();
  if (!raw || raw === "undefined" || raw === "null") {
    return "http://127.0.0.1:3115";
  }
  return raw.replace(/\/+$/, "");
})();
const OPS_CONTROL_TOKEN = String(import.meta.env.VITE_OPS_CONTROL_TOKEN || import.meta.env.VITE_WEBHOOK_SECRET || "").trim();
// Secret forwarded to every microservice call (WA, TG, Shopee, Meli).
// NOTE (F04): VITE_ vars are embedded in the client bundle at build time and are
// visible via browser DevTools.  This is an inherent limitation of the SPA
// architecture.  Rotate this token in .env if the bundle is ever publicly
// exposed.  Server-to-server calls should use the non-VITE WEBHOOK_SECRET env
// var set directly on each service container.
const MICROSERVICE_WEBHOOK_SECRET = String(import.meta.env.VITE_WEBHOOK_SECRET || "").trim();

type ProcessQueueKind = "route" | "dispatch" | "automation" | "convert";

type ProcessQueueSlot = {
  kind: ProcessQueueKind;
  queuedMs: number;
  pendingDepthAtGrant: number;
  grantedAt: number;
};

const PROCESS_QUEUE_CONCURRENCY: Record<ProcessQueueKind, number> = {
  route: Math.max(1, Number.parseInt(String(import.meta.env.VITE_QUEUE_ROUTE_CONCURRENCY || "5"), 10) || 5),
  dispatch: Math.max(1, Number.parseInt(String(import.meta.env.VITE_QUEUE_DISPATCH_CONCURRENCY || "4"), 10) || 4),
  automation: Math.max(1, Number.parseInt(String(import.meta.env.VITE_QUEUE_AUTOMATION_CONCURRENCY || "2"), 10) || 2),
  convert: Math.max(1, Number.parseInt(String(import.meta.env.VITE_QUEUE_CONVERT_CONCURRENCY || "3"), 10) || 3),
};

const PROCESS_QUEUE_BASE_DELAY_MS: Record<ProcessQueueKind, number> = {
  route: 120,
  dispatch: 220,
  automation: 650,
  convert: 400,
};

const PROCESS_QUEUE_ACTIVE: Record<ProcessQueueKind, number> = {
  route: 0,
  dispatch: 0,
  automation: 0,
  convert: 0,
};

const PROCESS_QUEUE_WAITERS: Record<
  ProcessQueueKind,
  Array<{ queuedAt: number; resolve: (slot: ProcessQueueSlot) => void }>
> = {
  route: [],
  dispatch: [],
  automation: [],
  convert: [],
};

function queuePendingDepth(kind: ProcessQueueKind) {
  return PROCESS_QUEUE_WAITERS[kind].length;
}

function queueLimit(kind: ProcessQueueKind) {
  return PROCESS_QUEUE_CONCURRENCY[kind];
}

function grantNextProcessSlot(kind: ProcessQueueKind) {
  const queue = PROCESS_QUEUE_WAITERS[kind];
  if (PROCESS_QUEUE_ACTIVE[kind] >= queueLimit(kind)) return;
  const next = queue.shift();
  if (!next) return;

  PROCESS_QUEUE_ACTIVE[kind] += 1;
  const now = Date.now();
  next.resolve({
    kind,
    queuedMs: Math.max(now - next.queuedAt, 0),
    pendingDepthAtGrant: queue.length,
    grantedAt: now,
  });
}

async function acquireProcessSlot(kind: ProcessQueueKind): Promise<ProcessQueueSlot> {
  if (PROCESS_QUEUE_ACTIVE[kind] < queueLimit(kind)) {
    PROCESS_QUEUE_ACTIVE[kind] += 1;
    return {
      kind,
      queuedMs: 0,
      pendingDepthAtGrant: queuePendingDepth(kind),
      grantedAt: Date.now(),
    };
  }

  return await new Promise<ProcessQueueSlot>((resolve) => {
    PROCESS_QUEUE_WAITERS[kind].push({ queuedAt: Date.now(), resolve });
  });
}

function releaseProcessSlot(slot: ProcessQueueSlot) {
  const kind = slot.kind;
  PROCESS_QUEUE_ACTIVE[kind] = Math.max(PROCESS_QUEUE_ACTIVE[kind] - 1, 0);
  grantNextProcessSlot(kind);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

async function applyProcessQueueDelay(slot: ProcessQueueSlot) {
  const baseDelay = PROCESS_QUEUE_BASE_DELAY_MS[slot.kind];
  const depthDelay = Math.min(slot.pendingDepthAtGrant * 90, 1_500);
  const queuedDelay = Math.min(Math.floor(slot.queuedMs * 0.1), 1_000);
  const jitter = Math.floor(Math.random() * 160);
  const totalDelay = Math.max(baseDelay + depthDelay + queuedDelay + jitter, 0);
  if (totalDelay > 0) {
    await sleep(totalDelay);
  }
}

function getProcessQueueSnapshot() {
  return {
    route: {
      active: PROCESS_QUEUE_ACTIVE.route,
      pending: PROCESS_QUEUE_WAITERS.route.length,
      limit: PROCESS_QUEUE_CONCURRENCY.route,
    },
    dispatch: {
      active: PROCESS_QUEUE_ACTIVE.dispatch,
      pending: PROCESS_QUEUE_WAITERS.dispatch.length,
      limit: PROCESS_QUEUE_CONCURRENCY.dispatch,
    },
    automation: {
      active: PROCESS_QUEUE_ACTIVE.automation,
      pending: PROCESS_QUEUE_WAITERS.automation.length,
      limit: PROCESS_QUEUE_CONCURRENCY.automation,
    },
    convert: {
      active: PROCESS_QUEUE_ACTIVE.convert,
      pending: PROCESS_QUEUE_WAITERS.convert.length,
      limit: PROCESS_QUEUE_CONCURRENCY.convert,
    },
  };
}

function toTimestampMs(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toGrowthRatio(current: number, expected: number): number {
  if (expected <= 0) return current > 0 ? 999 : 1;
  return Number((current / expected).toFixed(2));
}

function summarizeUserUsage(db: ReturnType<typeof loadDb>, targetUserId: string) {
  const nowMs = Date.now();
  const since24hMs = nowMs - (24 * 60 * 60 * 1000);
  const since7dMs = nowMs - (7 * 24 * 60 * 60 * 1000);

  const routes = db.tables.routes.filter((row) => row.user_id === targetUserId);
  const automations = db.tables.shopee_automations.filter((row) => row.user_id === targetUserId);
  const groups = db.tables.groups.filter((row) => row.user_id === targetUserId && !row.deleted_at);
  const waSessions = db.tables.whatsapp_sessions.filter((row) => row.user_id === targetUserId);
  const tgSessions = db.tables.telegram_sessions.filter((row) => row.user_id === targetUserId);
  const meliSessions = db.tables.meli_sessions.filter((row) => row.user_id === targetUserId);
  const schedules = db.tables.scheduled_posts.filter((row) => row.user_id === targetUserId);
  const history = db.tables.history_entries.filter((row) => row.user_id === targetUserId);

  let errors24h = 0;
  let history24h = 0;
  let errors7d = 0;
  let history7d = 0;
  let errorsPrev6d = 0;
  let historyPrev6d = 0;
  let lastActivityAt = "";

  for (const entry of history) {
    const createdAt = String(entry.created_at || "");
    const ts = toTimestampMs(createdAt);
    if (ts > 0) {
      const isError = String(entry.status || "") === "error" || String(entry.processing_status || "") === "failed";

      if (ts >= since7dMs) {
        history7d += 1;
        if (isError) errors7d += 1;

        if (ts < since24hMs) {
          historyPrev6d += 1;
          if (isError) errorsPrev6d += 1;
        }
      }

      if (ts >= since24hMs) {
        history24h += 1;
        if (isError) errors24h += 1;
      }
    }
    if (!lastActivityAt || ts > toTimestampMs(lastActivityAt)) {
      lastActivityAt = createdAt;
    }
  }

  const history24hExpectedFrom7dAvg = Number(((historyPrev6d > 0 ? historyPrev6d / 6 : history7d / 7) || 0).toFixed(2));
  const errors24hExpectedFrom7dAvg = Number(((errorsPrev6d > 0 ? errorsPrev6d / 6 : errors7d / 7) || 0).toFixed(2));
  const history24hGrowthRatio = toGrowthRatio(history24h, history24hExpectedFrom7dAvg);
  const errors24hGrowthRatio = toGrowthRatio(errors24h, errors24hExpectedFrom7dAvg);

  return {
    routesTotal: routes.length,
    routesActive: routes.filter((row) => String(row.status || "") === "active").length,
    automationsTotal: automations.length,
    automationsActive: automations.filter((row) => row.is_active === true).length,
    groupsTotal: groups.length,
    groupsWhatsapp: groups.filter((row) => String(row.platform || "") === "whatsapp").length,
    groupsTelegram: groups.filter((row) => String(row.platform || "") === "telegram").length,
    waSessionsTotal: waSessions.length,
    waSessionsOnline: waSessions.filter((row) => String(row.status || "") === "online").length,
    tgSessionsTotal: tgSessions.length,
    tgSessionsOnline: tgSessions.filter((row) => String(row.status || "") === "online").length,
    meliSessionsTotal: meliSessions.length,
    meliSessionsActive: meliSessions.filter((row) => String(row.status || "") === "active").length,
    schedulesTotal: schedules.length,
    schedulesPending: schedules.filter((row) => String(row.status || "") === "pending").length,
    schedulesActiveRecurring: schedules.filter((row) => {
      const recurrence = String(row.recurrence || "none");
      const status = String(row.status || "");
      return (recurrence === "daily" || recurrence === "weekly") && status !== "cancelled";
    }).length,
    history24h,
    history7d,
    history24hExpectedFrom7dAvg,
    history24hGrowthRatio,
    errors24h,
    errors7d,
    errors24hExpectedFrom7dAvg,
    errors24hGrowthRatio,
    lastActivityAt: lastActivityAt || null,
  };
}

function buildAdminObservabilitySnapshot(db: ReturnType<typeof loadDb>) {
  const users = db.auth.users.map((authUser) => {
    const profile = db.tables.profiles.find((row) => row.user_id === authUser.id) || null;
    const roleRow = db.tables.user_roles.find((row) => row.user_id === authUser.id) || null;
    const usage = summarizeUserUsage(db, authUser.id);

    const role: "admin" | "user" = roleRow?.role === "admin" ? "admin" : "user";
    return {
      user_id: String(authUser.id || ""),
      email: String(authUser.email || ""),
      name: String(profile?.name || authUser.user_metadata?.name || "Usuario"),
      role,
      account_status: String(authUser.user_metadata?.account_status || "active"),
      plan_id: role === "admin" ? ADMIN_PANEL_PLAN_ID : String(profile?.plan_id || "plan-starter"),
      created_at: String(profile?.created_at || authUser.created_at || nowIso()),
      usage,
    };
  });

  const nowMs = Date.now();
  const since24hMs = nowMs - (24 * 60 * 60 * 1000);
  const since7dMs = nowMs - (7 * 24 * 60 * 60 * 1000);
  const history24h = db.tables.history_entries.filter((row) => toTimestampMs(row.created_at) >= since24hMs);
  const history7d = db.tables.history_entries.filter((row) => toTimestampMs(row.created_at) >= since7dMs);
  const historyPrev6d = history7d.filter((row) => {
    const ts = toTimestampMs(row.created_at);
    return ts < since24hMs;
  });
  const globalErrors24h = history24h.filter((row) => String(row.status || "") === "error" || String(row.processing_status || "") === "failed").length;
  const globalErrors7d = history7d.filter((row) => String(row.status || "") === "error" || String(row.processing_status || "") === "failed").length;
  const globalErrorsPrev6d = historyPrev6d.filter((row) => String(row.status || "") === "error" || String(row.processing_status || "") === "failed").length;
  const history24hExpectedFrom7dAvg = Number((((historyPrev6d.length > 0 ? historyPrev6d.length / 6 : history7d.length / 7) || 0)).toFixed(2));
  const errors24hExpectedFrom7dAvg = Number((((globalErrorsPrev6d > 0 ? globalErrorsPrev6d / 6 : globalErrors7d / 7) || 0)).toFixed(2));
  const history24hGrowthRatio = toGrowthRatio(history24h.length, history24hExpectedFrom7dAvg);
  const errors24hGrowthRatio = toGrowthRatio(globalErrors24h, errors24hExpectedFrom7dAvg);

  const global = {
    usersTotal: users.length,
    usersActive: users.filter((row) => row.account_status === "active").length,
    usersInactive: users.filter((row) => row.account_status === "inactive").length,
    usersBlocked: users.filter((row) => row.account_status === "blocked").length,
    usersArchived: users.filter((row) => row.account_status === "archived").length,
    routesTotal: db.tables.routes.length,
    routesActive: db.tables.routes.filter((row) => String(row.status || "") === "active").length,
    automationsTotal: db.tables.shopee_automations.length,
    automationsActive: db.tables.shopee_automations.filter((row) => row.is_active === true).length,
    groupsTotal: db.tables.groups.filter((row) => !row.deleted_at).length,
    groupsWhatsapp: db.tables.groups.filter((row) => !row.deleted_at && String(row.platform || "") === "whatsapp").length,
    groupsTelegram: db.tables.groups.filter((row) => !row.deleted_at && String(row.platform || "") === "telegram").length,
    waSessionsTotal: db.tables.whatsapp_sessions.length,
    waSessionsOnline: db.tables.whatsapp_sessions.filter((row) => String(row.status || "") === "online").length,
    tgSessionsTotal: db.tables.telegram_sessions.length,
    tgSessionsOnline: db.tables.telegram_sessions.filter((row) => String(row.status || "") === "online").length,
    meliSessionsTotal: db.tables.meli_sessions.length,
    meliSessionsActive: db.tables.meli_sessions.filter((row) => String(row.status || "") === "active").length,
    schedulesTotal: db.tables.scheduled_posts.length,
    schedulesPending: db.tables.scheduled_posts.filter((row) => String(row.status || "") === "pending").length,
    history24h: history24h.length,
    history7d: history7d.length,
    history24hExpectedFrom7dAvg,
    history24hGrowthRatio,
    errors24h: globalErrors24h,
    errors7d: globalErrors7d,
    errors24hExpectedFrom7dAvg,
    errors24hGrowthRatio,
  };

  const rankings = {
    byLoad: [...users]
      .sort((a, b) => {
        const scoreA = (a.usage.routesActive * 3) + (a.usage.automationsActive * 3) + a.usage.groupsTotal + Math.floor(a.usage.history24h / 2);
        const scoreB = (b.usage.routesActive * 3) + (b.usage.automationsActive * 3) + b.usage.groupsTotal + Math.floor(b.usage.history24h / 2);
        return scoreB - scoreA;
      })
      .slice(0, 10)
      .map((row) => ({
        user_id: row.user_id,
        name: row.name,
        email: row.email,
        score: (row.usage.routesActive * 3) + (row.usage.automationsActive * 3) + row.usage.groupsTotal + Math.floor(row.usage.history24h / 2),
        usage: row.usage,
      })),
    bySpike: [...users]
      .sort((a, b) => {
        const scoreA = Math.max(Number(a.usage.history24hGrowthRatio || 1), Number(a.usage.errors24hGrowthRatio || 1));
        const scoreB = Math.max(Number(b.usage.history24hGrowthRatio || 1), Number(b.usage.errors24hGrowthRatio || 1));
        return scoreB - scoreA;
      })
      .slice(0, 10)
      .map((row) => ({
        user_id: row.user_id,
        name: row.name,
        email: row.email,
        score: Math.max(Number(row.usage.history24hGrowthRatio || 1), Number(row.usage.errors24hGrowthRatio || 1)),
        usage: row.usage,
      })),
  };

  const anomalies: Array<{
    id: string;
    severity: "info" | "warning" | "critical";
    title: string;
    message: string;
    user_id?: string;
    metric?: string;
    value?: number;
    threshold?: number;
  }> = [];

  if (globalErrors24h >= 50) {
    anomalies.push({
      id: "global-errors-critical",
      severity: "critical",
      title: "Erro global elevado nas últimas 24h",
      message: `Foram detectados ${globalErrors24h} erros nas últimas 24h.`,
      metric: "errors24h",
      value: globalErrors24h,
      threshold: 50,
    });
  } else if (globalErrors24h >= 20) {
    anomalies.push({
      id: "global-errors-warning",
      severity: "warning",
      title: "Erro global em alerta nas últimas 24h",
      message: `Foram detectados ${globalErrors24h} erros nas últimas 24h.`,
      metric: "errors24h",
      value: globalErrors24h,
      threshold: 20,
    });
  }

  if (global.history24h >= 40 && global.history24hGrowthRatio >= 3) {
    anomalies.push({
      id: "global-history-spike-critical",
      severity: "critical",
      title: "Pico critico de eventos no sistema",
      message: `Volume de eventos 24h em ${global.history24hGrowthRatio}x da media dos ultimos 7 dias.`,
      metric: "history24hGrowthRatio",
      value: global.history24hGrowthRatio,
      threshold: 3,
    });
  } else if (global.history24h >= 20 && global.history24hGrowthRatio >= 2) {
    anomalies.push({
      id: "global-history-spike-warning",
      severity: "warning",
      title: "Pico de eventos no sistema",
      message: `Volume de eventos 24h em ${global.history24hGrowthRatio}x da media dos ultimos 7 dias.`,
      metric: "history24hGrowthRatio",
      value: global.history24hGrowthRatio,
      threshold: 2,
    });
  }

  if (global.errors24h >= 10 && global.errors24hGrowthRatio >= 3) {
    anomalies.push({
      id: "global-errors-spike-critical",
      severity: "critical",
      title: "Pico critico de erros no sistema",
      message: `Erros 24h em ${global.errors24hGrowthRatio}x da media dos ultimos 7 dias.`,
      metric: "errors24hGrowthRatio",
      value: global.errors24hGrowthRatio,
      threshold: 3,
    });
  } else if (global.errors24h >= 5 && global.errors24hGrowthRatio >= 2) {
    anomalies.push({
      id: "global-errors-spike-warning",
      severity: "warning",
      title: "Pico de erros no sistema",
      message: `Erros 24h em ${global.errors24hGrowthRatio}x da media dos ultimos 7 dias.`,
      metric: "errors24hGrowthRatio",
      value: global.errors24hGrowthRatio,
      threshold: 2,
    });
  }

  for (const user of users) {
    if (user.usage.errors24h >= 25) {
      anomalies.push({
        id: `user-errors-critical:${user.user_id}`,
        severity: "critical",
        title: "Usuario com erro critico",
        message: `${user.name} registrou ${user.usage.errors24h} erros nas últimas 24h.`,
        user_id: user.user_id,
        metric: "userErrors24h",
        value: user.usage.errors24h,
        threshold: 25,
      });
    } else if (user.usage.errors24h >= 10) {
      anomalies.push({
        id: `user-errors-warning:${user.user_id}`,
        severity: "warning",
        title: "Usuario em alerta de erro",
        message: `${user.name} registrou ${user.usage.errors24h} erros nas últimas 24h.`,
        user_id: user.user_id,
        metric: "userErrors24h",
        value: user.usage.errors24h,
        threshold: 10,
      });
    }

    const nonActive = user.account_status !== "active";
    const keepsRunning = user.usage.routesActive > 0 || user.usage.automationsActive > 0;
    if (nonActive && keepsRunning) {
      anomalies.push({
        id: `inactive-running:${user.user_id}`,
        severity: "warning",
        title: "Conta nao ativa com carga operacional",
        message: `${user.name} esta ${user.account_status} mas ainda possui rotas/automacoes ativas.`,
        user_id: user.user_id,
      });
    }

    if (user.usage.history24h >= 15 && user.usage.history24hGrowthRatio >= 3) {
      anomalies.push({
        id: `user-history-spike-critical:${user.user_id}`,
        severity: "critical",
        title: "Usuario com pico critico de atividade",
        message: `${user.name} esta em ${user.usage.history24hGrowthRatio}x da media de eventos dos ultimos 7 dias.`,
        user_id: user.user_id,
        metric: "userHistory24hGrowthRatio",
        value: user.usage.history24hGrowthRatio,
        threshold: 3,
      });
    } else if (user.usage.history24h >= 10 && user.usage.history24hGrowthRatio >= 2) {
      anomalies.push({
        id: `user-history-spike-warning:${user.user_id}`,
        severity: "warning",
        title: "Usuario com pico de atividade",
        message: `${user.name} esta em ${user.usage.history24hGrowthRatio}x da media de eventos dos ultimos 7 dias.`,
        user_id: user.user_id,
        metric: "userHistory24hGrowthRatio",
        value: user.usage.history24hGrowthRatio,
        threshold: 2,
      });
    }

    if (user.usage.errors24h >= 5 && user.usage.errors24hGrowthRatio >= 3) {
      anomalies.push({
        id: `user-errors-spike-critical:${user.user_id}`,
        severity: "critical",
        title: "Usuario com pico critico de erros",
        message: `${user.name} esta em ${user.usage.errors24hGrowthRatio}x da media de erros dos ultimos 7 dias.`,
        user_id: user.user_id,
        metric: "userErrors24hGrowthRatio",
        value: user.usage.errors24hGrowthRatio,
        threshold: 3,
      });
    } else if (user.usage.errors24h >= 3 && user.usage.errors24hGrowthRatio >= 2) {
      anomalies.push({
        id: `user-errors-spike-warning:${user.user_id}`,
        severity: "warning",
        title: "Usuario com pico de erros",
        message: `${user.name} esta em ${user.usage.errors24hGrowthRatio}x da media de erros dos ultimos 7 dias.`,
        user_id: user.user_id,
        metric: "userErrors24hGrowthRatio",
        value: user.usage.errors24hGrowthRatio,
        threshold: 2,
      });
    }
  }

  anomalies.sort((a, b) => {
    const weight = (value: string) => (value === "critical" ? 3 : value === "warning" ? 2 : 1);
    return weight(b.severity) - weight(a.severity);
  });

  return { global, users, rankings, anomalies: anomalies.slice(0, 40) };
}

async function fetchOpsServiceHealthSnapshot(userId: string) {
  if (!OPS_CONTROL_URL) {
    return {
      online: false,
      url: "",
      error: "Servico Ops nao configurado (VITE_OPS_CONTROL_URL)",
      system: null,
      services: OPS_SERVICE_IDS.map((service) => ({
        id: service,
        status: "unknown",
        online: false,
        pid: null,
        uptimeSec: null,
        appName: "",
      })),
    };
  }

  try {
    const response = await callService<{
      online?: boolean;
      system?: Record<string, unknown>;
      services?: Array<Record<string, unknown>>;
      error?: string;
    }>(OPS_CONTROL_URL, `/api/services?_ts=${Date.now()}`, {
      userId,
      headers: OPS_CONTROL_TOKEN ? { "x-ops-token": OPS_CONTROL_TOKEN } : undefined,
    });

    return {
      online: response.online === true,
      url: OPS_CONTROL_URL,
      error: response.error ? String(response.error) : null,
      system: response.system && typeof response.system === "object" ? response.system : null,
      services: Array.isArray(response.services) ? response.services : [],
    };
  } catch (error) {
    // Ops-control is unreachable — fall back to direct health polling per service so the
    // admin panel still shows real component states even without the orchestrator.
    const serviceDirectMap: Array<{ id: string; url: string; healthPath?: string }> = [
      { id: "whatsapp", url: WHATSAPP_MICROSERVICE_URL },
      { id: "telegram", url: TELEGRAM_MICROSERVICE_URL },
      { id: "shopee", url: SHOPEE_MICROSERVICE_URL },
      { id: "meli", url: MELI_RPA_URL, healthPath: "/api/meli/health" },
    ];

    const results = await Promise.allSettled(
      serviceDirectMap.map(({ url, healthPath }) => getServiceHealth(url, healthPath)),
    );

    const fallbackServices = serviceDirectMap.map(({ id, url }, idx) => {
      const settled = results[idx];
      const h = settled.status === "fulfilled"
        ? settled.value
        : { online: false, uptimeSec: null, error: "Falha ao checar saúde direta", url };
      return {
        id,
        status: h.online ? "online" : "offline",
        online: h.online,
        pid: null,
        uptimeSec: h.uptimeSec ?? null,
        appName: "",
        processStatus: h.online ? "online-local" : "offline-local",
        processOnline: h.online,
        componentOnline: h.online,
        componentError: h.error ?? null,
        healthUrl: url,
        port: null,
        mode: "fallback",
      };
    });

    return {
      online: false,
      url: OPS_CONTROL_URL,
      error: error instanceof Error ? error.message : String(error),
      system: null,
      services: fallbackServices,
    };
  }
}

const OPS_SERVICE_IDS = ["whatsapp", "telegram", "shopee", "meli"] as const;
type OpsServiceId = (typeof OPS_SERVICE_IDS)[number] | "all";

function parseOpsServiceId(value: unknown): OpsServiceId | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "all") return "all";
  return OPS_SERVICE_IDS.find((service) => service === normalized) || null;
}

function parseOpsAction(value: unknown): "start" | "stop" | "restart" | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "start" || normalized === "stop" || normalized === "restart") return normalized;
  return null;
}

function buildScopedMeliSessionId(userId: string, sessionId: string): string {
  const sanitize = (value: string, max: number) =>
    String(value || "")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, max) || "x";

  return `${sanitize(userId, 64)}__${sanitize(sessionId, 48)}`;
}

function resolveDefaultMeliSessionId(snapshot: ReturnType<typeof loadDb>, userId: string): string {
  const userSessions = Array.isArray(snapshot.tables.meli_sessions)
    ? snapshot.tables.meli_sessions.filter((row) => row.user_id === userId)
    : [];

  if (userSessions.length === 0) return "";

  const preferred = userSessions.find((row) => row.status === "active")
    || userSessions.find((row) => row.status === "untested")
    || userSessions[0];

  return String(preferred?.id || "");
}

function resolveRouteMeliSessionId(snapshot: ReturnType<typeof loadDb>, userId: string, preferredSessionId: string): string {
  const normalizedPreferred = String(preferredSessionId || "").trim();
  const userSessions = Array.isArray(snapshot.tables.meli_sessions)
    ? snapshot.tables.meli_sessions.filter((row) => row.user_id === userId)
    : [];

  const readySession = userSessions.find((row) => row.status === "active")
    || userSessions.find((row) => row.status === "untested");
  if (readySession?.id) return String(readySession.id);

  if (normalizedPreferred) {
    const found = userSessions.find((row) => String(row.id) === normalizedPreferred);
    if (found?.id) return String(found.id);
  }

  return resolveDefaultMeliSessionId(snapshot, userId);
}

type IntegrationEvent = {
  event?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
};

type InboundMessageInput = {
  userId: string;
  platform: "whatsapp" | "telegram";
  sessionId: string;
  sourceExternalId: string;
  sourceName: string;
  from: string;
  message: string;
  media?: {
    kind: "image";
    sourcePlatform: "whatsapp" | "telegram";
    token?: string;
    base64?: string;
    mimeType?: string;
    fileName?: string;
  } | null;
};

type OutboundMediaPayload = {
  kind: "image";
  token?: string;
  base64?: string;
  mimeType?: string;
  fileName?: string;
};

const AUTO_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const AUTO_IMAGE_FETCH_TIMEOUT_MS = 12_000;
const ROUTE_MEDIA_PROCESSING_HOLD_MS = 45 * 60 * 1000;

type RouteProcessResult = {
  routesMatched: number;
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
};

const PARTNER_MARKETPLACE_PATTERNS: Record<string, RegExp[]> = {
  shopee: [/shopee\.com(\.\w+)?/i, /shope\.ee/i, /s\.shopee\./i],
  amazon: [/amazon\./i, /amzn\.to/i],
  mercadolivre: [/mercadolivre\.com\.br/i, /mercadolibre\.com/i, /mlb\.am/i],
  magalu: [/magazineluiza\.com\.br/i, /magalu\.com/i],
  aliexpress: [/aliexpress\.com/i, /s\.click\.aliexpress/i],
};

function normalizeMarketplaceList(value: unknown): string[] {
  if (!Array.isArray(value)) return ["shopee"];
  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : ["shopee"];
}

function isMarketplaceConversionEnabled(
  rules: Record<string, unknown>,
  marketplace: string,
): boolean {
  if (marketplace === "shopee") {
    return rules.autoConvertShopee !== false;
  }
  if (marketplace === "mercadolivre") {
    return rules.autoConvertMercadoLivre !== false;
  }
  return false;
}

function detectPartnerMarketplace(url: string): string | null {
  for (const [name, patterns] of Object.entries(PARTNER_MARKETPLACE_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(url))) {
      return name;
    }
  }
  return null;
}

function stripShopeeLpAffParam(link: string): string {
  const value = String(link || "").trim();
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (!parsed.searchParams.has("lp")) return value;

    const lpValues = parsed.searchParams.getAll("lp");
    if (!lpValues.some((item) => item.trim().toLowerCase() === "aff")) {
      return value;
    }

    const nextParams = new URLSearchParams();
    for (const [key, paramValue] of parsed.searchParams.entries()) {
      if (key === "lp" && paramValue.trim().toLowerCase() === "aff") {
        continue;
      }
      nextParams.append(key, paramValue);
    }

    const nextSearch = nextParams.toString();
    return `${parsed.origin}${parsed.pathname}${nextSearch ? `?${nextSearch}` : ""}${parsed.hash}`;
  } catch {
    return value.replace(/[?&]lp=aff(?=(&|#|$))/gi, (match, suffix) => {
      if (match.startsWith("?")) {
        return suffix === "&" ? "?" : "";
      }
      return suffix === "&" ? "&" : "";
    }).replace(/[?&]$/, "");
  }
}

function convertShopeeAffiliateLink(sourceUrl: string, userId: string) {
  const value = stripShopeeLpAffParam(String(sourceUrl || "").trim());
  if (!value) return "";
  if (value.includes("aff_id=")) return value;
  return `${value}${value.includes("?") ? "&" : "?"}aff_id=local_${userId.slice(0, 8)}`;
}

type ShopeeLinkConversionResult = {
  originalLink: string;
  resolvedLink: string;
  affiliateLink: string;
  product: Record<string, unknown> | null;
  usedService: boolean;
};

type MeliLinkConversionResult = {
  affiliateLink: string;
  cached: boolean;
  conversionTimeMs: number | null;
};

function getShopeeCredentialsForUser(snapshot: ReturnType<typeof loadDb>, userId: string) {
  return snapshot.tables.api_credentials.find(
    (row) => row.user_id === userId && row.provider === "shopee",
  ) || null;
}

async function convertShopeeLinkForUser(input: {
  url: string;
  userId: string;
  credentials: Record<string, unknown> | null;
  resolveRedirect?: boolean;
}): Promise<ShopeeLinkConversionResult> {
  const originalLink = String(input.url || "").trim();
  if (!originalLink) {
    return {
      originalLink: "",
      resolvedLink: "",
      affiliateLink: "",
      product: null,
      usedService: false,
    };
  }

  const resolvedLink = input.resolveRedirect === false
    ? originalLink
    : await resolveLinkWithRedirect(originalLink);

  const sourceMarketplace = detectPartnerMarketplace(originalLink);
  const resolvedMarketplace = detectPartnerMarketplace(resolvedLink);
  const isShopee = sourceMarketplace === "shopee" || resolvedMarketplace === "shopee";

  if (!isShopee) {
    return {
      originalLink,
      resolvedLink,
      affiliateLink: originalLink,
      product: null,
      usedService: false,
    };
  }

  const sourceForConversion = resolvedMarketplace === "shopee" ? resolvedLink : originalLink;
  const fallback = convertShopeeAffiliateLink(sourceForConversion || originalLink, input.userId);

  if (!input.credentials || !shopeeServiceConfigured()) {
    return {
      originalLink,
      resolvedLink,
      affiliateLink: fallback,
      product: null,
      usedService: false,
    };
  }

  try {
    const response = await callService<{
      affiliateLink?: string;
      product?: Record<string, unknown> | null;
      resolvedUrl?: string;
    }>(
      SHOPEE_MICROSERVICE_URL,
      "/api/shopee/convert-link",
      {
        method: "POST",
        body: {
          ...getShopeeCredentialPayload(input.credentials),
          url: sourceForConversion || originalLink,
        },
      },
    );

    const affiliateLink = stripShopeeLpAffParam(String(response.affiliateLink || fallback).trim() || fallback);
    return {
      originalLink,
      resolvedLink: String(response.resolvedUrl || resolvedLink || originalLink),
      affiliateLink,
      product: response.product || null,
      usedService: true,
    };
  } catch {
    return {
      originalLink,
      resolvedLink,
      affiliateLink: fallback,
      product: null,
      usedService: false,
    };
  }
}

async function syncPendingMeliCookies(userId: string, sessionId: string): Promise<void> {
  const snapshot = loadDb();
  const row = snapshot.tables.meli_sessions?.find((r) => r.user_id === userId && r.id === sessionId);
  if (!row?.pending_cookies) return;
  let pendingCookies: unknown;
  try {
    pendingCookies = typeof row.pending_cookies === "string" ? JSON.parse(String(row.pending_cookies)) : row.pending_cookies;
  } catch { pendingCookies = row.pending_cookies; }
  const scopedId = buildScopedMeliSessionId(userId, sessionId);
  try {
    await callService(MELI_RPA_URL, "/api/meli/sessions", { method: "POST", userId, body: { sessionId: scopedId, cookies: pendingCookies as Record<string, unknown> } });
    withDb((db) => {
      const r = db.tables.meli_sessions?.find((s) => s.user_id === userId && s.id === sessionId);
      if (r) { delete r.pending_cookies; r.updated_at = nowIso(); }
    });
  } catch { /* service offline — conversion will fail with clear error downstream */ }
}

async function convertMercadoLivreLinkForUser(input: {
  userId: string;
  sessionId: string;
  url: string;
}): Promise<MeliLinkConversionResult> {
  const url = String(input.url || "").trim();
  if (!url) {
    return { affiliateLink: "", cached: false, conversionTimeMs: null };
  }

  await syncPendingMeliCookies(input.userId, input.sessionId);
  const scopedSessionId = buildScopedMeliSessionId(input.userId, input.sessionId);
  const response = await callService<{
    affiliateLink?: string;
    cached?: boolean;
    conversionTimeMs?: number;
  }>(MELI_RPA_URL, "/api/meli/convert", {
    method: "POST",
    userId: input.userId,
    body: { productUrl: url, sessionId: scopedSessionId },
  });

  return {
    affiliateLink: String(response.affiliateLink || url),
    cached: response.cached === true,
    conversionTimeMs: typeof response.conversionTimeMs === "number" ? response.conversionTimeMs : null,
  };
}

async function convertShopeeLinksInContent(input: {
  content: string;
  userId: string;
  credentials: Record<string, unknown> | null;
  resolveRedirect?: boolean;
}) {
  const originalContent = String(input.content || "");
  const links = extractLinks(originalContent);
  if (links.length === 0) {
    return {
      convertedContent: originalContent,
      conversions: [] as ShopeeLinkConversionResult[],
    };
  }

  const cache = new Map<string, ShopeeLinkConversionResult>();
  const conversions: ShopeeLinkConversionResult[] = [];
  let convertedContent = originalContent;

  for (const link of links) {
    const normalizedLink = String(link || "").trim();
    if (!normalizedLink) continue;

    const cacheKey = `${normalizedLink}::${input.resolveRedirect === false ? "n" : "y"}`;
    let conversion = cache.get(cacheKey);
    if (!conversion) {
      conversion = await convertShopeeLinkForUser({
        url: normalizedLink,
        userId: input.userId,
        credentials: input.credentials,
        resolveRedirect: input.resolveRedirect,
      });
      cache.set(cacheKey, conversion);
    }

    if (!conversion.affiliateLink || conversion.affiliateLink === normalizedLink) continue;

    const shouldReplace = detectPartnerMarketplace(normalizedLink) === "shopee"
      || detectPartnerMarketplace(conversion.resolvedLink) === "shopee";

    if (!shouldReplace) continue;

    convertedContent = convertedContent.split(normalizedLink).join(conversion.affiliateLink);
    if (conversion.resolvedLink && conversion.resolvedLink !== normalizedLink) {
      convertedContent = convertedContent.split(conversion.resolvedLink).join(conversion.affiliateLink);
    }

    conversions.push(conversion);
  }

  return {
    convertedContent,
    conversions,
  };
}

const SHOPEE_AUTOMATION_KEYWORDS: Record<string, string[]> = {
  // Legacy string IDs for backward compatibility
  smartphones: ["iphone", "smartphone", "celular"],
  eletronicos: ["smartwatch", "fone bluetooth", "teclado", "mouse"],
  moda: ["vestido", "blusa feminina", "camiseta"],
  calcados: ["tenis", "sandalia", "chinelo"],
  beleza: ["maquiagem", "perfume", "skincare"],
  casa: ["organizador", "cozinha", "casa decoracao"],
  fitness: ["academia", "elastico fitness", "musculacao"],
  bebe: ["bebe", "infantil", "brinquedo educativo"],
  pet: ["pet shop", "cachorro", "gato"],
  gamer: ["headset gamer", "teclado gamer", "mouse gamer"],
};

/**
 * Convert saved category IDs (numeric or legacy string) into search keywords.
 * Uses the same category label as ShopeePesquisa ("Celulares & Eletronicos", etc.)
 * so automation results match what users see in the search tab.
 */
function shopeeCategoriesToKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const keywords: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id === "todos") continue;

    const numId = Number(id);

    if (!Number.isNaN(numId)) {
      // Check parent categories first
      const parentCat = SHOPEE_CATEGORIES.find((c) => c.id === numId);
      if (parentCat) {
        keywords.push(parentCat.label);
        continue;
      }
      // Check subcategories
      let foundSub = false;
      for (const cat of SHOPEE_CATEGORIES) {
        const sub = cat.subcategories.find((s) => s.id === numId);
        if (sub) {
          keywords.push(sub.label);
          foundSub = true;
          break;
        }
      }
      if (foundSub) continue;
    }

    // Legacy string IDs fallback
    const legacyKeywords = SHOPEE_AUTOMATION_KEYWORDS[id] || SHOPEE_AUTOMATION_KEYWORDS[id.toLowerCase()];
    if (legacyKeywords?.length) {
      keywords.push(legacyKeywords[0]);
    }
  }

  // Return unique keywords
  return [...new Set(keywords)];
}

type ShopeeAutomationQueryPlan = {
  id: string;
  type: "search" | "products";
  params: Record<string, unknown>;
  fallbackKeyword: string;
};

type ShopeeAutomationOfferSourceMode = "search" | "vitrine";

const SHOPEE_AUTOMATION_VITRINE_QUERY_PRESETS: Record<string, { listType: number; sortBy: string }> = {
  sales: { listType: 0, sortBy: "sales" },
  commission: { listType: 0, sortBy: "commission" },
  discount: { listType: 0, sortBy: "discount" },
  rating: { listType: 0, sortBy: "rating" },
  top: { listType: 2, sortBy: "sales" },
};

function normalizeShopeeAutomationOfferSourceMode(value: unknown): ShopeeAutomationOfferSourceMode {
  return String(value || "").trim().toLowerCase() === "vitrine" ? "vitrine" : "search";
}

function normalizeShopeeAutomationVitrineTabs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabs: string[] = [];
  for (const raw of value) {
    const tab = String(raw || "").trim().toLowerCase();
    if (!tab || !SHOPEE_AUTOMATION_VITRINE_QUERY_PRESETS[tab] || seen.has(tab)) continue;
    seen.add(tab);
    tabs.push(tab);
  }
  return tabs;
}

function buildShopeeAutomationQueryPlans(
  value: unknown,
  options?: { sourceMode?: unknown; vitrineTabs?: unknown },
): ShopeeAutomationQueryPlan[] {
  const sourceMode = normalizeShopeeAutomationOfferSourceMode(options?.sourceMode);
  if (sourceMode === "vitrine") {
    const tabs = normalizeShopeeAutomationVitrineTabs(options?.vitrineTabs);
    const selectedTabs = tabs.length > 0 ? tabs : ["sales"];
    const plans: ShopeeAutomationQueryPlan[] = [];
    for (const tab of selectedTabs) {
      const preset = SHOPEE_AUTOMATION_VITRINE_QUERY_PRESETS[tab];
      if (!preset) continue;
      plans.push({
        id: `vitrine_${tab}`,
        type: "products",
        params: { sortBy: preset.sortBy, listType: preset.listType, limit: 20, page: 1 },
        fallbackKeyword: "",
      });
    }
    if (plans.length > 0) return plans;
  }

  if (!Array.isArray(value) || value.length === 0) {
    return [{
      id: "cat_0",
      type: "search",
      params: { keyword: "oferta", sortBy: "sales", limit: 20, page: 1 },
      fallbackKeyword: "oferta",
    }];
  }

  const plans: ShopeeAutomationQueryPlan[] = [];

  for (const item of value) {
    if (typeof item !== "string") continue;
    const rawId = item.trim();
    if (!rawId || rawId === "todos") continue;

    const numId = Number(rawId);
    const nextId = `cat_${plans.length}`;

    if (!Number.isNaN(numId)) {
      const parentCat = SHOPEE_CATEGORIES.find((c) => c.id === numId);
      if (parentCat) {
        plans.push({
          id: nextId,
          type: "search",
          params: { keyword: parentCat.label, sortBy: "sales", limit: 20, page: 1 },
          fallbackKeyword: parentCat.label,
        });
        continue;
      }

      let matchedSub = false;
      for (const cat of SHOPEE_CATEGORIES) {
        const sub = cat.subcategories.find((s) => s.id === numId);
        if (!sub) continue;

        const kw = `${cat.label} ${sub.label}`.trim();
        plans.push({
          id: nextId,
          type: "search",
          params: { keyword: kw, sortBy: "sales", limit: 20, page: 1 },
          fallbackKeyword: kw,
        });
        matchedSub = true;
        break;
      }

      if (matchedSub) continue;
    }

    const legacyKeywords = SHOPEE_AUTOMATION_KEYWORDS[rawId] || SHOPEE_AUTOMATION_KEYWORDS[rawId.toLowerCase()];
    if (legacyKeywords?.length) {
      plans.push({
        id: nextId,
        type: "search",
        params: { keyword: legacyKeywords[0], sortBy: "sales", limit: 20, page: 1 },
        fallbackKeyword: legacyKeywords[0],
      });
    }
  }

  if (plans.length === 0) {
    plans.push({
      id: "cat_0",
      type: "search",
      params: { keyword: "oferta", sortBy: "sales", limit: 20, page: 1 },
      fallbackKeyword: "oferta",
    });
  }

  return plans.slice(0, 5);
}

function inTimeWindow(startTime: unknown, endTime: unknown, date = new Date()): boolean {
  const nowMinutes = (() => {
    const timezone = String(import.meta.env.VITE_AUTOMATION_TIMEZONE || "America/Sao_Paulo").trim() || "America/Sao_Paulo";
    try {
      const parts = new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: timezone,
      }).formatToParts(date);
      const hourPart = Number(parts.find((part) => part.type === "hour")?.value || "0");
      const minutePart = Number(parts.find((part) => part.type === "minute")?.value || "0");
      if (Number.isFinite(hourPart) && Number.isFinite(minutePart)) {
        return Math.max(0, Math.min(23, hourPart)) * 60 + Math.max(0, Math.min(59, minutePart));
      }
    } catch {
      // Fallback to local time when Intl timezone parsing is unavailable.
    }
    return date.getHours() * 60 + date.getMinutes();
  })();

  const parse = (value: unknown, fallback: number) => {
    const raw = String(value || "");
    const [h, m] = raw.split(":");
    const hours = Number.parseInt(h || "", 10);
    const minutes = Number.parseInt(m || "", 10);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
    return Math.max(0, Math.min(23, hours)) * 60 + Math.max(0, Math.min(59, minutes));
  };

  const start = parse(startTime, 8 * 60);
  const end = parse(endTime, 20 * 60);

  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes <= end;
  return nowMinutes >= start || nowMinutes <= end;
}

function minutesSinceIso(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return (Date.now() - parsed) / 60_000;
}

const AUTOMATION_RECENT_OFFER_LIMIT = 200;
const AUTOMATION_RECENT_OFFER_WINDOW_MS = 72 * 60 * 60 * 1_000;
const AUTOMATION_RUN_LOCK_TTL_MS = 4 * 60 * 1_000;
const AUTOMATION_INTERVAL_GRACE_MS = 15 * 1_000;

type RecentOfferTitleEntry = {
  title: string;
  sentAt: string;
};

type AutomationTraceStatus = "info" | "success" | "warning" | "error";

function mapTraceProcessingStatus(status: AutomationTraceStatus): "processed" | "blocked" | "failed" {
  if (status === "error") return "failed";
  if (status === "warning") return "blocked";
  return "processed";
}

function appendAutomationTrace(
  db: ReturnType<typeof loadDb>,
  input: {
    userId: string;
    sourceLabel: string;
    destinationLabel: string;
    status: AutomationTraceStatus;
    traceId: string;
    step: string;
    sourceRun: string;
    message: string;
    automationId?: string;
    data?: Record<string, unknown>;
  },
) {
  const processingStatus = mapTraceProcessingStatus(input.status);
  db.tables.history_entries.push({
    id: randomId("hist"),
    user_id: input.userId,
    type: "automation_trace",
    source: input.sourceLabel,
    destination: input.destinationLabel,
    status: input.status === "error" ? "error" : input.status === "warning" ? "warning" : "info",
    details: {
      message: input.message,
      traceId: input.traceId,
      step: input.step,
      sourceRun: input.sourceRun,
      automationId: input.automationId || "",
      ...(input.data || {}),
    },
    direction: "system",
    message_type: "text",
    processing_status: processingStatus,
    block_reason: input.status === "warning" ? input.step : "",
    error_step: input.status === "error" ? input.step : "",
    created_at: nowIso(),
  });
}

function normalizeOfferTitle(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function parseRecentOfferTitleMemory(raw: unknown, nowMs = Date.now()): RecentOfferTitleEntry[] {
  if (!Array.isArray(raw)) return [];

  const normalized: Array<RecentOfferTitleEntry & { ts: number }> = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = normalizeOfferTitle(row.title);
    const sentAt = typeof row.sentAt === "string" ? row.sentAt : "";
    const ts = Date.parse(sentAt);
    if (!title || Number.isNaN(ts)) continue;
    if (nowMs - ts > AUTOMATION_RECENT_OFFER_WINDOW_MS) continue;
    normalized.push({ title, sentAt: new Date(ts).toISOString(), ts });
  }

  normalized.sort((a, b) => b.ts - a.ts);
  return normalized.slice(0, AUTOMATION_RECENT_OFFER_LIMIT).map(({ title, sentAt }) => ({ title, sentAt }));
}

function getRecentOfferTitleSet(automation: Record<string, unknown>, nowMs = Date.now()): Set<string> {
  const memory = parseRecentOfferTitleMemory(automation.recent_offer_titles, nowMs);
  return new Set(memory.map((entry) => entry.title));
}

function appendRecentOfferTitleMemory(raw: unknown, title: unknown, sentAtIso: string): RecentOfferTitleEntry[] {
  const nowMs = Date.now();
  const normalizedTitle = normalizeOfferTitle(title);
  const existing = parseRecentOfferTitleMemory(raw, nowMs);
  if (!normalizedTitle) return existing;

  const deduped = existing.filter((entry) => entry.title !== normalizedTitle);
  return [{ title: normalizedTitle, sentAt: sentAtIso }, ...deduped]
    .slice(0, AUTOMATION_RECENT_OFFER_LIMIT);
}

function acquireAutomationRunLock(userId: string, automationId: string, owner: string, nowMs = Date.now()): boolean {
  let touched = false;

  withDb((db) => {
    const row = db.tables.shopee_automations.find((item) => item.id === automationId && item.user_id === userId);
    if (!row) return;

    const record = row as Record<string, unknown>;
    const lockRaw = record.runtime_lock;
    const lock = lockRaw && typeof lockRaw === "object" && !Array.isArray(lockRaw)
      ? (lockRaw as Record<string, unknown>)
      : null;
    const existingOwner = typeof lock?.owner === "string" ? lock.owner : "";
    const existingExpiresAt = typeof lock?.expiresAt === "string" ? Date.parse(lock.expiresAt) : NaN;
    const lockIsActive = Boolean(existingOwner) && Number.isFinite(existingExpiresAt) && existingExpiresAt > nowMs;

    if (lockIsActive && existingOwner !== owner) return;

    record.runtime_lock = {
      owner,
      expiresAt: new Date(nowMs + AUTOMATION_RUN_LOCK_TTL_MS).toISOString(),
    };
    row.updated_at = nowIso();
    touched = true;
  });

  if (!touched) return false;

  const row = loadDb().tables.shopee_automations.find((item) => item.id === automationId && item.user_id === userId);
  if (!row) return false;

  const record = row as Record<string, unknown>;
  const lock = record.runtime_lock;
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) return false;

  return typeof (lock as Record<string, unknown>).owner === "string"
    && String((lock as Record<string, unknown>).owner) === owner;
}

function releaseAutomationRunLock(userId: string, automationId: string, owner: string): void {
  withDb((db) => {
    const row = db.tables.shopee_automations.find((item) => item.id === automationId && item.user_id === userId);
    if (!row) return;

    const record = row as Record<string, unknown>;
    const lock = record.runtime_lock;
    if (!lock || typeof lock !== "object" || Array.isArray(lock)) return;
    if (String((lock as Record<string, unknown>).owner || "") !== owner) return;

    delete record.runtime_lock;
    row.updated_at = nowIso();
  });
}

function buildShopeeMessageFromTemplate(
  templateContent: string,
  product: Record<string, unknown>,
  affiliateLink: string,
): string {
  const contentWithoutImageLine = String(templateContent || "")
    // When {imagem} is used alone in a line, remove the whole line to avoid blank output rows.
    .replace(/^[ \t]*(?:\{imagem\}|\{\{imagem\}\})[ \t]*(?:\r?\n|$)/gim, "");

  return applyPlaceholders(contentWithoutImageLine, {
    "{titulo}": String(product.title || "Produto"),
    "{preco}": Number(product.salePrice || 0).toFixed(2),
    "{preco_original}": Number(product.originalPrice || 0).toFixed(2),
    "{desconto}": String(product.discount || 0),
    "{link}": affiliateLink,
    // Placeholder {imagem} only flags that media should be attached, never a text URL.
    "{imagem}": "",
    "{{imagem}}": "",
    "{avaliacao}": String(product.rating || 0),
  });
}

function templateRequestsAutomationImage(templateContent: string): boolean {
  const normalized = String(templateContent || "").toLowerCase();
  return normalized.includes("{imagem}") || normalized.includes("{{imagem}}");
}

function extractValidShopeeAffiliateLink(product: Record<string, unknown>): string {
  const offerLink = String(product.offerLink || "").trim();
  if (!offerLink) return "";
  if (!/^https?:\/\//i.test(offerLink)) return "";
  return offerLink;
}

function toKeywordList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function textMatchesAnyKeyword(text: string, keywords: string[]) {
  if (keywords.length === 0) return false;
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function buildAutomationProductKeywordText(product: Record<string, unknown>): string {
  return [
    String(product.title || "").trim(),
    String(product.productName || "").trim(),
    String(product.itemName || "").trim(),
    String(product.shopName || "").trim(),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

async function resolveLinkWithRedirect(url: string): Promise<string> {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return target;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);

  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    return response.url || target;
  } catch {
    return target;
  } finally {
    clearTimeout(timeout);
  }
}

function appendRouteHistory(
  db: ReturnType<typeof loadDb>,
  input: {
    userId: string;
    source: string;
    destination: string;
    status: "success" | "error" | "info";
    message: string;
    processingStatus: "sent" | "failed" | "blocked";
    blockReason?: string;
    errorMessage?: string;
    messageData?: Record<string, unknown>;
    capturedAt?: string;
    routeId: string;
    routeName: string;
    originPlatform?: "whatsapp" | "telegram";
  },
) {
  const capturedAt = input.capturedAt || nowIso();
  const errorMessage = input.errorMessage || input.blockReason || "";
  const detailPlatform = input.originPlatform
    || (typeof input.messageData?.platform === "string" ? String(input.messageData.platform) : "");
  db.tables.history_entries.push({
    id: randomId("hist"),
    user_id: input.userId,
    type: "route_forward",
    source: input.source,
    destination: input.destination,
    status: input.status,
    details: {
      message: input.message,
      routeId: input.routeId,
      routeName: input.routeName,
      capturedAt,
      platform: detailPlatform,
      status: input.status,
      processingStatus: input.processingStatus,
      error: errorMessage,
      ...input.messageData,
    },
    direction: "outbound",
    message_type: "text",
    processing_status: input.processingStatus,
    block_reason: errorMessage,
    error_step: input.processingStatus === "failed" ? "route_dispatch" : "",
    created_at: nowIso(),
  });
}

function incrementRouteMessagesForwarded(
  db: ReturnType<typeof loadDb>,
  routeId: string,
  userId: string,
  incrementBy: number,
) {
  if (incrementBy <= 0) return;
  const route = db.tables.routes.find((row) => row.id === routeId && row.user_id === userId);
  if (!route) return;

  const rules = route.rules && typeof route.rules === "object" && !Array.isArray(route.rules)
    ? { ...(route.rules as Record<string, unknown>) }
    : {};
  const current = Number(rules.messagesForwarded || 0);
  rules.messagesForwarded = Number.isFinite(current) ? current + incrementBy : incrementBy;
  route.rules = rules;
  route.updated_at = nowIso();
}

function withSecretHeaders(userId?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (MICROSERVICE_WEBHOOK_SECRET) {
    headers["x-webhook-secret"] = MICROSERVICE_WEBHOOK_SECRET;
  }
  if (typeof userId === "string" && userId.trim()) {
    headers["x-autolinks-user-id"] = userId.trim();
  }
  return headers;
}

async function callService<T>(
  baseUrl: string,
  path: string,
  init?: {
    method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
    body?: Record<string, unknown>;
    userId?: string;
    headers?: Record<string, string>;
  },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init?.method || "GET",
      headers: {
        ...withSecretHeaders(init?.userId),
        ...(init?.headers || {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    const isNetworkError = message.includes("failed to fetch") || message.includes("network") || message.includes("fetch");
    if (isNetworkError) {
      throw new Error("Serviço temporariamente indisponível. Tente novamente em instantes.");
    }
    throw error instanceof Error ? error : new Error("Falha de rede ao chamar servico externo");
  }

  const text = await response.text().catch(() => "");
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { message: text };
    }
  }

  if (!response.ok) {
    throw new Error(String(parsed.error || parsed.message || `Falha HTTP ${response.status}`));
  }

  return parsed as T;
}

async function fetchWhatsAppMediaByToken(token: string, userId: string): Promise<{
  base64: string;
  mimeType: string;
  fileName: string;
}> {
  return callService<{
    ok?: boolean;
    base64?: string;
    mimeType?: string;
    fileName?: string;
  }>(
    WHATSAPP_MICROSERVICE_URL,
    `/api/media/${encodeURIComponent(token)}`,
    { userId },
  ).then((response) => ({
    base64: String(response.base64 || ""),
    mimeType: String(response.mimeType || "image/jpeg"),
    fileName: String(response.fileName || "route_image.jpg"),
  }));
}

async function fetchTelegramMediaByToken(token: string, userId: string): Promise<{
  base64: string;
  mimeType: string;
  fileName: string;
}> {
  return callService<{
    ok?: boolean;
    base64?: string;
    mimeType?: string;
    fileName?: string;
  }>(
    TELEGRAM_MICROSERVICE_URL,
    `/api/telegram/media/${encodeURIComponent(token)}`,
    { userId },
  ).then((response) => ({
    base64: String(response.base64 || ""),
    mimeType: String(response.mimeType || "image/jpeg"),
    fileName: String(response.fileName || "route_image.jpg"),
  }));
}

async function scheduleWhatsAppMediaDeletion(token: string, userId: string, delayMs = 120_000): Promise<void> {
  if (!WHATSAPP_MICROSERVICE_URL || !token) return;
  try {
    await callService(
      WHATSAPP_MICROSERVICE_URL,
      `/api/media/${encodeURIComponent(token)}/schedule-delete`,
      {
        method: "POST",
        userId,
        body: { delayMs },
      },
    );
  } catch {
    // best effort cleanup
  }
}

async function scheduleTelegramMediaDeletion(token: string, userId: string, delayMs = 120_000): Promise<void> {
  if (!TELEGRAM_MICROSERVICE_URL || !token) return;
  try {
    await callService(
      TELEGRAM_MICROSERVICE_URL,
      `/api/telegram/media/${encodeURIComponent(token)}/schedule-delete`,
      {
        method: "POST",
        userId,
        body: { delayMs },
      },
    );
  } catch {
    // best effort cleanup
  }
}

async function resolveOutboundMedia(
  media: InboundMessageInput["media"],
  userId: string,
  destinationPlatform: "whatsapp" | "telegram",
): Promise<OutboundMediaPayload | null> {
  if (!media || media.kind !== "image") return null;

  // Prefer stable payload to avoid token lifecycle races during route fan-out.
  if (media.base64) {
    return {
      kind: "image",
      base64: media.base64,
      mimeType: media.mimeType || "image/jpeg",
      fileName: media.fileName || "route_image.jpg",
    };
  }

  // Fast path: WhatsApp -> WhatsApp can reuse media token directly in the same service.
  if (media.sourcePlatform === "whatsapp" && destinationPlatform === "whatsapp" && media.token) {
    return {
      kind: "image",
      token: media.token,
      mimeType: media.mimeType || "image/jpeg",
      fileName: media.fileName || "route_image.jpg",
    };
  }
  if (media.sourcePlatform === "telegram" && destinationPlatform === "telegram" && media.token) {
    return {
      kind: "image",
      token: media.token,
      mimeType: media.mimeType || "image/jpeg",
      fileName: media.fileName || "route_image.jpg",
    };
  }

  if (media.sourcePlatform === "whatsapp" && media.token && WHATSAPP_MICROSERVICE_URL) {
    const fetched = await fetchWhatsAppMediaByToken(media.token, userId);
    if (!fetched.base64) return null;
    return {
      kind: "image",
      base64: fetched.base64,
      mimeType: fetched.mimeType,
      fileName: fetched.fileName,
    };
  }
  if (media.sourcePlatform === "telegram" && media.token && TELEGRAM_MICROSERVICE_URL) {
    const fetched = await fetchTelegramMediaByToken(media.token, userId);
    if (!fetched.base64) return null;
    return {
      kind: "image",
      base64: fetched.base64,
      mimeType: fetched.mimeType,
      fileName: fetched.fileName,
    };
  }

  return null;
}

async function prepareRouteMediaForProcessing(
  media: InboundMessageInput["media"],
  userId: string,
): Promise<InboundMessageInput["media"]> {
  if (!media || media.kind !== "image") return media;
  if (!media.token) return media;

  if (media.sourcePlatform === "whatsapp") {
    // Keep source token alive while heavy route processing is in progress.
    await scheduleWhatsAppMediaDeletion(media.token, userId, ROUTE_MEDIA_PROCESSING_HOLD_MS);
  } else if (media.sourcePlatform === "telegram") {
    await scheduleTelegramMediaDeletion(media.token, userId, ROUTE_MEDIA_PROCESSING_HOLD_MS);
  }

  if (media.base64) return media;

  try {
    const fetched = media.sourcePlatform === "telegram"
      ? await fetchTelegramMediaByToken(media.token, userId)
      : await fetchWhatsAppMediaByToken(media.token, userId);
    if (!fetched.base64) return media;
    return {
      ...media,
      base64: fetched.base64,
      mimeType: media.mimeType || fetched.mimeType,
      fileName: media.fileName || fetched.fileName,
    };
  } catch {
    return media;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function normalizeErrorMessageForMatch(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function extractAutomationImageUrl(product: Record<string, unknown>): string {
  const candidates = [
    product.imageUrl,
    product.image_url,
    product.image,
    product.thumbnail,
    product.imageUri,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (/^https?:\/\//i.test(value)) return value;
  }

  return "";
}

async function buildAutomationImageMedia(product: Record<string, unknown>): Promise<OutboundMediaPayload> {
  const imageUrl = extractAutomationImageUrl(product);
  if (!imageUrl) {
    throw new Error("Envio cancelado: oferta sem imagem válida para anexo.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTO_IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Envio cancelado: falha ao baixar imagem da oferta (HTTP ${response.status}).`);
    }

    const mimeType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!mimeType.startsWith("image/")) {
      throw new Error("Envio cancelado: URL da oferta não retornou uma imagem válida.");
    }

    const sizeHeader = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(sizeHeader) && sizeHeader > AUTO_IMAGE_MAX_BYTES) {
      throw new Error("Envio cancelado: imagem excede o tamanho máximo permitido (8MB).");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      throw new Error("Envio cancelado: imagem da oferta está vazia.");
    }
    if (arrayBuffer.byteLength > AUTO_IMAGE_MAX_BYTES) {
      throw new Error("Envio cancelado: imagem excede o tamanho máximo permitido (8MB).");
    }

    return {
      kind: "image",
      base64: bytesToBase64(new Uint8Array(arrayBuffer)),
      mimeType,
      fileName: "automation_offer.jpg",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "falha ao anexar imagem";
    if (message.toLowerCase().includes("abort")) {
      throw new Error("Envio cancelado: tempo limite ao baixar imagem da oferta.");
    }
    throw new Error(message || "Envio cancelado: falha ao anexar imagem.");
  } finally {
    clearTimeout(timeout);
  }
}

async function getServiceHealth(baseUrl: string, healthPath = "/health") {
  try {
    const response = await callService<{
      ok?: boolean;
      uptimeSec?: number;
      sessions?: unknown[];
      service?: string;
      stats?: Record<string, unknown>;
    }>(baseUrl, healthPath);

    const uptimeRaw = Number(response.uptimeSec);
    return {
      online: response.ok === true,
      url: baseUrl,
      uptimeSec: Number.isFinite(uptimeRaw) ? uptimeRaw : null,
      sessions: Array.isArray(response.sessions) ? response.sessions : [],
      service: typeof response.service === "string" ? response.service : "",
      stats: response.stats && typeof response.stats === "object" ? response.stats : null,
      error: null as string | null,
    };
  } catch (error) {
    return {
      online: false,
      url: baseUrl,
      uptimeSec: null,
      sessions: [] as unknown[],
      service: "",
      stats: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isRecoverablePollingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = normalizeErrorMessageForMatch(message);
  return (
    normalized.includes("falha http 404") ||
    normalized.includes("sessao nao encontrada") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("connection refused")
  );
}

function isSessionNotFoundPollingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = normalizeErrorMessageForMatch(message);
  return normalized.includes("sessao nao encontrada") || normalized.includes("falha http 404");
}

const WHATSAPP_POLLABLE_STATUSES = new Set(["connecting", "qr_code", "pairing_code", "online", "warning"]);
const TELEGRAM_POLLABLE_STATUSES = new Set(["connecting", "awaiting_code", "awaiting_password", "online", "warning"]);
const CHANNEL_POLL_BACKOFF_UNTIL = new Map<string, number>();
const TELEGRAM_SYNC_LIMIT_BLOCKED = new Map<string, number>();

function inChannelPollBackoff(key: string) {
  const until = CHANNEL_POLL_BACKOFF_UNTIL.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    CHANNEL_POLL_BACKOFF_UNTIL.delete(key);
    return false;
  }
  return true;
}

function shopeeServiceConfigured() {
  return Boolean(SHOPEE_MICROSERVICE_URL);
}

function getShopeeCredentialPayload(credentials: Record<string, unknown>) {
  return {
    appId: String(credentials.app_id || ""),
    secret: String(credentials.secret_key || ""),
    region: String(credentials.region || "BR"),
  };
}

function purgeExpiredSoftDeletedGroups(db: ReturnType<typeof loadDb>, userId: string) {
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - THREE_DAYS_MS).toISOString();
  db.tables.groups = db.tables.groups.filter((row) => {
    if (row.user_id !== userId) return true;
    if (typeof row.deleted_at !== "string") return true;
    return row.deleted_at > cutoff; // keep if soft-deleted less than 3 days ago
  });
}

function resolvePlatformGroupLimitForUser(
  db: ReturnType<typeof loadDb>,
  userId: string,
  platform: "whatsapp" | "telegram",
): number {
  const profile = db.tables.profiles.find((row) => row.user_id === userId);
  const limits = resolveEffectiveOperationalLimitsByPlanId(String(profile?.plan_id || "plan-starter"));
  if (!limits) return 0;
  return platform === "whatsapp" ? limits.whatsappGroups : limits.telegramGroups;
}

function countActivePlatformGroups(
  db: ReturnType<typeof loadDb>,
  userId: string,
  platform: "whatsapp" | "telegram",
): number {
  return db.tables.groups.filter((row) =>
    row.user_id === userId
    && row.platform === platform
    && !row.deleted_at,
  ).length;
}

function upsertGroup(
  db: ReturnType<typeof loadDb>,
  input: {
    userId: string;
    platform: "whatsapp" | "telegram";
    sessionId: string;
    externalId: string;
    name: string;
    memberCount: number;
  },
) {
  // Purge groups that have been soft-deleted for more than 3 days before any lookup.
  purgeExpiredSoftDeletedGroups(db, input.userId);

  // 1. Exact match: same session + same externalId ? normal in-place update
  const exactMatch = db.tables.groups.find(
    (row) =>
      row.user_id === input.userId &&
      row.platform === input.platform &&
      row.session_id === input.sessionId &&
      row.external_id === input.externalId,
  );

  if (exactMatch) {
    exactMatch.name = input.name;
    exactMatch.member_count = input.memberCount;
    exactMatch.updated_at = nowIso();
    return exactMatch;
  }

  // 2. Cross-session match: same externalId but different session_id.
  //    Collect ALL records with this externalId across sessions, then pick the first one whose
  //    old session is no longer active (offline/deleted) and re-associate it to the current
  //    session.  This preserves the DB `id` so existing routes keep working.
  //    If every cross-session record still has an active session this is a genuine multi-session
  //    scenario - fall through and create a new entry.
  const ACTIVE_STATUSES = new Set(["online", "connecting", "qr_code", "pairing_code"]);
  const sessionTable =
    input.platform === "whatsapp" ? db.tables.whatsapp_sessions : db.tables.telegram_sessions;

  const crossMatches = db.tables.groups.filter(
    (row) =>
      row.user_id === input.userId &&
      row.platform === input.platform &&
      row.external_id === input.externalId,
  );

  const deadCrossMatch = crossMatches.find((match) => {
    const oldSession = sessionTable.find(
      (row) => row.id === match.session_id && row.user_id === input.userId,
    );
    return !oldSession || !ACTIVE_STATUSES.has(String(oldSession.status || ""));
  });

  if (deadCrossMatch) {
    // Re-associate to the new/current session - preserves the DB `id` so all routes survive.
    // Clear deleted_at so the group reappears in the UI.
    deadCrossMatch.session_id = input.sessionId;
    deadCrossMatch.deleted_at = null;
    deadCrossMatch.name = input.name;
    deadCrossMatch.member_count = input.memberCount;
    deadCrossMatch.updated_at = nowIso();
    return deadCrossMatch;
  }

  if (crossMatches.length > 0) {
    // All existing records have active sessions ? this is a genuine multi-session entry
    // Fall through to create a new record below.
  }

  const platformGroupLimit = resolvePlatformGroupLimitForUser(db, input.userId, input.platform);
  const activeGroupCount = countActivePlatformGroups(db, input.userId, input.platform);
  if (platformGroupLimit !== -1 && activeGroupCount >= platformGroupLimit) {
    return null;
  }

  const row = {
    id: randomId("grp"),
    user_id: input.userId,
    name: input.name,
    platform: input.platform,
    member_count: input.memberCount,
    session_id: input.sessionId,
    external_id: input.externalId,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  db.tables.groups.push(row);
  return row;
}

function appendInboundHistory(
  db: ReturnType<typeof loadDb>,
  input: {
    userId: string;
    source: string;
    destination: string;
    message: string;
    platform: "whatsapp" | "telegram";
  },
) {
  db.tables.history_entries.push({
    id: randomId("hist"),
    user_id: input.userId,
    type: "session_event",
    source: input.source,
    destination: input.destination,
    status: "info",
    details: { message: input.message, platform: input.platform },
    direction: "inbound",
    message_type: "text",
    processing_status: "received",
    block_reason: "",
    error_step: "",
    created_at: nowIso(),
  });
}

function appendOutboundHistory(
  db: ReturnType<typeof loadDb>,
  input: {
    userId: string;
    source: string;
    destination: string;
    message: string;
    platform: "whatsapp" | "telegram";
  },
) {
  db.tables.history_entries.push({
    id: randomId("hist"),
    user_id: input.userId,
    type: "message_sent",
    source: input.source,
    destination: input.destination,
    status: "success",
    details: { message: input.message, platform: input.platform },
    direction: "outbound",
    message_type: "text",
    processing_status: "sent",
    block_reason: "",
    error_step: "",
    created_at: nowIso(),
  });
}

function appendLinkConvertedHistory(
  db: ReturnType<typeof loadDb>,
  input: {
    userId: string;
    source: string;
    originalLink: string;
    affiliateLink: string;
    resolvedLink?: string;
    status?: "success" | "error";
    error?: string;
  },
) {
  db.tables.history_entries.push({
    id: randomId("hist"),
    user_id: input.userId,
    type: "link_converted",
    source: input.source,
    destination: "Shopee",
    status: input.status || "success",
    details: {
      originalLink: input.originalLink,
      affiliateLink: input.affiliateLink,
      resolvedLink: input.resolvedLink || "",
      error: input.error || "",
    },
    direction: "system",
    message_type: "text",
    processing_status: input.status === "error" ? "failed" : "sent",
    block_reason: input.error || "",
    error_step: input.status === "error" ? "conversion" : "",
    created_at: nowIso(),
  });
}

function buildSourceExternalIdCandidates(rawValue: string): string[] {
  const base = String(rawValue || "").trim();
  if (!base) return [];

  const candidates = new Set<string>([base]);
  const unsigned = base.replace(/^-/, "");
  const numeric = /^\d+$/.test(unsigned);

  if (base.startsWith("-100") && /^\d+$/.test(base.slice(4))) {
    candidates.add(`-${base.slice(4)}`);
    candidates.add(base.slice(4));
  }
  if (base.startsWith("-") && numeric) {
    candidates.add(unsigned);
    candidates.add(`-100${unsigned}`);
  }
  if (numeric) {
    candidates.add(`-${unsigned}`);
    candidates.add(`-100${unsigned}`);
  }

  return [...candidates];
}

async function processInboundMessageForRoutes(input: InboundMessageInput): Promise<RouteProcessResult> {
  const snapshot = loadDb();
  const capturedAt = nowIso();
  const routeMedia = await prepareRouteMediaForProcessing(input.media, input.userId);
  const scheduleInboundMediaCleanup = async (): Promise<void> => {
    if (!routeMedia?.token) return;
    if (routeMedia.sourcePlatform === "whatsapp") {
      await scheduleWhatsAppMediaDeletion(routeMedia.token, input.userId, 120_000);
    } else if (routeMedia.sourcePlatform === "telegram") {
      await scheduleTelegramMediaDeletion(routeMedia.token, input.userId, 120_000);
    }
  };
  const sourceExternalCandidates = new Set(buildSourceExternalIdCandidates(input.sourceExternalId));
  const sourceGroup = snapshot.tables.groups.find(
    (row) =>
      row.user_id === input.userId &&
      row.platform === input.platform &&
      String(row.session_id || "") === input.sessionId &&
      sourceExternalCandidates.has(String(row.external_id || "")),
  ) || snapshot.tables.groups.find(
    (row) =>
      row.user_id === input.userId &&
      row.platform === input.platform &&
      String(row.session_id || "") === input.sessionId &&
      String(row.name || "") === input.sourceName,
  ) || snapshot.tables.groups.find(
    (row) =>
      row.user_id === input.userId &&
      row.platform === input.platform &&
      sourceExternalCandidates.has(String(row.external_id || "")),
  );

  if (!sourceGroup) {
    withDb((db) => {
      appendRouteHistory(db, {
        userId: input.userId,
        source: input.from || input.sourceName || "Origem",
        destination: "Roteador",
        status: "info",
        message: input.message,
        processingStatus: "blocked",
        blockReason: "source_group_not_found",
        capturedAt,
        messageData: {
          sourceExternalId: input.sourceExternalId,
          sourceName: input.sourceName,
          from: input.from,
          platform: input.platform,
          sessionId: input.sessionId,
        },
        routeId: "unmatched",
        routeName: "Nenhuma rota correspondente",
        originPlatform: input.platform,
      });
    });
    await scheduleInboundMediaCleanup();
    return { routesMatched: 0, processed: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const sourceExternalCandidateSet = sourceExternalCandidates;
  const routeSourceExternalById = new Map<string, string>();
  for (const group of snapshot.tables.groups) {
    if (group.user_id !== input.userId) continue;
    routeSourceExternalById.set(String(group.id || ""), String(group.external_id || "").trim());
  }

  const allConfiguredRoutes = snapshot.tables.routes.filter((row) => {
    if (row.user_id !== input.userId) return false;
    if (row.source_group_id === sourceGroup.id) return true;

    const routeSourceExternalId = routeSourceExternalById.get(String(row.source_group_id || "")) || "";
    if (!routeSourceExternalId) return false;

    const routeSourceExternalCandidates = buildSourceExternalIdCandidates(routeSourceExternalId);
    return routeSourceExternalCandidates.some((candidate) => sourceExternalCandidateSet.has(candidate));
  });

  const routes = allConfiguredRoutes.filter((row) => row.status === "active");

  if (routes.length === 0) {
    const hasInactiveRoutes = allConfiguredRoutes.length > 0;
    const inactiveRouteNames = allConfiguredRoutes
      .map((r) => String(r.name || r.id || "").trim())
      .filter(Boolean);
    withDb((db) => {
      appendRouteHistory(db, {
        userId: input.userId,
        source: String(sourceGroup.name || input.sourceName || "Origem"),
        destination: "Roteador",
        status: "info",
        message: input.message,
        processingStatus: "blocked",
        blockReason: hasInactiveRoutes ? "all_routes_inactive" : "no_routes_configured",
        capturedAt,
        messageData: {
          sourceExternalId: input.sourceExternalId,
          sourceName: input.sourceName,
          from: input.from,
          platform: input.platform,
          sessionId: input.sessionId,
          ...(hasInactiveRoutes && inactiveRouteNames.length > 0 ? { inactiveRouteNames } : {}),
        },
        routeId: "none",
        routeName: hasInactiveRoutes
          ? `Rota inativa: ${inactiveRouteNames.join(", ")}`
          : "Sem rota configurada",
        originPlatform: input.platform,
      });
    });
    await scheduleInboundMediaCleanup();
    return { routesMatched: 0, processed: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const shopeeCredentials = getShopeeCredentialsForUser(snapshot, input.userId);
  const shopeeConversionCache = new Map<string, ShopeeLinkConversionResult>();
  const meliConversionCache = new Map<string, string>();

  let processed = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const route of routes) {
    const rules = route.rules && typeof route.rules === "object" && !Array.isArray(route.rules)
      ? (route.rules as Record<string, unknown>)
      : {};
    const routeName = String(route.name || "Rota");
    const sourceName = String(sourceGroup.name || input.sourceName || "Origem");

    const negativeKeywords = toKeywordList(rules.negativeKeywords);
    if (textMatchesAnyKeyword(input.message, negativeKeywords)) {
      skipped += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: input.message,
          processingStatus: "blocked",
          blockReason: "negative_keyword",
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
        });
      });
      continue;
    }

    const positiveKeywords = toKeywordList(rules.positiveKeywords);
    if (positiveKeywords.length > 0 && !textMatchesAnyKeyword(input.message, positiveKeywords)) {
      skipped += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: input.message,
          processingStatus: "blocked",
          blockReason: "positive_keyword_missing",
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
        });
      });
      continue;
    }

    const originalLinks = extractLinks(input.message);
    const shouldResolveBeforeValidate = rules.resolvePartnerLinks !== false;
    const partnerMarketplaces = normalizeMarketplaceList(rules.partnerMarketplaces);
    const enabledPartnerMarketplaces = partnerMarketplaces.filter((marketplace) =>
      isMarketplaceConversionEnabled(rules, marketplace),
    );
    const requirePartnerLink = rules.requirePartnerLink !== false;
    const shouldResolveUnknownLinks = requirePartnerLink ? true : shouldResolveBeforeValidate;
    const inspectedLinks: Array<{
      original: string;
      resolved: string;
      originalMarketplace: string | null;
      resolvedMarketplace: string | null;
      partnerMarketplace: string | null;
    }> = [];

    for (const originalLink of originalLinks) {
      const original = String(originalLink || "").trim();
      if (!original) continue;

      const originalMarketplace = detectPartnerMarketplace(original);
      let resolved = original;
      let resolvedMarketplace = originalMarketplace;

      if (originalMarketplace && enabledPartnerMarketplaces.includes(originalMarketplace)) {
        inspectedLinks.push({
          original,
          resolved,
          originalMarketplace,
          resolvedMarketplace,
          partnerMarketplace: originalMarketplace,
        });
        continue;
      }

      if (!originalMarketplace && shouldResolveUnknownLinks) {
        resolved = await resolveLinkWithRedirect(original);
        resolvedMarketplace = detectPartnerMarketplace(resolved);
      }

      const partnerMarketplace = resolvedMarketplace && enabledPartnerMarketplaces.includes(resolvedMarketplace)
        ? resolvedMarketplace
        : null;

      inspectedLinks.push({
        original,
        resolved,
        originalMarketplace,
        resolvedMarketplace,
        partnerMarketplace,
      });
    }

    const disallowedMarketplaceLink = inspectedLinks.find((item) => {
      const detected = item.originalMarketplace || item.resolvedMarketplace;
      return Boolean(detected && !enabledPartnerMarketplaces.includes(detected));
    });
    if (disallowedMarketplaceLink) {
      skipped += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: input.message,
          processingStatus: "blocked",
          blockReason: "marketplace_not_enabled",
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
          messageData: {
            marketplace: disallowedMarketplaceLink.originalMarketplace || disallowedMarketplaceLink.resolvedMarketplace || "unknown",
            allowedMarketplaces: enabledPartnerMarketplaces,
            configuredMarketplaces: partnerMarketplaces,
          },
        });
      });
      continue;
    }

    const partnerLinks = inspectedLinks.filter((item) => Boolean(item.partnerMarketplace));

    const hasPartnerLink = partnerLinks.length > 0;
    if (requirePartnerLink && !hasPartnerLink) {
      skipped += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: input.message,
          processingStatus: "blocked",
          blockReason: "partner_link_required",
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
          messageData: {
            allowedMarketplaces: enabledPartnerMarketplaces,
            configuredMarketplaces: partnerMarketplaces,
          },
        });
      });
      continue;
    }

    processed += 1;

    let finalMessage = input.message;
    let primaryLink = partnerLinks[0]?.resolved || partnerLinks[0]?.original || originalLinks[0] || "";
    let primaryProduct: Partial<ShopeeProduct> | null = null;
    let convertedShopee = false;
    let conversionFailure: { reason: string; error: string } | null = null;
    let linksEligibleForConversion = 0;
    let convertedLinks = 0;

    for (const inspectedLink of partnerLinks) {
      const marketplace = String(inspectedLink.partnerMarketplace || "");
      if (!marketplace) continue;

      if (marketplace === "shopee") {
        linksEligibleForConversion += 1;
        const original = inspectedLink.original;
        const resolved = inspectedLink.resolved || original;
        const conversionSource = inspectedLink.resolvedMarketplace === "shopee" ? resolved : original;
        const cacheKey = conversionSource || original;
        let conversion = shopeeConversionCache.get(cacheKey);
        if (!conversion) {
          conversion = await convertShopeeLinkForUser({
            url: conversionSource,
            userId: input.userId,
            credentials: shopeeCredentials,
            resolveRedirect: false,
          });
          shopeeConversionCache.set(cacheKey, conversion);
        }

        const affiliateLink = conversion.affiliateLink || convertShopeeAffiliateLink(resolved || original, input.userId);
        if (!affiliateLink) {
          conversionFailure = { reason: "shopee_conversion_failed", error: "Falha ao converter link Shopee." };
          break;
        }

        if (!convertedShopee) {
          primaryLink = affiliateLink;
          convertedShopee = true;
        }
        if (!primaryProduct && conversion.product && typeof conversion.product === "object") {
          primaryProduct = conversion.product as Partial<ShopeeProduct>;
        }

        if (affiliateLink !== original || (resolved && affiliateLink !== resolved)) {
          withDb((db) => {
            appendLinkConvertedHistory(db, {
              userId: input.userId,
              source: `route:${routeName}`,
              originalLink: original,
              affiliateLink,
              resolvedLink: conversion?.resolvedLink || resolved,
            });
          });
        }

        if (original) {
          finalMessage = finalMessage.split(original).join(affiliateLink);
        }
        if (resolved && resolved !== original) {
          finalMessage = finalMessage.split(resolved).join(affiliateLink);
        }

        convertedLinks += 1;
        continue;
      }

      if (marketplace === "mercadolivre") {
        linksEligibleForConversion += 1;
        const original = inspectedLink.original;
        const resolved = inspectedLink.resolved || original;
        const configuredMeliSessionId = typeof rules.meliSessionId === "string" ? rules.meliSessionId : "";
        const meliSessionId = resolveRouteMeliSessionId(snapshot, input.userId, configuredMeliSessionId);
        if (!meliSessionId) {
          conversionFailure = { reason: "meli_session_missing", error: "Sessão Mercado Livre não configurada para a rota." };
          break;
        }

        const conversionSource = inspectedLink.resolvedMarketplace === "mercadolivre" ? resolved : original;
        const cacheKey = `${meliSessionId}::${conversionSource}`;
        let affiliateLink = meliConversionCache.get(cacheKey);
        if (!affiliateLink) {
          try {
            const convResult = await convertMercadoLivreLinkForUser({
              userId: input.userId,
              sessionId: meliSessionId,
              url: conversionSource,
            });
            affiliateLink = convResult.affiliateLink || "";
            if (affiliateLink) {
              meliConversionCache.set(cacheKey, affiliateLink);
            }
          } catch (error) {
            conversionFailure = {
              reason: "meli_conversion_failed",
              error: error instanceof Error ? error.message : "Falha ao converter link Mercado Livre.",
            };
            break;
          }
        }

        if (!affiliateLink) {
          conversionFailure = { reason: "meli_conversion_failed", error: "Falha ao converter link Mercado Livre." };
          break;
        }

        primaryLink = affiliateLink;
        withDb((db) => {
          appendLinkConvertedHistory(db, {
            userId: input.userId,
            source: `route:${routeName}`,
            originalLink: original,
            affiliateLink,
            resolvedLink: resolved,
          });
        });
        finalMessage = finalMessage.split(original).join(affiliateLink);
        if (resolved !== original) finalMessage = finalMessage.split(resolved).join(affiliateLink);
        convertedLinks += 1;
      }
    }

    if (conversionFailure) {
      skipped += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: input.message,
          processingStatus: "blocked",
          blockReason: conversionFailure.reason,
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
          messageData: {
            reason: conversionFailure.reason,
            error: conversionFailure.error,
          },
        });
      });
      continue;
    }

    if (linksEligibleForConversion > 0 && convertedLinks === 0) {
      skipped += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: input.message,
          processingStatus: "blocked",
          blockReason: "conversion_required",
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
          messageData: {
            reason: "conversion_required",
          },
        });
      });
      continue;
    }

    const rawTemplateId = typeof rules.templateId === "string" ? rules.templateId : "";
    const templateId = rawTemplateId && rawTemplateId !== "none" && rawTemplateId !== "original" ? rawTemplateId : "";
    if (templateId) {
      const template = snapshot.tables.templates.find(
        (row) => row.user_id === input.userId && String(row.id) === templateId,
      );

      if (template && typeof template.content === "string") {
        const placeholderData = buildTemplatePlaceholderData(primaryProduct, primaryLink);
        finalMessage = applyPlaceholders(template.content, placeholderData);
      }
    }

    const directDestinationIds = snapshot.tables.route_destinations
      .filter((row) => row.route_id === route.id)
      .map((row) => String(row.group_id));

    const masterGroupIds: string[] = [];
    if (typeof rules.masterGroupId === "string" && rules.masterGroupId) {
      masterGroupIds.push(rules.masterGroupId);
    }
    if (Array.isArray(rules.masterGroupIds)) {
      for (const item of rules.masterGroupIds) {
        if (typeof item === "string" && item.trim()) {
          masterGroupIds.push(item.trim());
        }
      }
    }

    const linkedDestinationIds = snapshot.tables.master_group_links
      .filter((row) => masterGroupIds.includes(String(row.master_group_id)) && row.is_active !== false)
      .map((row) => String(row.group_id));

    let destinationGroupIds = [...new Set([...directDestinationIds, ...linkedDestinationIds])]
      .filter((groupId) => groupId !== String(sourceGroup.id));

    const destinationSessionId = typeof rules.sessionId === "string" ? rules.sessionId : "";
    if (destinationSessionId) {
      destinationGroupIds = destinationGroupIds.filter((groupId) =>
        snapshot.tables.groups.some(
          (group) => group.id === groupId && group.user_id === input.userId && String(group.session_id || "") === destinationSessionId,
        ),
      );
    }

    if (destinationGroupIds.length === 0) {
      skipped += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: finalMessage,
          processingStatus: "blocked",
          blockReason: "no_destination_groups",
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
        });
      });
      continue;
    }

    let routeSentCount = 0;

    // Auto-download product image when no media is attached
    let effectiveMedia = routeMedia;
    if (!effectiveMedia) {
      const productImageUrl = primaryProduct?.imageUrl ? String(primaryProduct.imageUrl).trim() : "";
      if (productImageUrl && productImageUrl.startsWith("http")) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          try {
            const response = await fetch(productImageUrl, { method: "GET", redirect: "follow", signal: controller.signal });
            if (response.ok) {
              const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
              if (mimeType.startsWith("image/") && !mimeType.includes("svg")) {
                const buffer = Buffer.from(await response.arrayBuffer());
                if (buffer.length > 0 && buffer.length <= 8 * 1024 * 1024) {
                  effectiveMedia = {
                    kind: "image",
                    base64: buffer.toString("base64"),
                    mimeType: mimeType || "image/jpeg",
                    sourcePlatform: "auto",
                  } as RouteForwardMediaInput;
                }
              }
            }
          } finally {
            clearTimeout(timeout);
          }
        } catch { /* ignore auto-image failures */ }
      }
    }
    if (!effectiveMedia) {
      failed += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: finalMessage,
          processingStatus: "blocked",
          blockReason: "missing_image_required",
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
          messageData: {
            reason: "missing_image_required",
            hasMedia: false,
          },
        });
      });
      continue;
    }
    if (!String(finalMessage || "").trim()) {
      failed += 1;
      withDb((db) => {
        appendRouteHistory(db, {
          userId: input.userId,
          source: sourceName,
          destination: routeName,
          status: "info",
          message: finalMessage,
          processingStatus: "blocked",
          blockReason: "missing_text_required",
          routeId: String(route.id),
          routeName,
          originPlatform: input.platform,
          messageData: {
            reason: "missing_text_required",
            hasMedia: true,
          },
        });
      });
      continue;
    }

    const routeHasMedia = Boolean(effectiveMedia && effectiveMedia.kind === "image");

    for (const destinationId of destinationGroupIds) {
      const destinationGroup = snapshot.tables.groups.find(
        (row) => row.id === destinationId && row.user_id === input.userId,
      );

      if (!destinationGroup) {
        failed += 1;
        withDb((db) => {
          appendRouteHistory(db, {
            userId: input.userId,
            source: sourceName,
            destination: destinationId,
            status: "error",
            message: finalMessage,
            processingStatus: "failed",
            blockReason: "destination_not_found",
            routeId: String(route.id),
            routeName,
            originPlatform: input.platform,
          });
        });
        continue;
      }

      const destinationPlatform = String(destinationGroup.platform || "");
      const destinationPlatformTyped = destinationPlatform === "telegram" ? "telegram" : "whatsapp";
      const destinationSessionId = String(destinationGroup.session_id || "");
      const destinationSessionOnline = destinationPlatform === "whatsapp"
        ? snapshot.tables.whatsapp_sessions.some(
          (row) =>
            row.user_id === input.userId &&
            String(row.id || "") === destinationSessionId &&
            String(row.status || "") === "online",
        )
        : destinationPlatform === "telegram"
          ? snapshot.tables.telegram_sessions.some(
            (row) =>
              row.user_id === input.userId &&
              String(row.id || "") === destinationSessionId &&
              String(row.status || "") === "online",
          )
          : false;

      if (!destinationSessionOnline) {
        failed += 1;
        withDb((db) => {
          appendRouteHistory(db, {
            userId: input.userId,
            source: sourceName,
            destination: String(destinationGroup.name || destinationGroup.id),
            status: "error",
            message: finalMessage,
            processingStatus: "failed",
            blockReason: "destination_session_offline",
            routeId: String(route.id),
            routeName,
            originPlatform: input.platform,
          });
        });
        continue;
      }

      try {
        const outboundMedia = routeHasMedia
          ? await resolveOutboundMedia(effectiveMedia, input.userId, destinationPlatformTyped)
          : null;
        if (!outboundMedia) {
          throw new Error("Envio cancelado: não foi possível preparar o anexo de imagem da mensagem.");
        }
        if (!String(finalMessage || "").trim()) {
          throw new Error("Envio cancelado: a mensagem de texto está vazia.");
        }
        await sendMessageToGroup(input.userId, destinationGroup, finalMessage, outboundMedia);
        sent += 1;
        routeSentCount += 1;
        withDb((db) => {
          appendRouteHistory(db, {
            userId: input.userId,
            source: sourceName,
            destination: String(destinationGroup.name || destinationGroup.id),
            status: "success",
            message: finalMessage,
            processingStatus: "sent",
            routeId: String(route.id),
            routeName,
            originPlatform: input.platform,
          });
        });
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        withDb((db) => {
          appendRouteHistory(db, {
            userId: input.userId,
            source: sourceName,
            destination: String(destinationGroup.name || destinationGroup.id),
            status: "error",
            message: finalMessage,
            processingStatus: "failed",
            blockReason: reason,
            routeId: String(route.id),
            routeName,
            originPlatform: input.platform,
          });
        });
      }
    }

    if (routeSentCount > 0) {
      withDb((db) => {
        incrementRouteMessagesForwarded(db, String(route.id), input.userId, routeSentCount);
      });
    }

  }

  await scheduleInboundMediaCleanup();
  return {
    routesMatched: routes.length,
    processed,
    sent,
    skipped,
    failed,
  };
}

function normalizeWhatsAppStatus(status: unknown) {
  const value = String(status || "").trim();
  if (value === "online") return "online";
  if (value === "connecting") return "connecting";
  if (value === "qr_code") return "qr_code";
  if (value === "pairing_code") return "pairing_code";
  return "offline";
}

function normalizeTelegramStatus(status: unknown) {
  const value = String(status || "").trim();
  if (value === "online") return "online";
  if (value === "connecting") return "connecting";
  if (value === "awaiting_code") return "awaiting_code";
  if (value === "awaiting_password") return "awaiting_password";
  return "offline";
}

function applyWhatsAppEvents(
  db: ReturnType<typeof loadDb>,
  userId: string,
  sessionId: string,
  events: IntegrationEvent[],
): InboundMessageInput[] {
  const session = db.tables.whatsapp_sessions.find((row) => row.id === sessionId && row.user_id === userId);
  if (!session) return [];
  const inboundMessages: InboundMessageInput[] = [];

  for (const raw of events) {
    const event = String(raw.event || "");
    const data = raw.data && typeof raw.data === "object" ? raw.data : {};

    if (event === "connection_update") {
      const status = normalizeWhatsAppStatus(data.status);
      session.status = status;
      session.connected_at = status === "online" ? nowIso() : null;
      session.error_message = String(data.errorMessage || data.error_message || "");

      if (status === "qr_code") {
        session.qr_code = String(data.qrCode || "");
      } else if (status === "pairing_code") {
        session.qr_code = String(data.pairingCode || "");
      } else {
        session.qr_code = "";
      }

      if (data.phone && typeof data.phone === "string") {
        session.phone = data.phone;
      }

      continue;
    }

    if (event === "groups_sync") {
      const groups = Array.isArray(data.groups) ? (data.groups as Array<Record<string, unknown>>) : [];
      let blockedGroups = 0;
      for (const group of groups) {
        const persisted = upsertGroup(db, {
          userId,
          platform: "whatsapp",
          sessionId,
          externalId: String(group.id || ""),
          name: String(group.name || group.id || "Grupo"),
          memberCount: Number(group.memberCount || 0),
        });
        if (!persisted) blockedGroups += 1;
      }

      if (blockedGroups > 0) {
        const maxGroups = resolvePlatformGroupLimitForUser(db, userId, "whatsapp");
        session.error_message = `Limite de grupos WhatsApp excedido. Plano permite ${maxGroups === -1 ? "ilimitado" : maxGroups}.`;
        session.updated_at = nowIso();
      }
      continue;
    }

    if (event === "group_name_update") {
      const externalId = String(data.id || "");
      const newName = String(data.name || "");
      if (externalId && newName) {
        const group = db.tables.groups.find(
          (row) => row.user_id === userId && row.platform === "whatsapp" && row.external_id === externalId && !row.deleted_at,
        );
        if (group) {
          group.name = newName;
          group.updated_at = nowIso();
        }
      }
      continue;
    }

    if (event === "message_received") {
      const groupExternalId = String(data.groupId || "");
      const groupName = String(data.groupName || data.groupId || "Grupo");
      const message = String(data.message || "");
      const from = String(data.from || "WhatsApp");
      const fromMe = data.fromMe === true || data.from_me === true;
      const mediaRaw = data.media && typeof data.media === "object"
        ? (data.media as Record<string, unknown>)
        : null;
      const media = mediaRaw && String(mediaRaw.kind || "") === "image"
        ? {
          kind: "image" as const,
          sourcePlatform: "whatsapp" as const,
          token: typeof mediaRaw.token === "string" ? mediaRaw.token : undefined,
          base64: typeof mediaRaw.base64 === "string" ? mediaRaw.base64 : undefined,
          mimeType: typeof mediaRaw.mimeType === "string" ? mediaRaw.mimeType : undefined,
          fileName: typeof mediaRaw.fileName === "string" ? mediaRaw.fileName : undefined,
        }
        : null;
      const mediaKindHint = String(data.mediaKind || data.media_kind || "").trim().toLowerCase();
      const hasMediaHint = data.hasMedia === true || data.has_media === true || Boolean(mediaKindHint) || Boolean(media);
      if (fromMe) {
        appendInboundHistory(db, {
          userId,
          source: from,
          destination: groupName,
          message,
          platform: "whatsapp",
        });
        db.tables.history_entries.push({
          id: randomId("hist"),
          user_id: userId,
          type: "route_forward",
          source: groupName,
          destination: "-",
          status: "info",
          details: {
            message,
            reason: "from_me_ignored",
            sourceExternalId: groupExternalId,
            sessionId,
            platform: "whatsapp",
          },
          direction: "inbound",
          message_type: "text",
          processing_status: "blocked",
          block_reason: "from_me_ignored",
          error_step: "route_filter",
          created_at: nowIso(),
        });
        continue;
      }
      if (!message && !media && hasMediaHint) {
        appendInboundHistory(db, {
          userId,
          source: from,
          destination: groupName,
          message: `[midia ${mediaKindHint || "desconhecida"} recebida]`,
          platform: "whatsapp",
        });
        db.tables.history_entries.push({
          id: randomId("hist"),
          user_id: userId,
          type: "route_forward",
          source: groupName,
          destination: "-",
          status: "warning",
          details: {
            message: "",
            reason: "unsupported_media_type",
            mediaKind: mediaKindHint || "unknown",
            sourceExternalId: groupExternalId,
            sessionId,
            platform: "whatsapp",
          },
          direction: "inbound",
          message_type: "text",
          processing_status: "blocked",
          block_reason: "unsupported_media_type",
          error_step: "media_ingestion",
          created_at: nowIso(),
        });
        continue;
      }
      appendInboundHistory(db, {
        userId,
        source: from,
        destination: groupName,
        message,
        platform: "whatsapp",
      });
      inboundMessages.push({
        userId,
        platform: "whatsapp",
        sessionId,
        sourceExternalId: groupExternalId,
        sourceName: groupName,
        from,
        message,
        media,
      });
      continue;
    }

    if (event === "message_sent") {
      appendOutboundHistory(db, {
        userId,
        source: "WhatsApp",
        destination: String(data.groupName || data.to || "Destino"),
        message: String(data.message || "Mensagem enviada"),
        platform: "whatsapp",
      });
    }
  }

  return inboundMessages;
}

function applyTelegramEvents(
  db: ReturnType<typeof loadDb>,
  userId: string,
  sessionId: string,
  events: IntegrationEvent[],
): InboundMessageInput[] {
  const session = db.tables.telegram_sessions.find((row) => row.id === sessionId && row.user_id === userId);
  if (!session) return [];
  const inboundMessages: InboundMessageInput[] = [];

  for (const raw of events) {
    const event = String(raw.event || "");
    const data = raw.data && typeof raw.data === "object" ? raw.data : {};

    if (event === "connection_update") {
      const status = normalizeTelegramStatus(data.status);
      session.status = status;
      session.connected_at = status === "online" ? nowIso() : null;
      session.error_message = String(data.errorMessage || data.error_message || "");
      if (typeof data.session_string === "string" && data.session_string) {
        session.session_string = data.session_string;
      }
      if (typeof data.phone === "string" && data.phone) {
        session.phone = data.phone;
      }
      continue;
    }

    if (event === "groups_sync") {
      const groups = Array.isArray(data.groups) ? (data.groups as Array<Record<string, unknown>>) : [];
      let blockedGroups = 0;
      for (const group of groups) {
        const persisted = upsertGroup(db, {
          userId,
          platform: "telegram",
          sessionId,
          externalId: String(group.id || ""),
          name: String(group.name || group.id || "Grupo"),
          memberCount: Number(group.memberCount || 0),
        });
        if (!persisted) blockedGroups += 1;
      }

      if (blockedGroups > 0) {
        const maxGroups = resolvePlatformGroupLimitForUser(db, userId, "telegram");
        session.error_message = `Limite de grupos Telegram excedido. Plano permite ${maxGroups === -1 ? "ilimitado" : maxGroups}.`;
        session.updated_at = nowIso();
      }

      TELEGRAM_SYNC_LIMIT_BLOCKED.set(`${userId}:${sessionId}`, blockedGroups);
      continue;
    }

    if (event === "group_name_update") {
      const externalId = String(data.id || "");
      const newName = String(data.name || "");
      if (externalId && newName) {
        const group = db.tables.groups.find(
          (row) => row.user_id === userId && row.platform === "telegram" && row.external_id === externalId && !row.deleted_at,
        );
        if (group) {
          group.name = newName;
          group.updated_at = nowIso();
        }
      }
      continue;
    }

    if (event === "message_received") {
      const groupExternalId = String(data.groupId || "");
      const groupName = String(data.groupName || data.groupId || "Grupo");
      const message = String(data.message || "");
      const from = String(data.from || "Telegram");
      const fromMe = data.fromMe === true || data.from_me === true;
      const mediaRaw = data.media && typeof data.media === "object"
        ? (data.media as Record<string, unknown>)
        : null;
      const media = mediaRaw && String(mediaRaw.kind || "") === "image"
        ? {
          kind: "image" as const,
          sourcePlatform: "telegram" as const,
          token: typeof mediaRaw.token === "string" ? mediaRaw.token : undefined,
          base64: typeof mediaRaw.base64 === "string" ? mediaRaw.base64 : undefined,
          mimeType: typeof mediaRaw.mimeType === "string" ? mediaRaw.mimeType : undefined,
          fileName: typeof mediaRaw.fileName === "string" ? mediaRaw.fileName : undefined,
        }
        : null;
      const mediaKindHint = String(data.mediaKind || data.media_kind || "").trim().toLowerCase();
      const hasMediaHint = data.hasMedia === true || data.has_media === true || Boolean(mediaKindHint) || Boolean(media);
      if (fromMe) {
        appendInboundHistory(db, {
          userId,
          source: from,
          destination: groupName,
          message,
          platform: "telegram",
        });
        db.tables.history_entries.push({
          id: randomId("hist"),
          user_id: userId,
          type: "route_forward",
          source: groupName,
          destination: "-",
          status: "info",
          details: {
            message,
            reason: "from_me_ignored",
            sourceExternalId: groupExternalId,
            sessionId,
            platform: "telegram",
          },
          direction: "inbound",
          message_type: "text",
          processing_status: "blocked",
          block_reason: "from_me_ignored",
          error_step: "route_filter",
          created_at: nowIso(),
        });
        continue;
      }
      if (!message && !media && hasMediaHint) {
        appendInboundHistory(db, {
          userId,
          source: from,
          destination: groupName,
          message: `[midia ${mediaKindHint || "desconhecida"} recebida]`,
          platform: "telegram",
        });
        db.tables.history_entries.push({
          id: randomId("hist"),
          user_id: userId,
          type: "route_forward",
          source: groupName,
          destination: "-",
          status: "warning",
          details: {
            message: "",
            reason: "unsupported_media_type",
            mediaKind: mediaKindHint || "unknown",
            sourceExternalId: groupExternalId,
            sessionId,
            platform: "telegram",
          },
          direction: "inbound",
          message_type: "text",
          processing_status: "blocked",
          block_reason: "unsupported_media_type",
          error_step: "media_ingestion",
          created_at: nowIso(),
        });
        continue;
      }
      appendInboundHistory(db, {
        userId,
        source: from,
        destination: groupName,
        message,
        platform: "telegram",
      });
      inboundMessages.push({
        userId,
        platform: "telegram",
        sessionId,
        sourceExternalId: groupExternalId,
        sourceName: groupName,
        from,
        message,
        media,
      });
      continue;
    }

    if (event === "message_sent") {
      appendOutboundHistory(db, {
        userId,
        source: "Telegram",
        destination: String(data.groupName || data.to || "Destino"),
        message: String(data.message || "Mensagem enviada"),
        platform: "telegram",
      });
    }
  }

  return inboundMessages;
}

async function pollWhatsappEventsForSession(userId: string, sessionId: string) {
  const backoffKey = `wa:${userId}:${sessionId}`;
  if (inChannelPollBackoff(backoffKey)) return 0;

  let data: { events?: IntegrationEvent[] };
  try {
    data = await callService<{ events?: IntegrationEvent[] }>(
      WHATSAPP_MICROSERVICE_URL,
      `/api/sessions/${encodeURIComponent(sessionId)}/events`,
      { userId },
    );
  } catch (error) {
    if (isRecoverablePollingError(error)) {
      withDb((db) => {
        const row = db.tables.whatsapp_sessions.find(
          (item) => item.id === sessionId && item.user_id === userId,
        );
        if (!row) return;

        const notFound = isSessionNotFoundPollingError(error);
        row.status = notFound ? "offline" : "warning";
        row.connected_at = null;
        if (notFound) {
          CHANNEL_POLL_BACKOFF_UNTIL.delete(backoffKey);
          row.qr_code = "";
          row.error_message = "Sessão não encontrada no serviço WhatsApp. Conecte novamente para recriar.";
        } else {
          CHANNEL_POLL_BACKOFF_UNTIL.set(backoffKey, Date.now() + 10_000);
          row.error_message = `Serviço WhatsApp indisponível em ${WHATSAPP_MICROSERVICE_URL}. Verifique se o serviço está ativo.`;
        }
        row.updated_at = nowIso();
      });
      return 0;
    }
    throw error;
  }
  CHANNEL_POLL_BACKOFF_UNTIL.delete(backoffKey);
  const events = Array.isArray(data.events) ? data.events : [];
  if (events.length === 0) return 0;

  const inboundMessages = withDb((db) => applyWhatsAppEvents(db, userId, sessionId, events));
  for (const inbound of inboundMessages) {
    await processInboundMessageForRoutes(inbound);
  }

  return events.length;
}

async function pollTelegramEventsForSession(userId: string, sessionId: string) {
  const backoffKey = `tg:${userId}:${sessionId}`;
  if (inChannelPollBackoff(backoffKey)) return 0;

  let data: { events?: IntegrationEvent[] };
  try {
    data = await callService<{ events?: IntegrationEvent[] }>(
      TELEGRAM_MICROSERVICE_URL,
      `/api/telegram/events/${encodeURIComponent(sessionId)}`,
      { userId },
    );
  } catch (error) {
    if (isRecoverablePollingError(error)) {
      withDb((db) => {
        const row = db.tables.telegram_sessions.find(
          (item) => item.id === sessionId && item.user_id === userId,
        );
        if (!row) return;

        const notFound = isSessionNotFoundPollingError(error);
        row.status = notFound ? "offline" : "warning";
        row.connected_at = null;
        if (notFound) {
          CHANNEL_POLL_BACKOFF_UNTIL.delete(backoffKey);
          row.phone_code_hash = "";
          row.error_message = "Sessão não encontrada no serviço Telegram. Inicie uma nova conexão.";
        } else {
          CHANNEL_POLL_BACKOFF_UNTIL.set(backoffKey, Date.now() + 10_000);
          row.error_message = `Serviço Telegram indisponível em ${TELEGRAM_MICROSERVICE_URL}. Verifique se o serviço está ativo.`;
        }
        row.updated_at = nowIso();
      });
      return 0;
    }
    throw error;
  }
  CHANNEL_POLL_BACKOFF_UNTIL.delete(backoffKey);
  const events = Array.isArray(data.events) ? data.events : [];
  if (events.length === 0) return 0;

  const inboundMessages = withDb((db) => applyTelegramEvents(db, userId, sessionId, events));
  for (const inbound of inboundMessages) {
    await processInboundMessageForRoutes(inbound);
  }

  return events.length;
}

function appendDispatchFailureHistory(
  db: ReturnType<typeof loadDb>,
  input: {
    userId: string;
    destination: string;
    message: string;
    reason: string;
    platform?: string;
  },
) {
  db.tables.history_entries.push({
    id: randomId("hist"),
    user_id: input.userId,
    type: "schedule_sent",
    source: "Agendamento",
    destination: input.destination,
    status: "error",
    details: { message: input.message, error: input.reason, platform: input.platform || "" },
    direction: "outbound",
    message_type: "text",
    processing_status: "failed",
    block_reason: input.reason,
    error_step: "dispatch",
    created_at: nowIso(),
  });
}

async function sendMessageToGroup(
  userId: string,
  group: Record<string, unknown>,
  message: string,
  media?: OutboundMediaPayload | null,
): Promise<void> {
  const platform = String(group.platform || "");
  const sessionId = String(group.session_id || "");
  const externalId = String(group.external_id || "");
  const destinationLabel = String(group.name || group.id || externalId || "Destino");

  if (!sessionId || !externalId) {
    if (platform === "whatsapp") {
      withDb((db) => {
        appendOutboundHistory(db, {
          userId,
          source: "WhatsApp",
          destination: destinationLabel,
          message: formatMessageForPlatform(message, "whatsapp"),
          platform: "whatsapp",
        });
      });
      return;
    }

    if (platform === "telegram") {
      withDb((db) => {
        appendOutboundHistory(db, {
          userId,
          source: "Telegram",
          destination: destinationLabel,
          message: formatMessageForPlatform(message, "telegram"),
          platform: "telegram",
        });
      });
      return;
    }

    throw new Error("Grupo sem session_id/external_id para envio");
  }

  if (platform === "whatsapp") {
    const whatsappMessage = formatMessageForPlatform(message, "whatsapp");
    if (!WHATSAPP_MICROSERVICE_URL) {
      withDb((db) => {
        appendOutboundHistory(db, {
          userId,
          source: "WhatsApp",
          destination: destinationLabel,
          message: whatsappMessage,
          platform: "whatsapp",
        });
      });
      return;
    }

    try {
      await callService(WHATSAPP_MICROSERVICE_URL, "/api/send-message", {
        method: "POST",
        userId,
        body: { sessionId, jid: externalId, content: whatsappMessage, media: media || undefined },
      });
    } catch {
      // Local fallback: keep dispatch flows working in offline/dev scenarios.
      withDb((db) => {
        appendOutboundHistory(db, {
          userId,
          source: "WhatsApp",
          destination: destinationLabel,
          message: whatsappMessage,
          platform: "whatsapp",
        });
      });
      return;
    }

    await pollWhatsappEventsForSession(userId, sessionId).catch(() => 0);
    return;
  }

  if (platform === "telegram") {
    const telegramMessage = formatMessageForPlatform(message, "telegram");
    if (!TELEGRAM_MICROSERVICE_URL) {
      withDb((db) => {
        appendOutboundHistory(db, {
          userId,
          source: "Telegram",
          destination: destinationLabel,
          message: telegramMessage,
          platform: "telegram",
        });
      });
      return;
    }

    try {
      await callService(TELEGRAM_MICROSERVICE_URL, "/api/telegram/send-message", {
        method: "POST",
        userId,
        body: { sessionId, chatId: externalId, message: telegramMessage, media: media || undefined },
      });
    } catch {
      // Local fallback: keep dispatch flows working in offline/dev scenarios.
      withDb((db) => {
        appendOutboundHistory(db, {
          userId,
          source: "Telegram",
          destination: destinationLabel,
          message: telegramMessage,
          platform: "telegram",
        });
      });
      return;
    }

    await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
    return;
  }

  throw new Error(`Plataforma invalida para envio: ${platform || "desconhecida"}`);
}

export async function invokeLocalFunction(name: string, options?: { body?: Record<string, unknown> }) {
  const body = options?.body || {};

  // Pre-hash password for admin create_user before entering the sync withDb context
  let _preHashedCreateUserPassword: string | undefined;
  if (name === "admin-users" && String(body.action || "") === "create_user") {
    const pw = String(body.password || "");
    if (pw.length >= 6) {
      _preHashedCreateUserPassword = await hashPassword(pw);
    }
  }

  // Pre-hash password for admin reset_password before entering the sync withDb context
  let _preHashedResetPassword: string | undefined;
  if (name === "admin-users" && String(body.action || "") === "reset_password") {
    const pw = String(body.password || "").trim();
    if (pw.length >= 6) {
      _preHashedResetPassword = await hashPassword(pw);
    }
  }

  withDb((db) => {
    const nowMs = Date.now();
    cleanupExpiredScheduledMedia(db, nowMs);
    cleanupExpiredHistoryEntries(db, nowMs);
  });
  const authSnapshot = loadDb();
  const session = authSnapshot.auth.session;
  const currentUser = session?.user || null;
  const userId = currentUser?.id || null;

  if (currentUser && userId && !PLAN_EXPIRY_ALLOWED_FUNCTIONS.has(name)) {
    const isAdminUser = userIsAdmin(authSnapshot, userId);
    if (!isAdminUser && isPlanExpiredForUser(authSnapshot, userId)) {
      return fail("Plano expirado. Renove ou troque de plano para continuar usando os recursos.");
    }
  }

  if (name === "poll-channel-events") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    return {
      data: {
        ok: true,
        source: String(body.source || "local"),
        whatsapp: { sessions: 0, events: 0 },
        telegram: { sessions: 0, events: 0 },
      },
      error: null,
    };
  }

  if (name === "meli-vitrine-list") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const tabs = [
      { key: "destaques", label: "Destaques", activeCount: 0 },
      { key: "top_performance", label: "Top Performance", activeCount: 0 },
      { key: "mais_vendidos", label: "Mais vendidos", activeCount: 0 },
      { key: "ofertas_quentes", label: "Ofertas quentes", activeCount: 0 },
      { key: "melhor_avaliados", label: "Melhor Avaliados", activeCount: 0 },
    ];

    const requestedTab = String(body.tab || "destaques").trim() || "destaques";
    const page = Math.max(1, Number.parseInt(String(body.page || "1"), 10) || 1);
    const limit = Math.max(1, Math.min(60, Number.parseInt(String(body.limit || "24"), 10) || 24));

    return {
      data: {
        tab: requestedTab,
        page,
        limit,
        total: 0,
        hasMore: false,
        items: [],
        tabs,
        lastSyncAt: null,
        stale: true,
      },
      error: null,
    };
  }

  if (name === "meli-vitrine-sync") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    if (!userIsAdmin(authSnapshot, userId)) return fail("Acesso negado");

    return {
      data: {
        success: true,
        skipped: true,
        source: String(body.source || "manual"),
        scannedTabs: 0,
        fetchedCards: 0,
        addedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        unchangedCount: 0,
        lastSyncAt: nowIso(),
        message: "Sincronizacao local simulada concluida.",
      },
      error: null,
    };
  }

  if (name === "meli-automation-run") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    return {
      data: {
        ok: true,
        source: String(body.source || "manual"),
        scope: "user",
        active: 0,
        processed: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        message: "Nenhuma automacao ML elegivel para execucao neste ambiente local.",
      },
      error: null,
    };
  }

  if (name === "route-process-message") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const slot = await acquireProcessSlot("route");
    await applyProcessQueueDelay(slot);
    try {

    const platform = String(body.platform || "") === "telegram" ? "telegram" : "whatsapp";
    const sessionId = String(body.sessionId || "").trim();
    const sourceExternalId = String(body.groupId || body.sourceExternalId || "").trim();
    const sourceName = String(body.groupName || body.sourceName || "Grupo").trim();
    const from = String(body.from || (platform === "telegram" ? "Telegram" : "WhatsApp")).trim();
    const message = String(body.message || "").trim();
    const rawMedia = body.media && typeof body.media === "object" ? (body.media as Record<string, unknown>) : null;
    const mediaKind = String(rawMedia?.kind || "").trim();
    const mediaBase64 = String(rawMedia?.base64 || "").trim();
    const mediaToken = String(rawMedia?.token || "").trim();
    const mediaMimeType = String(rawMedia?.mimeType || "").trim();
    const mediaFileName = String(rawMedia?.fileName || "").trim();
    const mediaSourcePlatformRaw = String(rawMedia?.sourcePlatform || "").trim();
    const mediaSourcePlatform: "whatsapp" | "telegram" = mediaSourcePlatformRaw === "telegram"
      ? "telegram"
      : platform;
    const media = mediaKind === "image" && (mediaBase64 || mediaToken)
      ? {
          kind: "image" as const,
          sourcePlatform: mediaSourcePlatform,
          token: mediaToken || undefined,
          base64: mediaBase64 || undefined,
          mimeType: mediaMimeType || undefined,
          fileName: mediaFileName || undefined,
        }
      : null;

    if (!sessionId || !sourceExternalId || !message) {
      return fail("sessionId, groupId e message são obrigatórios");
    }

    const result = await processInboundMessageForRoutes({
      userId,
      platform,
      sessionId,
      sourceExternalId,
      sourceName,
      from,
      message,
      media,
    });

    return { data: { ok: true, ...result }, error: null };
    } finally {
      releaseProcessSlot(slot);
    }
  }

  if (name === "whatsapp-connect" && WHATSAPP_MICROSERVICE_URL) {
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const action = String(body.action || "");
    const sessionId = String(body.sessionId || "");

    if (action === "health") {
      const health = await getServiceHealth(WHATSAPP_MICROSERVICE_URL);
      return { data: health, error: null };
    }

    if (action === "poll_events_all") {
      // Reconcile local session status from microservice health first.
      // This prevents stale offline rows from blocking dispatch after service restarts.
      try {
        const health = await getServiceHealth(WHATSAPP_MICROSERVICE_URL);
        const healthSessions = Array.isArray(health.sessions)
          ? (health.sessions as Array<Record<string, unknown>>)
          : [];

        withDb((db) => {
          for (const row of db.tables.whatsapp_sessions) {
            if (row.user_id !== userId) continue;
            const sessionInfo = healthSessions.find((item) => String(item.sessionId || "") === String(row.id));
            if (!sessionInfo) continue;

            const nextStatus = normalizeWhatsAppStatus(String(sessionInfo.status || row.status || "offline"));
            row.status = nextStatus;
            row.error_message = nextStatus !== "online"
              ? row.error_message
              : "";
            if (nextStatus === "online" && !row.connected_at) {
              row.connected_at = nowIso();
            }
            if (nextStatus !== "online") {
              row.connected_at = null;
            }
            row.updated_at = nowIso();
          }
        });
      } catch {
        // Keep poll best-effort even if health endpoint fails.
      }

      const sessions = loadDb().tables.whatsapp_sessions
        .filter((row) => row.user_id === userId)
        .filter((row) => {
          const status = String(row.status || "offline");
          return WHATSAPP_POLLABLE_STATUSES.has(status);
        })
        .map((row) => String(row.id));

      let totalEvents = 0;
      for (const id of sessions) {
        try {
          totalEvents += await pollWhatsappEventsForSession(userId, id);
        } catch {
          // keep polling best-effort
        }
      }

      return { data: { success: true, sessions: sessions.length, events: totalEvents }, error: null };
    }

    if (!sessionId) return fail("sessionId obrigatorio");
    const dbSnapshot = loadDb();
    const sessionRow = dbSnapshot.tables.whatsapp_sessions.find((row) => row.id === sessionId && row.user_id === userId);
    if (!sessionRow) return fail("Sessão WhatsApp não encontrada");

    if (action === "connect") {
      const authMethod = "qr";
      const phone = String(sessionRow.phone || "").trim();

      withDb((db) => {
        const row = db.tables.whatsapp_sessions.find((item) => item.id === sessionId && item.user_id === userId);
        if (!row) return;
        row.auth_method = "qr";
        row.status = "connecting";
        row.error_message = "";
        row.updated_at = nowIso();
      });

      try {
        const response = await callService<{ status?: string }>(
          WHATSAPP_MICROSERVICE_URL,
          `/api/sessions/${encodeURIComponent(sessionId)}/connect`,
          {
            method: "POST",
            userId,
            body: {
              userId,
              webhookUrl: "",
              phone,
              authMethod,
              sessionName: String(sessionRow.name || sessionId),
            },
          },
        );

        const nextStatus = normalizeWhatsAppStatus(response.status || "connecting");
        withDb((db) => {
          const row = db.tables.whatsapp_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = nextStatus;
          row.error_message = "";
          row.updated_at = nowIso();
        });

        await pollWhatsappEventsForSession(userId, sessionId).catch(() => 0);
        return { data: { success: true, status: nextStatus, waiting_webhook: false }, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao iniciar conexão WhatsApp";
        withDb((db) => {
          const row = db.tables.whatsapp_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = "warning";
          row.error_message = message;
          row.updated_at = nowIso();
        });
        return fail(message);
      }
    }

    if (action === "disconnect") {
      try {
        await callService(WHATSAPP_MICROSERVICE_URL, `/api/sessions/${encodeURIComponent(sessionId)}/disconnect`, {
          method: "POST",
          userId,
          body: { sessionId },
        });

        withDb((db) => {
          const row = db.tables.whatsapp_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = "offline";
          row.connected_at = null;
          row.qr_code = "";
          row.error_message = "";
          row.updated_at = nowIso();
        });

        return { data: { success: true, status: "offline" }, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao desconectar sessão WhatsApp";
        withDb((db) => {
          const row = db.tables.whatsapp_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = "warning";
          row.error_message = message;
          row.updated_at = nowIso();
        });
        return fail(message);
      }
    }

    if (action === "sync_groups") {
      try {
        const response = await callService<{ groups?: Array<Record<string, unknown>>; count?: number }>(
          WHATSAPP_MICROSERVICE_URL,
          `/api/sessions/${encodeURIComponent(sessionId)}/sync-groups`,
          {
            method: "POST",
            userId,
            body: { sessionId },
          },
        );

        let blockedGroups = 0;
        withDb((db) => {
          const groups = Array.isArray(response.groups) ? response.groups : [];
          for (const group of groups) {
            const persisted = upsertGroup(db, {
              userId,
              platform: "whatsapp",
              sessionId,
              externalId: String(group.id || ""),
              name: String(group.name || group.id || "Grupo"),
              memberCount: Number(group.memberCount || 0),
            });
            if (!persisted) blockedGroups += 1;
          }

          if (blockedGroups > 0) {
            const row = db.tables.whatsapp_sessions.find((item) => item.id === sessionId && item.user_id === userId);
            const maxGroups = resolvePlatformGroupLimitForUser(db, userId, "whatsapp");
            if (row) {
              row.error_message = `Limite de grupos WhatsApp excedido. Plano permite ${maxGroups === -1 ? "ilimitado" : maxGroups}.`;
              row.updated_at = nowIso();
            }
          }
        });

        const snapshot = loadDb();
        const activeMasterLinkedGroupIds = new Set(
          snapshot.tables.master_group_links
            .filter((link) => link.is_active !== false)
            .map((link) => String(link.group_id)),
        );

        const inviteTargets = snapshot.tables.groups
          .filter((row) => row.user_id === userId)
          .filter((row) => row.platform === "whatsapp")
          .filter((row) => row.session_id === sessionId)
          .filter((row) => !row.deleted_at)
          .filter((row) => activeMasterLinkedGroupIds.has(String(row.id)))
          .filter((row) => !String(row.invite_link || "").trim());

        let inviteChecked = 0;
        let inviteUpdated = 0;
        let inviteFailed = 0;

        for (const target of inviteTargets) {
          const groupId = String(target.external_id || "").trim();
          if (!groupId) continue;
          inviteChecked += 1;

          try {
            const inviteResponse = await callService<{ inviteLink?: string }>(
              WHATSAPP_MICROSERVICE_URL,
              `/api/sessions/${encodeURIComponent(sessionId)}/group-invite`,
              {
                method: "POST",
                userId,
                body: { groupId },
              },
            );

            const inviteLink = String(inviteResponse.inviteLink || "").trim();
            if (!/^https?:\/\//i.test(inviteLink)) {
              inviteFailed += 1;
              continue;
            }

            withDb((db) => {
              const row = db.tables.groups.find((item) => item.id === target.id && item.user_id === userId);
              if (!row) return;
              row.invite_link = inviteLink;
              row.updated_at = nowIso();
            });

            inviteUpdated += 1;
          } catch {
            inviteFailed += 1;
          }
        }

        await pollWhatsappEventsForSession(userId, sessionId).catch(() => 0);
        return {
          data: {
            success: true,
            groups: Number(response.count || 0),
            blockedGroups,
            masterGroupInviteSync: {
              checked: inviteChecked,
              updated: inviteUpdated,
              failed: inviteFailed,
            },
          },
          error: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao sincronizar grupos WhatsApp";
        withDb((db) => {
          const row = db.tables.whatsapp_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.error_message = message;
          row.updated_at = nowIso();
        });
        return fail(message);
      }
    }

    if (action === "send_message") {
      const jid = String(body.jid || "");
      const content = String(body.content || "");
      if (!jid || !content.trim()) return fail("jid e content sao obrigatorios");
      const outboundContent = formatMessageForPlatform(content, "whatsapp");

      try {
        const response = await callService<{ id?: string }>(WHATSAPP_MICROSERVICE_URL, "/api/send-message", {
          method: "POST",
          userId,
          body: { sessionId, jid, content: outboundContent },
        });

        await pollWhatsappEventsForSession(userId, sessionId).catch(() => 0);
        return { data: { success: true, id: response.id || null }, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao enviar mensagem WhatsApp";
        return fail(message);
      }
    }


          if (action === "group_invite") {
            const groupId = String(body.groupId || "").trim();
            if (!groupId) return fail("groupId é obrigatório");

            try {
              const response = await callService<{ groupId?: string; inviteCode?: string; inviteLink?: string }>(
                WHATSAPP_MICROSERVICE_URL,
                `/api/sessions/${encodeURIComponent(sessionId)}/group-invite`,
                {
                  method: "POST",
                  userId,
                  body: { groupId },
                },
              );

              return {
                data: {
                  success: true,
                  groupId: String(response.groupId || groupId),
                  inviteCode: String(response.inviteCode || ""),
                  inviteLink: String(response.inviteLink || ""),
                },
                error: null,
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : "Falha ao obter convite do grupo";
              return fail(message);
            }
          }
    if (action === "poll_events") {
      const total = await pollWhatsappEventsForSession(userId, sessionId).catch(() => 0);
      return { data: { success: true, events: total }, error: null };
    }
  }

  if (name === "telegram-connect" && TELEGRAM_MICROSERVICE_URL) {
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const action = String(body.action || "");
    const sessionId = String(body.sessionId || "");

    if (action === "health") {
      const health = await getServiceHealth(TELEGRAM_MICROSERVICE_URL);
      return { data: health, error: null };
    }

    if (action === "poll_events_all") {
      // Reconcile local session status from microservice health first.
      // This prevents stale offline rows from blocking dispatch after service restarts.
      try {
        const health = await getServiceHealth(TELEGRAM_MICROSERVICE_URL);
        const healthSessions = Array.isArray(health.sessions)
          ? (health.sessions as Array<Record<string, unknown>>)
          : [];

        withDb((db) => {
          for (const row of db.tables.telegram_sessions) {
            if (row.user_id !== userId) continue;
            const sessionInfo = healthSessions.find((item) => String(item.sessionId || "") === String(row.id));
            if (!sessionInfo) continue;

            const nextStatus = normalizeTelegramStatus(String(sessionInfo.status || row.status || "offline"));
            row.status = nextStatus;
            row.error_message = nextStatus !== "online"
              ? row.error_message
              : "";
            if (nextStatus === "online" && !row.connected_at) {
              row.connected_at = nowIso();
            }
            if (nextStatus !== "online") {
              row.connected_at = null;
            }
            row.updated_at = nowIso();
          }
        });
      } catch {
        // Keep poll best-effort even if health endpoint fails.
      }

      const sessions = loadDb().tables.telegram_sessions
        .filter((row) => row.user_id === userId)
        .filter((row) => {
          const status = String(row.status || "offline");
          if (TELEGRAM_POLLABLE_STATUSES.has(status)) return true;
          // Keep polling offline sessions that still have a saved Telegram string,
          // so the UI can recover to the real state after service restarts.
          return status === "offline" && Boolean(String(row.session_string || "").trim());
        })
        .map((row) => String(row.id));

      let totalEvents = 0;
      for (const id of sessions) {
        try {
          totalEvents += await pollTelegramEventsForSession(userId, id);
        } catch {
          // keep polling best-effort
        }
      }

      return { data: { success: true, sessions: sessions.length, events: totalEvents }, error: null };
    }

    if (!sessionId) return fail("sessionId obrigatorio");
    const dbSnapshot = loadDb();
    const sessionRow = dbSnapshot.tables.telegram_sessions.find((row) => row.id === sessionId && row.user_id === userId);
    if (!sessionRow) return fail("Sessão Telegram não encontrada");

    if (action === "send_code") {
      withDb((db) => {
        const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
        if (!row) return;
        row.status = "connecting";
        row.error_message = "";
        row.updated_at = nowIso();
      });

      try {
        const response = await callService<{ status?: string }>(
          TELEGRAM_MICROSERVICE_URL,
          "/api/telegram/send_code",
          {
            method: "POST",
            userId,
            body: {
              sessionId,
              userId,
              phone: String(sessionRow.phone || ""),
              webhookUrl: "",
              sessionString: String(sessionRow.session_string || ""),
            },
          },
        );

        const nextStatus = normalizeTelegramStatus(response.status || "connecting");
        withDb((db) => {
          const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = nextStatus;
          row.error_message = "";
          row.updated_at = nowIso();
        });

        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        return { data: { status: nextStatus }, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao iniciar conexão Telegram";
        withDb((db) => {
          const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = "warning";
          row.error_message = message;
          row.updated_at = nowIso();
        });
        return fail(message);
      }
    }

    if (action === "verify_code") {
      withDb((db) => {
        const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
        if (!row) return;
        row.status = "connecting";
        row.error_message = "";
        row.updated_at = nowIso();
      });

      try {
        await callService(TELEGRAM_MICROSERVICE_URL, "/api/telegram/verify_code", {
          method: "POST",
          userId,
          body: { sessionId, code: String(body.code || "") },
        });
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        return { data: { status: "connecting" }, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao verificar codigo Telegram";
        withDb((db) => {
          const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = "warning";
          row.error_message = message;
          row.updated_at = nowIso();
        });
        return fail(message);
      }
    }

    if (action === "verify_password") {
      withDb((db) => {
        const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
        if (!row) return;
        row.status = "connecting";
        row.error_message = "";
        row.updated_at = nowIso();
      });

      try {
        await callService(TELEGRAM_MICROSERVICE_URL, "/api/telegram/verify_password", {
          method: "POST",
          userId,
          body: { sessionId, password: String(body.password || "") },
        });
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        return { data: { status: "connecting" }, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao verificar senha 2FA do Telegram";
        withDb((db) => {
          const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = "warning";
          row.error_message = message;
          row.updated_at = nowIso();
        });
        return fail(message);
      }
    }

    if (action === "disconnect") {
      const clearSession = body.clearSession === true || String(body.clearSession || "").trim().toLowerCase() === "true";
      try {
        await callService(TELEGRAM_MICROSERVICE_URL, "/api/telegram/disconnect", {
          method: "POST",
          userId,
          body: { sessionId, clearSession },
        });

        withDb((db) => {
          const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = "offline";
          row.connected_at = null;
          if (clearSession) {
            row.session_string = "";
          }
          row.error_message = "";
          row.updated_at = nowIso();
        });

        return { data: { status: "offline", clear_session: clearSession }, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao desconectar sessão Telegram";
        withDb((db) => {
          const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.status = "warning";
          row.error_message = message;
          row.updated_at = nowIso();
        });
        return fail(message);
      }
    }

    if (action === "sync_groups") {
      try {
        const syncResponse = await callService<{ blockedGroups?: number }>(TELEGRAM_MICROSERVICE_URL, "/api/telegram/sync_groups", {
          method: "POST",
          userId,
          body: { sessionId },
        });
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        const blockedKey = `${userId}:${sessionId}`;
        const blockedFromEvents = TELEGRAM_SYNC_LIMIT_BLOCKED.get(blockedKey);
        TELEGRAM_SYNC_LIMIT_BLOCKED.delete(blockedKey);
        const blockedGroups = Number(
          (typeof blockedFromEvents === "number" ? blockedFromEvents : syncResponse.blockedGroups) || 0,
        );
        return { data: { status: "online", blockedGroups }, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao sincronizar grupos Telegram";
        withDb((db) => {
          const row = db.tables.telegram_sessions.find((item) => item.id === sessionId && item.user_id === userId);
          if (!row) return;
          row.error_message = message;
          row.updated_at = nowIso();
        });
        return fail(message);
      }
    }

    if (action === "send_message") {
      const chatId = String(body.chatId || "");
      const message = String(body.message || "");
      if (!chatId || !message.trim()) return fail("chatId e message sao obrigatorios");
      const outboundMessage = formatMessageForPlatform(message, "telegram");

      try {
        const response = await callService<{ id?: string }>(TELEGRAM_MICROSERVICE_URL, "/api/telegram/send-message", {
          method: "POST",
          userId,
          body: { sessionId, chatId, message: outboundMessage },
        });

        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        return { data: { status: "online", id: response.id || null }, error: null };
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Falha ao enviar mensagem Telegram";
        return fail(messageText);
      }
    }

    if (action === "poll_events") {
      const total = await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
      return { data: { success: true, events: total }, error: null };
    }
  }

  if (name === "dispatch-messages" && currentUser && userId && (WHATSAPP_MICROSERVICE_URL || TELEGRAM_MICROSERVICE_URL)) {
    const slot = await acquireProcessSlot("dispatch");
    await applyProcessQueueDelay(slot);
    try {
    const snapshot = loadDb();
    const now = Date.now();
    const limit = Number(body.limit || 20);
    const shopeeCredentials = getShopeeCredentialsForUser(snapshot, userId);

    const pending = snapshot.tables.scheduled_posts
      .filter((row) => row.user_id === userId && row.status === "pending")
      .filter((row) => !!getDueSlotKey(row as unknown as Record<string, unknown>, now))
      .slice(0, Number.isFinite(limit) ? limit : 20);

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const post of pending) {
      const metadata = parseScheduleMeta(post.metadata);
      const dueSlotKey = getDueSlotKey(post as unknown as Record<string, unknown>, now);
      if (!dueSlotKey) continue;
      const recurring = isRecurringSchedule(post as unknown as Record<string, unknown>);

      const masterGroupIds = Array.isArray(metadata.masterGroupIds)
        ? (metadata.masterGroupIds as unknown[]).filter((item): item is string => typeof item === "string")
        : [];

      const directGroupIds = snapshot.tables.scheduled_post_destinations
        .filter((dest) => dest.post_id === post.id)
        .map((dest) => String(dest.group_id));

      const masterLinkedGroupIds = snapshot.tables.master_group_links
        .filter((link) => masterGroupIds.includes(String(link.master_group_id)))
        .map((link) => String(link.group_id));

      const destinationGroupIds = [...new Set([...directGroupIds, ...masterLinkedGroupIds])];
      let message = typeof metadata.finalContent === "string" ? metadata.finalContent : String(post.content || "");
      const rawTemplateId = typeof metadata.templateId === "string" ? metadata.templateId.trim() : "";
      if (rawTemplateId) {
        const template = snapshot.tables.templates.find(
          (row) => row.user_id === userId && String(row.id) === rawTemplateId,
        );
        const templateData = parseScheduleTemplateData(metadata);
        if (template && typeof template.content === "string" && Object.keys(templateData).length > 0) {
          message = applyPlaceholders(template.content, templateData);
        }
      }
      let scheduleMedia = parseScheduledImageFromMeta(metadata);
      const requiresScheduleImage = scheduleRequiresMandatoryImage(metadata);
      const conversionResult = await convertShopeeLinksInContent({
        content: message,
        userId,
        credentials: shopeeCredentials,
      });
      message = conversionResult.convertedContent;

      if (!scheduleMedia && requiresScheduleImage) {
        const productImageUrl = extractScheduleProductImageUrl(metadata);
        if (productImageUrl) {
          try {
            scheduleMedia = await buildAutomationImageMedia({ imageUrl: productImageUrl });
          } catch {
            scheduleMedia = null;
          }
        }
      }

      if (conversionResult.conversions.length > 0) {
        withDb((db) => {
          for (const conversion of conversionResult.conversions) {
            appendLinkConvertedHistory(db, {
              userId,
              source: "schedule_dispatch",
              originalLink: conversion.originalLink,
              affiliateLink: conversion.affiliateLink,
              resolvedLink: conversion.resolvedLink,
            });
          }
        });
      }

      if (destinationGroupIds.length === 0) {
        skipped += 1;
        withDb((db) => {
          const row = db.tables.scheduled_posts.find((item) => item.id === post.id && item.user_id === userId);
          if (!row) return;
          row.status = "cancelled";
          appendDispatchFailureHistory(db, {
            userId,
            destination: String(post.id),
            message,
            reason: "Agendamento cancelado: nenhum destino válido",
            platform: "",
          });
          row.metadata = markScheduleMediaCleanup(parseScheduleMeta(row.metadata), now);
          schedulePostMediaCleanup(userId, String(row.id), parseScheduleMeta(row.metadata));
          row.updated_at = nowIso();
        });
        continue;
      }

      if (requiresScheduleImage && !scheduleMedia) {
        failed += 1;
        skipped += 1;
        withDb((db) => {
          const row = db.tables.scheduled_posts.find((item) => item.id === post.id && item.user_id === userId);
          if (row) {
            row.status = "cancelled";
            row.metadata = markScheduleMediaCleanup(parseScheduleMeta(row.metadata), now);
            schedulePostMediaCleanup(userId, String(row.id), parseScheduleMeta(row.metadata));
            row.updated_at = nowIso();
          }
          appendDispatchFailureHistory(db, {
            userId,
            destination: String(post.id),
            message,
            reason: "Agendamento cancelado: imagem obrigatória ausente.",
            platform: "",
          });
          db.tables.history_entries.push({
            id: randomId("hist"),
            user_id: userId,
            type: "schedule_sent",
            source: "Agendamento",
            destination: String(post.id),
            status: "warning",
            details: {
              message,
              reason: "missing_image_required",
              requiresImage: true,
            },
            direction: "outbound",
            message_type: "text",
            processing_status: "blocked",
            block_reason: "missing_image_required",
            error_step: "media_requirements",
            created_at: nowIso(),
          });
        });
        continue;
      }

      let postSentCount = 0;
      let postSkippedOfflineCount = 0;
      let postError = "";

      for (const groupId of destinationGroupIds) {
        const group = snapshot.tables.groups.find((row) => row.id === groupId && row.user_id === userId);

        if (!group) {
          failed += 1;
          postError = `Grupo destino não encontrado: ${groupId}`;
          errors.push(postError);
          withDb((db) => {
            appendDispatchFailureHistory(db, {
              userId,
              destination: groupId,
              message,
              reason: postError,
              platform: "",
            });
          });
          break;
        }

        // Skip groups whose session is offline - post stays pending for the next dispatch cycle.
        const groupPlatform = String(group.platform || "");
        const groupSessionId = String(group.session_id || "");
        const isSessionOnline = groupPlatform === "whatsapp"
          ? (() => {
            const sessionRow = snapshot.tables.whatsapp_sessions.find(
              (row) => row.user_id === userId && String(row.id) === groupSessionId,
            );
            if (!sessionRow) return true;
            return String(sessionRow.status || "") === "online";
          })()
          : groupPlatform === "telegram"
            ? (() => {
              const sessionRow = snapshot.tables.telegram_sessions.find(
                (row) => row.user_id === userId && String(row.id) === groupSessionId,
              );
              if (!sessionRow) return true;
              return String(sessionRow.status || "") === "online";
            })()
            : true;

        if (!isSessionOnline) {
          postSkippedOfflineCount += 1;
          skipped += 1;
          continue;
        }

        try {
          await sendMessageToGroup(userId, group, message, scheduleMedia);
          sent += 1;
          postSentCount += 1;

          withDb((db) => {
            db.tables.history_entries.push({
              id: randomId("hist"),
              user_id: userId,
              type: "schedule_sent",
              source: "Agendamento",
              destination: String(group.name || group.id),
              status: "success",
              details: { message, platform: String(group.platform || "") },
              direction: "outbound",
              message_type: scheduleMedia ? "image" : "text",
              processing_status: "sent",
              block_reason: "",
              error_step: "",
              created_at: nowIso(),
            });
          });
        } catch (error) {
          failed += 1;
          const reason = error instanceof Error ? error.message : String(error);
          postError = reason;
          errors.push(`${group.name || group.id}: ${reason}`);

          withDb((db) => {
            appendDispatchFailureHistory(db, {
              userId,
              destination: String(group.name || group.id),
              message,
              reason,
              platform: String(group.platform || ""),
            });
          });
          break;
        }
      }

      withDb((db) => {
        const row = db.tables.scheduled_posts.find((item) => item.id === post.id && item.user_id === userId);
        if (!row) return;
        if (postError) {
          row.status = "cancelled";
          row.metadata = markScheduleMediaCleanup(parseScheduleMeta(row.metadata), now);
          schedulePostMediaCleanup(userId, String(row.id), parseScheduleMeta(row.metadata));
        } else if (recurring) {
          const mergedMeta = parseScheduleMeta(row.metadata);
          row.status = "pending";
          row.scheduled_at = computeNextRecurringScheduledAt(row as unknown as Record<string, unknown>, now);
          row.metadata = {
            ...mergedMeta,
            lastDispatchSlot: dueSlotKey,
          };
        } else if (postSentCount > 0) {
          row.status = "sent";
          row.metadata = markScheduleMediaCleanup(parseScheduleMeta(row.metadata), now);
          schedulePostMediaCleanup(userId, String(row.id), parseScheduleMeta(row.metadata));
        } else if (postSkippedOfflineCount > 0) {
          // All destinations were skipped because their sessions were offline.
          // Keep the post pending so it is retried on the next dispatch cycle.
          row.status = "pending";
        } else {
          row.status = "cancelled";
          row.metadata = markScheduleMediaCleanup(parseScheduleMeta(row.metadata), now);
          schedulePostMediaCleanup(userId, String(row.id), parseScheduleMeta(row.metadata));
        }
        row.updated_at = nowIso();
      });
    }

    return {
      data: {
        ok: true,
        runMode: "user",
        source: String(body.source || "frontend"),
        scanned: pending.length,
        processed: pending.length,
        sent,
        failed,
        skipped,
        historyLogged: sent + failed,
        errors,
      },
      error: null,
    };
    } finally {
      releaseProcessSlot(slot);
    }
  }

  if (name === "shopee-test-connection") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;

    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const credentials = snapshot.tables.api_credentials.find((row) => row.user_id === userId && row.provider === "shopee");
    if (!credentials) return { data: { success: false, reason: "Credenciais Shopee não configuradas" }, error: null };

    if (!shopeeServiceConfigured()) {
      return {
        data: {
          success: false,
          region: String(credentials.region || "BR"),
          reason: "Serviço Shopee não configurado. Defina VITE_SHOPEE_MICROSERVICE_URL e inicie o serviço Shopee.",
        },
        error: null,
      };
    }

    try {
      const response = await callService<{ success?: boolean; error?: string; region?: string }>(
        SHOPEE_MICROSERVICE_URL,
        "/api/shopee/test-connection",
        {
          method: "POST",
          body: getShopeeCredentialPayload(credentials),
        },
      );

      if (response.success) {
        return {
          data: {
            success: true,
            region: String(response.region || credentials.region || "BR"),
          },
          error: null,
        };
      }

      return {
        data: {
          success: false,
          region: String(response.region || credentials.region || "BR"),
          reason: String(response.error || "Falha ao autenticar na Shopee"),
        },
        error: null,
      };
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      const isNetworkError = rawMsg.toLowerCase().includes("failed to fetch") || rawMsg.toLowerCase().includes("networkerror") || rawMsg.toLowerCase().includes("econnrefused");
      return {
        data: {
          success: false,
          region: String(credentials.region || "BR"),
          reason: isNetworkError
            ? "Serviço Shopee offline. Inicie o microserviço (porta 3113) ou use o script iniciar-preview.bat."
            : rawMsg,
        },
        error: null,
      };
    }
  }

  if (name === "shopee-service-health") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    if (!shopeeServiceConfigured()) {
      return {
        data: {
          online: false,
          url: "",
          uptimeSec: null,
          service: "shopee-affiliate",
          stats: null,
          error: "Serviço Shopee não configurado (VITE_SHOPEE_MICROSERVICE_URL)",
        },
        error: null,
      };
    }

    const health = await getServiceHealth(SHOPEE_MICROSERVICE_URL);
    return { data: health, error: null };
  }

  if (name === "shopee-convert-link") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;

    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const credentials = getShopeeCredentialsForUser(snapshot, userId);
    if (!credentials) return fail("Credenciais Shopee não configuradas");

    const source = String(body.url || body.link || "").trim();
    if (!source) return fail("URL Shopee obrigatoria");
    const sourceLabel = String(body.source || "shopee-conversor");

    const slot = await acquireProcessSlot("convert");
    await applyProcessQueueDelay(slot);
    try {
      const conversion = await convertShopeeLinkForUser({
        url: source,
        userId,
        credentials,
      });

      const sourceMarketplace = detectPartnerMarketplace(source);
      const resolvedMarketplace = detectPartnerMarketplace(conversion.resolvedLink);
      if (sourceMarketplace !== "shopee" && resolvedMarketplace !== "shopee") {
        return fail("URL informada não parece ser da Shopee");
      }

      withDb((db) => {
        appendLinkConvertedHistory(db, {
          userId,
          source: sourceLabel,
          originalLink: source,
          affiliateLink: conversion.affiliateLink,
          resolvedLink: conversion.resolvedLink,
        });
      });

      return {
        data: {
          affiliateLink: conversion.affiliateLink || source,
          product: conversion.product || null,
          resolvedUrl: conversion.resolvedLink || source,
          usedService: conversion.usedService,
        },
        error: null,
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Falha ao converter link Shopee");
    } finally {
      releaseProcessSlot(slot);
    }
  }

  if (name === "shopee-convert-links") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const credentials = getShopeeCredentialsForUser(snapshot, userId);
    if (!credentials) return fail("Credenciais Shopee não configuradas");

    const urlsRaw = Array.isArray(body.urls) ? body.urls : Array.isArray(body.links) ? body.links : [];
    const urls = urlsRaw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);

    if (urls.length === 0) return fail("Lista de URLs Shopee obrigatoria");

    const slot = await acquireProcessSlot("convert");
    await applyProcessQueueDelay(slot);
    try {

    const sourceLabel = String(body.source || "shopee-batch-converter");
    const conversions: Array<{
      originalLink: string;
      resolvedLink: string;
      affiliateLink: string;
      usedService: boolean;
      product: Record<string, unknown> | null;
      error: string | null;
    }> = [];

    for (const originalLink of urls) {
      try {
        const conversion = await convertShopeeLinkForUser({
          url: originalLink,
          userId,
          credentials,
        });

        const sourceMarketplace = detectPartnerMarketplace(originalLink);
        const resolvedMarketplace = detectPartnerMarketplace(conversion.resolvedLink);
        if (sourceMarketplace !== "shopee" && resolvedMarketplace !== "shopee") {
          conversions.push({
            originalLink,
            resolvedLink: conversion.resolvedLink || originalLink,
            affiliateLink: originalLink,
            usedService: conversion.usedService,
            product: null,
            error: "URL informada não parece ser da Shopee",
          });
          continue;
        }

        withDb((db) => {
          appendLinkConvertedHistory(db, {
            userId,
            source: sourceLabel,
            originalLink,
            affiliateLink: conversion.affiliateLink || originalLink,
            resolvedLink: conversion.resolvedLink,
          });
        });

        conversions.push({
          originalLink,
          resolvedLink: conversion.resolvedLink || originalLink,
          affiliateLink: conversion.affiliateLink || originalLink,
          usedService: conversion.usedService,
          product: conversion.product || null,
          error: null,
        });
      } catch (error) {
        conversions.push({
          originalLink,
          resolvedLink: originalLink,
          affiliateLink: originalLink,
          usedService: false,
          product: null,
          error: error instanceof Error ? error.message : "Falha ao converter link Shopee",
        });
      }
    }

    return {
      data: {
        conversions,
      },
      error: null,
    };
    } finally {
      releaseProcessSlot(slot);
    }
  }

  if (name === "shopee-batch") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;

    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const credentials = snapshot.tables.api_credentials.find((row) => row.user_id === userId && row.provider === "shopee");
    if (!credentials) return fail("Credenciais Shopee não configuradas");
    if (!shopeeServiceConfigured()) {
      return fail("Serviço Shopee não configurado. Defina VITE_SHOPEE_MICROSERVICE_URL e inicie o serviço Shopee.");
    }

    const queries = Array.isArray(body.queries) ? (body.queries as Array<Record<string, unknown>>) : [];
    if (queries.length === 0) return { data: { results: {} }, error: null };

    try {
      const response = await callService<{ results?: Record<string, unknown> }>(
        SHOPEE_MICROSERVICE_URL,
        "/api/shopee/batch",
        {
          method: "POST",
          body: {
            ...getShopeeCredentialPayload(credentials),
            queries,
          },
        },
      );

      return { data: { results: response.results || {} }, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao consultar produtos na Shopee";
      const results: Record<string, unknown> = {};
      for (const query of queries) {
        const id = String(query.id || randomId("query"));
        results[id] = { products: [], hasMore: false, error: message };
      }
      return { data: { results }, error: null };
    }
  }

  if (name === "shopee-automation-run") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;

    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const slot = await acquireProcessSlot("automation");
    await applyProcessQueueDelay(slot);
    try {

    const credentials = snapshot.tables.api_credentials.find((row) => row.user_id === userId && row.provider === "shopee");
    if (!credentials) {
      return {
        data: {
          ok: false,
          processed: 0,
          sent: 0,
          skipped: 0,
          failed: 0,
          message: "Credenciais Shopee não configuradas",
        },
        error: null,
      };
    }

    if (!shopeeServiceConfigured()) {
      return {
        data: {
          ok: false,
          processed: 0,
          sent: 0,
          skipped: 0,
          failed: 0,
          message: "Serviço Shopee não configurado",
        },
        error: null,
      };
    }

    const activeAutomations = snapshot.tables.shopee_automations.filter(
      (row) => row.user_id === userId && row.is_active === true,
    );

    let processed = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    const source = String(body.source || "manual");
    const traceEnabled = body.trace === true;
    const runTraceId = randomId("shopee_trace");

    const trace = (
      sourceLabel: string,
      destinationLabel: string,
      status: AutomationTraceStatus,
      step: string,
      message: string,
      automationId?: string,
      data?: Record<string, unknown>,
    ) => {
      if (!traceEnabled) return;
      withDb((db) => {
        appendAutomationTrace(db, {
          userId,
          sourceLabel,
          destinationLabel,
          status,
          traceId: runTraceId,
          step,
          sourceRun: source,
          message,
          automationId,
          data,
        });
      });
    };

    trace(
      "Piloto automático",
      "run:start",
      "info",
      "run_start",
      "Execução da automação iniciada",
      undefined,
      { activeAutomations: activeAutomations.length },
    );

    for (const automation of activeAutomations) {
      const automationId = String(automation.id);
      const automationName = String(automation.name || "Automação Shopee");
      const sessionId = String(automation.session_id || "");
      const intervalMinutes = Number(automation.interval_minutes || 30);
      const runLockOwner = randomId("shopee_lock");
      let diagnosticReason = "";
      let diagnosticStep = "";
      let diagnosticStatus: "blocked" | "failed" = "blocked";

      const persistAutomationDiagnostic = () => {
        if (!diagnosticReason) return;
        withDb((db) => {
          db.tables.history_entries.push({
            id: randomId("hist"),
            user_id: userId,
            type: "automation_run",
            source: automationName,
            destination: "automation:diagnostic",
            status: diagnosticStatus === "failed" ? "error" : "info",
            details: {
              message: diagnosticReason,
              automationId,
              source,
              step: diagnosticStep,
            },
            direction: "system",
            message_type: "text",
            processing_status: diagnosticStatus,
            block_reason: diagnosticReason,
            error_step: diagnosticStatus === "failed" ? diagnosticStep : "",
            created_at: nowIso(),
          });
        });
      };

      trace(
        automationName,
        "automation:start",
        "info",
        "automation_start",
        "Iniciando avaliação da automação",
        automationId,
        {
          sessionId,
          intervalMinutes,
          activeHoursStart: String(automation.active_hours_start || ""),
          activeHoursEnd: String(automation.active_hours_end || ""),
        },
      );

      if (!sessionId) {
        skipped += 1;
        errors.push(`${automationName}: sem sessão configurada`);
        diagnosticReason = "sem sessão configurada";
        diagnosticStep = "skip_no_session";
        diagnosticStatus = "blocked";
        persistAutomationDiagnostic();
        trace(automationName, "automation:skip", "warning", "skip_no_session", "Automação sem sessão configurada", automationId);
        continue;
      }

      if (!inTimeWindow(automation.active_hours_start, automation.active_hours_end)) {
        skipped += 1;
        diagnosticReason = "fora da janela de horário configurada";
        diagnosticStep = "skip_outside_time_window";
        diagnosticStatus = "blocked";
        persistAutomationDiagnostic();
        trace(automationName, "automation:skip", "warning", "skip_outside_time_window", "Automação fora da janela ativa", automationId);
        continue;
      }

      if (!acquireAutomationRunLock(userId, automationId, runLockOwner)) {
        skipped += 1;
        diagnosticReason = "execução concorrente detectada (outra instância em andamento)";
        diagnosticStep = "skip_lock_not_acquired";
        diagnosticStatus = "blocked";
        persistAutomationDiagnostic();
        trace(
          automationName,
          "automation:skip",
          "warning",
          "skip_lock_not_acquired",
          "Automação ignorada por lock de concorrência",
          automationId,
        );
        continue;
      }

      try {
        const latestAutomation = loadDb().tables.shopee_automations.find(
          (item) => item.id === automationId && item.user_id === userId,
        ) || automation;

      const elapsed = minutesSinceIso(latestAutomation.last_run_at);
      if (elapsed !== null && elapsed * 60_000 + AUTOMATION_INTERVAL_GRACE_MS < intervalMinutes * 60_000) {
        skipped += 1;
        diagnosticReason = `intervalo mínimo ainda não atingido (${Number(elapsed.toFixed(1))} de ${intervalMinutes} min)`;
        diagnosticStep = "skip_interval_not_elapsed";
        diagnosticStatus = "blocked";
        persistAutomationDiagnostic();
        trace(
          automationName,
          "automation:skip",
          "warning",
          "skip_interval_not_elapsed",
          "Automação ignorada por intervalo mínimo",
          automationId,
          { elapsedMinutes: Number(elapsed.toFixed(2)), intervalMinutes },
        );
        continue;
      }

      withDb((db) => {
        const row = db.tables.shopee_automations.find((item) => item.id === automationId && item.user_id === userId);
        if (!row) return;
        row.last_run_at = nowIso();
        row.updated_at = nowIso();
      });

      const minDiscount = Number(latestAutomation.min_discount || 0);
      const minPrice = Number(latestAutomation.min_price || 0);
      const maxPrice = Number(latestAutomation.max_price || 9999);
      const automationConfig = latestAutomation.config && typeof latestAutomation.config === "object" && !Array.isArray(latestAutomation.config)
        ? (latestAutomation.config as Record<string, unknown>)
        : {};
      const offerSourceMode = normalizeShopeeAutomationOfferSourceMode(automationConfig.offerSourceMode);
      const vitrineTabs = normalizeShopeeAutomationVitrineTabs(automationConfig.vitrineTabs);
      const positiveKeywords = toKeywordList(automationConfig.positiveKeywords);
      const negativeKeywords = toKeywordList(automationConfig.negativeKeywords);
      const recentOfferTitles = getRecentOfferTitleSet(latestAutomation);
      let duplicateRejectedCount = 0;
      let filteredCandidatesCount = 0;

      let chosenProduct: Record<string, unknown> | null = null;

      try {
        // Mirror ShopeePesquisa lookup strategy: category (matchId/listType) first,
        // and fallback to keyword when category endpoints are unstable.
        const queryPlans = buildShopeeAutomationQueryPlans(latestAutomation.categories, {
          sourceMode: offerSourceMode,
          vitrineTabs,
        });
        const queries = queryPlans.map((plan) => ({
          id: plan.id,
          type: plan.type,
          params: plan.params,
        }));

        trace(
          automationName,
          "offer:lookup",
          "info",
          "offer_lookup_start",
          "Iniciando busca de ofertas",
          automationId,
          {
            queryPlans: queryPlans.length,
            queryPlanIds: queryPlans.map((plan) => plan.id),
          },
        );

        const batch = await callService<{ results?: Record<string, { products?: unknown[]; error?: string }> }>(
          SHOPEE_MICROSERVICE_URL,
          "/api/shopee/batch",
          {
            method: "POST",
            body: {
              ...getShopeeCredentialPayload(credentials),
              queries,
            },
          },
        );

        const mergedResults: Record<string, { products?: unknown[]; error?: string }> = {
          ...(batch.results || {}),
        };

        trace(
          automationName,
          "offer:lookup",
          "info",
          "offer_lookup_primary_done",
          "Consulta principal de ofertas concluída",
          automationId,
          {
            resultBuckets: Object.keys(mergedResults).length,
            erroredBuckets: Object.values(mergedResults).filter((result) => !!result?.error).length,
          },
        );

        const fallbackPlans = queryPlans.filter((plan) => {
          const result = mergedResults[plan.id];
          const message = String(result?.error || "").toLowerCase();
          return (
            !!plan.fallbackKeyword &&
            (message.includes("wrong type") || message.includes("system error") || message.includes("fetch failed"))
          );
        });

        if (fallbackPlans.length > 0) {
          trace(
            automationName,
            "offer:lookup",
            "warning",
            "offer_lookup_fallback_start",
            "Executando fallback por palavra-chave",
            automationId,
            { fallbackPlans: fallbackPlans.length },
          );
          const fallbackBatch = await callService<{ results?: Record<string, { products?: unknown[]; error?: string }> }>(
            SHOPEE_MICROSERVICE_URL,
            "/api/shopee/batch",
            {
              method: "POST",
              body: {
                ...getShopeeCredentialPayload(credentials),
                queries: fallbackPlans.map((plan) => ({
                  id: plan.id,
                  type: "search",
                  params: {
                    keyword: plan.fallbackKeyword,
                    sortBy: "sales",
                    limit: 20,
                    page: 1,
                  },
                })),
              },
            },
          );

          for (const plan of fallbackPlans) {
            const fallbackResult = fallbackBatch.results?.[plan.id];
            if (!fallbackResult) continue;
            mergedResults[plan.id] = fallbackResult;
          }

          trace(
            automationName,
            "offer:lookup",
            "info",
            "offer_lookup_fallback_done",
            "Fallback de ofertas concluído",
            automationId,
          );
        }

        // Collect all products from all category queries
        const allProducts: Record<string, unknown>[] = [];
        for (const qId of Object.keys(mergedResults)) {
          const result = mergedResults[qId];
          if (result?.error) continue;
          const prods = Array.isArray(result?.products) ? result.products : [];
          for (const p of prods) {
            if (p && typeof p === "object") allProducts.push(p as Record<string, unknown>);
          }
        }

        if (Object.values(mergedResults).length > 0 && Object.values(mergedResults).every((r) => r?.error)) {
          const firstError = Object.values(mergedResults)[0]?.error || "falha ao consultar Shopee";
          failed += 1;
          errors.push(`${automationName}: ${firstError}`);
          diagnosticReason = `falha na captura de ofertas: ${firstError}`;
          diagnosticStep = "offer_lookup_all_queries_failed";
          diagnosticStatus = "failed";
          persistAutomationDiagnostic();
          trace(
            automationName,
            "offer:lookup",
            "error",
            "offer_lookup_all_queries_failed",
            "Todas as consultas de oferta falharam",
            automationId,
            {
              firstError,
              resultBuckets: Object.keys(mergedResults).length,
            },
          );
          continue;
        }

        // Apply filters: minDiscount, minPrice, maxPrice
        const filtered = allProducts
          .filter((item) => Number(item.discount || 0) >= minDiscount)
          .filter((item) => Number(item.salePrice || 0) >= minPrice)
          .filter((item) => Number(item.salePrice || 0) <= maxPrice)
          .filter((item) => {
            const productText = buildAutomationProductKeywordText(item);
            if (negativeKeywords.length > 0 && textMatchesAnyKeyword(productText, negativeKeywords)) return false;
            if (positiveKeywords.length > 0 && !textMatchesAnyKeyword(productText, positiveKeywords)) return false;
            return true;
          });
        filteredCandidatesCount = filtered.length;

        // Enforce affiliate-only products: if there is no real offerLink, this offer cannot be dispatched.
        const withAffiliateLink = filtered.filter((item) => extractValidShopeeAffiliateLink(item).length > 0);
        const duplicateCount = withAffiliateLink.filter((item) => {
          const normalizedTitle = normalizeOfferTitle(item.title);
          return normalizedTitle && recentOfferTitles.has(normalizedTitle);
        }).length;

        trace(
          automationName,
          "offer:filter",
          "info",
          "offer_filter_done",
          "Filtro de ofertas concluído",
          automationId,
          {
            fetchedProducts: allProducts.length,
            filteredProducts: filtered.length,
            affiliateProducts: withAffiliateLink.length,
            positiveKeywordsCount: positiveKeywords.length,
            negativeKeywordsCount: negativeKeywords.length,
            recentMemorySize: recentOfferTitles.size,
            duplicateCandidates: duplicateCount,
          },
        );

        const pickFreshOffer = (products: Record<string, unknown>[]) => {
          for (const item of products) {
            const normalizedTitle = normalizeOfferTitle(item.title);
            if (!normalizedTitle) continue;
            if (recentOfferTitles.has(normalizedTitle)) {
              duplicateRejectedCount += 1;
              continue;
            }
            return item;
          }
          return null;
        };

        chosenProduct = pickFreshOffer(withAffiliateLink);

        // When no fresh product is found in page 1, keep searching more pages.
        if (!chosenProduct && recentOfferTitles.size > 0) {
          const activePlans = queryPlans.filter((plan) => {
            const result = mergedResults[plan.id];
            return result && !result.error;
          });

          for (let nextPage = 2; nextPage <= 6 && !chosenProduct; nextPage++) {
            if (activePlans.length === 0) break;
            try {
              const nextBatch = await callService<{ results?: Record<string, { products?: unknown[]; error?: string }> }>(
                SHOPEE_MICROSERVICE_URL,
                "/api/shopee/batch",
                {
                  method: "POST",
                  body: {
                    ...getShopeeCredentialPayload(credentials),
                    queries: activePlans.map((plan) => ({
                      id: plan.id,
                      type: "search",
                      params: {
                        ...plan.params,
                        keyword: plan.fallbackKeyword || (plan.params.keyword as string) || undefined,
                        matchId: undefined,
                        listType: undefined,
                        page: nextPage,
                      },
                    })),
                  },
                },
              );

              const nextProducts: Record<string, unknown>[] = [];
              for (const qId of Object.keys(nextBatch.results || {})) {
                const result = nextBatch.results?.[qId];
                if (!result || result.error) continue;
                const prods = Array.isArray(result.products) ? result.products : [];
                for (const p of prods) {
                  if (p && typeof p === "object") nextProducts.push(p as Record<string, unknown>);
                }
              }

              const nextFiltered = nextProducts
                .filter((item) => Number(item.discount || 0) >= minDiscount)
                .filter((item) => Number(item.salePrice || 0) >= minPrice)
                .filter((item) => Number(item.salePrice || 0) <= maxPrice)
                .filter((item) => extractValidShopeeAffiliateLink(item).length > 0);

              trace(
                automationName,
                "offer:pagination",
                "info",
                "offer_pagination_page_checked",
                "Página adicional analisada para evitar duplicidade",
                automationId,
                {
                  page: nextPage,
                  fetchedProducts: nextProducts.length,
                  eligibleProducts: nextFiltered.length,
                },
              );

              chosenProduct = pickFreshOffer(nextFiltered);

              if (nextProducts.length === 0) break;
            } catch {
              break;
            }
          }
        }
      } catch (error) {
        failed += 1;
        errors.push(`${automationName}: ${error instanceof Error ? error.message : "falha ao consultar Shopee"}`);
        diagnosticReason = `erro na captura de ofertas: ${error instanceof Error ? error.message : "falha ao consultar Shopee"}`;
        diagnosticStep = "offer_lookup_failed";
        diagnosticStatus = "failed";
        persistAutomationDiagnostic();
        trace(
          automationName,
          "offer:lookup",
          "error",
          "offer_lookup_failed",
          "Falha ao consultar ofertas da Shopee",
          automationId,
          { error: error instanceof Error ? error.message : "falha ao consultar Shopee" },
        );
        continue;
      }

      if (!chosenProduct) {
        skipped += 1;
        if (recentOfferTitles.size > 0) {
          errors.push(`${automationName}: sem nova oferta disponível (duplicadas descartadas nesta execução: ${duplicateRejectedCount})`);
          diagnosticReason = "sem oferta nova (bloqueada por deduplicação)";
          diagnosticStep = "offer_duplicate_blocked";
          diagnosticStatus = "blocked";
          persistAutomationDiagnostic();
          trace(
            automationName,
            "offer:dedupe",
            "warning",
            "offer_duplicate_blocked",
            "Oferta ignorada por duplicidade recente",
            automationId,
            {
              duplicateRejectedCount,
              recentMemorySize: recentOfferTitles.size,
            },
          );
        } else if (filteredCandidatesCount === 0) {
          errors.push(`${automationName}: nenhuma oferta correspondeu aos filtros configurados`);
          diagnosticReason = "nenhuma oferta correspondeu aos filtros configurados";
          diagnosticStep = "offer_no_match_filters";
          diagnosticStatus = "blocked";
          persistAutomationDiagnostic();
          trace(
            automationName,
            "offer:filter",
            "warning",
            "offer_no_match_filters",
            "Nenhuma oferta correspondeu aos filtros desta automação",
            automationId,
            {
              minDiscount,
              minPrice,
              maxPrice,
              positiveKeywordsCount: positiveKeywords.length,
              negativeKeywordsCount: negativeKeywords.length,
            },
          );
        } else {
          errors.push(`${automationName}: nenhuma oferta com link de afiliado disponível no momento`);
          diagnosticReason = "nenhuma oferta elegível com link de afiliado";
          diagnosticStep = "offer_not_found";
          diagnosticStatus = "blocked";
          persistAutomationDiagnostic();
          trace(
            automationName,
            "offer:lookup",
            "warning",
            "offer_not_found",
            "Nenhuma oferta elegível encontrada",
            automationId,
          );
        }
        continue;
      }

      trace(
        automationName,
        "offer:selected",
        "success",
        "offer_selected",
        "Oferta escolhida para envio",
        automationId,
        {
          offerTitle: String(chosenProduct.title || ""),
          offerPrice: Number(chosenProduct.salePrice || 0),
          offerDiscount: Number(chosenProduct.discount || 0),
        },
      );

      const template = snapshot.tables.templates.find(
        (row) => row.user_id === userId && row.id === latestAutomation.template_id,
      ) || snapshot.tables.templates.find(
        (row) => row.user_id === userId && row.is_default === true,
      );

      const affiliateLink = extractValidShopeeAffiliateLink(chosenProduct);
      if (!affiliateLink) {
        skipped += 1;
        errors.push(`${automationName}: oferta selecionada sem link de afiliado válido`);
        diagnosticReason = "oferta selecionada sem link de afiliado válido";
        diagnosticStep = "offer_missing_affiliate_link";
        diagnosticStatus = "blocked";
        persistAutomationDiagnostic();
        trace(
          automationName,
          "offer:validate",
          "warning",
          "offer_missing_affiliate_link",
          "Oferta sem link de afiliado válido",
          automationId,
        );
        continue;
      }

      const title = String(chosenProduct.title || "Oferta Shopee");
      const templateContent = template && typeof template.content === "string"
        ? template.content
        : "";
      trace(
        automationName,
        "message:format",
        "info",
        "message_format_start",
        "Iniciando formatação da mensagem",
        automationId,
        {
          hasTemplate: !!template,
          templateId: String(template?.id || ""),
          templateName: String(template?.name || ""),
        },
      );
      const message = templateContent
        ? buildShopeeMessageFromTemplate(templateContent, chosenProduct, affiliateLink)
        : `${title}\n${affiliateLink}`;
      const templateExplicitlyRequestsImage = templateRequestsAutomationImage(templateContent);
      const shouldAttachAutomationImage = true;
      trace(
        automationName,
        "message:format",
        "success",
        "message_format_done",
        "Mensagem formatada",
        automationId,
        {
          messageLength: message.length,
          usesTemplate: templateContent.length > 0,
          attachImage: shouldAttachAutomationImage,
          templateRequestedImage: templateExplicitlyRequestsImage,
          imageAttachMode: templateExplicitlyRequestsImage ? "placeholder_or_default" : "default_only",
          hasAffiliateLink: affiliateLink.length > 0,
        },
      );

      const directGroupIds = Array.isArray(latestAutomation.destination_group_ids)
        ? (latestAutomation.destination_group_ids as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
      const masterGroupIds = Array.isArray(latestAutomation.master_group_ids)
        ? (latestAutomation.master_group_ids as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
      const linkedGroupIds = snapshot.tables.master_group_links
        .filter((row) => masterGroupIds.includes(String(row.master_group_id)) && row.is_active !== false)
        .map((row) => String(row.group_id));

      const destinationIds = [...new Set([...directGroupIds, ...linkedGroupIds])];
      const allDestinationGroups = snapshot.tables.groups.filter(
        (group) =>
          group.user_id === userId &&
          destinationIds.includes(String(group.id)),
      );

      // Plan-gated cap: limit how many groups this automation may dispatch to.
      const userProfile = snapshot.tables.profiles.find((row) => row.user_id === userId);
      const userPlanId = String(userProfile?.plan_id || "plan-starter");
      const userLimits = resolveEffectiveLimitsByPlanId(userPlanId);
      const maxGroupsPerAutomation = userLimits?.groupsPerAutomation ?? -1;
      const destinationGroups = maxGroupsPerAutomation !== -1 && allDestinationGroups.length > maxGroupsPerAutomation
        ? allDestinationGroups.slice(0, maxGroupsPerAutomation)
        : allDestinationGroups;
      if (maxGroupsPerAutomation !== -1 && allDestinationGroups.length > maxGroupsPerAutomation) {
        console.warn(`[shopee-automation-run] [${automationName}] dispatch capped at ${maxGroupsPerAutomation} groups (plan: ${userPlanId}), had ${allDestinationGroups.length}`);
      }

      if (destinationGroups.length === 0) {
        failed += 1;
        errors.push(`${automationName}: nenhum grupo destino válido para a sessão selecionada`);
        diagnosticReason = "nenhum grupo destino válido para a sessão selecionada";
        diagnosticStep = "destination_resolution_failed";
        diagnosticStatus = "failed";
        persistAutomationDiagnostic();
        console.warn(`[shopee-automation-run] [${automationName}] no dest groups. directGroupIds=${directGroupIds.length}, masterGroupIds=${masterGroupIds.length}, linkedGroupIds=${linkedGroupIds.length}, destinationIds=${destinationIds.length}`);
        trace(
          automationName,
          "dispatch:resolve",
          "error",
          "destination_resolution_failed",
          "Nenhum grupo destino válido encontrado",
          automationId,
          {
            directGroupIds: directGroupIds.length,
            masterGroupIds: masterGroupIds.length,
            linkedGroupIds: linkedGroupIds.length,
            destinationIds: destinationIds.length,
          },
        );
        continue;
      }

      console.warn(`[shopee-automation-run] [${automationName}] sending to ${destinationGroups.length} groups (platforms: ${destinationGroups.map((g) => g.platform).join(",")})`);
      trace(
        automationName,
        "dispatch:start",
        "info",
        "dispatch_start",
        "Iniciando tentativa de envio para grupos destino",
        automationId,
        {
          destinationGroups: destinationGroups.length,
          platforms: destinationGroups.map((g) => String(g.platform || "")),
        },
      );
      let automationMedia: OutboundMediaPayload | null = null;
      if (shouldAttachAutomationImage) {
        // Build media once per automation attempt and reuse it across destination groups.
        try {
          automationMedia = await buildAutomationImageMedia(chosenProduct);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Envio cancelado: falha ao anexar imagem.";
          failed += destinationGroups.length;
          errors.push(`${automationName}: ${reason}`);
          diagnosticReason = `falha ao preparar mídia da automação: ${reason}`;
          diagnosticStep = "automation_media_failed";
          diagnosticStatus = "failed";
          persistAutomationDiagnostic();
          trace(
            automationName,
            "dispatch:media",
            "error",
            "automation_media_failed",
            "Falha ao preparar mídia da automação",
            automationId,
            { reason },
          );

          withDb((db) => {
            for (const group of destinationGroups) {
              db.tables.history_entries.push({
                id: randomId("hist"),
                user_id: userId,
                type: "automation_run",
                source: automationName,
                destination: String(group.name || group.id),
                status: "error",
                details: {
                  message,
                  product: chosenProduct,
                  automationId,
                  source,
                  reason,
                  platform: String(group.platform || ""),
                  hasMedia: !!automationMedia,
                },
                direction: "outbound",
                message_type: automationMedia ? "image" : "text",
                processing_status: "failed",
                block_reason: reason,
                error_step: "automation_send",
                created_at: nowIso(),
              });
            }
          });
          continue;
        }
      }

      let sentThisAutomation = 0;
      for (const group of destinationGroups) {
        const groupPlatform = String(group.platform || "");
        const groupSessionId = String(group.session_id || "");
        let isSessionOnline = groupPlatform === "whatsapp"
          ? snapshot.tables.whatsapp_sessions.some(
            (row) => row.user_id === userId && String(row.id) === groupSessionId && String(row.status || "") === "online",
          )
          : groupPlatform === "telegram"
            ? snapshot.tables.telegram_sessions.some(
              (row) => row.user_id === userId && String(row.id) === groupSessionId && String(row.status || "") === "online",
            )
            : false;

        trace(
          automationName,
          `dispatch:precheck:${String(group.name || group.id)}`,
          "info",
          "destination_precheck",
          "Validando sessão de destino antes do envio",
          automationId,
          {
            groupId: String(group.id || ""),
            groupName: String(group.name || group.id),
            platform: groupPlatform,
            sessionId: groupSessionId,
            initialSessionOnline: isSessionOnline,
          },
        );

        if (!isSessionOnline && groupSessionId) {
          // Reconcile stale local status from channel events before blocking the send.
          if (groupPlatform === "whatsapp") {
            await pollWhatsappEventsForSession(userId, groupSessionId).catch(() => 0);
          } else if (groupPlatform === "telegram") {
            await pollTelegramEventsForSession(userId, groupSessionId).catch(() => 0);
          }

          trace(
            automationName,
            `dispatch:precheck:${String(group.name || group.id)}`,
            "info",
            "destination_precheck_reconciled",
            "Reconciliacao de status da sessão executada",
            automationId,
            {
              groupId: String(group.id || ""),
              groupName: String(group.name || group.id),
              platform: groupPlatform,
              sessionId: groupSessionId,
            },
          );

          const refreshedSnapshot = loadDb();
          isSessionOnline = groupPlatform === "whatsapp"
            ? refreshedSnapshot.tables.whatsapp_sessions.some(
              (row) => row.user_id === userId && String(row.id) === groupSessionId && String(row.status || "") === "online",
            )
            : groupPlatform === "telegram"
              ? refreshedSnapshot.tables.telegram_sessions.some(
                (row) => row.user_id === userId && String(row.id) === groupSessionId && String(row.status || "") === "online",
              )
              : false;

          // If still offline after event poll, cross-check against the health endpoint directly.
          // This handles the case where the Telegram session has no queued events (empty queue)
          // so no connection_update was applied, even though the session is actually online.
          if (!isSessionOnline && groupPlatform === "telegram" && TELEGRAM_MICROSERVICE_URL) {
            try {
              const health = await callService<{ sessions?: Array<{ sessionId: string; status: string }> }>(
                TELEGRAM_MICROSERVICE_URL,
                "/health",
              );
              const healthSession = Array.isArray(health.sessions)
                ? health.sessions.find((s) => s.sessionId === groupSessionId)
                : null;
              if (healthSession?.status === "online") {
                withDb((db) => {
                  const row = db.tables.telegram_sessions.find(
                    (item) => item.id === groupSessionId && item.user_id === userId,
                  );
                  if (row) {
                    row.status = "online";
                    row.connected_at = row.connected_at || nowIso();
                    row.updated_at = nowIso();
                  }
                });
                isSessionOnline = true;
                trace(
                  automationName,
                  `dispatch:precheck:${String(group.name || group.id)}`,
                  "success",
                  "destination_precheck_health_override",
                  "Sessão Telegram confirmada online via health",
                  automationId,
                  {
                    groupId: String(group.id || ""),
                    groupName: String(group.name || group.id),
                    sessionId: groupSessionId,
                  },
                );
              }
            } catch {
              // health check failed - keep isSessionOnline as-is
              trace(
                automationName,
                `dispatch:precheck:${String(group.name || group.id)}`,
                "warning",
                "destination_precheck_health_failed",
                "Falha ao consultar health do Telegram",
                automationId,
                {
                  groupId: String(group.id || ""),
                  groupName: String(group.name || group.id),
                  sessionId: groupSessionId,
                },
              );
            }
          }
        }

        if (!isSessionOnline) {
          skipped += 1;
          const reason = `sessão ${groupPlatform || "desconhecida"} offline`;
          errors.push(`${automationName} -> ${String(group.name || group.id)}: ${reason}`);
          trace(
            automationName,
            `dispatch:block:${String(group.name || group.id)}`,
            "warning",
            "destination_session_offline",
            "Envio bloqueado por sessão de destino offline",
            automationId,
            {
              groupId: String(group.id || ""),
              groupName: String(group.name || group.id),
              platform: groupPlatform,
            },
          );

          withDb((db) => {
            db.tables.history_entries.push({
              id: randomId("hist"),
              user_id: userId,
              type: "automation_run",
              source: automationName,
              destination: String(group.name || group.id),
              status: "info",
              details: {
                message,
                product: chosenProduct,
                automationId,
                source,
                reason,
                platform: groupPlatform,
                hasMedia: !!automationMedia,
              },
              direction: "outbound",
              message_type: automationMedia ? "image" : "text",
              processing_status: "blocked",
              block_reason: "destination_session_offline",
              error_step: "automation_send",
              created_at: nowIso(),
            });
          });
          continue;
        }

        try {
          trace(
            automationName,
            `dispatch:attempt:${String(group.name || group.id)}`,
            "info",
            "send_attempt",
            "Tentativa de envio iniciada",
            automationId,
            {
              groupId: String(group.id || ""),
              groupName: String(group.name || group.id),
              platform: String(group.platform || ""),
            },
          );
          await sendMessageToGroup(userId, group, message, automationMedia);
          sent += 1;
          sentThisAutomation += 1;
          trace(
            automationName,
            `dispatch:success:${String(group.name || group.id)}`,
            "success",
            "send_success",
            "Envio concluído com sucesso",
            automationId,
            {
              groupId: String(group.id || ""),
              groupName: String(group.name || group.id),
              platform: String(group.platform || ""),
            },
          );

          withDb((db) => {
            db.tables.history_entries.push({
              id: randomId("hist"),
              user_id: userId,
              type: "automation_run",
              source: automationName,
              destination: String(group.name || group.id),
              status: "success",
              details: {
                message,
                product: chosenProduct,
                automationId,
                source,
                platform: String(group.platform || ""),
                hasMedia: !!automationMedia,
              },
              direction: "outbound",
              message_type: automationMedia ? "image" : "text",
              processing_status: "sent",
              block_reason: "",
              error_step: "",
              created_at: nowIso(),
            });
          });
        } catch (error) {
          failed += 1;
          const reason = error instanceof Error ? error.message : "falha no envio";
          errors.push(`${automationName} -> ${String(group.name || group.id)}: ${reason}`);
          trace(
            automationName,
            `dispatch:error:${String(group.name || group.id)}`,
            "error",
            "send_failed",
            "Falha durante envio da oferta",
            automationId,
            {
              groupId: String(group.id || ""),
              groupName: String(group.name || group.id),
              platform: String(group.platform || ""),
              reason,
            },
          );

          withDb((db) => {
            db.tables.history_entries.push({
              id: randomId("hist"),
              user_id: userId,
              type: "automation_run",
              source: automationName,
              destination: String(group.name || group.id),
              status: "error",
              details: {
                message,
                product: chosenProduct,
                automationId,
                source,
                reason,
                platform: String(group.platform || ""),
                hasMedia: !!automationMedia,
              },
              direction: "outbound",
              message_type: automationMedia ? "image" : "text",
              processing_status: "failed",
              block_reason: reason,
              error_step: "automation_send",
              created_at: nowIso(),
            });
          });
        }
      }

      withDb((db) => {
        const row = db.tables.shopee_automations.find((item) => item.id === automationId && item.user_id === userId);
        if (!row) return;
        row.products_sent = Number(row.products_sent || 0) + sentThisAutomation;
        if (sentThisAutomation > 0) {
          row.recent_offer_titles = appendRecentOfferTitleMemory(
            row.recent_offer_titles,
            chosenProduct?.title,
            nowIso(),
          );
        }
        row.updated_at = nowIso();
      });

      if (sentThisAutomation > 0) {
        processed += 1;
      }

      trace(
        automationName,
        "automation:done",
        sentThisAutomation > 0 ? "success" : "warning",
        "automation_done",
        sentThisAutomation > 0 ? "Automação concluída com envios" : "Automação concluída sem envios",
        automationId,
        {
          sentThisAutomation,
        },
      );
      } finally {
        releaseAutomationRunLock(userId, automationId, runLockOwner);
      }
    }

    if (failed > 0 || skipped > 0) {
      console.warn("[shopee-automation-run] completed with warnings", {
        source,
        active: activeAutomations.length,
        processed,
        sent,
        skipped,
        failed,
        errors: errors.slice(0, 10),
      });
    } else {
      console.info("[shopee-automation-run] completed", {
        source,
        active: activeAutomations.length,
        processed,
        sent,
        skipped,
        failed,
      });
    }

    trace(
      "Piloto automático",
      "run:done",
      failed > 0 ? "warning" : "success",
      "run_done",
      "Execução da automação finalizada",
      undefined,
      {
        active: activeAutomations.length,
        processed,
        sent,
        skipped,
        failed,
      },
    );

    return {
      data: {
        ok: true,
        source,
        traceEnabled,
        traceId: traceEnabled ? runTraceId : null,
        active: activeAutomations.length,
        processed,
        sent,
        skipped,
        failed,
        errors,
      },
      error: null,
    };
    } finally {
      releaseProcessSlot(slot);
    }
  }

  // --- Mercado Livre RPA RPCs ----------------------------------------------

  if (name === "meli-save-session") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const requestedSessionId = String(body.sessionId || "").trim();
    const sessionName = String(body.name || "").trim();
    const cookiesRaw = body.cookies;

    if (!requestedSessionId) return fail("sessionId é obrigatório");
    if (!cookiesRaw) return fail("cookies é obrigatório");

    const existingUserSessions = Array.isArray(snapshot.tables.meli_sessions)
      ? snapshot.tables.meli_sessions
        .filter((row) => row.user_id === userId)
        .sort((a, b) => {
          const aTime = Date.parse(String(a.updated_at || a.created_at || ""));
          const bTime = Date.parse(String(b.updated_at || b.created_at || ""));
          const safeA = Number.isFinite(aTime) ? aTime : 0;
          const safeB = Number.isFinite(bTime) ? bTime : 0;
          return safeB - safeA;
        })
      : [];
    const canonicalSessionId = String(existingUserSessions[0]?.id || requestedSessionId).trim();
    const canonicalSession = existingUserSessions.find((row) => String(row.id) === canonicalSessionId) || null;
    const staleSessionIds = existingUserSessions
      .map((row) => String(row.id || "").trim())
      .filter((id) => id && id !== canonicalSessionId);
    const scopedSessionId = buildScopedMeliSessionId(userId, canonicalSessionId);

    // -- Validate cookies locally (no service required) ----------------------
    let cookieArr: Array<{ name: string; value: string }>;
    try {
      let parsed: unknown;
      if (typeof cookiesRaw === "string") {
        parsed = JSON.parse(cookiesRaw);
      } else {
        parsed = cookiesRaw;
      }
      if (Array.isArray(parsed)) {
        cookieArr = parsed as typeof cookieArr;
      } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).cookies)) {
        cookieArr = (parsed as Record<string, unknown>).cookies as typeof cookieArr;
      } else {
        return fail("Formato inválido. Esperado { cookies: [...] } ou [...]");
      }
    } catch {
      return fail("JSON de cookies inválido");
    }

    const hasMercadoLivreDomainCookie = cookieArr.some((cookie) => {
      const domain = String((cookie as { domain?: unknown }).domain || "").toLowerCase();
      return domain.includes("mercadolivre") || domain.includes("mercadolibre") || domain.includes("meli.la");
    });
    if (!hasMercadoLivreDomainCookie) {
      return fail("Os cookies enviados não parecem ser do Mercado Livre. Exporte os cookies da página mercadolivre.com.br/afiliados/linkbuilder.");
    }

    // Extract metadata from cookie values (no browser/service needed)
    const orgnickp = cookieArr.find((c) => c.name === "orgnickp");
    const orguseridp = cookieArr.find((c) => c.name === "orguseridp");
    const localAccountName = orgnickp?.value || undefined;
    const localMlUserId = orguseridp?.value || undefined;

    const cookiesJson = typeof cookiesRaw === "string" ? cookiesRaw : JSON.stringify(cookiesRaw);
    const now = nowIso();

    // -- Save session to local DB immediately (offline-safe) -----------------
    withDb((db) => {
      if (!Array.isArray(db.tables.meli_sessions)) db.tables.meli_sessions = [];
      db.tables.meli_sessions = db.tables.meli_sessions.filter((row) => {
        if (row.user_id !== userId) return true;
        return !staleSessionIds.includes(String(row.id || "").trim());
      });

      const existing = db.tables.meli_sessions.find((row) => row.user_id === userId && row.id === canonicalSessionId);
      if (existing) {
        if (localAccountName) existing.account_name = localAccountName;
        if (localMlUserId) existing.ml_user_id = localMlUserId;
        existing.status = "untested";
        existing.error_message = "";
        existing.pending_cookies = cookiesJson;
        existing.updated_at = now;
        if (sessionName) existing.name = sessionName;
      } else {
        db.tables.meli_sessions.push({
          id: canonicalSessionId,
          user_id: userId,
          name: sessionName || localAccountName || String(canonicalSession?.name || "").trim() || canonicalSessionId,
          account_name: localAccountName || "",
          ml_user_id: localMlUserId || "",
          status: "untested",
          last_checked_at: null,
          error_message: "",
          pending_cookies: cookiesJson,
          created_at: now,
          updated_at: now,
        });
      }
    });

    // -- Best-effort: sync cookies to RPA service (no failure if offline) ----
    try {
      const response = await callService<{
        status?: string;
        accountName?: string;
        mlUserId?: string;
        logs?: unknown[];
      }>(MELI_RPA_URL, "/api/meli/sessions", {
        method: "POST",
        userId,
        body: { sessionId: scopedSessionId, cookies: cookiesRaw },
      });

      for (const staleSessionId of staleSessionIds) {
        const staleScopedSessionId = buildScopedMeliSessionId(userId, staleSessionId);
        try {
          await callService(MELI_RPA_URL, `/api/meli/sessions/${encodeURIComponent(staleScopedSessionId)}`, {
            method: "DELETE",
            userId,
          });
        } catch {
          // Ignore cleanup failures for stale sessions.
        }
      }

      // Service responded - update with real metadata and clear pending
      withDb((db) => {
        const row = db.tables.meli_sessions?.find((r) => r.user_id === userId && r.id === canonicalSessionId);
        if (row) {
          if (response.accountName) row.account_name = String(response.accountName);
          if (response.mlUserId) row.ml_user_id = String(response.mlUserId);
          delete row.pending_cookies;
          row.updated_at = nowIso();
        }
      });
      return { data: { success: true, accountName: response.accountName || localAccountName, mlUserId: response.mlUserId || localMlUserId, logs: response.logs }, error: null };
    } catch {
      // Service offline - session already saved locally, will sync on test
      return { data: { success: true, accountName: localAccountName, mlUserId: localMlUserId, logs: [] }, error: null };
    }
  }

  if (name === "meli-service-health") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const health = await getServiceHealth(MELI_RPA_URL, "/api/meli/health");
    return { data: health, error: null };
  }

  if (name === "process-queue-health") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    if (!userIsAdmin(authSnapshot, userId)) return fail("Acesso negado");

    return {
      data: {
        ok: true,
        checkedAt: nowIso(),
        queues: getProcessQueueSnapshot(),
      },
      error: null,
    };
  }

  if (name === "ops-service-health") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    if (!userIsAdmin(authSnapshot, userId)) return fail("Acesso negado");
    const ops = await fetchOpsServiceHealthSnapshot(userId);
    return { data: ops, error: null };
  }

  if (name === "admin-system-observability") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    if (!userIsAdmin(authSnapshot, userId)) return fail("Acesso negado");

    const snapshot = loadDb();
    const usage = buildAdminObservabilitySnapshot(snapshot);
    const queues = getProcessQueueSnapshot();
    const ops = await fetchOpsServiceHealthSnapshot(userId);

    const anomalies = [...usage.anomalies];

    for (const [queueName, queue] of Object.entries(queues)) {
      const limit = Number(queue.limit || 0);
      const pending = Number(queue.pending || 0);
      if (!Number.isFinite(limit) || limit <= 0) continue;

      if (pending >= (limit * 2)) {
        anomalies.push({
          id: `queue-critical:${queueName}`,
          severity: "critical",
          title: `Fila ${queueName} em pressao critica`,
          message: `Fila ${queueName} possui ${pending} itens pendentes para limite ${limit}.`,
          metric: "queuePending",
          value: pending,
          threshold: limit * 2,
        });
      } else if (pending >= limit) {
        anomalies.push({
          id: `queue-warning:${queueName}`,
          severity: "warning",
          title: `Fila ${queueName} em alerta`,
          message: `Fila ${queueName} possui ${pending} itens pendentes para limite ${limit}.`,
          metric: "queuePending",
          value: pending,
          threshold: limit,
        });
      }
    }

    if (ops.online !== true) {
      anomalies.push({
        id: "ops-offline",
        severity: "critical",
        title: "Ops Control indisponivel",
        message: String(ops.error || "Nao foi possivel obter telemetria do Ops Control."),
      });
    }

    anomalies.sort((a, b) => {
      const weight = (value: string) => (value === "critical" ? 3 : value === "warning" ? 2 : 1);
      return weight(b.severity) - weight(a.severity);
    });

    return {
      data: {
        ok: true,
        checkedAt: nowIso(),
        global: usage.global,
        users: usage.users,
        rankings: usage.rankings,
        anomalies: anomalies.slice(0, 50),
        workers: {
          ops,
          queues,
        },
      },
      error: null,
    };
  }

  if (name === "ops-service-control") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    if (!userIsAdmin(authSnapshot, userId)) return fail("Acesso negado");
    if (!OPS_CONTROL_URL) return fail("Serviço Ops não configurado (VITE_OPS_CONTROL_URL)");

    const service = parseOpsServiceId(body.service);
    const operation = parseOpsAction(body.operation || body.action);
    if (!service) return fail("Serviço inválido");
    if (!operation) return fail("Ação inválida");

    try {
      const result = await callService<Record<string, unknown>>(
        OPS_CONTROL_URL,
        `/api/services/${encodeURIComponent(service)}/${encodeURIComponent(operation)}`,
        {
          method: "POST",
          userId,
          body: { source: "admin-panel" },
          headers: OPS_CONTROL_TOKEN ? { "x-ops-token": OPS_CONTROL_TOKEN } : undefined,
        },
      );

      withDb((db) => {
        appendAudit(db, "ops_service_control", userId, null, {
          service,
          operation,
          ok: result.ok === true,
          status: String(result.status || ""),
          app_name: String(result.appName || ""),
          results: Array.isArray(result.results) ? result.results : undefined,
        });
      });

      return {
        data: {
          ok: result.ok === true,
          service,
          operation,
          status: String(result.status || ""),
          appName: String(result.appName || ""),
          results: Array.isArray(result.results) ? result.results : [],
        },
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      withDb((db) => {
        appendAudit(db, "ops_service_control", userId, null, {
          service,
          operation,
          ok: false,
          error: message,
        });
      });

      return fail(message);
    }
  }

  if (name === "ops-service-ports") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    if (!userIsAdmin(authSnapshot, userId)) return fail("Acesso negado");

    return {
      data: {
        ok: true,
        services: [],
      },
      error: null,
    };
  }

  if (name === "ops-service-port") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    if (!userIsAdmin(authSnapshot, userId)) return fail("Acesso negado");

    const service = parseOpsServiceId(body.service || body.id);
    if (!service || service === "all") return fail("Serviço inválido");

    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail("Porta inválida");

    withDb((db) => {
      appendAudit(db, "ops_service_port", userId, null, {
        service,
        port,
        ok: true,
        source: "local-stub",
      });
    });

    return {
      data: {
        ok: true,
        service,
        port,
        status: "updated",
      },
      error: null,
    };
  }

  if (name === "ops-bootstrap") {
    if (!currentUser || !userId) return fail("Usuário não autenticado");
    if (!userIsAdmin(authSnapshot, userId)) return fail("Acesso negado");

    return {
      data: {
        ok: true,
        online: true,
        started: false,
        url: OPS_CONTROL_URL || "",
      },
      error: null,
    };
  }

  if (name === "meli-test-session") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) return fail("sessionId é obrigatório");
    const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);

    // -- If session has pending_cookies, sync to RPA service first -----------
    const sessionRow = snapshot.tables.meli_sessions?.find((r) => r.user_id === userId && r.id === sessionId);
    if (sessionRow?.pending_cookies) {
      try {
        await syncPendingMeliCookies(userId, sessionId);
        // Verify sync succeeded (pending_cookies should be cleared)
        const refreshed = loadDb().tables.meli_sessions?.find((r) => r.user_id === userId && r.id === sessionId);
        if (refreshed?.pending_cookies) {
          return fail("Serviço Mercado Livre (porta 3114) não está disponível. Inicie o serviço RPA e tente novamente.");
        }
      } catch {
        return fail("Serviço Mercado Livre (porta 3114) não está disponível. Inicie o serviço RPA e tente novamente.");
      }
    }

    try {
      const response = await callService<{
        status?: string;
        accountName?: string;
        mlUserId?: string;
        lastChecked?: string;
        logs?: unknown[];
      }>(MELI_RPA_URL, `/api/meli/sessions/${encodeURIComponent(scopedSessionId)}/test?full=1`, {
        method: "POST",
        userId,
      });

      const status = String(response.status || "error");
      const statusErrorMap: Record<string, string> = {
        expired: "Sessão expirada - reimporte cookies atualizados.",
        not_found: "Sessão não encontrada no serviço RPA.",
        no_affiliate: "Conta autenticada, mas sem acesso ao programa de afiliados.",
        error: "Falha ao validar sessão no serviço Mercado Livre.",
      };
      const logs = Array.isArray(response.logs) ? response.logs : [];
      const latestLogMessage = logs
        .slice()
        .reverse()
        .find((entry) => {
          if (!entry || typeof entry !== "object") return false;
          const level = String((entry as { level?: unknown }).level || "").toLowerCase();
          return level === "error" || level === "warn";
        });
      const latestErrorMessage = latestLogMessage && typeof latestLogMessage === "object"
        ? String((latestLogMessage as { message?: unknown }).message || "").trim()
        : "";
      const errorMessage = status === "active"
        ? ""
        : latestErrorMessage || statusErrorMap[status] || `Status da sessão: ${status}`;

      const now = nowIso();
      withDb((db) => {
        if (!Array.isArray(db.tables.meli_sessions)) db.tables.meli_sessions = [];
        const row = db.tables.meli_sessions.find((r) => r.user_id === userId && r.id === sessionId);
        if (row) {
          row.status = status;
          row.last_checked_at = now;
          if (response.accountName) row.account_name = String(response.accountName);
          if (response.mlUserId) row.ml_user_id = String(response.mlUserId);
          row.error_message = errorMessage;
          row.updated_at = now;
        }
      });

      return { data: { status, accountName: response.accountName, errorMessage, logs: response.logs }, error: null };
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Falha ao testar sessão ML");
    }
  }

  if (name === "meli-list-sessions") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const sessions = Array.isArray(snapshot.tables.meli_sessions)
      ? snapshot.tables.meli_sessions
        .filter((row) => row.user_id === userId)
        .sort((a, b) => {
          const aTime = Date.parse(String(a.updated_at || a.created_at || ""));
          const bTime = Date.parse(String(b.updated_at || b.created_at || ""));
          const safeA = Number.isFinite(aTime) ? aTime : 0;
          const safeB = Number.isFinite(bTime) ? bTime : 0;
          return safeB - safeA;
        })
      : [];
    const canonical = sessions[0] || null;
    const staleSessionIds = sessions
      .slice(1)
      .map((row) => String(row.id || "").trim())
      .filter(Boolean);

    if (staleSessionIds.length > 0) {
      withDb((db) => {
        if (!Array.isArray(db.tables.meli_sessions)) return;
        db.tables.meli_sessions = db.tables.meli_sessions.filter((row) => {
          if (row.user_id !== userId) return true;
          return !staleSessionIds.includes(String(row.id || "").trim());
        });
      });
    }

    return { data: { sessions: canonical ? [canonical] : [] }, error: null };
  }

  if (name === "meli-delete-session") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) return fail("sessionId é obrigatório");
    const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);

    try {
      await callService(MELI_RPA_URL, `/api/meli/sessions/${encodeURIComponent(scopedSessionId)}`, {
        method: "DELETE",
        userId,
      });
    } catch {
      // Ignore service error - remove from DB regardless
    }

    withDb((db) => {
      if (!Array.isArray(db.tables.meli_sessions)) return;
      const idx = db.tables.meli_sessions.findIndex((row) => row.user_id === userId && row.id === sessionId);
      if (idx !== -1) db.tables.meli_sessions.splice(idx, 1);
    });

    return { data: { success: true }, error: null };
  }

  const normalizeMeliTemplateTextLocal = (value: unknown) =>
    String(value || "").replace(/\s+/g, " ").trim();

  const canonicalizeMeliProductUrlLocal = (rawUrl: string) => {
    try {
      const parsed = new URL(String(rawUrl || "").trim());
      parsed.hash = "";
      parsed.search = "";
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
      return parsed.toString();
    } catch {
      return String(rawUrl || "").trim();
    }
  };

  const deriveMeliProductTitleLocal = (rawUrl: string) => {
    try {
      const parsed = new URL(String(rawUrl || "").trim());
      const parts = parsed.pathname.split("/").filter(Boolean);
      const slug = parts.find((part) => part.toLowerCase() !== "p" && !/^mlb/i.test(part)) || "";
      const decoded = decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      if (!decoded) return "";
      return decoded
        .split(" ")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    } catch {
      return "";
    }
  };

  const getLocalMeliProductSnapshot = (rawUrl: string, snapshotInput: ReturnType<typeof loadDb>) => {
    const productUrl = canonicalizeMeliProductUrlLocal(rawUrl);
    const rows = Array.isArray(snapshotInput.tables.meli_vitrine_products)
      ? snapshotInput.tables.meli_vitrine_products
      : [];
    const matched = rows.find((row) => canonicalizeMeliProductUrlLocal(String(row.product_url || "")) === productUrl);
    if (matched) {
      return {
        productUrl,
        title: String(matched.title || ""),
        imageUrl: String(matched.image_url || ""),
        price: Number.isFinite(Number(matched.price_cents)) ? Number((Number(matched.price_cents) / 100).toFixed(2)) : null,
        oldPrice: Number.isFinite(Number(matched.old_price_cents)) ? Number((Number(matched.old_price_cents) / 100).toFixed(2)) : null,
        installmentsText: normalizeMeliTemplateTextLocal(matched.installments_text),
        seller: normalizeMeliTemplateTextLocal(matched.seller),
        rating: Number.isFinite(Number(matched.rating)) ? Number(matched.rating) : null,
        reviewsCount: Number.isFinite(Number(matched.reviews_count)) ? Number(matched.reviews_count) : null,
      };
    }

    return {
      productUrl,
      title: deriveMeliProductTitleLocal(productUrl) || "Oferta Mercado Livre",
      imageUrl: "",
      price: null,
      oldPrice: null,
      installmentsText: "",
      seller: "",
      rating: null,
      reviewsCount: null,
    };
  };

  if (name === "meli-convert-link") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const url = String(body.url || "").trim();
    if (!url) return fail("url é obrigatório");
    const sessionId = resolveRouteMeliSessionId(snapshot, userId, String(body.sessionId || ""));
    if (!sessionId) return fail("Nenhuma sessão Mercado Livre disponível para conversão.");

    const slot = await acquireProcessSlot("convert");
    await applyProcessQueueDelay(slot);
    try {
      const response = await convertMercadoLivreLinkForUser({ userId, sessionId, url });

      withDb((db) => {
        appendLinkConvertedHistory(db, {
          userId,
          source: String(body.source || "meli-conversor"),
          originalLink: url,
          affiliateLink: response.affiliateLink || url,
          resolvedLink: url,
        });
      });

      return {
        data: {
          originalLink: url,
          resolvedLink: url,
          affiliateLink: response.affiliateLink || url,
          cached: response.cached,
          conversionTimeMs: response.conversionTimeMs,
        },
        error: null,
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Falha ao converter link ML");
    } finally {
      releaseProcessSlot(slot);
    }
  }

  if (name === "meli-product-snapshot") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    if (!currentUser) return fail("Usuário não autenticado");

    const url = String(body.url || body.productUrl || "").trim();
    if (!url) return fail("url é obrigatório");

    return {
      data: {
        success: true,
        ...getLocalMeliProductSnapshot(url, snapshot),
      },
      error: null,
    };
  }

  if (name === "meli-convert-links") {
    const snapshot = loadDb();
    const currentUser = snapshot.auth.session?.user || null;
    const userId = currentUser?.id || null;
    if (!currentUser || !userId) return fail("Usuário não autenticado");

    const urlsRaw = Array.isArray(body.urls) ? body.urls : [];
    const sessionId = resolveRouteMeliSessionId(snapshot, userId, String(body.sessionId || ""));
    if (!sessionId) return fail("Nenhuma sessão Mercado Livre disponível para conversão.");

    const urls = urlsRaw.filter((item): item is string => typeof item === "string").map((s) => s.trim()).filter(Boolean);
    if (urls.length === 0) return fail("Lista de URLs obrigatória");
    if (urls.length > 50) return fail("Máximo de 50 URLs por lote");

    const slot = await acquireProcessSlot("convert");
    await applyProcessQueueDelay(slot);
    try {
      const conversions: Array<{ originalLink: string; affiliateLink: string; cached: boolean; error: string | null }> = [];
      for (const url of urls) {
        try {
          const response = await convertMercadoLivreLinkForUser({ userId, sessionId, url });
          conversions.push({ originalLink: url, affiliateLink: response.affiliateLink || url, cached: response.cached, error: null });
        } catch (error) {
          conversions.push({ originalLink: url, affiliateLink: url, cached: false, error: error instanceof Error ? error.message : "Falha" });
        }
      }
      return { data: { conversions }, error: null };
    } finally {
      releaseProcessSlot(slot);
    }
  }

  return withDb((db) => {
    const currentUser = db.auth.session?.user || null;
    const userId = currentUser?.id || null;

    if (name === "link-hub-public") {
      const slug = String(body.slug || "").trim();
      if (!slug) return fail("Slug obrigatorio");

      const page = db.tables.link_hub_pages.find((row) => row.slug === slug && row.is_active === true) || null;
      if (!page) return { data: { page: null, groups: [], groupLabels: {} }, error: null };

      const ownerUserId = String(page.user_id || "");
      const resolvePublicInviteUrl = (group: Record<string, unknown>) => {
        const explicit = String(group.invite_link || "").trim();
        if (/^https?:\/\//i.test(explicit)) return explicit;

        const external = String(group.external_id || "").trim();
        const platform = String(group.platform || "").trim();
        if (!external) return "";
        if (/^https?:\/\//i.test(external)) return external;

        if (platform === "telegram") {
          if (/^@[A-Za-z0-9_]{3,}$/i.test(external)) return `https://t.me/${external.slice(1)}`;
          if (/^[A-Za-z0-9_]{3,}$/i.test(external)) return `https://t.me/${external}`;
          return "";
        }

        if (platform === "whatsapp") {
          if (/^chat\.whatsapp\.com\/[A-Za-z0-9]+$/i.test(external)) return `https://${external}`;
          if (/^[A-Za-z0-9]{20,32}$/.test(external)) return `https://chat.whatsapp.com/${external}`;
          return "";
        }

        return "";
      };

      const config = (page.config || {}) as Record<string, unknown>;
      const groupIds = Array.isArray(config.groupIds) ? (config.groupIds as string[]) : [];
      const masterGroupIds = Array.isArray(config.masterGroupIds) ? (config.masterGroupIds as string[]) : [];
      const groupLabels = (config.groupLabels || {}) as Record<string, string>;

      const directGroups = db.tables.groups.filter((group) => (
        String(group.user_id || "") === ownerUserId
        && !group.deleted_at
        && groupIds.includes(String(group.id))
      ));
      const linkedGroups = db.tables.master_group_links
        .filter((link) => masterGroupIds.includes(String(link.master_group_id)) && link.is_active !== false)
        .map((link) => db.tables.groups.find((group) => (
          group.id === link.group_id
          && String(group.user_id || "") === ownerUserId
          && !group.deleted_at
        )))
        .filter(Boolean) as Record<string, unknown>[];

      const groups = [...directGroups, ...linkedGroups]
        .filter((item, idx, arr) => arr.findIndex((other) => other.id === item.id) === idx)
        .map((group) => ({ ...group, redirect_url: resolvePublicInviteUrl(group) }));

      return { data: { page, groups, groupLabels }, error: null };
    }

    if (!currentUser || !userId) return fail("Usuário não autenticado");

    if (name === "dispatch-messages") {
      const now = Date.now();
      const limit = Number(body.limit || 20);

      const pending = db.tables.scheduled_posts
        .filter((row) => row.user_id === userId && row.status === "pending")
        .filter((row) => !!getDueSlotKey(row as unknown as Record<string, unknown>, now))
        .slice(0, Number.isFinite(limit) ? limit : 20);

      let sent = 0;
      let failed = 0;
      let skipped = 0;

      for (const post of pending) {
        const metadata = parseScheduleMeta(post.metadata);
        const dueSlotKey = getDueSlotKey(post as unknown as Record<string, unknown>, now);
        if (!dueSlotKey) continue;
        const recurring = isRecurringSchedule(post as unknown as Record<string, unknown>);

        const masterGroupIds = Array.isArray(metadata.masterGroupIds)
          ? (metadata.masterGroupIds as unknown[]).filter((item): item is string => typeof item === "string")
          : [];

        const directGroupIds = db.tables.scheduled_post_destinations
          .filter((dest) => dest.post_id === post.id)
          .map((dest) => String(dest.group_id));

        const masterLinkedGroupIds = db.tables.master_group_links
          .filter((link) => masterGroupIds.includes(String(link.master_group_id)))
          .map((link) => String(link.group_id));

        const destinationGroupIds = [...new Set([...directGroupIds, ...masterLinkedGroupIds])];

        if (destinationGroupIds.length === 0) {
          skipped += 1;
          post.status = "cancelled";
          appendDispatchFailureHistory(db, {
            userId,
            destination: String(post.id),
            message: String(post.content || ""),
            reason: "Agendamento cancelado: nenhum destino válido",
            platform: "",
          });
          post.metadata = markScheduleMediaCleanup(parseScheduleMeta(post.metadata), now);
          schedulePostMediaCleanup(userId, String(post.id), parseScheduleMeta(post.metadata));
          post.updated_at = nowIso();
          continue;
        }

        const message = typeof metadata.finalContent === "string" ? metadata.finalContent : String(post.content || "");
        const scheduleMedia = parseScheduledImageFromMeta(metadata);
        const requiresScheduleImage = scheduleRequiresMandatoryImage(metadata);
        if (requiresScheduleImage && !scheduleMedia) {
          failed += 1;
          skipped += 1;
          post.status = "cancelled";
          appendDispatchFailureHistory(db, {
            userId,
            destination: String(post.id),
            message,
            reason: "Agendamento cancelado: imagem obrigatória ausente.",
            platform: "",
          });
          db.tables.history_entries.push({
            id: randomId("hist"),
            user_id: userId,
            type: "schedule_sent",
            source: "Agendamento",
            destination: String(post.id),
            status: "warning",
            details: { message, reason: "missing_image_required", requiresImage: true },
            direction: "outbound",
            message_type: "text",
            processing_status: "blocked",
            block_reason: "missing_image_required",
            error_step: "media_requirements",
            created_at: nowIso(),
          });
          post.metadata = markScheduleMediaCleanup(parseScheduleMeta(post.metadata), now);
          schedulePostMediaCleanup(userId, String(post.id), parseScheduleMeta(post.metadata));
          post.updated_at = nowIso();
          continue;
        }
        let postSentCount = 0;
        let postError = "";

        for (const groupId of destinationGroupIds) {
          const group = db.tables.groups.find((row) => row.id === groupId && row.user_id === userId);
          if (!group) {
            failed += 1;
            postError = `Grupo destino não encontrado: ${groupId}`;
            appendDispatchFailureHistory(db, {
              userId,
              destination: groupId,
              message,
              reason: postError,
              platform: "",
            });
            break;
          }

          db.tables.history_entries.push({
            id: randomId("hist"),
            user_id: userId,
            type: "schedule_sent",
            source: "Agendamento",
            destination: String(group.name || group.id),
            status: "success",
            details: { message, platform: String(group.platform || "") },
            direction: "outbound",
            message_type: scheduleMedia ? "image" : "text",
            processing_status: "sent",
            block_reason: "",
            error_step: "",
            created_at: nowIso(),
          });

          sent += 1;
          postSentCount += 1;
        }

        if (postError) {
          post.status = "cancelled";
          post.metadata = markScheduleMediaCleanup(parseScheduleMeta(post.metadata), now);
          schedulePostMediaCleanup(userId, String(post.id), parseScheduleMeta(post.metadata));
        } else if (recurring) {
          const mergedMeta = parseScheduleMeta(post.metadata);
          post.status = "pending";
          post.scheduled_at = computeNextRecurringScheduledAt(post as unknown as Record<string, unknown>, now);
          post.metadata = {
            ...mergedMeta,
            lastDispatchSlot: dueSlotKey,
          };
        } else {
          post.status = postSentCount > 0 ? "sent" : "cancelled";
          if (post.status === "sent" || post.status === "cancelled") {
            post.metadata = markScheduleMediaCleanup(parseScheduleMeta(post.metadata), now);
            schedulePostMediaCleanup(userId, String(post.id), parseScheduleMeta(post.metadata));
          }
        }
        post.updated_at = nowIso();
      }

      return {
        data: {
          ok: true,
          runMode: "user",
          source: String(body.source || "frontend"),
          scanned: pending.length,
          processed: pending.length,
          sent,
          failed,
          skipped,
          historyLogged: sent + failed,
          errors: [],
        },
        error: null,
      };
    }

    if (name === "whatsapp-connect") {
      const sessionId = String(body.sessionId || "");
      const action = String(body.action || "");

      if (action === "health") {
        return {
          data: {
            online: false,
            url: "",
            uptimeSec: null,
            sessions: [],
            error: "Baileys não configurado. Defina VITE_WHATSAPP_MICROSERVICE_URL e inicie o serviço WhatsApp.",
          },
          error: null,
        };
      }

      if (action === "poll_events_all" || action === "poll_events") {
        const now = nowIso();
        const staleStatuses = new Set(["online", "connecting", "qr_code", "pairing_code", "warning"]);

        for (const row of db.tables.whatsapp_sessions) {
          if (row.user_id !== userId) continue;
          if (!staleStatuses.has(String(row.status || ""))) continue;

          row.status = "offline";
          row.connected_at = null;
          row.qr_code = "";
          row.updated_at = now;
          if (!String(row.error_message || "").trim()) {
            row.error_message = "Baileys não configurado. Defina VITE_WHATSAPP_MICROSERVICE_URL e inicie o serviço WhatsApp.";
          }
        }

        return { data: { success: true, sessions: 0, events: 0 }, error: null };
      }

      const sessionRow = db.tables.whatsapp_sessions.find((row) => row.id === sessionId && row.user_id === userId);
      if (!sessionRow) return fail("Sessão WhatsApp não encontrada");

      if (action === "connect") {
        sessionRow.status = "offline";
        sessionRow.connected_at = null;
        sessionRow.qr_code = "";
        sessionRow.error_message = "Baileys não configurado. Defina VITE_WHATSAPP_MICROSERVICE_URL e inicie o serviço WhatsApp.";
        return fail("Baileys não configurado. Defina VITE_WHATSAPP_MICROSERVICE_URL e inicie o serviço WhatsApp.");
      } else if (action === "disconnect") {
        sessionRow.status = "offline";
        sessionRow.connected_at = null;
        sessionRow.qr_code = "";
        sessionRow.error_message = "";
      } else if (action === "sync_groups") {
        return fail("Sincronização indisponível: serviço WhatsApp (Baileys) não configurado.");
      } else if (action === "group_invite") {
        return fail("Convite indisponível: serviço WhatsApp (Baileys) não configurado.");
      } else if (action === "send_message") {
        return fail("Envio indisponível: serviço WhatsApp (Baileys) não configurado.");
      } else {
        return fail("Ação WhatsApp inválida");
      }

      return { data: { success: true, status: sessionRow.status }, error: null };
    }
    if (name === "telegram-connect") {
      const sessionId = String(body.sessionId || "");
      const action = String(body.action || "");

      if (action === "health") {
        return {
          data: {
            online: false,
            url: "",
            uptimeSec: null,
            sessions: [],
            error: "Telegram telegraph não configurado. Defina VITE_TELEGRAM_MICROSERVICE_URL e TELEGRAM_API_ID/TELEGRAM_API_HASH no .env do serviço Telegram.",
          },
          error: null,
        };
      }

      if (action === "poll_events_all" || action === "poll_events") {
        const now = nowIso();
        const staleStatuses = new Set(["online", "connecting", "awaiting_code", "awaiting_password", "warning"]);

        for (const row of db.tables.telegram_sessions) {
          if (row.user_id !== userId) continue;
          if (!staleStatuses.has(String(row.status || ""))) continue;

          row.status = "offline";
          row.connected_at = null;
          row.phone_code_hash = "";
          row.session_string = "";
          row.updated_at = now;
          if (!String(row.error_message || "").trim()) {
            row.error_message = "Telegram telegraph não configurado. Defina VITE_TELEGRAM_MICROSERVICE_URL e TELEGRAM_API_ID/TELEGRAM_API_HASH no .env do serviço Telegram.";
          }
        }

        return { data: { success: true, sessions: 0, events: 0 }, error: null };
      }

      const sessionRow = db.tables.telegram_sessions.find((row) => row.id === sessionId && row.user_id === userId);
      if (!sessionRow) return fail("Sessão Telegram não encontrada");

      if (action === "send_code") {
        sessionRow.status = "offline";
        sessionRow.connected_at = null;
        sessionRow.error_message = "Telegram telegraph não configurado. Defina VITE_TELEGRAM_MICROSERVICE_URL e TELEGRAM_API_ID/TELEGRAM_API_HASH no .env do serviço Telegram.";
        return fail("Telegram telegraph não configurado. Defina VITE_TELEGRAM_MICROSERVICE_URL e TELEGRAM_API_ID/TELEGRAM_API_HASH no .env do serviço Telegram.");
      }

      if (action === "verify_code" || action === "verify_password") {
        return fail("Verificação indisponível: sessão Telegram não iniciada no telegraph.");
      }

      if (action === "disconnect") {
        sessionRow.status = "offline";
        sessionRow.connected_at = null;
        sessionRow.error_message = "";
        sessionRow.phone_code_hash = "";
        sessionRow.session_string = "";
        return { data: { status: "offline" }, error: null };
      }

      if (action === "sync_groups") {
        return fail("Sincronização indisponível: serviço Telegram (telegraph) não configurado.");
      }

      if (action === "send_message") {
        return fail("Envio indisponível: serviço Telegram (telegraph) não configurado.");
      }

      return fail("Ação Telegram inválida");
    }

    if (name === "admin-users") {
      if (!userIsAdmin(db, userId)) return fail("Acesso negado");

      const action = String(body.action || "");
      const controlPlane = loadAdminControlPlaneState();
      const validPlanIds = new Set(controlPlane.plans.map((plan) => String(plan.id || "").trim()).filter(Boolean));
      const fallbackPlanId = (() => {
        const preferred = String(controlPlane.defaultSignupPlanId || "").trim();
        if (preferred && validPlanIds.has(preferred)) return preferred;
        const firstActive = controlPlane.plans.find((plan) => plan.isActive && String(plan.id || "").trim());
        if (firstActive?.id) return String(firstActive.id);
        const first = controlPlane.plans.find((plan) => String(plan.id || "").trim());
        return first?.id ? String(first.id) : "plan-starter";
      })();

      if (action === "list_users") {
        const users = db.auth.users.map((authUser) => {
          const profile = db.tables.profiles.find((row) => row.user_id === authUser.id) || {};
          const roleRow = db.tables.user_roles.find((row) => row.user_id === authUser.id);
          const role: "admin" | "user" = roleRow?.role === "admin" ? "admin" : "user";
          const status = String(authUser.user_metadata?.account_status || "active");
          const rawPlanId = String(profile.plan_id || "").trim();
          const safePlanId = role === "admin"
            ? ADMIN_PANEL_PLAN_ID
            : (rawPlanId && validPlanIds.has(rawPlanId) ? rawPlanId : fallbackPlanId);
          return {
            id: String(profile.id || authUser.id),
            user_id: authUser.id,
            name: String(profile.name || authUser.user_metadata?.name || "Usuário"),
            email: authUser.email,
            plan_id: safePlanId,
            created_at: String(profile.created_at || authUser.created_at),
            role,
            account_status: status,
            plan_expires_at: role !== "admin" && typeof (profile as Record<string, unknown>).plan_expires_at === "string"
              ? String((profile as Record<string, unknown>).plan_expires_at)
              : null,
          };
        });
        return { data: { users }, error: null };
      }

      if (action === "list_audit") {
        const audit = [...db.tables.admin_audit_logs]
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, 50);
        return { data: { audit }, error: null };
      }

      if (action === "update_plan") {
        const targetUserId = String(body.user_id || "");
        if (!targetUserId) return fail("Usuário alvo obrigatório");
        const targetRole = db.tables.user_roles.find((row) => row.user_id === targetUserId)?.role === "admin" ? "admin" : "user";
        if (targetRole === "admin") {
          return fail("Admins não possuem plano. Mude a permissão para usuário para aplicar plano.");
        }
        const planId = String(body.plan_id || "").trim();
        if (!planId || !validPlanIds.has(planId)) {
          return fail("Plano invalido para este ambiente");
        }
        const profile = db.tables.profiles.find((row) => row.user_id === targetUserId);
        if (!profile) return fail("Perfil não encontrado");

        profile.plan_id = planId;
        profile.plan_expires_at = resolvePlanExpirationIsoFromControlPlane(planId);
        profile.updated_at = nowIso();
        appendAudit(db, "update_plan", userId, targetUserId, {
          plan_id: planId,
          plan_expires_at: profile.plan_expires_at,
        });
        return { data: { success: true }, error: null };
      }

      if (action === "set_role") {
        const targetUserId = String(body.user_id || "");
        const role = String(body.role || "user") === "admin" ? "admin" : "user";
        if (!targetUserId) return fail("Usuário alvo obrigatório");
        if (targetUserId === userId && role !== "admin") {
          return fail("Nao e permitido remover a propria permissao admin");
        }
        const profile = db.tables.profiles.find((row) => row.user_id === targetUserId);
        if (!profile) return fail("Perfil nao encontrado");

        if (role === "user") {
          const planId = String(profile.plan_id || "").trim();
          const hasExpiry = typeof profile.plan_expires_at === "string"
            && Number.isFinite(Date.parse(profile.plan_expires_at));
          if (!planId || planId === ADMIN_PANEL_PLAN_ID || !validPlanIds.has(planId)) {
            profile.plan_id = fallbackPlanId;
            profile.plan_expires_at = resolvePlanExpirationIsoFromControlPlane(fallbackPlanId);
            profile.updated_at = nowIso();
          } else if (!hasExpiry) {
            profile.plan_expires_at = resolvePlanExpirationIsoFromControlPlane(planId);
            profile.updated_at = nowIso();
          }
        } else {
          profile.plan_id = ADMIN_PANEL_PLAN_ID;
          profile.plan_expires_at = null;
          profile.updated_at = nowIso();
        }

        for (let i = db.tables.user_roles.length - 1; i >= 0; i -= 1) {
          if (db.tables.user_roles[i].user_id === targetUserId) {
            db.tables.user_roles.splice(i, 1);
          }
        }

        db.tables.user_roles.push({
          id: randomId("role"),
          user_id: targetUserId,
          role,
          created_at: nowIso(),
        });

        appendAudit(db, "set_role", userId, targetUserId, { role });
        return { data: { success: true }, error: null };
      }

      if (action === "set_name") {
        const targetUserId = String(body.user_id || "");
        const nextName = String(body.name || "").trim();
        if (!targetUserId) return fail("Usuario alvo obrigatorio");
        if (!nextName) return fail("Nome obrigatorio");

        const target = db.auth.users.find((row) => row.id === targetUserId);
        if (!target) return fail("Usuario nao encontrado");

        target.user_metadata = {
          ...target.user_metadata,
          name: nextName,
          updated_at: nowIso(),
        };

        const profile = db.tables.profiles.find((row) => row.user_id === targetUserId);
        if (profile) {
          profile.name = nextName;
          profile.updated_at = nowIso();
        }

        appendAudit(db, "set_name", userId, targetUserId, { name: nextName });
        return { data: { success: true }, error: null };
      }

      if (action === "set_status") {
        const targetUserId = String(body.user_id || "");
        const status = String(body.account_status || "active");
        if (!["active", "inactive", "blocked", "archived"].includes(status)) {
          return fail("Status de conta invalido");
        }

        if (targetUserId === userId && status !== "active") {
          return fail("Nao e permitido inativar, bloquear ou arquivar o proprio usuario admin");
        }

        const target = db.auth.users.find((row) => row.id === targetUserId);
        if (!target) return fail("Usuario nao encontrado");

        target.user_metadata = {
          ...target.user_metadata,
          account_status: status,
          status_updated_at: nowIso(),
        };

        appendAudit(db, "set_status", userId, targetUserId, { account_status: status });
        return { data: { success: true }, error: null };
      }

      if (action === "archive_user") {
        const targetUserId = String(body.user_id || "");
        if (targetUserId === userId) {
          return fail("Nao e permitido arquivar o proprio usuario admin");
        }
        const target = db.auth.users.find((row) => row.id === targetUserId);
        if (!target) return fail("Usuario nao encontrado");

        target.user_metadata = {
          ...target.user_metadata,
          account_status: "archived",
          status_updated_at: nowIso(),
          archived_at: nowIso(),
        };

        appendAudit(db, "archive_user", userId, targetUserId, {});
        return { data: { success: true }, error: null };
      }

      if (action === "restore_user") {
        const targetUserId = String(body.user_id || "");
        const target = db.auth.users.find((row) => row.id === targetUserId);
        if (!target) return fail("Usuario nao encontrado");

        target.user_metadata = {
          ...target.user_metadata,
          account_status: "active",
          status_updated_at: nowIso(),
        };

        appendAudit(db, "restore_user", userId, targetUserId, {});
        return { data: { success: true }, error: null };
      }

      if (action === "delete_user") {
        const targetUserId = String(body.user_id || "");
        if (!targetUserId) return fail("Usuario alvo obrigatorio");

        if (targetUserId === userId) {
          return fail("Nao e permitido apagar o proprio usuario admin");
        }

        if (!db.auth.users.some((row) => row.id === targetUserId)) {
          return fail("Usuario nao encontrado");
        }

        deleteUserFromDb(db, targetUserId);

        appendAudit(db, "delete_user", userId, targetUserId, {});
        return { data: { success: true }, error: null };
      }

      if (action === "create_user") {
        const email = normalizeEmail(String(body.email || ""));
        const rawPassword = String(body.password || "");
        const name = String(body.name || "Usuário").trim() || "Usuário";
        const role = String(body.role || "user") === "admin" ? "admin" : "user";
        const requestedPlanId = String(body.plan_id || "").trim();
        const planId = role === "admin"
          ? ADMIN_PANEL_PLAN_ID
          : (requestedPlanId && validPlanIds.has(requestedPlanId) ? requestedPlanId : fallbackPlanId);

        if (!email || !isValidEmail(email) || rawPassword.length < 6) {
          return fail("Informe email válido e senha com no mínimo 6 caracteres");
        }

        if (db.auth.users.some((row) => normalizeEmail(row.email) === email)) {
          return fail("Usuário já cadastrado com este email");
        }

        const storedPassword = _preHashedCreateUserPassword ?? rawPassword;
        const created = createAuthUserInDb(db, { email, password: storedPassword, name, role, planId });
        created.user_metadata = {
          ...created.user_metadata,
          account_status: "active",
          status_updated_at: nowIso(),
        };

        const profile = db.tables.profiles.find((row) => row.user_id === created.id);
        const roleRow = db.tables.user_roles.find((row) => row.user_id === created.id);
        const status = String(created.user_metadata?.account_status || "active");

        if (!profile || roleRow?.role !== role || status !== "active") {
          return fail("Usuario criado sem consistencia de perfil/role/status");
        }

        appendAudit(db, "create_user", userId, created.id, { email, role, plan_id: planId });
        return {
          data: {
            success: true,
            created_user: {
              id: String(profile.id || created.id),
              user_id: created.id,
              name: String(profile.name || created.user_metadata?.name || "Usuário"),
              email: created.email,
              plan_id: String(profile.plan_id || planId),
              created_at: String(profile.created_at || created.created_at),
              role: roleRow.role === "admin" ? "admin" : "user",
              account_status: status,
            },
          },
          error: null,
        };
      }

      if (action === "update_user") {
        const targetUserId = String(body.user_id || "");
        if (!targetUserId) return fail("Usuario alvo obrigatorio");
        const role = String(body.role || "user") === "admin" ? "admin" : "user";
        if (targetUserId === userId && role !== "admin") {
          return fail("Nao e permitido remover a propria permissao admin");
        }

        const target = db.auth.users.find((row) => row.id === targetUserId);
        if (!target) return fail("Usuario nao encontrado");

        const profile = db.tables.profiles.find((row) => row.user_id === targetUserId);
        if (!profile) return fail("Perfil nao encontrado");

        const emailProvided = body.email !== undefined;
        const email = normalizeEmail(String(body.email || ""));
        if (emailProvided) {
          if (!email || !isValidEmail(email)) return fail("Email invalido");
          const duplicate = db.auth.users.find((row) => row.id !== targetUserId && normalizeEmail(row.email) === email);
          if (duplicate) return fail("Email ja cadastrado");
        }

        const accountStatusRaw = String(body.account_status || "").trim();
        const hasAccountStatus = accountStatusRaw.length > 0;
        if (hasAccountStatus && !["active", "inactive", "blocked", "archived"].includes(accountStatusRaw)) {
          return fail("Status de conta invalido");
        }
        if (hasAccountStatus && targetUserId === userId && accountStatusRaw !== "active") {
          return fail("Nao e permitido inativar, bloquear ou arquivar o proprio usuario admin");
        }

        // Name / email
        const nextName = String(body.name || "").trim();
        if (nextName) {
          target.user_metadata = { ...target.user_metadata, name: nextName, updated_at: nowIso() };
          profile.name = nextName;
          profile.updated_at = nowIso();
        }
        if (emailProvided) {
          target.email = email;
          profile.email = email;
          profile.updated_at = nowIso();
        }

        // Plan / expiry
        const requestedPlanId = String(body.plan_id || "").trim();
        const rawCurrentPlanId = String(profile.plan_id || "").trim();
        const rawCurrentExpiry = typeof profile.plan_expires_at === "string" ? profile.plan_expires_at : null;
        if (role === "admin") {
          profile.plan_id = ADMIN_PANEL_PLAN_ID;
          profile.plan_expires_at = null;
          profile.updated_at = nowIso();
        } else {
          if (requestedPlanId) {
            if (!validPlanIds.has(requestedPlanId)) return fail("Plano invalido para este ambiente");
            profile.plan_id = requestedPlanId;
            profile.plan_expires_at = resolvePlanExpirationIsoFromControlPlane(requestedPlanId);
          } else if (!rawCurrentPlanId || rawCurrentPlanId === ADMIN_PANEL_PLAN_ID || !validPlanIds.has(rawCurrentPlanId)) {
            profile.plan_id = fallbackPlanId;
            profile.plan_expires_at = resolvePlanExpirationIsoFromControlPlane(fallbackPlanId);
          } else {
            profile.plan_id = rawCurrentPlanId;
            profile.plan_expires_at = rawCurrentExpiry || resolvePlanExpirationIsoFromControlPlane(rawCurrentPlanId);
          }
          profile.updated_at = nowIso();
        }

        // Role
        for (let i = db.tables.user_roles.length - 1; i >= 0; i -= 1) {
          if (db.tables.user_roles[i].user_id === targetUserId) {
            db.tables.user_roles.splice(i, 1);
          }
        }
        db.tables.user_roles.push({ id: randomId("role"), user_id: targetUserId, role, created_at: nowIso() });

        // Status
        if (hasAccountStatus) {
          target.user_metadata = { ...target.user_metadata, account_status: accountStatusRaw, status_updated_at: nowIso() };
        }

        appendAudit(db, "update_user", userId, targetUserId, {
          name: nextName || undefined,
          email: emailProvided ? email : undefined,
          plan_id: String(profile.plan_id || "") || undefined,
          role,
          account_status: hasAccountStatus ? accountStatusRaw : undefined,
        });
        return { data: { success: true }, error: null };
      }

      if (action === "extend_plan") {
        const targetUserId = String(body.user_id || "");
        if (!targetUserId) return fail("Usuário alvo obrigatório");
        const targetRole = db.tables.user_roles.find((row) => row.user_id === targetUserId)?.role === "admin" ? "admin" : "user";
        if (targetRole === "admin") return fail("Admins não possuem plano para renovação");

        const profile = db.tables.profiles.find((row) => row.user_id === targetUserId);
        if (!profile) return fail("Perfil não encontrado");

        const currentPlanId = String(profile.plan_id || "").trim();
        if (!currentPlanId || !validPlanIds.has(currentPlanId)) {
          return fail("Plano do usuário inválido ou inativo");
        }

        // Extend from the current expiry if still valid, otherwise from today
        const currentExpiryMs =
          typeof profile.plan_expires_at === "string" && profile.plan_expires_at
            ? Date.parse(profile.plan_expires_at)
            : NaN;
        const baseMs =
          Number.isFinite(currentExpiryMs) && currentExpiryMs > Date.now()
            ? currentExpiryMs
            : Date.now();
        const newExpiresAt = resolvePlanExpirationIsoFromControlPlane(currentPlanId, baseMs);
        profile.plan_expires_at = newExpiresAt;
        profile.updated_at = nowIso();

        appendAudit(db, "extend_plan", userId, targetUserId, {
          plan_id: currentPlanId,
          plan_expires_at: newExpiresAt,
          extended_from: new Date(baseMs).toISOString(),
        });
        return { data: { success: true, plan_expires_at: newExpiresAt }, error: null };
      }

      if (action === "set_plan_expiry") {
        const targetUserId = String(body.user_id || "");
        if (!targetUserId) return fail("Usuário alvo obrigatório");
        const targetRole = db.tables.user_roles.find((row) => row.user_id === targetUserId)?.role === "admin" ? "admin" : "user";
        if (targetRole === "admin") return fail("Admins não possuem vencimento de plano");

        const profile = db.tables.profiles.find((row) => row.user_id === targetUserId);
        if (!profile) return fail("Perfil não encontrado");

        const rawDate = body.expires_at;
        if (rawDate === null || rawDate === undefined || rawDate === "" || rawDate === "never") {
          profile.plan_expires_at = null;
        } else {
          const ms = Date.parse(String(rawDate));
          if (!Number.isFinite(ms)) return fail("Data de vencimento inválida");
          profile.plan_expires_at = new Date(ms).toISOString();
        }
        profile.updated_at = nowIso();

        appendAudit(db, "set_plan_expiry", userId, targetUserId, {
          plan_id: profile.plan_id,
          plan_expires_at: profile.plan_expires_at,
        });
        return { data: { success: true, plan_expires_at: profile.plan_expires_at }, error: null };
      }

      if (action === "reset_password") {
        const targetUserId = String(body.user_id || "");
        const newPassword = String(body.password || "").trim();
        if (!targetUserId) return fail("Usuário alvo obrigatório");
        if (newPassword.length < 6) return fail("Senha deve ter ao menos 6 caracteres");

        const authUser = db.auth.users.find((row) => row.id === targetUserId);
        if (!authUser) return fail("Usuário não encontrado");
        if (!_preHashedResetPassword) return fail("Erro interno: senha não processada");

        authUser.password = _preHashedResetPassword;
        appendAudit(db, "reset_password", userId, targetUserId, { user_id: targetUserId });
        return { data: { success: true }, error: null };
      }

      if (action === "add_billing_note") {
        const targetUserId = String(body.user_id || "");
        const rawType = String(body.note_type || "note");
        const noteType = ["refund", "credit", "note"].includes(rawType)
          ? (rawType as "refund" | "credit" | "note")
          : "note";
        const amount = Number(body.amount || 0);
        const reason = String(body.reason || "").trim();

        if (!targetUserId) return fail("Usuário alvo obrigatório");
        if (!reason) return fail("Motivo obrigatório");
        if ((noteType === "refund" || noteType === "credit") && amount <= 0) {
          return fail("Valor deve ser maior que zero para reembolso ou crédito");
        }
        if (!db.auth.users.some((row) => row.id === targetUserId)) {
          return fail("Usuário não encontrado");
        }

        appendAudit(db, `billing_${noteType}`, userId, targetUserId, {
          note_type: noteType,
          amount: noteType === "note" ? 0 : amount,
          reason,
        });
        return { data: { success: true }, error: null };
      }

      return fail("A\u00e7\u00e3o administrativa inv\u00e1lida");
    }

    if (name === "admin-announcements") {
      if (!userIsAdmin(db, userId)) return fail("Acesso negado");

      const action = String(body.action || "").trim();

      if (action === "list") {
        const rows = [...db.tables.system_announcements]
          .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

        const items = rows.map((row) => {
          const announcementId = String(row.id || "");
          const related = db.tables.user_notifications.filter((item) => item.announcement_id === announcementId);
          const delivered = related.length;
          const read = related.filter((item) => item.status === "read").length;
          const dismissed = related.filter((item) => item.status === "dismissed").length;
          const unread = related.filter((item) => item.status === "unread").length;
          const readRate = delivered > 0 ? Math.round((read / delivered) * 100) : 0;

          return {
            ...row,
            last_delivered_at: typeof row.last_delivered_at === "string" ? row.last_delivered_at : null,
            metrics: {
              delivered,
              read,
              dismissed,
              unread,
              read_rate: readRate,
            },
          };
        });

        return { data: { announcements: items }, error: null };
      }

      if (action === "preview_recipients") {
        const filter = normalizeTargetFilter(body.target_filter);
        const { planToAccessLevel } = resolveUserAccessLevelMap();
        const users: Array<{ user_id: string; email: string; name: string; plan_id: string; role: "admin" | "user" }> = [];

        for (const authUser of db.auth.users) {
          const localUserId = String(authUser.id || "").trim();
          if (!localUserId) continue;

          const status = String(authUser.user_metadata?.account_status || "active");
          if (status !== "active") continue;

          const profile = db.tables.profiles.find((row) => row.user_id === localUserId);
          const roleRow = db.tables.user_roles.find((row) => row.user_id === localUserId);
          const role: "admin" | "user" = roleRow?.role === "admin" ? "admin" : "user";
          const planId = role === "admin"
            ? ADMIN_PANEL_PLAN_ID
            : (String(profile?.plan_id || "plan-starter").trim() || "plan-starter");
          const accessLevelId = planToAccessLevel.get(planId) || "";

          if (!userMatchesAnnouncementFilter({ userId: localUserId, planId, role, accessLevelId }, filter)) {
            continue;
          }

          users.push({
            user_id: localUserId,
            email: String(authUser.email || ""),
            name: String(profile?.name || authUser.user_metadata?.name || "Usuario"),
            plan_id: planId,
            role,
          });
        }

        return {
          data: {
            count: users.length,
            users: users.slice(0, 200),
          },
          error: null,
        };
      }

      if (action === "create") {
        const title = String(body.title || "").trim();
        const message = String(body.message || "").trim();
        if (!title) return fail("Titulo obrigatorio");
        if (!message) return fail("Mensagem obrigatoria");

        const now = nowIso();
        const row = {
          id: randomId("announce"),
          created_at: now,
          updated_at: now,
          created_by_user_id: String(userId || ""),
          title,
          message,
          severity: String(body.severity || "info") === "critical"
            ? "critical"
            : String(body.severity || "info") === "warning"
              ? "warning"
              : "info",
          channel: String(body.channel || "bell") === "modal"
            ? "modal"
            : String(body.channel || "bell") === "both"
              ? "both"
              : "bell",
          auto_popup_on_login: body.auto_popup_on_login === true,
          starts_at: typeof body.starts_at === "string" && body.starts_at.trim() ? body.starts_at.trim() : null,
          ends_at: typeof body.ends_at === "string" && body.ends_at.trim() ? body.ends_at.trim() : null,
          is_active: body.is_active !== false,
          target_filter: normalizeTargetFilter(body.target_filter),
        };

        db.tables.system_announcements.push(row);

        let delivery = { delivered: 0, matchedUsers: 0 };
        if (body.deliver_now !== false) {
          delivery = deliverAnnouncementToInbox(db, row);
        }

        appendAudit(db, "create_announcement", String(userId || ""), null, {
          announcement_id: row.id,
          delivered: delivery.delivered,
          matched_users: delivery.matchedUsers,
        });

        return { data: { announcement: row, delivery }, error: null };
      }

      if (action === "update") {
        const announcementId = String(body.id || "").trim();
        if (!announcementId) return fail("ID obrigatorio");

        const row = db.tables.system_announcements.find((item) => item.id === announcementId);
        if (!row) return fail("Comunicado nao encontrado");

        if (typeof body.title === "string" && body.title.trim()) row.title = body.title.trim();
        if (typeof body.message === "string" && body.message.trim()) row.message = body.message.trim();
        if (body.severity === "info" || body.severity === "warning" || body.severity === "critical") row.severity = body.severity;
        if (body.channel === "bell" || body.channel === "modal" || body.channel === "both") row.channel = body.channel;
        if (typeof body.auto_popup_on_login === "boolean") row.auto_popup_on_login = body.auto_popup_on_login;
        if (typeof body.starts_at === "string" || body.starts_at === null) {
          row.starts_at = typeof body.starts_at === "string" && body.starts_at.trim() ? body.starts_at.trim() : null;
        }
        if (typeof body.ends_at === "string" || body.ends_at === null) {
          row.ends_at = typeof body.ends_at === "string" && body.ends_at.trim() ? body.ends_at.trim() : null;
        }
        if (typeof body.is_active === "boolean") row.is_active = body.is_active;
        if (body.target_filter && typeof body.target_filter === "object") {
          row.target_filter = normalizeTargetFilter(body.target_filter);
        }
        row.updated_at = nowIso();

        let delivery = { delivered: 0, matchedUsers: 0 };
        if (body.redeliver === true) {
          delivery = deliverAnnouncementToInbox(db, row);
        }

        appendAudit(db, "update_announcement", String(userId || ""), null, {
          announcement_id: row.id,
          redeliver: body.redeliver === true,
          delivered: delivery.delivered,
          matched_users: delivery.matchedUsers,
        });

        return { data: { announcement: row, delivery }, error: null };
      }

      if (action === "deactivate") {
        const announcementId = String(body.id || "").trim();
        if (!announcementId) return fail("ID obrigatorio");
        const row = db.tables.system_announcements.find((item) => item.id === announcementId);
        if (!row) return fail("Comunicado nao encontrado");

        row.is_active = false;
        row.updated_at = nowIso();

        appendAudit(db, "deactivate_announcement", String(userId || ""), null, {
          announcement_id: row.id,
        });

        return { data: { success: true }, error: null };
      }

      if (action === "delete") {
        const announcementId = String(body.id || "").trim();
        if (!announcementId) return fail("ID obrigatorio");

        const rowIndex = db.tables.system_announcements.findIndex((item) => item.id === announcementId);
        if (rowIndex < 0) return fail("Comunicado nao encontrado");

        db.tables.system_announcements.splice(rowIndex, 1);
        db.tables.user_notifications = db.tables.user_notifications.filter(
          (item) => String(item.announcement_id || "") !== announcementId,
        );

        appendAudit(db, "delete_announcement", String(userId || ""), null, {
          announcement_id: announcementId,
        });

        return { data: { success: true }, error: null };
      }

      if (action === "deliver_now") {
        const announcementId = String(body.id || "").trim();
        if (!announcementId) return fail("ID obrigatorio");
        const row = db.tables.system_announcements.find((item) => item.id === announcementId);
        if (!row) return fail("Comunicado nao encontrado");

        const lastDeliveredAt = typeof row.last_delivered_at === "string" ? row.last_delivered_at : null;
        if (lastDeliveredAt) {
          const elapsed = Date.now() - Date.parse(lastDeliveredAt);
          if (elapsed < DELIVER_COOLDOWN_MS) {
            const remainingSec = Math.ceil((DELIVER_COOLDOWN_MS - elapsed) / 1000);
            return fail(`Aguarde ${remainingSec}s antes de reenviar novamente.`);
          }
        }

        const delivery = deliverAnnouncementToInbox(db, row);
        appendAudit(db, "deliver_announcement", String(userId || ""), null, {
          announcement_id: row.id,
          delivered: delivery.delivered,
          matched_users: delivery.matchedUsers,
        });

        return { data: { success: true, delivery }, error: null };
      }

      return fail("Acao de notificacoes admin invalida");
    }

    if (name === "user-notifications") {
      if (!currentUser || !userId) return fail("Usuario nao autenticado");

      const action = String(body.action || "list").trim();

      if (action === "unread_count") {
        const count = db.tables.user_notifications.filter(
          (row) => row.user_id === userId && row.status === "unread",
        ).length;
        return { data: { count }, error: null };
      }

      if (action === "list") {
        const statusFilter = String(body.status || "all").trim();
        const limit = Math.max(1, Math.min(200, Number(body.limit || 50)));

        let rows = db.tables.user_notifications.filter((row) => row.user_id === userId);
        if (statusFilter === "unread") rows = rows.filter((row) => row.status === "unread");
        if (statusFilter === "read") rows = rows.filter((row) => row.status === "read");
        if (statusFilter === "dismissed") rows = rows.filter((row) => row.status === "dismissed");

        rows = [...rows]
          .sort((a, b) => String(b.delivered_at || b.created_at || "").localeCompare(String(a.delivered_at || a.created_at || "")))
          .slice(0, limit);

        const items = rows.map((row) => {
          const announcement = db.tables.system_announcements.find((item) => item.id === row.announcement_id) || null;
          return {
            ...row,
            announcement: announcement
              ? {
                  id: announcement.id,
                  title: announcement.title,
                  message: announcement.message,
                  severity: announcement.severity,
                  channel: announcement.channel,
                  auto_popup_on_login: announcement.auto_popup_on_login === true,
                  is_active: announcement.is_active !== false,
                  starts_at: announcement.starts_at || null,
                  ends_at: announcement.ends_at || null,
                }
              : null,
          };
        });

        const unreadCount = db.tables.user_notifications.filter((row) => row.user_id === userId && row.status === "unread").length;
        return { data: { items, unread_count: unreadCount }, error: null };
      }

      if (action === "mark_read") {
        const idList = Array.isArray(body.ids)
          ? body.ids.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
          : (typeof body.id === "string" && body.id.trim() ? [body.id.trim()] : []);
        if (idList.length === 0) return fail("ID obrigatorio");

        const now = nowIso();
        let updated = 0;
        for (const row of db.tables.user_notifications) {
          if (row.user_id !== userId) continue;
          if (!idList.includes(String(row.id))) continue;
          if (row.status === "read") continue;
          row.status = "read";
          row.read_at = now;
          row.updated_at = now;
          updated += 1;
        }
        return { data: { success: true, updated }, error: null };
      }

      if (action === "mark_all_read") {
        const now = nowIso();
        let updated = 0;
        for (const row of db.tables.user_notifications) {
          if (row.user_id !== userId) continue;
          if (row.status !== "unread") continue;
          row.status = "read";
          row.read_at = now;
          row.updated_at = now;
          updated += 1;
        }
        return { data: { success: true, updated }, error: null };
      }

      if (action === "dismiss") {
        const notificationId = String(body.id || "").trim();
        if (!notificationId) return fail("ID obrigatorio");
        const row = db.tables.user_notifications.find((item) => item.id === notificationId && item.user_id === userId);
        if (!row) return fail("Notificacao nao encontrada");

        const now = nowIso();
        row.status = "dismissed";
        row.dismissed_at = now;
        row.updated_at = now;
        return { data: { success: true }, error: null };
      }

      if (action === "login_popup") {
        const nowMs = Date.now();
        const rows = db.tables.user_notifications
          .filter((row) => row.user_id === userId && row.status === "unread")
          .sort((a, b) => String(b.delivered_at || "").localeCompare(String(a.delivered_at || "")));

        const candidate = rows.find((row) => {
          const ann = db.tables.system_announcements.find((item) => item.id === row.announcement_id);
          if (!ann) return false;
          if (!isAnnouncementActiveNow(ann, nowMs)) return false;
          const severity = String(ann.severity || "info");
          const channel = String(ann.channel || "bell");
          return ann.auto_popup_on_login === true && severity === "critical" && (channel === "modal" || channel === "both");
        });

        if (!candidate) {
          return { data: { item: null }, error: null };
        }

        const announcement = db.tables.system_announcements.find((item) => item.id === candidate.announcement_id);
        if (!announcement) return { data: { item: null }, error: null };

        const now = nowIso();
        candidate.status = "read";
        candidate.read_at = now;
        candidate.updated_at = now;

        return {
          data: {
            item: {
              ...candidate,
              announcement: {
                id: announcement.id,
                title: announcement.title,
                message: announcement.message,
                severity: announcement.severity,
                channel: announcement.channel,
              },
            },
          },
          error: null,
        };
      }

      return fail("Acao de notificacao invalida");
    }

    if (name === "admin-maintenance") {
      if (!currentUser || !userId) return fail("Usuario nao autenticado");
      if (!userIsAdmin(db, userId)) return fail("Acesso negado");

      const action = String(body.action || "get").trim();
      const current = resolveMaintenanceFlags(db);

      if (action === "get") {
        return { data: { ...current }, error: null };
      }

      if (action === "set") {
        let row = db.tables.app_runtime_flags.find((item) => String(item.id || "") === "global");
        const now = nowIso();
        if (!row) {
          row = {
            id: "global",
            created_at: now,
            updated_at: now,
            maintenance_enabled: false,
            maintenance_title: "Sistema em manutencao",
            maintenance_message: "Estamos realizando melhorias. Tente novamente em alguns minutos.",
            maintenance_eta: null,
            allow_admin_bypass: true,
            updated_by_user_id: String(userId || ""),
          };
          db.tables.app_runtime_flags.push(row);
        }

        if (typeof body.maintenance_enabled === "boolean") row.maintenance_enabled = body.maintenance_enabled;
        if (typeof body.maintenance_title === "string") row.maintenance_title = body.maintenance_title.trim() || "Sistema em manutencao";
        if (typeof body.maintenance_message === "string") row.maintenance_message = body.maintenance_message.trim() || "Estamos realizando melhorias. Tente novamente em alguns minutos.";
        if (typeof body.maintenance_eta === "string" || body.maintenance_eta === null) {
          row.maintenance_eta = typeof body.maintenance_eta === "string" && body.maintenance_eta.trim()
            ? body.maintenance_eta.trim()
            : null;
        }
        if (typeof body.allow_admin_bypass === "boolean") row.allow_admin_bypass = body.allow_admin_bypass;

        row.id = "global";
        row.updated_at = now;
        row.updated_by_user_id = String(userId || "");

        appendAudit(db, "set_maintenance", String(userId || ""), null, {
          maintenance_enabled: row.maintenance_enabled,
          maintenance_eta: row.maintenance_eta,
          allow_admin_bypass: row.allow_admin_bypass,
        });

        return {
          data: {
            maintenance_enabled: row.maintenance_enabled === true,
            maintenance_title: String(row.maintenance_title || "Sistema em manutencao"),
            maintenance_message: String(row.maintenance_message || ""),
            maintenance_eta: row.maintenance_eta ? String(row.maintenance_eta) : null,
            allow_admin_bypass: row.allow_admin_bypass !== false,
            updated_by_user_id: String(row.updated_by_user_id || ""),
          },
          error: null,
        };
      }

      return fail("Acao de manutencao invalida");
    }

    if (name === "account-plan") {
      if (!currentUser || !userId) return fail("Usuário não autenticado");
      if (userIsAdmin(db, userId)) return fail("Conta admin não possui plano de assinatura");

      const action = String(body.action || "");
      if (action !== "change_plan") {
        return fail("Ação de conta inválida");
      }

      const nextPlanId = String(body.plan_id || "").trim();
      if (!nextPlanId) return fail("Plano obrigatório");

      const controlPlane = loadAdminControlPlaneState();
      const targetPlan = controlPlane.plans.find((plan) => plan.id === nextPlanId);
      if (!targetPlan || !targetPlan.isActive || !targetPlan.visibleInAccount) {
        return fail("Plano indisponível para migração");
      }

      const profile = db.tables.profiles.find((row) => row.user_id === userId);
      if (!profile) return fail("Perfil não encontrado");

      const targetLimits = resolveEffectiveLimitsByPlanId(nextPlanId);
      const targetOperational = resolveEffectiveOperationalLimitsByPlanId(nextPlanId);
      if (!targetLimits || !targetOperational) {
        return fail("Nao foi possivel validar limites do plano selecionado");
      }

      const usage = {
        wa: db.tables.whatsapp_sessions.filter((row) => row.user_id === userId && row.status !== "deleted").length,
        tg: db.tables.telegram_sessions.filter((row) => row.user_id === userId && row.status !== "deleted").length,
        waGroups: db.tables.groups.filter((row) => row.user_id === userId && row.platform === "whatsapp" && !row.deleted_at).length,
        tgGroups: db.tables.groups.filter((row) => row.user_id === userId && row.platform === "telegram" && !row.deleted_at).length,
        routes: db.tables.routes.filter((row) => row.user_id === userId).length,
        automations: db.tables.shopee_automations.filter((row) => row.user_id === userId).length,
        schedules: db.tables.scheduled_posts.filter((row) => row.user_id === userId).length,
        templates: db.tables.templates.filter((row) => row.user_id === userId).length,
      };

      const exceeded = [
        { label: "sessoes WhatsApp", used: usage.wa, max: targetOperational.whatsappSessions },
        { label: "sessoes Telegram", used: usage.tg, max: targetOperational.telegramSessions },
        { label: "grupos WhatsApp", used: usage.waGroups, max: targetOperational.whatsappGroups },
        { label: "grupos Telegram", used: usage.tgGroups, max: targetOperational.telegramGroups },
        { label: "rotas", used: usage.routes, max: targetOperational.routes },
        { label: "automacoes", used: usage.automations, max: targetOperational.automations },
        { label: "agendamentos", used: usage.schedules, max: targetOperational.schedules },
        { label: "templates", used: usage.templates, max: targetLimits.templates },
      ]
        .filter((item) => item.max !== -1 && item.used > item.max)
        .map((item) => `${item.label} (${item.used}/${item.max})`);

      if (exceeded.length > 0) {
        return fail(`Nao foi possivel trocar de plano: limite excedido em ${exceeded.join(", ")}.`);
      }

      profile.plan_id = nextPlanId;
      profile.plan_expires_at = resolvePlanExpirationIsoFromControlPlane(nextPlanId);
      profile.updated_at = nowIso();

      db.tables.history_entries.push({
        id: randomId("hist"),
        user_id: userId,
        type: "session_event",
        source: "Conta",
        destination: "Plano",
        status: "success",
        details: {
          message: `Plano alterado para ${targetPlan.name}`,
          plan_id: nextPlanId,
          plan_expires_at: profile.plan_expires_at,
        },
        direction: "system",
        message_type: "text",
        processing_status: "processed",
        block_reason: "",
        error_step: "",
        created_at: nowIso(),
      });

      return {
        data: {
          success: true,
          plan_id: profile.plan_id,
          plan_expires_at: profile.plan_expires_at,
        },
        error: null,
      };
    }

    return fail(`Função local não implementada: ${name}`);
  });
}





