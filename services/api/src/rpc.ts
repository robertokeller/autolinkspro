import { Router } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { pool, query, queryOne, execute, transaction } from "./db.js";
import { requireAuth, signToken } from "./auth.js";
import { getPasswordPolicyError } from "./password-policy.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMeliProductSnapshot, listMeliVitrine, syncMeliVitrine } from "./meli-vitrine.js";

export const rpcRouter = Router();

// â”€â”€ Public: link-hub pages (no authentication required) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
rpcRouter.post("/rpc", async (req, res, next) => {
  if (String(req.body?.name ?? "") !== "link-hub-public") { next(); return; }
  const params = req.body ?? {};
  const slug = String(params.slug ?? "").trim();
  if (!slug) { res.json({ data: null, error: { message: "Slug obrigatório" } }); return; }
  try {
    const page = await queryOne("SELECT slug, title, config, is_active, user_id FROM link_hub_pages WHERE slug = $1 AND is_active = TRUE", [slug]);
    if (!page) { res.json({ data: { page: null, groups: [], groupLabels: {} }, error: null }); return; }
    const ownerUserId = String(page.user_id || "").trim();
    const resolvePublicInviteUrl = (row: { invite_link?: unknown; external_id?: unknown; platform?: unknown }) => {
      const explicit = String(row.invite_link ?? "").trim();
      if (/^https?:\/\//i.test(explicit)) return explicit;

      const external = String(row.external_id ?? "").trim();
      const platform = String(row.platform ?? "").trim();
      if (!external) return "";
      if (/^https?:\/\//i.test(external)) return external;

      if (platform === "telegram") {
        if (/^@[A-Za-z0-9_]{3,}$/i.test(external)) {
          return `https://t.me/${external.slice(1)}`;
        }
        if (/^[A-Za-z0-9_]{3,}$/i.test(external)) {
          return `https://t.me/${external}`;
        }
        return "";
      }

      if (platform === "whatsapp") {
        if (/^chat\.whatsapp\.com\/[A-Za-z0-9]+$/i.test(external)) return `https://${external}`;
        if (/^[A-Za-z0-9]{20,32}$/.test(external)) return `https://chat.whatsapp.com/${external}`;
        return "";
      }

      return "";
    };
    const publicPage = {
      slug: page.slug,
      title: page.title,
      config: page.config,
      is_active: page.is_active,
    };
    const cfg = page.config ?? {};
    const gids = Array.isArray(cfg.groupIds) ? cfg.groupIds : [];
    const mgids = Array.isArray(cfg.masterGroupIds) ? cfg.masterGroupIds : [];
    const groupLabels = cfg.groupLabels ?? {};
    const directGroups = gids.length > 0
      ? await query(
          `SELECT id, name, platform, external_id, invite_link, member_count
             FROM groups
            WHERE user_id = $1
              AND deleted_at IS NULL
              AND id = ANY($2)`,
          [ownerUserId, gids],
        )
      : [];
    let linkedGroups: Array<Record<string, unknown>> = [];
    if (mgids.length > 0) {
      const links = await query(
        `SELECT l.group_id
           FROM master_group_links l
           JOIN master_groups mg
             ON mg.id = l.master_group_id
          WHERE mg.user_id = $1
            AND l.is_active <> FALSE
            AND l.master_group_id = ANY($2)`,
        [ownerUserId, mgids],
      );
      const linkedIds = links.map((l: Record<string, unknown>) => l.group_id);
      linkedGroups = linkedIds.length > 0
        ? await query(
            `SELECT id, name, platform, external_id, invite_link, member_count
               FROM groups
              WHERE user_id = $1
                AND deleted_at IS NULL
                AND id = ANY($2)`,
            [ownerUserId, linkedIds],
          )
        : [];
    }
    const seen = new Set();
    const groups = [...directGroups, ...linkedGroups]
      .filter((g: Record<string, unknown>) => {
        if (seen.has(g.id)) return false;
        seen.add(g.id);
        return true;
      })
      .map((g: Record<string, unknown>) => ({
        ...g,
        redirect_url: resolvePublicInviteUrl({
          invite_link: g.invite_link,
          external_id: g.external_id,
          platform: g.platform,
        }),
      }));
    res.json({ data: { page: publicPage, groups, groupLabels }, error: null });
  } catch {
    res.status(500).json({ data: null, error: { message: "Erro interno" } });
  }
});

// Public: resolve and redirect master group invite (no authentication required)
rpcRouter.post("/rpc", async (req, res, next) => {
  if (String(req.body?.name ?? "") !== "master-group-invite") { next(); return; }

  const params = req.body ?? {};
  const masterGroupId = String(params.masterGroupId ?? "").trim();
  if (!masterGroupId) {
    res.json({ data: null, error: { message: "ID do grupo mestre é obrigatório" } });
    return;
  }

  const resolvePublicInviteUrl = (row: { invite_link?: unknown; external_id?: unknown; platform?: unknown }) => {
    const explicit = String(row.invite_link ?? "").trim();
    if (/^https?:\/\//i.test(explicit)) return explicit;

    const external = String(row.external_id ?? "").trim();
    const platform = String(row.platform ?? "").trim();
    if (!external) return "";
    if (/^https?:\/\//i.test(external)) return external;

    if (platform === "telegram") {
      if (/^@[A-Za-z0-9_]{3,}$/i.test(external)) {
        return `https://t.me/${external.slice(1)}`;
      }
      if (/^[A-Za-z0-9_]{3,}$/i.test(external)) {
        return `https://t.me/${external}`;
      }
      return "";
    }

    if (platform === "whatsapp") {
      if (/^chat\.whatsapp\.com\/[A-Za-z0-9]+$/i.test(external)) return `https://${external}`;
      if (/^[A-Za-z0-9]{20,32}$/.test(external)) return `https://chat.whatsapp.com/${external}`;
      return "";
    }

    return "";
  };

  try {
    const masterGroup = await queryOne<{
      id: string;
      user_id: string;
      name: string;
      distribution: string;
    }>(
      "SELECT id, user_id, name, distribution FROM master_groups WHERE id = $1",
      [masterGroupId],
    );

    if (!masterGroup) {
      res.json({ data: null, error: { message: "Grupo mestre não encontrado" } });
      return;
    }

    const linkedGroups = await query<{
      id: string;
      name: string;
      platform: string;
      member_count: number;
      invite_link: string;
      external_id: string;
    }>(
      `SELECT g.id, g.name, g.platform, g.member_count, g.invite_link, g.external_id
         FROM master_group_links l
         JOIN groups g
           ON g.id = l.group_id
        WHERE l.master_group_id = $1
          AND l.is_active <> FALSE
          AND g.user_id = $2
          AND g.deleted_at IS NULL`,
      [masterGroupId, masterGroup.user_id],
    );

    const candidates = linkedGroups
      .map((group) => ({ ...group, redirect_url: resolvePublicInviteUrl(group) }))
      .filter((group) => !!group.redirect_url);

    if (candidates.length === 0) {
      res.json({ data: null, error: { message: "Nenhum grupo filho com link de convite válido" } });
      return;
    }

    const mode = String(masterGroup.distribution || "").trim().toLowerCase() === "random"
      ? "random"
      : "balanced";

    let selected = candidates[0];
    if (mode === "random") {
      selected = candidates[Math.floor(Math.random() * candidates.length)];
    } else {
      const minMembers = Math.min(...candidates.map((group) => Number(group.member_count || 0)));
      const balanced = candidates.filter((group) => Number(group.member_count || 0) === minMembers);
      selected = balanced[Math.floor(Math.random() * balanced.length)];
    }

    res.json({
      data: {
        redirectUrl: selected.redirect_url,
        mode,
        group: {
          id: selected.id,
          name: selected.name,
          platform: selected.platform,
          memberCount: Number(selected.member_count || 0),
        },
        masterGroup: {
          id: masterGroup.id,
          name: masterGroup.name,
        },
      },
      error: null,
    });
  } catch {
    res.status(500).json({ data: null, error: { message: "Erro interno" } });
  }
});

rpcRouter.use(requireAuth);

const IS_PRODUCTION = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
const USE_LOCAL_FALLBACK_URLS = !IS_PRODUCTION;
const WHATSAPP_URL  = process.env.WHATSAPP_MICROSERVICE_URL
  ?? process.env.VITE_WHATSAPP_MICROSERVICE_URL
  ?? (USE_LOCAL_FALLBACK_URLS ? "http://127.0.0.1:3111" : "");
const TELEGRAM_URL  = process.env.TELEGRAM_MICROSERVICE_URL
  ?? process.env.VITE_TELEGRAM_MICROSERVICE_URL
  ?? (USE_LOCAL_FALLBACK_URLS ? "http://127.0.0.1:3112" : "");
const SHOPEE_URL    = process.env.SHOPEE_MICROSERVICE_URL
  ?? process.env.VITE_SHOPEE_MICROSERVICE_URL
  ?? (USE_LOCAL_FALLBACK_URLS ? "http://127.0.0.1:3113" : "");
const MELI_URL      = process.env.MELI_RPA_URL
  ?? process.env.VITE_MELI_RPA_URL
  ?? (USE_LOCAL_FALLBACK_URLS ? "http://127.0.0.1:3114" : "");
const OPS_URL       = process.env.OPS_CONTROL_URL
  ?? process.env.VITE_OPS_CONTROL_URL
  ?? (USE_LOCAL_FALLBACK_URLS ? "http://127.0.0.1:3115" : "");
const OPS_TOKEN     = String(process.env.OPS_CONTROL_TOKEN ?? "").trim();
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET ?? "").trim();
const PLAN_EXPIRY_ALLOWED = new Set(["account-plan","admin-users","link-hub-public","admin-announcements","user-notifications","admin-maintenance"]);
const MAX_URL_LENGTH = 2048;
const MAX_SHOPEE_CONVERT_BATCH = 30;
const MAX_MELI_CONVERT_BATCH = 50;
const MAX_SHOPEE_BATCH_QUERIES = 20;
const ROUTE_MEDIA_DEBUG_ENABLED = new Set(["1", "true", "yes", "on"]).has(
  String(process.env.ROUTE_MEDIA_DEBUG || "").trim().toLowerCase(),
);

type RpcRatePolicy = {
  max: number;
  windowMs: number;
  message: string;
};

const RPC_RATE_BY_FUNCTION: Record<string, RpcRatePolicy> = {
  "shopee-convert-link": {
    max: 40,
    windowMs: 60_000,
    message: "Limite de conversão Shopee atingido. Aguarde 1 minuto.",
  },
  "shopee-convert-links": {
    max: 12,
    windowMs: 60_000,
    message: "Limite de lote Shopee atingido. Aguarde 1 minuto.",
  },
  "shopee-batch": {
    max: 20,
    windowMs: 60_000,
    message: "Limite de consultas Shopee atingido. Aguarde 1 minuto.",
  },
  "shopee-automation-run": {
    max: 6,
    windowMs: 60_000,
    message: "Muitas execucoes de piloto automatico Shopee. Aguarde 1 minuto.",
  },
  "meli-convert-link": {
    max: 30,
    windowMs: 60_000,
    message: "Limite de conversão Mercado Livre atingido. Aguarde 1 minuto.",
  },
  "meli-convert-links": {
    max: 10,
    windowMs: 60_000,
    message: "Limite de lote Mercado Livre atingido. Aguarde 1 minuto.",
  },
  "meli-test-session": {
    max: 24,
    windowMs: 60_000,
    message: "Limite de válidacao de sessão atingido. Aguarde 1 minuto.",
  },
  "meli-automation-run": {
    max: 6,
    windowMs: 60_000,
    message: "Muitas execucoes de piloto automatico Mercado Livre. Aguarde 1 minuto.",
  },
  "meli-vitrine-sync": {
    max: 6,
    windowMs: 60_000,
    message: "Muitas atualizacoes da vitrine ML. Aguarde 1 minuto.",
  },
};

const rpcFunctionRateStore = new Map<string, { count: number; resetAt: number }>();

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ok(res, data) { res.json({ data, error: null }); }
function fail(res, message, status = 200) { res.status(status).json({ data: null, error: { message } }); }
function nowIso() { return new Date().toISOString(); }

const AUTOMATION_RECENT_OFFER_LIMIT = 200;
const AUTOMATION_RECENT_OFFER_WINDOW_HOURS = 72;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalhostUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = String(u.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function inferPortFromUrl(raw: string, fallback: number): number {
  try {
    const u = new URL(raw);
    const port = Number(u.port);
    if (Number.isFinite(port) && port > 0) return port;
    if (u.protocol === "https:") return 443;
    if (u.protocol === "http:") return 80;
    return fallback;
  } catch {
    return fallback;
  }
}

function sanitizeScopePart(value: string, max = 24): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, max) || "x";
}

function buildScopedMeliSessionId(userId: string, sessionId: string): string {
  return `${sanitizeScopePart(userId, 64)}__${sanitizeScopePart(sessionId, 48)}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function parseHttpUrl(raw: string): URL | null {
  const value = String(raw || "").trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isShopeeProductUrlLike(raw: string): boolean {
  const parsed = parseHttpUrl(raw);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return host.includes("shopee.") || host.endsWith("shope.ee");
}

function isMercadoLivreProductUrlLike(raw: string): boolean {
  const parsed = parseHttpUrl(raw);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return (
    host === "meli.la"
    || host.endsWith(".meli.la")
    || host === "mlb.am"
    || host.endsWith(".mlb.am")
    || host.includes("mercadolivre")
    || host.includes("mercadolibre")
    || host.includes("mercadopago")
    || host.includes("mlstatic")
  );
}

function consumeRpcFunctionRateLimit(scopeKey: string, funcName: string): { allowed: boolean; policy: RpcRatePolicy | null } {
  const policy = RPC_RATE_BY_FUNCTION[funcName] ?? null;
  if (!policy) return { allowed: true, policy: null };

  const now = Date.now();
  const key = `${scopeKey}:${funcName}`;
  const entry = rpcFunctionRateStore.get(key);

  if (!entry || now > entry.resetAt) {
    rpcFunctionRateStore.set(key, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true, policy };
  }

  entry.count += 1;
  return { allowed: entry.count <= policy.max, policy };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rpcFunctionRateStore) {
    if (now > entry.resetAt) rpcFunctionRateStore.delete(key);
  }
}, 5 * 60_000).unref();

function parseTimeToMinutes(value: unknown, fallbackMinutes: number): number {
  const raw = String(value || "").trim();
  const [hRaw, mRaw] = raw.split(":");
  const hours = Number.parseInt(hRaw || "", 10);
  const minutes = Number.parseInt(mRaw || "", 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallbackMinutes;
  const safeHours = Math.max(0, Math.min(23, hours));
  const safeMinutes = Math.max(0, Math.min(59, minutes));
  return safeHours * 60 + safeMinutes;
}

function nowMinutesInTimeZone(date = new Date()): number {
  const tz = String(process.env.AUTOMATION_TIMEZONE || process.env.TZ || "America/Sao_Paulo").trim() || "America/Sao_Paulo";
  try {
    const parts = new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).formatToParts(date);
    const hourPart = Number(parts.find((part) => part.type === "hour")?.value || "0");
    const minutePart = Number(parts.find((part) => part.type === "minute")?.value || "0");
    if (Number.isFinite(hourPart) && Number.isFinite(minutePart)) {
      return Math.max(0, Math.min(23, hourPart)) * 60 + Math.max(0, Math.min(59, minutePart));
    }
  } catch {
    // Fallback to host time when timezone parsing is unavailable.
  }
  return date.getHours() * 60 + date.getMinutes();
}

function inAutomationTimeWindow(startTime: unknown, endTime: unknown, date = new Date()): boolean {
  const nowMinutes = nowMinutesInTimeZone(date);
  const startMinutes = parseTimeToMinutes(startTime, 8 * 60);
  const endMinutes = parseTimeToMinutes(endTime, 20 * 60);
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

function hasLetters(value: string): boolean {
  return /[a-zA-Z\u00C0-\u024F]/.test(value);
}

type AutomationOfferSourceMode = "search" | "vitrine";

const AUTOMATION_VITRINE_QUERY_PRESETS: Record<string, { listType: number; sortBy: string }> = {
  sales: { listType: 0, sortBy: "sales" },
  commission: { listType: 0, sortBy: "commission" },
  discount: { listType: 0, sortBy: "discount" },
  rating: { listType: 0, sortBy: "rating" },
  top: { listType: 2, sortBy: "sales" },
};

function normalizeAutomationOfferSourceMode(value: unknown): AutomationOfferSourceMode {
  return String(value || "").trim().toLowerCase() === "vitrine" ? "vitrine" : "search";
}

function normalizeAutomationVitrineTabs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const normalized = String(raw || "").trim().toLowerCase();
    if (!normalized || !AUTOMATION_VITRINE_QUERY_PRESETS[normalized] || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

const MELI_AUTOMATION_ALLOWED_TABS = new Set([
  "destaques",
  "top_performance",
  "mais_vendidos",
  "ofertas_quentes",
  "melhor_avaliados",
]);

const MELI_AUTOMATION_TAB_ALIASES: Record<string, string> = {
  all: "destaques",
  destaques: "destaques",
  top_performance: "top_performance",
  mais_vendidos: "mais_vendidos",
  ofertas_quentes: "ofertas_quentes",
  melhor_avaliados: "melhor_avaliados",
  beleza_cuidados: "destaques",
  calcados_roupas_bolsas: "destaques",
  casa_moveis_decoracao: "destaques",
  celulares_telefones: "destaques",
  construcao: "destaques",
  eletrodomesticos: "destaques",
  esportes_fitness: "destaques",
  ferramentas: "destaques",
  informatica: "destaques",
  saude: "destaques",
};

function normalizeMeliAutomationVitrineTabs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const normalizedRaw = String(raw || "").trim().toLowerCase();
    const normalized = MELI_AUTOMATION_TAB_ALIASES[normalizedRaw] || normalizedRaw;
    if (!normalized || !MELI_AUTOMATION_ALLOWED_TABS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractAutomationSearchKeywords(input: {
  categories: unknown;
  automationName: string;
}): string[] {
  const out: string[] = [];
  const categories = toStringArray(input.categories);
  for (const raw of categories) {
    if (raw.toLowerCase() === "todos") continue;
    if (hasLetters(raw)) out.push(raw);
  }

  const name = String(input.automationName || "").trim();
  if (name && hasLetters(name)) out.push(name);

  out.push("oferta");

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of out) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(value.trim());
    if (unique.length >= 5) break;
  }
  return unique.length > 0 ? unique : ["oferta"];
}

function buildShopeeAutomationQueries(input: {
  categories: unknown;
  automationName: string;
  sourceMode: AutomationOfferSourceMode;
  vitrineTabs: string[];
}): Array<{ id: string; type: "search" | "products"; params: Record<string, unknown> }> {
  if (input.sourceMode === "vitrine") {
    const tabs = input.vitrineTabs.length > 0 ? input.vitrineTabs : ["sales"];
    const queries: Array<{ id: string; type: "search" | "products"; params: Record<string, unknown> }> = [];
    for (const tabKey of tabs) {
      const preset = AUTOMATION_VITRINE_QUERY_PRESETS[tabKey];
      if (!preset) continue;
      queries.push({
        id: `vitrine_${tabKey}`,
        type: "products",
        params: {
          sortBy: preset.sortBy,
          listType: preset.listType,
          limit: 20,
          page: 1,
        },
      });
    }
    if (queries.length > 0) return queries;
  }

  const keywords = extractAutomationSearchKeywords(input);
  return keywords.map((keyword, index) => ({
    id: `kw_${index}`,
    type: "search" as const,
    params: {
      keyword,
      sortBy: "sales",
      limit: 20,
      page: 1,
    },
  }));
}

function extractValidShopeeAffiliateLink(product: Record<string, unknown>): string {
  const candidates = [
    String(product.offerLink || "").trim(),
    String(product.affiliateLink || "").trim(),
    String(product.link || "").trim(),
  ];
  for (const link of candidates) {
    if (/^https?:\/\//i.test(link)) return link;
  }
  return "";
}

function normalizeOfferTitle(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function loadRecentAutomationOfferTitleSet(input: {
  userId: string;
  automationId: string;
  automationName: string;
}): Promise<Set<string>> {
  const rows = await query<{ title: string }>(
    `SELECT COALESCE(
       NULLIF(TRIM(details->'product'->>'title'), ''),
       NULLIF(TRIM(details->>'title'), ''),
       ''
     ) AS title
       FROM history_entries
      WHERE user_id = $1
        AND type = 'automation_run'
        AND processing_status = 'sent'
        AND (
          details->>'automationId' = $2
          OR (COALESCE(details->>'automationId', '') = '' AND source = $3)
        )
        AND created_at >= NOW() - ($4::int * INTERVAL '1 hour')
      ORDER BY created_at DESC
      LIMIT $5`,
    [
      input.userId,
      input.automationId,
      input.automationName,
      AUTOMATION_RECENT_OFFER_WINDOW_HOURS,
      AUTOMATION_RECENT_OFFER_LIMIT,
    ],
  );

  const normalizedTitles = rows
    .map((row) => normalizeOfferTitle(row.title))
    .filter(Boolean);
  return new Set(normalizedTitles);
}

function applyPlaceholders(template: string, replacements: Record<string, string>): string {
  let output = String(template || "");
  for (const [key, value] of Object.entries(replacements)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(escaped, "g"), value);
    const doubleKey = key.replace("{", "{{").replace("}", "}}");
    if (doubleKey !== key) {
      const escapedDouble = doubleKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      output = output.replace(new RegExp(escapedDouble, "g"), value);
    }
  }
  return output;
}

function escapeTelegramHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function formatMessageForPlatform(message: string, platform: "whatsapp" | "telegram"): string {
  if (platform === "whatsapp") {
    return message
      .replace(/\*\*(.+?)\*\*/gs, "*$1*")
      .replace(/__(.+?)__/gs, "_$1_")
      .replace(/~~(.+?)~~/gs, "~$1~");
  }

  const escaped = escapeTelegramHtml(message);
  return escaped
    .replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")
    .replace(/__(.+?)__/gs, "<i>$1</i>")
    .replace(/~~(.+?)~~/gs, "<s>$1</s>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "<b>$1</b>");
}

function formatMessageForDestinationPlatform(message: string, platform: string): string {
  if (platform === "whatsapp" || platform === "telegram") {
    return formatMessageForPlatform(message, platform);
  }
  return message;
}

function toRouteKeywordList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function routeTextMatchesAnyKeyword(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const normalized = String(text || "").toLowerCase();
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

function buildRouteTemplatePlaceholderData(
  product: Record<string, unknown> | null,
  affiliateLink: string,
): Record<string, string> {
  const source = product && typeof product === "object" ? product : {};

  const salePrice = toNumber(source.salePrice ?? source.price, Number.NaN);
  const originalPriceRaw = toNumber(
    source.originalPrice
    ?? source.priceMinBeforeDiscount
    ?? source.priceBeforeDiscount
    ?? source.priceMin,
    Number.NaN,
  );
  const originalPrice = Number.isFinite(originalPriceRaw) && originalPriceRaw > 0
    ? originalPriceRaw
    : salePrice;

  const formatPrice = (value: number) => (Number.isFinite(value) && value > 0 ? value.toFixed(2) : "");

  const discountFromProduct = toNumber(source.discount ?? source.priceDiscountRate, 0);
  const discountComputed = Number.isFinite(originalPrice) && Number.isFinite(salePrice) && originalPrice > salePrice
    ? Math.round((1 - salePrice / originalPrice) * 100)
    : 0;
  const discount = Math.max(0, discountFromProduct || discountComputed);

  const title = String(source.title ?? source.productName ?? "").trim();
  const link = String(
    affiliateLink
      || source.affiliateLink
      || source.offerLink
      || source.link
      || source.productLink
      || "",
  ).trim();
  const rating = toNumber(source.rating ?? source.ratingStar, 0);

  return {
    "{titulo}": title,
    "{preco}": formatPrice(salePrice),
    "{preco_original}": formatPrice(originalPrice),
    "{desconto}": discount > 0 ? String(discount) : "",
    "{link}": link,
    "{imagem}": "",
    "{avaliacao}": rating > 0 ? String(rating) : "",
  };
}

function buildShopeeAutomationMessage(templateContent: string, product: Record<string, unknown>, affiliateLink: string): string {
  const contentWithoutImageLine = String(templateContent || "")
    .replace(/^[ \t]*(?:\{imagem\}|\{\{imagem\}\})[ \t]*(?:\r?\n|$)/gim, "");

  return applyPlaceholders(contentWithoutImageLine, {
    "{titulo}": String(product.title || "Produto Shopee"),
    "{preco}": Number(toNumber(product.salePrice, 0)).toFixed(2),
    "{preco_original}": Number(toNumber(product.originalPrice, 0)).toFixed(2),
    "{desconto}": String(Math.max(0, toNumber(product.discount, 0))),
    "{link}": affiliateLink,
    "{imagem}": "",
    "{avaliacao}": String(Math.max(0, toNumber(product.rating, 0))),
  });
}

function formatMeliTemplatePrice(value: unknown): string {
  const numeric = toNumber(value, 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return numeric.toFixed(2).replace(".", ",");
}

function normalizeMeliTemplateInstallments(value: unknown): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = normalized.match(/(\d{1,2})x\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) return normalized.replace(/^ou\s+/i, "").trim();
  const suffix = /sem juros/i.test(normalized) ? " sem juros" : "";
  return `${match[1]}x de R$${match[2]}${suffix}`.trim();
}

function buildMeliAutomationMessage(templateContent: string, product: Record<string, unknown>, affiliateLink: string): string {
  const contentWithoutImageLine = String(templateContent || "")
    .replace(/^[ \t]*(?:\{imagem\}|\{\{imagem\}\})[ \t]*(?:\r?\n|$)/gim, "");

  return applyPlaceholders(contentWithoutImageLine, {
    "{titulo}": String(product.title || "Produto Mercado Livre").trim(),
    "{preco}": formatMeliTemplatePrice(product.price),
    "{preco_original}": formatMeliTemplatePrice(product.oldPrice),
    "{link}": String(affiliateLink || "").trim(),
    "{imagem}": "",
    "{avaliacao}": toNumber(product.rating, 0) > 0 ? Number(toNumber(product.rating, 0)).toFixed(1) : "",
    "{avaliacoes}": toNumber(product.reviewsCount, 0) > 0 ? String(Math.floor(toNumber(product.reviewsCount, 0))) : "",
    "{parcelamento}": normalizeMeliTemplateInstallments(product.installmentsText),
    "{vendedor}": String(product.seller || "").trim(),
  });
}

async function insertAutomationHistoryEntry(input: {
  userId: string;
  automationName: string;
  destination: string;
  status: "success" | "error" | "warning" | "info";
  processingStatus: "sent" | "failed" | "blocked" | "processed";
  message: string;
  details?: Record<string, unknown>;
  blockReason?: string;
  errorStep?: string;
  messageType?: "text" | "image";
}) {
  await execute(
    "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'automation_run',$3,$4,$5,$6,'outbound',$7,$8,$9,$10)",
    [
      uuid(),
      input.userId,
      input.automationName,
      input.destination,
      input.status,
      JSON.stringify({
        message: input.message,
        ...(input.details || {}),
      }),
      input.messageType || "text",
      input.processingStatus,
      input.blockReason || "",
      input.errorStep || "",
    ],
  );
}

function safeGrowthRatio(current: number, expected: number): number {
  if (expected <= 0) return current > 0 ? Number(current.toFixed(4)) : 0;
  return Number((current / expected).toFixed(4));
}

function calcExpected24hFrom7d(total7d: number): number {
  return Number((Math.max(total7d, 0) / 7).toFixed(4));
}

function isSessionOnlineStatus(status: unknown): boolean {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "online" || normalized === "active" || normalized === "connected" || normalized === "ready";
}

type QueueBucket = { active: number; pending: number; limit: number };

function normalizeQueueBucket(value: unknown, fallbackLimit: number): QueueBucket {
  const row = (value && typeof value === "object" && !Array.isArray(value)) ? value as Record<string, unknown> : {};
  return {
    active: Math.max(0, toInt(row.active, 0)),
    pending: Math.max(0, toInt(row.pending, 0)),
    limit: Math.max(1, toInt(row.limit, fallbackLimit)),
  };
}

async function collectProcessQueueSnapshot() {
  const dispatchLimit = Math.max(10, toInt(process.env.DISPATCH_LIMIT, 100));
  const routeLimit = Math.max(10, toInt(process.env.ROUTE_PROCESS_LIMIT, 200));
  const automationLimit = Math.max(5, toInt(process.env.SHOPEE_AUTOMATION_LIMIT, 50));

  const [dispatchRow, automationRow, routeActiveRow, waHealth, tgHealth, meliHealth] = await Promise.all([
    queryOne<{
      processing_active: string | number;
      pending_due: string | number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'processing') AS processing_active,
         COUNT(*) FILTER (WHERE status = 'pending' AND scheduled_at <= NOW()) AS pending_due
       FROM scheduled_posts`
    ),
    queryOne<{
      active: string | number;
      pending_due: string | number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active' AND is_active = TRUE) AS active,
         COUNT(*) FILTER (
           WHERE status = 'active' AND is_active = TRUE
             AND (
               last_run_at IS NULL
               OR last_run_at <= NOW() - (GREATEST(COALESCE(interval_minutes, 1), 1) * INTERVAL '1 minute')
             )
         ) AS pending_due
       FROM shopee_automations`
    ),
    queryOne<{ active_routes: string | number }>("SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_routes FROM routes"),
    WHATSAPP_URL ? proxyMicroservice(WHATSAPP_URL, "/health", "GET", null, {}, 5000) : Promise.resolve({ data: null, error: { message: "WHATSAPP_MICROSERVICE_URL não configurado" } }),
    TELEGRAM_URL ? proxyMicroservice(TELEGRAM_URL, "/health", "GET", null, {}, 5000) : Promise.resolve({ data: null, error: { message: "TELEGRAM_MICROSERVICE_URL não configurado" } }),
    MELI_URL ? proxyMicroservice(MELI_URL, "/api/meli/health", "GET", null, {}, 5000) : Promise.resolve({ data: null, error: { message: "MELI_RPA_URL não configurado" } }),
  ]);

  const waPayload = (waHealth.data && typeof waHealth.data === "object") ? waHealth.data as Record<string, unknown> : {};
  const tgPayload = (tgHealth.data && typeof tgHealth.data === "object") ? tgHealth.data as Record<string, unknown> : {};
  const waSessions = Array.isArray(waPayload.sessions) ? waPayload.sessions : [];
  const tgSessions = Array.isArray(tgPayload.sessions) ? tgPayload.sessions : [];

  const waQueued = waSessions.reduce((acc, item) => {
    const row = (item && typeof item === "object") ? item as Record<string, unknown> : {};
    return acc + Math.max(0, toInt(row.queuedEvents, 0));
  }, 0);
  const tgQueued = tgSessions.reduce((acc, item) => {
    const row = (item && typeof item === "object") ? item as Record<string, unknown> : {};
    return acc + Math.max(0, toInt(row.queuedEvents, 0));
  }, 0);
  const routeQueued = waQueued + tgQueued;

  const meliPayload = (meliHealth.data && typeof meliHealth.data === "object") ? meliHealth.data as Record<string, unknown> : {};
  const meliStats = (meliPayload.stats && typeof meliPayload.stats === "object")
    ? meliPayload.stats as Record<string, unknown>
    : {};

  const convertActive = Math.max(0, toInt(meliStats.activeCount, 0));
  const convertPending = Math.max(0, toInt(meliStats.queueLength, 0));
  const convertLimit = Math.max(1, toInt(meliStats.maxConcurrency, toInt(process.env.MELI_CONVERTER_CONCURRENCY, 1)));

  return {
    route: normalizeQueueBucket(
      { active: toInt(routeActiveRow?.active_routes, 0), pending: routeQueued, limit: routeLimit },
      routeLimit,
    ),
    dispatch: normalizeQueueBucket(
      {
        active: toInt(dispatchRow?.processing_active, 0),
        pending: toInt(dispatchRow?.pending_due, 0),
        limit: dispatchLimit,
      },
      dispatchLimit,
    ),
    automation: normalizeQueueBucket(
      {
        active: toInt(automationRow?.active, 0),
        pending: toInt(automationRow?.pending_due, 0),
        limit: automationLimit,
      },
      automationLimit,
    ),
    convert: normalizeQueueBucket(
      {
        active: convertActive,
        pending: convertPending,
        limit: convertLimit,
      },
      convertLimit,
    ),
    telemetry: {
      whatsapp: {
        queuedEvents: waQueued,
        sessions: waSessions.length,
        online: waHealth.error ? false : true,
        error: waHealth.error?.message ?? null,
      },
      telegram: {
        queuedEvents: tgQueued,
        sessions: tgSessions.length,
        online: tgHealth.error ? false : true,
        error: tgHealth.error?.message ?? null,
      },
      meli: {
        online: meliHealth.error ? false : true,
        error: meliHealth.error?.message ?? null,
      },
    },
  };
}

function extractMicroserviceError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    if (typeof row.error === "string" && row.error.trim()) return row.error.trim();
    if (row.error && typeof row.error === "object" && typeof (row.error as Record<string, unknown>).message === "string") {
      return String((row.error as Record<string, unknown>).message);
    }
    if (typeof row.message === "string" && row.message.trim()) return row.message.trim();
  }
  return fallback;
}

async function proxyMicroservice(baseUrl, path, method, body, extraHeaders = {}, timeoutMs = 10_000) {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "x-webhook-secret": WEBHOOK_SECRET, ...extraHeaders },
      body: method !== "GET" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const rawText = await r.text();
    let json: unknown = null;
    if (rawText) {
      try {
        json = JSON.parse(rawText);
      } catch {
        json = null;
      }
    }

    if (!r.ok) {
      const fallback = rawText?.trim() || `Microservice error ${r.status}`;
      return { data: null, error: { message: extractMicroserviceError(json, fallback), status: r.status } };
    }

    if (json === null) {
      return { data: null, error: { message: "Invalid JSON from microservice" } };
    }

    return { data: json, error: null };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      console.warn(`[rpc] proxyMicroservice timeout: ${method} ${url}`);
      return { data: null, error: { message: `Microservice timeout (${Math.round(timeoutMs / 1000)}s)` } };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { data: null, error: { message } };
  } finally {
    clearTimeout(timeoutId);
  }
}

function isTransientMicroserviceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as Record<string, unknown>;
  const status = Number(row.status);
  if (Number.isFinite(status) && [408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  const message = String(row.message || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("too many requests")
    || message.includes("rate limit")
    || message.includes("timeout")
    || message.includes("temporar")
    || message.includes("econnreset")
    || message.includes("socket hang up")
  );
}

function isTransientMeliSessionValidationResult(input: {
  status: string;
  errorMessage: string;
  logs: unknown[];
}): boolean {
  const normalizedStatus = String(input.status || "").trim().toLowerCase();
  if (normalizedStatus === "active") return false;

  const lines: string[] = [String(input.errorMessage || "")];
  for (const entry of input.logs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const message = String(row.message || "").trim();
    if (message) lines.push(message);
  }
  const haystack = lines.join(" ").toLowerCase();
  if (!haystack) return false;

  if (normalizedStatus !== "error" && normalizedStatus !== "no_affiliate") {
    return false;
  }

  return (
    haystack.includes("http 429")
    || haystack.includes("too many requests")
    || haystack.includes("rate limit")
    || haystack.includes("timeout")
    || haystack.includes("temporar")
    || haystack.includes("captcha")
    || haystack.includes("challenge")
    || haystack.includes("security")
    || haystack.includes("service unavailable")
    || haystack.includes("indispon")
    || haystack.includes("http 503")
    || haystack.includes("http 502")
  );
}

function buildUserScopedHeaders(userId: string) {
  return { "x-autolinks-user-id": userId };
}

type RouteForwardMedia = {
  kind: "image";
  sourcePlatform?: "whatsapp" | "telegram" | "auto";
  token?: string;
  base64?: string;
  mimeType?: string;
  fileName?: string;
};

function summarizeRouteForwardMedia(media: RouteForwardMedia | null | undefined): Record<string, unknown> {
  if (!media || media.kind !== "image") return { kind: "none" };
  return {
    kind: "image",
    sourcePlatform: media.sourcePlatform || "unknown",
    hasToken: Boolean(media.token),
    hasBase64: Boolean(media.base64),
    mimeType: media.mimeType || "",
    fileName: media.fileName || "",
    base64Length: media.base64 ? media.base64.length : 0,
  };
}

function logRouteMediaDebug(event: string, payload: Record<string, unknown>): void {
  if (!ROUTE_MEDIA_DEBUG_ENABLED) return;
  try {
    console.info(`[route-media-debug] ${event} ${JSON.stringify(payload)}`);
  } catch {
    console.info(`[route-media-debug] ${event}`);
  }
}

function parseRouteForwardMedia(raw: unknown): RouteForwardMedia | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.kind !== "image") return null;

  const token = typeof row.token === "string" ? row.token.trim() : "";
  const base64 = typeof row.base64 === "string" ? row.base64.trim() : "";
  if (!token && !base64) return null;
  const sourcePlatformRaw = typeof row.sourcePlatform === "string" ? row.sourcePlatform.trim().toLowerCase() : "";
  const sourcePlatform = sourcePlatformRaw === "whatsapp" || sourcePlatformRaw === "telegram" || sourcePlatformRaw === "auto"
    ? sourcePlatformRaw as "whatsapp" | "telegram" | "auto"
    : undefined;

  return {
    kind: "image",
    sourcePlatform,
    token: token || undefined,
    base64: base64 || undefined,
    mimeType: typeof row.mimeType === "string" && row.mimeType.trim() ? row.mimeType.trim() : "image/jpeg",
    fileName: typeof row.fileName === "string" && row.fileName.trim() ? row.fileName.trim() : "route_image.jpg",
  };
}

type ScheduleRecurrenceMode = "none" | "daily" | "weekly";
const SCHEDULE_WEEK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type ScheduleWeekDay = (typeof SCHEDULE_WEEK_DAYS)[number];
const SCHEDULE_WEEK_DAY_SET = new Set<string>(SCHEDULE_WEEK_DAYS);

function parseScheduleMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function parseScheduleTemplateData(metadata: Record<string, unknown>): Record<string, string> {
  const raw = metadata.templateData;
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

  parsed["{imagem}"] = "";
  parsed["{{imagem}}"] = "";
  return parsed;
}

function normalizeScheduleRecurrence(value: unknown): ScheduleRecurrenceMode {
  if (value === "daily" || value === "weekly") return value;
  return "none";
}

function normalizeScheduleTime(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) return "";
  const [hhRaw, mmRaw] = trimmed.split(":");
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return "";
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseScheduleRecurrenceTimes(metadata: Record<string, unknown>, scheduledAtRaw: unknown): string[] {
  const raw = Array.isArray(metadata.recurrenceTimes)
    ? metadata.recurrenceTimes
    : [];
  const normalized = raw
    .map((item) => normalizeScheduleTime(item))
    .filter(Boolean);

  if (normalized.length > 0) {
    return Array.from(new Set(normalized)).sort();
  }

  const scheduledAt = new Date(String(scheduledAtRaw || ""));
  if (Number.isNaN(scheduledAt.getTime())) return [];
  return [`${String(scheduledAt.getHours()).padStart(2, "0")}:${String(scheduledAt.getMinutes()).padStart(2, "0")}`];
}

function parseScheduleWeekDays(metadata: Record<string, unknown>, baseDate: Date): ScheduleWeekDay[] {
  if (Array.isArray(metadata.weekDays)) {
    const values = metadata.weekDays
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item): item is ScheduleWeekDay => SCHEDULE_WEEK_DAY_SET.has(item));
    if (values.length > 0) return Array.from(new Set(values));
  }

  return [SCHEDULE_WEEK_DAYS[baseDate.getDay()] || "sun"];
}

function dateKeyLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getLatestScheduleSlotOnDate(times: string[], now: Date): string | null {
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

function getDueScheduleSlotKey(post: {
  recurrence: unknown;
  scheduled_at: unknown;
  metadata: unknown;
}, nowMs: number): string | null {
  const recurrence = normalizeScheduleRecurrence(post.recurrence);
  const scheduledAt = String(post.scheduled_at || "");
  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) return null;
  if (scheduledDate.getTime() > nowMs) return null;

  const metadata = parseScheduleMetadata(post.metadata);
  const lastDispatchSlot = typeof metadata.lastDispatchSlot === "string"
    ? metadata.lastDispatchSlot
    : "";
  const now = new Date(nowMs);

  if (recurrence === "none") {
    return `once:${scheduledAt}`;
  }

  const times = parseScheduleRecurrenceTimes(metadata, scheduledAt);
  if (times.length === 0) return null;

  if (recurrence === "daily") {
    const slot = getLatestScheduleSlotOnDate(times, now);
    if (!slot) return null;
    const key = `daily:${dateKeyLocal(now)}@${slot}`;
    return key === lastDispatchSlot ? null : key;
  }

  const weekDays = parseScheduleWeekDays(metadata, scheduledDate);
  const today = SCHEDULE_WEEK_DAYS[now.getDay()] || "sun";
  if (!weekDays.includes(today)) return null;
  const slot = getLatestScheduleSlotOnDate(times, now);
  if (!slot) return null;
  const key = `weekly:${dateKeyLocal(now)}@${slot}`;
  return key === lastDispatchSlot ? null : key;
}

function computeNextRecurringScheduleAt(post: {
  recurrence: unknown;
  scheduled_at: unknown;
  metadata: unknown;
}, nowMs: number): string {
  const recurrence = normalizeScheduleRecurrence(post.recurrence);
  const scheduledAt = String(post.scheduled_at || "");
  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) return nowIso();
  if (recurrence === "none") return scheduledAt;

  const metadata = parseScheduleMetadata(post.metadata);
  const times = parseScheduleRecurrenceTimes(metadata, scheduledAt);
  if (times.length === 0) return scheduledAt;

  const weekDays = parseScheduleWeekDays(metadata, scheduledDate);

  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const candidateDate = new Date(nowMs);
    candidateDate.setHours(0, 0, 0, 0);
    candidateDate.setDate(candidateDate.getDate() + dayOffset);

    if (recurrence === "weekly") {
      const weekDay = SCHEDULE_WEEK_DAYS[candidateDate.getDay()] || "sun";
      if (!weekDays.includes(weekDay)) continue;
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

function parseScheduledPostMedia(metadata: Record<string, unknown>): RouteForwardMedia | null {
  return parseRouteForwardMedia(metadata.media);
}

function scheduleRequiresMandatoryImage(metadata: Record<string, unknown>): boolean {
  const policy = String(metadata.imagePolicy || "").trim().toLowerCase();
  if (policy === "required") return true;
  const source = String(metadata.scheduleSource || "").trim().toLowerCase();
  return source === "shopee_catalog";
}

function extractScheduleProductImageUrl(metadata: Record<string, unknown>): string {
  const candidates = [
    metadata.productImageUrl,
    metadata.imageUrl,
    metadata.product_image_url,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (/^https?:\/\//i.test(value)) return value;
  }
  return "";
}

function markScheduledPostMediaCleanup(metadata: Record<string, unknown>, nowMs: number): Record<string, unknown> {
  if (!parseScheduledPostMedia(metadata)) return metadata;
  return {
    ...metadata,
    mediaCleanupAt: new Date(nowMs + 120_000).toISOString(),
  };
}

const SCHEDULED_POST_MEDIA_CLEANUP_TIMERS = new Map<string, ReturnType<typeof setTimeout>>();

async function cleanupExpiredScheduledPostMedia(userId?: string): Promise<void> {
  if (userId) {
    await execute(
      `UPDATE scheduled_posts
          SET metadata = metadata - 'media' - 'mediaCleanupAt',
              updated_at = NOW()
        WHERE user_id = $1
          AND status IN ('sent', 'cancelled', 'failed')
          AND metadata ? 'media'
          AND COALESCE(metadata->>'mediaCleanupAt', '') <> ''
          AND metadata->>'mediaCleanupAt' <= $2`,
      [userId, nowIso()],
    );
    return;
  }

  await execute(
    `UPDATE scheduled_posts
        SET metadata = metadata - 'media' - 'mediaCleanupAt',
            updated_at = NOW()
      WHERE status IN ('sent', 'cancelled', 'failed')
        AND metadata ? 'media'
        AND COALESCE(metadata->>'mediaCleanupAt', '') <> ''
        AND metadata->>'mediaCleanupAt' <= $1`,
    [nowIso()],
  );
}

function scheduleScheduledPostMediaCleanup(input: {
  userId: string;
  postId: string;
  metadata: Record<string, unknown>;
}): void {
  const cleanupAtRaw = typeof input.metadata.mediaCleanupAt === "string"
    ? input.metadata.mediaCleanupAt
    : "";
  const cleanupAtMs = Date.parse(cleanupAtRaw);
  if (!Number.isFinite(cleanupAtMs)) return;

  const timerKey = `${input.userId}:${input.postId}`;
  const existing = SCHEDULED_POST_MEDIA_CLEANUP_TIMERS.get(timerKey);
  if (existing) clearTimeout(existing);

  const delayMs = Math.max(0, cleanupAtMs - Date.now());
  const handle = setTimeout(() => {
    void execute(
      `UPDATE scheduled_posts
          SET metadata = metadata - 'media' - 'mediaCleanupAt',
              updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
          AND status IN ('sent', 'cancelled', 'failed')
          AND metadata ? 'media'
          AND COALESCE(metadata->>'mediaCleanupAt', '') <> ''
          AND metadata->>'mediaCleanupAt' <= $3`,
      [input.postId, input.userId, nowIso()],
    ).catch(() => {
      // Best effort cleanup: expiration is also reconciled in dispatch-messages.
    }).finally(() => {
      SCHEDULED_POST_MEDIA_CLEANUP_TIMERS.delete(timerKey);
    });
  }, delayMs);

  SCHEDULED_POST_MEDIA_CLEANUP_TIMERS.set(timerKey, handle);
}

async function resolveRouteForwardMediaForPlatform(input: {
  userId: string;
  platform: string;
  media: RouteForwardMedia | null;
}): Promise<RouteForwardMedia | null> {
  const { userId, platform, media } = input;
  logRouteMediaDebug("resolve.start", {
    userId,
    platform,
    media: summarizeRouteForwardMedia(media),
  });
  if (!media || media.kind !== "image") return null;
  if (platform !== "whatsapp" && platform !== "telegram") return null;

  const withDefaults = (partial: RouteForwardMedia): RouteForwardMedia => ({
    kind: "image",
    sourcePlatform: partial.sourcePlatform || media.sourcePlatform,
    token: partial.token,
    base64: partial.base64,
    mimeType: partial.mimeType || media.mimeType || "image/jpeg",
    fileName: partial.fileName || media.fileName || "route_image.jpg",
  });

  const fetchFromServiceByToken = async (
    service: "whatsapp" | "telegram",
    token: string,
  ): Promise<RouteForwardMedia | null> => {
    const baseUrl = service === "whatsapp" ? WHATSAPP_URL : TELEGRAM_URL;
    if (!baseUrl) {
      logRouteMediaDebug("resolve.fetch_token.no_base_url", {
        userId,
        platform,
        service,
        tokenPrefix: token.slice(0, 8),
      });
      return null;
    }
    const path = service === "whatsapp"
      ? `/api/media/${encodeURIComponent(token)}`
      : `/api/telegram/media/${encodeURIComponent(token)}`;
    const mediaResponse = await proxyMicroservice(
      baseUrl,
      path,
      "GET",
      null,
      buildUserScopedHeaders(userId),
      8000,
    );
    if (mediaResponse.error) {
      logRouteMediaDebug("resolve.fetch_token.error", {
        userId,
        platform,
        service,
        tokenPrefix: token.slice(0, 8),
        error: mediaResponse.error.message,
        status: Number((mediaResponse.error as { status?: number }).status) || null,
      });
      return null;
    }

    const payload = (mediaResponse.data && typeof mediaResponse.data === "object")
      ? mediaResponse.data as Record<string, unknown>
      : {};
    const base64 = typeof payload.base64 === "string" ? payload.base64.trim() : "";
    if (!base64) {
      logRouteMediaDebug("resolve.fetch_token.empty_base64", {
        userId,
        platform,
        service,
        tokenPrefix: token.slice(0, 8),
        payloadKeys: Object.keys(payload),
      });
      return null;
    }

    logRouteMediaDebug("resolve.fetch_token.success", {
      userId,
      platform,
      service,
      tokenPrefix: token.slice(0, 8),
      base64Length: base64.length,
    });

    return withDefaults({
      kind: "image",
      sourcePlatform: service,
      base64,
      mimeType: typeof payload.mimeType === "string" && payload.mimeType.trim()
        ? payload.mimeType.trim()
        : undefined,
      fileName: typeof payload.fileName === "string" && payload.fileName.trim()
        ? payload.fileName.trim()
        : undefined,
    });
  };

  if (media.base64) {
    return withDefaults({
      kind: "image",
      sourcePlatform: media.sourcePlatform,
      base64: media.base64,
    });
  }

  if (!media.token) return null;

  // Fast paths preserving provider-native token when destination is the same provider.
  if (platform === "whatsapp" && media.sourcePlatform === "whatsapp") {
    logRouteMediaDebug("resolve.fast_path_token", {
      userId,
      platform,
      sourcePlatform: media.sourcePlatform,
      tokenPrefix: String(media.token || "").slice(0, 8),
    });
    return withDefaults({
      kind: "image",
      sourcePlatform: "whatsapp",
      token: media.token,
    });
  }
  if (platform === "telegram" && media.sourcePlatform === "telegram") {
    logRouteMediaDebug("resolve.fast_path_token", {
      userId,
      platform,
      sourcePlatform: media.sourcePlatform,
      tokenPrefix: String(media.token || "").slice(0, 8),
    });
    return withDefaults({
      kind: "image",
      sourcePlatform: "telegram",
      token: media.token,
    });
  }

  const source = media.sourcePlatform;
  if (source === "whatsapp") {
    return fetchFromServiceByToken("whatsapp", media.token);
  }
  if (source === "telegram") {
    return fetchFromServiceByToken("telegram", media.token);
  }

  // Unknown token origin: try WhatsApp first for backwards compatibility, then Telegram.
  const fetchedFromWhatsApp = await fetchFromServiceByToken("whatsapp", media.token);
  if (fetchedFromWhatsApp) return fetchedFromWhatsApp;
  return fetchFromServiceByToken("telegram", media.token);
}

async function scheduleRouteForwardMediaDeletion(input: {
  userId: string;
  media: RouteForwardMedia | null;
  delayMs?: number;
}): Promise<void> {
  const { userId, media } = input;
  if (!media?.token) return;

  const delayMs = Number.isFinite(Number(input.delayMs))
    ? Math.max(1_000, Number(input.delayMs))
    : 120_000;

  const headers = buildUserScopedHeaders(userId);
  const callScheduleDelete = async (service: "whatsapp" | "telegram") => {
    const baseUrl = service === "whatsapp" ? WHATSAPP_URL : TELEGRAM_URL;
    if (!baseUrl) return;
    const path = service === "whatsapp"
      ? `/api/media/${encodeURIComponent(media.token || "")}/schedule-delete`
      : `/api/telegram/media/${encodeURIComponent(media.token || "")}/schedule-delete`;
    await proxyMicroservice(
      baseUrl,
      path,
      "POST",
      { delayMs },
      headers,
      8_000,
    );
  };

  if (media.sourcePlatform === "whatsapp") {
    await callScheduleDelete("whatsapp");
    return;
  }
  if (media.sourcePlatform === "telegram") {
    await callScheduleDelete("telegram");
    return;
  }

  await Promise.allSettled([callScheduleDelete("whatsapp"), callScheduleDelete("telegram")]);
}

const AUTO_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const AUTO_IMAGE_FETCH_TIMEOUT_MS = 10_000;
const GENERAL_URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
const OG_IMAGE_REGEX = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*\/?>/i;
const OG_IMAGE_REVERSE_REGEX = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*\/?>/i;

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/") && !mime.includes("svg");
}

async function fetchImageBuffer(imageUrl: string, signal: AbortSignal): Promise<RouteForwardMedia | null> {
  const response = await fetch(imageUrl, { method: "GET", redirect: "follow", signal });
  if (!response.ok) return null;

  const contentLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > AUTO_IMAGE_MAX_BYTES) return null;

  const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!isImageMime(mimeType)) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > AUTO_IMAGE_MAX_BYTES) return null;

  return {
    kind: "image",
    base64: buffer.toString("base64"),
    mimeType: mimeType || "image/jpeg",
    fileName: "route_auto_image.jpg",
  };
}

async function extractOgImage(pageUrl: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(pageUrl, {
    method: "GET",
    redirect: "follow",
    signal,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AutolinksBot/1.0)", Accept: "text/html" },
  });
  if (!response.ok) return null;

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/html")) return null;

  const html = await response.text();
  const head = html.slice(0, 32_000);
  const match = head.match(OG_IMAGE_REGEX) || head.match(OG_IMAGE_REVERSE_REGEX);
  if (!match || !match[1]) return null;

  const ogUrl = match[1].replace(/&amp;/g, "&").trim();
  if (!ogUrl.startsWith("http")) return null;
  return ogUrl;
}

async function tryAutoDownloadImageFromMessage(text: string): Promise<RouteForwardMedia | null> {
  const rawUrls = String(text || "").match(GENERAL_URL_REGEX);
  if (!rawUrls || rawUrls.length === 0) return null;

  const urls = rawUrls
    .map((u) => u.replace(/[),.!?]+$/, "").trim())
    .filter((u) => /^https?:\/\//i.test(u));

  for (const url of urls.slice(0, 3)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTO_IMAGE_FETCH_TIMEOUT_MS);
    try {
      // 1. Try direct image download
      const direct = await fetchImageBuffer(url, controller.signal);
      if (direct) return direct;

      // 2. If HTML page, extract og:image and download that
      const ogImageUrl = await extractOgImage(url, controller.signal);
      if (ogImageUrl) {
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), AUTO_IMAGE_FETCH_TIMEOUT_MS);
        try {
          const ogResult = await fetchImageBuffer(ogImageUrl, controller2.signal);
          if (ogResult) return ogResult;
        } finally {
          clearTimeout(timeout2);
        }
      }
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
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

async function buildAutomationImageMedia(product: Record<string, unknown>): Promise<RouteForwardMedia> {
  const imageUrl = extractAutomationImageUrl(product);
  if (!imageUrl) {
    throw new Error("Envio cancelado: oferta sem imagem válida para anexo.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTO_IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Envio cancelado: falha ao baixar imagem da oferta (HTTP ${response.status}).`);
    }

    const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!isImageMime(mimeType)) {
      throw new Error("Envio cancelado: URL da oferta não retornou uma imagem válida.");
    }

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > AUTO_IMAGE_MAX_BYTES) {
      throw new Error("Envio cancelado: imagem excede o tamanho maximo permitido (8MB).");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      throw new Error("Envio cancelado: imagem da oferta esta vazia.");
    }
    if (buffer.length > AUTO_IMAGE_MAX_BYTES) {
      throw new Error("Envio cancelado: imagem excede o tamanho maximo permitido (8MB).");
    }

    return {
      kind: "image",
      base64: buffer.toString("base64"),
      mimeType: mimeType || "image/jpeg",
      fileName: "automation_offer.jpg",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Envio cancelado: falha ao anexar imagem.";
    if (message.toLowerCase().includes("abort")) {
      throw new Error("Envio cancelado: tempo limite ao baixar imagem da oferta.");
    }
    throw new Error(message || "Envio cancelado: falha ao anexar imagem.");
  } finally {
    clearTimeout(timeout);
  }
}

function isNotFoundSessionError(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("não encontrada")
    || normalized.includes("não encontrada")
    || normalized.includes("sessão não encontrada")
    || normalized.includes("sessão não encontrada")
    || normalized.includes("session not found")
    || normalized.includes("not found")
  );
}

function normalizeWhatsAppStatus(status: unknown): string {
  const value = String(status ?? "").trim().toLowerCase();
  if (value === "online") return "online";
  if (value === "connecting") return "connecting";
  if (value === "qr_code") return "qr_code";
  if (value === "pairing_code") return "pairing_code";
  if (value === "warning") return "warning";
  if (value === "error") return "error";
  return "offline";
}

function normalizeTelegramStatus(status: unknown): string {
  const value = String(status ?? "").trim().toLowerCase();
  if (value === "online") return "online";
  if (value === "connecting") return "connecting";
  if (value === "awaiting_code") return "awaiting_code";
  if (value === "awaiting_password") return "awaiting_password";
  if (value === "warning") return "warning";
  if (value === "error") return "error";
  return "offline";
}

type IntegrationEvent = { event: string; data: Record<string, unknown> };

function toIntegrationEvents(payload: unknown): IntegrationEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const eventsRaw = (payload as Record<string, unknown>).events;
  if (!Array.isArray(eventsRaw)) return [];

  const events: IntegrationEvent[] = [];
  for (const row of eventsRaw) {
    if (!row || typeof row !== "object") continue;
    const event = String((row as Record<string, unknown>).event ?? "").trim();
    if (!event) continue;
    const dataRaw = (row as Record<string, unknown>).data;
    const data = dataRaw && typeof dataRaw === "object" && !Array.isArray(dataRaw)
      ? dataRaw as Record<string, unknown>
      : {};
    events.push({ event, data });
  }
  return events;
}

async function upsertGroupRow(input: {
  userId: string;
  sessionId: string;
  platform: "whatsapp" | "telegram";
  externalId: string;
  name: string;
  memberCount: number;
}) {
  const externalId = String(input.externalId || "").trim();
  if (!externalId) return;
  const normalizedName = String(input.name || "").trim();
  if (!normalizedName) return;
  const memberCount = Number.isFinite(input.memberCount) ? Math.max(0, Math.trunc(input.memberCount)) : 0;

  // If a group changed external_id in the provider, recover the previously saved row
  // by matching the same session + normalized name before regular upsert by external_id.
  await execute(
    `UPDATE groups g
     SET external_id = $1,
         name = $2,
         member_count = $3,
         deleted_at = NULL,
         updated_at = NOW()
     WHERE g.id = (
       SELECT g1.id
       FROM groups g1
       WHERE g1.user_id = $4
         AND g1.platform = $5
         AND g1.session_id = $6
         AND g1.deleted_at IS NULL
         AND LOWER(TRIM(g1.name)) = LOWER(TRIM($2))
         AND g1.external_id <> $1
         AND NOT EXISTS (
           SELECT 1
           FROM groups g2
           WHERE g2.user_id = $4
             AND g2.platform = $5
             AND g2.session_id = $6
             AND g2.external_id = $1
             AND g2.deleted_at IS NULL
         )
       ORDER BY g1.updated_at DESC NULLS LAST
       LIMIT 1
     )`,
    [externalId, normalizedName, memberCount, input.userId, input.platform, input.sessionId],
  );

  await execute(
    `INSERT INTO groups (id, user_id, name, platform, member_count, session_id, external_id, deleted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NOW())
     ON CONFLICT (user_id, session_id, external_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       member_count = EXCLUDED.member_count,
       deleted_at = NULL,
       updated_at = NOW()`,
    [uuid(), input.userId, normalizedName, input.platform, memberCount, input.sessionId, externalId],
  );
}

async function refreshTelegramHealthState(userId: string): Promise<number> {
  if (!TELEGRAM_URL) return 0;

  const health = await proxyMicroservice(
    TELEGRAM_URL,
    "/health",
    "GET",
    null,
    buildUserScopedHeaders(userId),
  );
  if (health.error) return 0;

  const payload = (health.data && typeof health.data === "object")
    ? health.data as Record<string, unknown>
    : {};
  const sessionsRaw = Array.isArray(payload.sessions) ? payload.sessions : [];

  const runtimeStatusBySession = new Map<string, string>();
  for (const row of sessionsRaw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const sessionId = String(r.sessionId ?? "").trim();
    const owner = String(r.userId ?? "").trim();
    if (!sessionId || owner !== userId) continue;
    runtimeStatusBySession.set(sessionId, normalizeTelegramStatus(r.status));
  }

  const dbSessions = await query<{ id: string }>(
    "SELECT id FROM telegram_sessions WHERE user_id = $1",
    [userId],
  );

  let touched = 0;
  for (const row of dbSessions) {
    const sessionId = String(row?.id ?? "").trim();
    if (!sessionId) continue;

    const runtimeStatus = runtimeStatusBySession.get(sessionId);
    if (runtimeStatus) {
      await execute(
        `UPDATE telegram_sessions
         SET status = $1,
             connected_at = CASE WHEN $1 = 'online' THEN COALESCE(connected_at, NOW()) ELSE NULL END,
             error_message = CASE WHEN $1 = 'online' THEN '' ELSE error_message END,
             updated_at = NOW()
         WHERE id = $2 AND user_id = $3`,
        [runtimeStatus, sessionId, userId],
      );
      touched += 1;
      continue;
    }

    await execute(
      `UPDATE telegram_sessions
       SET status = 'offline',
           connected_at = NULL,
           phone_code_hash = '',
           error_message = CASE
             WHEN COALESCE(error_message, '') = '' THEN 'Sessão não encontrada no runtime do Telegram. Reautentique para reconectar.'
             ELSE error_message
           END,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    touched += 1;
  }

  return touched;
}

function normalizeGroupNameKey(name: unknown): string {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function reconcileWhatsAppSessionsFromHealth(userId: string) {
  if (!WHATSAPP_URL) return { reconciled: 0, online: false };

  const health = await proxyMicroservice(
    WHATSAPP_URL,
    "/health",
    "GET",
    null,
    buildUserScopedHeaders(userId),
    6000,
  );
  if (health.error) {
    return { reconciled: 0, online: false };
  }

  const payload = (health.data && typeof health.data === "object")
    ? (health.data as Record<string, unknown>)
    : {};
  const sessionsRaw = Array.isArray(payload.sessions) ? payload.sessions : [];

  const statusBySessionId = new Map<string, { status: string; queuedEvents: number }>();
  for (const row of sessionsRaw) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (String(item.userId ?? "") !== userId) continue;
    const sessionId = String(item.sessionId ?? "").trim();
    if (!sessionId) continue;
    statusBySessionId.set(sessionId, {
      status: normalizeWhatsAppStatus(item.status),
      queuedEvents: Math.max(0, toInt(item.queuedEvents, 0)),
    });
  }

  const ownSessions = await query<{ id: string }>("SELECT id FROM whatsapp_sessions WHERE user_id = $1", [userId]);
  let reconciled = 0;

  for (const row of ownSessions) {
    const sessionId = String(row?.id ?? "").trim();
    if (!sessionId) continue;

    const fromHealth = statusBySessionId.get(sessionId);
    if (!fromHealth) {
      await execute(
        "UPDATE whatsapp_sessions SET status='offline', connected_at=NULL, qr_code='', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2",
        [sessionId, userId],
      );
      reconciled += 1;
      continue;
    }

    const connectedAt = fromHealth.status === "online" ? nowIso() : null;
    await execute(
      `UPDATE whatsapp_sessions
       SET status = $1,
           connected_at = $2,
           qr_code = CASE WHEN $1 IN ('qr_code', 'pairing_code') THEN qr_code ELSE '' END,
           error_message = CASE WHEN $1 = 'warning' THEN error_message ELSE '' END,
           updated_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [fromHealth.status, connectedAt, sessionId, userId],
    );
    reconciled += 1;
  }

  return { reconciled, online: true };
}

async function syncWhatsAppGroupsWithReconciliation(userId: string, sessionId: string, remoteGroups: Array<Record<string, unknown>>) {
  const existingRows = await query<{
    id: string;
    name: string;
    external_id: string;
  }>(
    `SELECT id, name, external_id
     FROM groups
     WHERE user_id = $1
       AND platform = 'whatsapp'
       AND session_id = $2
       AND deleted_at IS NULL`,
    [userId, sessionId],
  );

  const existingByExternalId = new Map<string, { id: string; name: string; external_id: string }>();
  const existingByNameKey = new Map<string, Array<{ id: string; name: string; external_id: string }>>();
  for (const row of existingRows) {
    const ext = String(row.external_id || "").trim();
    if (ext) existingByExternalId.set(ext, row);
    const nameKey = normalizeGroupNameKey(row.name);
    if (!nameKey) continue;
    const bucket = existingByNameKey.get(nameKey) || [];
    bucket.push(row);
    existingByNameKey.set(nameKey, bucket);
  }

  const remoteExternalIds = new Set<string>();
  const claimedExistingIds = new Set<string>();

  for (const row of remoteGroups) {
    if (!row || typeof row !== "object") continue;
    const group = row as Record<string, unknown>;
    const externalId = String(group.id ?? "").trim();
    if (!externalId) continue;

    remoteExternalIds.add(externalId);
    const name = String(group.name ?? group.id ?? "Grupo");
    const memberCount = Number(group.memberCount ?? group.member_count ?? group.participantsCount ?? 0);

    const alreadyMatched = existingByExternalId.get(externalId);
    if (alreadyMatched) {
      claimedExistingIds.add(alreadyMatched.id);
      await upsertGroupRow({
        userId,
        sessionId,
        platform: "whatsapp",
        externalId,
        name,
        memberCount,
      });
      continue;
    }

    const nameKey = normalizeGroupNameKey(name);
    const candidates = nameKey ? (existingByNameKey.get(nameKey) || []) : [];
    const available = candidates.filter((c) => !claimedExistingIds.has(c.id) && !remoteExternalIds.has(String(c.external_id || "").trim()));

    if (available.length === 1) {
      const candidate = available[0];
      await execute(
        `UPDATE groups
         SET external_id = $1,
             name = $2,
             member_count = $3,
             deleted_at = NULL,
             updated_at = NOW()
         WHERE id = $4 AND user_id = $5`,
        [externalId, name, Number.isFinite(memberCount) ? Math.max(0, Math.trunc(memberCount)) : 0, candidate.id, userId],
      );
      claimedExistingIds.add(candidate.id);
      continue;
    }

    await upsertGroupRow({
      userId,
      sessionId,
      platform: "whatsapp",
      externalId,
      name,
      memberCount,
    });
  }
}

async function syncMasterGroupWhatsAppInviteLinks(userId: string, sessionId: string): Promise<{ checked: number; updated: number; failed: number }> {
  if (!WHATSAPP_URL) return { checked: 0, updated: 0, failed: 0 };

  const rows = await query<{
    id: string;
    external_id: string;
    invite_link: string | null;
  }>(
    `SELECT g.id, g.external_id, g.invite_link
       FROM groups g
      WHERE g.user_id = $1
        AND g.platform = 'whatsapp'
        AND g.session_id = $2
        AND g.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
            FROM master_group_links l
           WHERE l.group_id = g.id
             AND l.is_active <> FALSE
        )`,
    [userId, sessionId],
  );

  let checked = 0;
  let updated = 0;
  let failed = 0;

  for (const row of rows) {
    const currentInvite = String(row.invite_link || "").trim();
    if (/^https?:\/\//i.test(currentInvite)) continue;

    const groupId = String(row.external_id || "").trim();
    if (!groupId) continue;

    checked += 1;
    const upstream = await proxyMicroservice(
      WHATSAPP_URL,
      `/api/sessions/${encodeURIComponent(sessionId)}/group-invite`,
      "POST",
      { groupId },
      buildUserScopedHeaders(userId),
      8_000,
    );

    if (upstream.error) {
      failed += 1;
      continue;
    }

    const payload = (upstream.data && typeof upstream.data === "object")
      ? upstream.data as Record<string, unknown>
      : {};
    const inviteLink = String(payload.inviteLink ?? "").trim();
    if (!/^https?:\/\//i.test(inviteLink)) {
      failed += 1;
      continue;
    }

    await execute(
      "UPDATE groups SET invite_link = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3",
      [inviteLink, row.id, userId],
    );
    updated += 1;
  }

  return { checked, updated, failed };
}

async function logRouteProcessingFailure(input: {
  userId: string;
  sourceName: string;
  sourceExternalId: string;
  sessionId: string;
  message: string;
  media: RouteForwardMedia | null;
  platform: "whatsapp" | "telegram";
  error: unknown;
}): Promise<void> {
  const {
    userId,
    sourceName,
    sourceExternalId,
    sessionId,
    message,
    media,
    platform,
    error,
  } = input;
  const errorMessage = error instanceof Error ? error.message : String(error);

  try {
    await execute(
      "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,'-','error',$4,'inbound',$5,'failed','route_processing_error','route_engine')",
      [
        uuid(),
        userId,
        sourceName,
        JSON.stringify({
          message,
          sourceExternalId,
          sessionId,
          platform,
          hasMedia: !!media,
          error: errorMessage,
        }),
        media ? "image" : "text",
      ],
    );
  } catch {
    // Best-effort history log; do not interrupt event polling.
  }

  console.error(`[rpc] route processing ${platform} failed: ${errorMessage}`);
}

async function applyWhatsAppEvents(userId: string, sessionId: string, events: IntegrationEvent[]) {
  let groupsSynced = 0;
  for (const raw of events) {
    const event = raw.event;
    const data = raw.data;

    if (event === "connection_update") {
      const status = normalizeWhatsAppStatus(data.status);
      const connectedAt = status === "online" ? nowIso() : null;
      const errorMessage = String(data.errorMessage ?? data.error_message ?? "");
      let qrCode = "";
      if (status === "qr_code") qrCode = String(data.qrCode ?? "");
      if (status === "pairing_code") qrCode = String(data.pairingCode ?? "");
      const phone = String(data.phone ?? "").trim();

      await execute(
        `UPDATE whatsapp_sessions
         SET status = $1,
             connected_at = $2,
             error_message = $3,
             qr_code = $4,
             phone = CASE WHEN $5 <> '' THEN $5 ELSE phone END,
             updated_at = NOW()
         WHERE id = $6 AND user_id = $7`,
        [status, connectedAt, errorMessage, qrCode, phone, sessionId, userId],
      );
      continue;
    }

    if (event === "groups_sync") {
      const groups = Array.isArray(data.groups) ? data.groups : [];
      for (const row of groups) {
        if (!row || typeof row !== "object") continue;
        const group = row as Record<string, unknown>;
        await upsertGroupRow({
          userId,
          sessionId,
          platform: "whatsapp",
          externalId: String(group.id ?? ""),
          name: String(group.name ?? group.id ?? "Grupo"),
          memberCount: Number(group.memberCount ?? group.member_count ?? group.participantsCount ?? 0),
        });
        groupsSynced += 1;
      }
      continue;
    }

    if (event === "group_name_update") {
      const externalId = String(data.id ?? "").trim();
      const name = String(data.name ?? "").trim();
      if (!externalId || !name) continue;
      await execute(
        "UPDATE groups SET name = $1, updated_at = NOW() WHERE user_id = $2 AND platform = 'whatsapp' AND external_id = $3 AND deleted_at IS NULL",
        [name, userId, externalId],
      );
      continue;
    }

    if (event === "message_received") {
      const sourceExternalId = String(data.groupId ?? "").trim();
      const sourceName = String(data.groupName ?? data.groupId ?? "Grupo").trim() || "Grupo";
      const message = String(data.message ?? "").trim();
      const media = parseRouteForwardMedia(data.media);
      logRouteMediaDebug("incoming.whatsapp.message_received", {
        userId,
        sessionId,
        sourceExternalId,
        sourceName,
        hasText: Boolean(message),
        textLength: message.length,
        media: summarizeRouteForwardMedia(media),
      });
      if (!sourceExternalId || (!message && !media)) continue;

      try {
        await processRouteMessageForUser({
          userId,
          sessionId,
          sourceExternalId,
          sourceName,
          message,
          media,
        });
      } catch (error) {
        await logRouteProcessingFailure({
          userId,
          sourceName,
          sourceExternalId,
          sessionId,
          message,
          media,
          platform: "whatsapp",
          error,
        });
      }
    }
  }
  return { groupsSynced };
}

async function applyTelegramEvents(userId: string, sessionId: string, events: IntegrationEvent[]) {
  let groupsSynced = 0;
  for (const raw of events) {
    const event = raw.event;
    const data = raw.data;

    if (event === "connection_update") {
      const status = normalizeTelegramStatus(data.status);
      const connectedAt = status === "online" ? nowIso() : null;
      const errorMessage = String(data.errorMessage ?? data.error_message ?? "");
      const sessionString = String(data.session_string ?? "");
      const phone = String(data.phone ?? "").trim();
      const clearSession = data.clear_session === true;

      await execute(
        `UPDATE telegram_sessions
         SET status = $1,
             connected_at = $2,
             error_message = $3,
             session_string = CASE
               WHEN $8 THEN ''
               WHEN $4 <> '' THEN $4
               ELSE session_string
             END,
             phone = CASE WHEN $5 <> '' THEN $5 ELSE phone END,
             phone_code_hash = CASE WHEN $8 THEN '' ELSE phone_code_hash END,
             updated_at = NOW()
         WHERE id = $6 AND user_id = $7`,
        [status, connectedAt, errorMessage, sessionString, phone, sessionId, userId, clearSession],
      );
      continue;
    }

    if (event === "groups_sync") {
      const groups = Array.isArray(data.groups) ? data.groups : [];
      for (const row of groups) {
        if (!row || typeof row !== "object") continue;
        const group = row as Record<string, unknown>;
        await upsertGroupRow({
          userId,
          sessionId,
          platform: "telegram",
          externalId: String(group.id ?? ""),
          name: String(group.name ?? group.id ?? "Grupo"),
          memberCount: Number(group.memberCount ?? group.member_count ?? 0),
        });
        groupsSynced += 1;
      }
      continue;
    }

    if (event === "group_name_update") {
      const externalId = String(data.id ?? "").trim();
      const name = String(data.name ?? "").trim();
      if (!externalId || !name) continue;
      await execute(
        "UPDATE groups SET name = $1, updated_at = NOW() WHERE user_id = $2 AND platform = 'telegram' AND external_id = $3 AND deleted_at IS NULL",
        [name, userId, externalId],
      );
      continue;
    }

    if (event === "message_received") {
      const sourceExternalId = String(data.groupId ?? "").trim();
      const sourceName = String(data.groupName ?? data.groupId ?? "Grupo").trim() || "Grupo";
      const message = String(data.message ?? "").trim();
      const media = parseRouteForwardMedia(data.media);
      logRouteMediaDebug("incoming.telegram.message_received", {
        userId,
        sessionId,
        sourceExternalId,
        sourceName,
        hasText: Boolean(message),
        textLength: message.length,
        media: summarizeRouteForwardMedia(media),
      });
      if (!sourceExternalId || (!message && !media)) continue;

      try {
        await processRouteMessageForUser({
          userId,
          sessionId,
          sourceExternalId,
          sourceName,
          message,
          media,
        });
      } catch (error) {
        await logRouteProcessingFailure({
          userId,
          sourceName,
          sourceExternalId,
          sessionId,
          message,
          media,
          platform: "telegram",
          error,
        });
      }
    }
  }
  return { groupsSynced };
}

const ROUTE_LINK_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

const ROUTE_PARTNER_MARKETPLACE_PATTERNS: Record<string, RegExp[]> = {
  shopee: [/shopee\.com(\.\w+)?/i, /shope\.ee/i, /s\.shopee\./i],
  mercadolivre: [/mercadolivre\.com\.br/i, /mercadolibre\.com/i, /mlb\.am/i, /meli\.la/i],
};

function extractRouteLinks(content: string): string[] {
  return String(content || "").match(ROUTE_LINK_REGEX) || [];
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

function normalizeRouteMarketplaceList(value: unknown): string[] {
  if (!Array.isArray(value)) return ["shopee"];
  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item in ROUTE_PARTNER_MARKETPLACE_PATTERNS);
  return cleaned.length > 0 ? [...new Set(cleaned)] : ["shopee"];
}

function isRouteMarketplaceConversionEnabled(
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

function detectRoutePartnerMarketplace(url: string): string | null {
  for (const [name, patterns] of Object.entries(ROUTE_PARTNER_MARKETPLACE_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(url))) return name;
  }
  return null;
}

async function resolveRouteLinkWithRedirect(url: string): Promise<string> {
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

async function resolveRouteMeliSessionId(userId: string, configuredSessionId: unknown): Promise<string> {
  const configured = String(configuredSessionId || "").trim();
  const preferredReady = await queryOne<{ id: string }>(
    `SELECT id
       FROM meli_sessions
      WHERE user_id = $1
        AND status IN ('active', 'untested')
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
               updated_at DESC NULLS LAST,
               created_at DESC
      LIMIT 1`,
    [userId],
  );
  if (preferredReady?.id) return String(preferredReady.id);

  if (configured) {
    const ownedConfigured = await queryOne<{ id: string }>(
      "SELECT id FROM meli_sessions WHERE id = $1 AND user_id = $2",
      [configured, userId],
    );
    if (ownedConfigured?.id) return String(ownedConfigured.id);
  }

  const latest = await queryOne<{ id: string }>(
    "SELECT id FROM meli_sessions WHERE user_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1",
    [userId],
  );
  return latest?.id ? String(latest.id) : "";
}

async function processRouteMessageForUser(input: {
  userId: string;
  sessionId: string;
  sourceExternalId: string;
  sourceName: string;
  message: string;
  media?: RouteForwardMedia | null;
}) {
  const { userId, sessionId, sourceExternalId, sourceName, message, media = null } = input;
  const messageType = media ? "image" : "text";
  logRouteMediaDebug("route.process.start", {
    userId,
    sessionId,
    sourceExternalId,
    sourceName,
    hasText: Boolean(message),
    textLength: message.length,
    media: summarizeRouteForwardMedia(media),
  });

  const shopeeCredentials = await queryOne<{ app_id: string; secret_key: string; region: string }>(
    "SELECT app_id, secret_key, region FROM api_credentials WHERE user_id = $1 AND provider = 'shopee'",
    [userId],
  );
  const shopeeConversionCache = new Map<string, {
    affiliateLink: string;
    resolvedUrl: string;
    ok: boolean;
    error?: string;
    productImageUrl?: string;
    product?: Record<string, unknown>;
  }>();
  const meliConversionCache = new Map<string, { affiliateLink: string; ok: boolean; error?: string }>();
  const routeMeliSessionCache = new Map<string, string>();
  const routeTemplateCache = new Map<string, string | null>();

  const sourceExternalCandidates = buildSourceExternalIdCandidates(sourceExternalId);
  const sourceCandidates = new Set<string>([sessionId, ...sourceExternalCandidates].filter(Boolean));

  const sourceGroupRows = await query<{ id: string }>(
    `SELECT id
       FROM groups
      WHERE user_id = $1
        AND session_id = $2
        AND external_id = ANY($3)
        AND deleted_at IS NULL`,
    [userId, sessionId, sourceExternalCandidates],
  );
  for (const row of sourceGroupRows) {
    if (row?.id) sourceCandidates.add(String(row.id));
  }
  if (sourceGroupRows.length === 0 && sourceExternalCandidates.length > 0) {
    const fallbackSourceRows = await query<{ id: string }>(
      `SELECT id
         FROM groups
        WHERE user_id = $1
          AND external_id = ANY($2)
          AND deleted_at IS NULL`,
      [userId, sourceExternalCandidates],
    );
    for (const row of fallbackSourceRows) {
      if (row?.id) sourceCandidates.add(String(row.id));
    }
  }

  const sourceExternalCandidateSet = new Set(sourceExternalCandidates);

  const routes = await query<{
    id: string;
    name: string;
    source_group_id: string;
    source_external_id: string;
    rules: unknown;
    dest_ids: string[];
  }>(
    `SELECT
       r.id,
       r.name,
       r.source_group_id,
       COALESCE(sg.external_id, '') AS source_external_id,
       r.rules,
       COALESCE(json_agg(rd.group_id) FILTER (WHERE rd.group_id IS NOT NULL),'[]') AS dest_ids
     FROM routes r
     LEFT JOIN groups sg ON sg.id = r.source_group_id AND sg.user_id::text = r.user_id::text
     LEFT JOIN route_destinations rd ON rd.route_id = r.id
     WHERE r.user_id::text = $1 AND r.status = 'active'
     GROUP BY r.id, sg.external_id`,
    [userId],
  );

  const matching = routes.filter((route) => {
    const routeSourceGroupId = String(route.source_group_id || "").trim();
    if (routeSourceGroupId && sourceCandidates.has(routeSourceGroupId)) return true;

    const routeSourceExternalId = String(route.source_external_id || "").trim();
    if (!routeSourceExternalId) return false;

    const routeSourceExternalCandidates = buildSourceExternalIdCandidates(routeSourceExternalId);
    return routeSourceExternalCandidates.some((candidate) => sourceExternalCandidateSet.has(candidate));
  });
  if (matching.length === 0) {
    logRouteMediaDebug("route.process.blocked.no_active_routes", {
      userId,
      sessionId,
      sourceExternalId,
      sourceName,
      hasText: Boolean(message),
      textLength: message.length,
      media: summarizeRouteForwardMedia(media),
    });
    await execute(
      "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,'-','warning',$4,'inbound',$5,'blocked','no_active_routes','route_match')",
      [uuid(), userId, sourceName, JSON.stringify({ message, sourceExternalId, sessionId, reason: "no_active_routes", hasMedia: !!media }), media ? "image" : "text"],
    );
    return { dispatched: 0, routesMatched: 0 };
  }

  const routeMasterGroupIds = new Map<string, string[]>();
  const allMasterGroupIds = new Set<string>();
  for (const route of matching) {
    const rules = route.rules && typeof route.rules === "object" && !Array.isArray(route.rules)
      ? route.rules as Record<string, unknown>
      : {};
    const fromArray = Array.isArray(rules.masterGroupIds)
      ? rules.masterGroupIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    const fromSingle = typeof rules.masterGroupId === "string" && rules.masterGroupId.trim().length > 0
      ? [rules.masterGroupId.trim()]
      : [];
    const ids = [...new Set([...fromArray, ...fromSingle])];
    routeMasterGroupIds.set(route.id, ids);
    for (const id of ids) allMasterGroupIds.add(id);
  }

  const masterLinks = allMasterGroupIds.size > 0
    ? await query<{ master_group_id: string; group_id: string }>(
      `SELECT l.master_group_id, l.group_id
         FROM master_group_links l
         JOIN master_groups mg
           ON mg.id = l.master_group_id
        WHERE l.master_group_id = ANY($1)
          AND l.is_active <> FALSE
          AND mg.user_id = $2`,
      [[...allMasterGroupIds], userId],
    )
    : [];
  const linkedByMaster = new Map<string, string[]>();
  for (const row of masterLinks) {
    const list = linkedByMaster.get(row.master_group_id) ?? [];
    list.push(row.group_id);
    linkedByMaster.set(row.master_group_id, list);
  }

  const targetByRoute = new Map<string, string[]>();
  const allTargetGroupIds = new Set<string>();
  for (const route of matching) {
    const direct = Array.isArray(route.dest_ids) ? route.dest_ids : [];
    const fromMaster = (routeMasterGroupIds.get(route.id) ?? []).flatMap((masterId) => linkedByMaster.get(masterId) ?? []);
    const targetIds = [...new Set([...direct, ...fromMaster])]
      .filter((groupId) => !sourceCandidates.has(String(groupId)));
    targetByRoute.set(route.id, targetIds);
    for (const gid of targetIds) allTargetGroupIds.add(gid);
  }

  const destGroupRows = allTargetGroupIds.size > 0
    ? await query<{ id: string; name: string; platform: string; session_id: string; external_id: string }>(
      "SELECT id, name, platform, session_id, external_id FROM groups WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL",
      [[...allTargetGroupIds], userId],
    )
    : [];
  const destGroupMap = new Map(destGroupRows.map((group) => [String(group.id), group]));

  let dispatched = 0;
  let mediaUsedInSuccessfulDispatch = false;
  for (const route of matching) {
    let routeDispatched = 0;
    const rules = route.rules && typeof route.rules === "object" && !Array.isArray(route.rules)
      ? route.rules as Record<string, unknown>
      : {};

    const negativeKeywords = toRouteKeywordList(rules.negativeKeywords);
    if (routeTextMatchesAnyKeyword(message, negativeKeywords)) {
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'info',$5,'inbound',$6,'blocked','negative_keyword','route_filter')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message,
          routeId: route.id,
          routeName: route.name,
          reason: "negative_keyword",
          keywords: negativeKeywords,
          hasMedia: !!media,
        }), messageType],
      );
      continue;
    }

    const positiveKeywords = toRouteKeywordList(rules.positiveKeywords);
    if (positiveKeywords.length > 0 && !routeTextMatchesAnyKeyword(message, positiveKeywords)) {
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'info',$5,'inbound',$6,'blocked','positive_keyword_missing','route_filter')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message,
          routeId: route.id,
          routeName: route.name,
          reason: "positive_keyword_missing",
          keywords: positiveKeywords,
          hasMedia: !!media,
        }), messageType],
      );
      continue;
    }

    const shouldResolveBeforeValidate = rules.resolvePartnerLinks !== false;
    const partnerMarketplaces = normalizeRouteMarketplaceList(rules.partnerMarketplaces);
    const enabledPartnerMarketplaces = partnerMarketplaces.filter((marketplace) =>
      isRouteMarketplaceConversionEnabled(rules, marketplace),
    );
    const requirePartnerLink = rules.requirePartnerLink !== false;
    const routeLinks = extractRouteLinks(message);

    const inspectedLinks: Array<{
      original: string;
      resolved: string;
      originalMarketplace: string | null;
      resolvedMarketplace: string | null;
      partnerMarketplace: string | null;
    }> = [];

    for (const originalLink of routeLinks) {
      const original = String(originalLink || "").trim();
      if (!original) continue;
      const originalMarketplace = detectRoutePartnerMarketplace(original);
      const resolved = shouldResolveBeforeValidate ? await resolveRouteLinkWithRedirect(original) : original;
      const resolvedMarketplace = detectRoutePartnerMarketplace(resolved);
      const partnerMarketplace = originalMarketplace && enabledPartnerMarketplaces.includes(originalMarketplace)
        ? originalMarketplace
        : resolvedMarketplace && enabledPartnerMarketplaces.includes(resolvedMarketplace)
          ? resolvedMarketplace
          : null;
      inspectedLinks.push({ original, resolved, originalMarketplace, resolvedMarketplace, partnerMarketplace });
    }

    const disallowedMarketplaceLink = inspectedLinks.find((item) => {
      const detected = item.originalMarketplace || item.resolvedMarketplace;
      return Boolean(detected && !enabledPartnerMarketplaces.includes(detected));
    });
    if (disallowedMarketplaceLink) {
      const disallowedMarketplace = disallowedMarketplaceLink.originalMarketplace || disallowedMarketplaceLink.resolvedMarketplace || "unknown";
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound',$6,'blocked','marketplace_not_enabled','partner_gate')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message,
          routeId: route.id,
          routeName: route.name,
          marketplace: disallowedMarketplace,
          allowedMarketplaces: enabledPartnerMarketplaces,
          configuredMarketplaces: partnerMarketplaces,
          reason: "marketplace_not_enabled",
          hasMedia: !!media,
        }), messageType],
      );
      continue;
    }

    const partnerLinks = inspectedLinks.filter((item) => Boolean(item.partnerMarketplace));
    if (requirePartnerLink && partnerLinks.length === 0) {
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound',$6,'blocked','partner_link_required','partner_gate')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message,
          routeId: route.id,
          routeName: route.name,
          allowedMarketplaces: enabledPartnerMarketplaces,
          configuredMarketplaces: partnerMarketplaces,
          reason: "partner_link_required",
          hasMedia: !!media,
        }), messageType],
      );
      continue;
    }

    let outboundText = message;
    let primaryLink = partnerLinks[0]?.resolved || partnerLinks[0]?.original || routeLinks[0] || "";
    let primaryProduct: Record<string, unknown> | null = null;
    let conversionFailure: { reason: string; error: string } | null = null;
    let linksEligibleForConversion = 0;
    let convertedLinks = 0;
    let conversionProductImageUrl = "";

    for (const link of partnerLinks) {
      const marketplace = String(link.partnerMarketplace || "");
      if (!marketplace) continue;

      if (marketplace === "shopee") {
        linksEligibleForConversion += 1;
        if (!SHOPEE_URL) {
          conversionFailure = { reason: "shopee_service_unavailable", error: "Serviço Shopee indisponível para conversão." };
          break;
        }
        if (!shopeeCredentials) {
          conversionFailure = { reason: "shopee_credentials_missing", error: "Credenciais Shopee não configuradas." };
          break;
        }

        const conversionSource = link.resolvedMarketplace === "shopee" ? link.resolved : link.original;
        const cacheKey = conversionSource;
        let conversion = shopeeConversionCache.get(cacheKey);
        if (!conversion) {
          const response = await proxyMicroservice(
            SHOPEE_URL,
            "/api/shopee/convert-link",
            "POST",
            {
              url: conversionSource,
              appId: shopeeCredentials.app_id,
              secret: shopeeCredentials.secret_key,
              region: shopeeCredentials.region,
            },
          );
          if (response.error) {
            conversion = { affiliateLink: "", resolvedUrl: conversionSource, ok: false, error: response.error.message };
          } else {
            const payload = (response.data && typeof response.data === "object")
              ? response.data as Record<string, unknown>
              : {};
            const rawAffLink = String(payload.affiliateLink || "").trim();
            const affiliateLink = rawAffLink.replace(/[?&]lp=aff(?=(&|#|$))/gi, (m, s) => m.startsWith("?") ? (s === "&" ? "?" : "") : (s === "&" ? "&" : "")).replace(/[?&]$/, "");
            const product = (payload.product && typeof payload.product === "object") ? payload.product as Record<string, unknown> : null;
            const productImageUrl = product ? String(product.imageUrl || "").trim() : "";
            conversion = {
              affiliateLink,
              resolvedUrl: String(payload.resolvedUrl || conversionSource || link.original),
              ok: Boolean(affiliateLink),
              error: affiliateLink ? undefined : "Conversão Shopee retornou link vazio.",
              productImageUrl: productImageUrl || undefined,
              product: product || undefined,
            };
          }
          shopeeConversionCache.set(cacheKey, conversion);
        }

        if (!conversion.ok || !conversion.affiliateLink) {
          conversionFailure = { reason: "shopee_conversion_failed", error: conversion.error || "Falha ao converter link Shopee." };
          break;
        }

        outboundText = outboundText.split(link.original).join(conversion.affiliateLink);
        if (link.resolved && link.resolved !== link.original) {
          outboundText = outboundText.split(link.resolved).join(conversion.affiliateLink);
        }
        if (!primaryLink || primaryLink === link.original || primaryLink === link.resolved) {
          primaryLink = conversion.affiliateLink;
        }
        if (!primaryProduct && conversion.product) {
          primaryProduct = conversion.product;
        }
        if (!conversionProductImageUrl && conversion.productImageUrl) {
          conversionProductImageUrl = conversion.productImageUrl;
        }
        convertedLinks += 1;
        continue;
      }

      if (marketplace === "mercadolivre") {
        linksEligibleForConversion += 1;
        if (!MELI_URL) {
          conversionFailure = { reason: "meli_service_unavailable", error: "Serviço Mercado Livre indisponível para conversão." };
          break;
        }

        let meliSessionId = routeMeliSessionCache.get(route.id);
        if (!meliSessionId) {
          meliSessionId = await resolveRouteMeliSessionId(userId, rules.meliSessionId);
          routeMeliSessionCache.set(route.id, meliSessionId);
        }
        if (!meliSessionId) {
          conversionFailure = { reason: "meli_session_missing", error: "Sessão Mercado Livre não configurada para a rota." };
          break;
        }

        const conversionSource = link.resolvedMarketplace === "mercadolivre" ? link.resolved : link.original;
        const cacheKey = `${meliSessionId}::${conversionSource}`;
        let conversion = meliConversionCache.get(cacheKey);
        if (!conversion) {
          const scopedSessionId = buildScopedMeliSessionId(userId, meliSessionId);
          const meliHeaders = buildUserScopedHeaders(userId);
          const response = await proxyMicroservice(
            MELI_URL,
            "/api/meli/convert",
            "POST",
            { productUrl: conversionSource, sessionId: scopedSessionId },
            meliHeaders,
            90_000,
          );
          if (response.error) {
            conversion = { affiliateLink: "", ok: false, error: response.error.message };
          } else {
            const payload = (response.data && typeof response.data === "object")
              ? response.data as Record<string, unknown>
              : {};
            const success = payload.success === true;
            const affiliateLink = String(payload.affiliateLink || "").trim();
            conversion = {
              affiliateLink,
              ok: success && Boolean(affiliateLink),
              error: success ? undefined : String(payload.error || "Falha ao converter link Mercado Livre."),
            };
          }
          meliConversionCache.set(cacheKey, conversion);
        }

        if (!conversion.ok || !conversion.affiliateLink) {
          conversionFailure = { reason: "meli_conversion_failed", error: conversion.error || "Falha ao converter link Mercado Livre." };
          break;
        }

        outboundText = outboundText.split(link.original).join(conversion.affiliateLink);
        if (link.resolved && link.resolved !== link.original) {
          outboundText = outboundText.split(link.resolved).join(conversion.affiliateLink);
        }
        if (!primaryLink || primaryLink === link.original || primaryLink === link.resolved) {
          primaryLink = conversion.affiliateLink;
        }
        convertedLinks += 1;
      }
    }

    if (conversionFailure) {
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound',$6,'blocked',$7,'conversion')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message,
          routeId: route.id,
          routeName: route.name,
          error: conversionFailure.error,
          reason: conversionFailure.reason,
          hasMedia: !!media,
        }), messageType, conversionFailure.reason],
      );
      continue;
    }

    if (linksEligibleForConversion > 0 && convertedLinks === 0) {
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound',$6,'blocked','conversion_required','conversion')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message,
          routeId: route.id,
          routeName: route.name,
          reason: "conversion_required",
          hasMedia: !!media,
        }), messageType],
      );
      continue;
    }

    const rawTemplateId = typeof rules.templateId === "string" ? rules.templateId.trim() : "";
    const templateId = rawTemplateId && rawTemplateId !== "none" && rawTemplateId !== "original"
      ? rawTemplateId
      : "";
    if (templateId && isUuid(templateId)) {
      let templateContent = routeTemplateCache.get(templateId);
      if (templateContent === undefined) {
        const templateRow = await queryOne<{ content: string }>(
          "SELECT content FROM templates WHERE user_id = $1 AND id = $2",
          [userId, templateId],
        );
        templateContent = templateRow && typeof templateRow.content === "string"
          ? templateRow.content
          : null;
        routeTemplateCache.set(templateId, templateContent);
      }

      if (templateContent) {
        const placeholderData = buildRouteTemplatePlaceholderData(primaryProduct, primaryLink);
        outboundText = applyPlaceholders(templateContent, placeholderData);
      }
    }

    let routeMedia = media;
    let autoImageSource = "";
    if (!routeMedia && conversionProductImageUrl) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AUTO_IMAGE_FETCH_TIMEOUT_MS);
      try {
        routeMedia = await fetchImageBuffer(conversionProductImageUrl, controller.signal);
        if (routeMedia) autoImageSource = "shopee_product";
      } catch { /* ignore */ } finally {
        clearTimeout(timeout);
      }
    }
    if (!routeMedia) {
      routeMedia = await tryAutoDownloadImageFromMessage(outboundText);
      if (routeMedia) autoImageSource = "url_extraction";
    }
    const routeMessageType = routeMedia ? "image" : "text";
    if (!routeMedia) {
      logRouteMediaDebug("route.process.blocked.missing_image_required.inbound", {
        userId,
        sessionId,
        routeId: route.id,
        routeName: route.name,
        sourceExternalId,
        sourceName,
        hasText: Boolean(outboundText),
        textLength: String(outboundText || "").trim().length,
        originalMedia: summarizeRouteForwardMedia(media),
      });
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound',$6,'blocked','missing_image_required','media_requirements')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message: outboundText,
          routeId: route.id,
          routeName: route.name,
          reason: "missing_image_required",
          hasMedia: false,
        }), routeMessageType],
      );
      continue;
    }
    if (!String(outboundText || "").trim()) {
      logRouteMediaDebug("route.process.blocked.missing_text_required.inbound", {
        userId,
        sessionId,
        routeId: route.id,
        routeName: route.name,
        sourceExternalId,
        sourceName,
        media: summarizeRouteForwardMedia(routeMedia),
      });
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound','text','blocked','missing_text_required','message_validation')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message: outboundText,
          routeId: route.id,
          routeName: route.name,
          reason: "missing_text_required",
          hasMedia: true,
        })],
      );
      continue;
    }

    const targetIds = targetByRoute.get(route.id) ?? [];
    const destinationSessionFilter = typeof rules.sessionId === "string" ? rules.sessionId.trim() : "";
    const filteredTargetIds = destinationSessionFilter
      ? targetIds.filter((targetId) => {
        const group = destGroupMap.get(String(targetId));
        return !!group && String(group.session_id || "").trim() === destinationSessionFilter;
      })
      : targetIds;
    if (filteredTargetIds.length === 0) {
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound',$6,'blocked',$7,'route_targets')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message: outboundText,
          routeId: route.id,
          routeName: route.name,
          reason: destinationSessionFilter ? "no_destination_groups_for_session" : "no_destination_groups",
          destinationSessionFilter: destinationSessionFilter || null,
          hasMedia: !!routeMedia,
        }), routeMessageType, destinationSessionFilter ? "no_destination_groups_for_session" : "no_destination_groups"],
      );
      continue;
    }

    for (const targetId of filteredTargetIds) {
      const group = destGroupMap.get(String(targetId));
      if (!group) {
        await execute(
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'error',$5,'outbound','text','failed','destination_not_found','destination_lookup')",
          [uuid(), userId, sourceName, route.name, JSON.stringify({ message: outboundText, routeId: route.id, routeName: route.name, destinationId: targetId, reason: "destination_not_found" })],
        );
        continue;
      }

      const platform = String(group.platform ?? "");
      const destinationSessionId = String(group.session_id ?? "");
      const destinationExternalId = String(group.external_id ?? "");
      if (!destinationSessionId || !destinationExternalId) {
        await execute(
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'error',$5,'outbound','text','failed','destination_session_offline','destination_válidation')",
          [uuid(), userId, sourceName, group.name, JSON.stringify({ message: outboundText, routeId: route.id, routeName: route.name, reason: "destination_session_offline" })],
        );
        continue;
      }

      const scopedHeaders = buildUserScopedHeaders(userId);
      const mediaForDestination = routeMedia
        ? await resolveRouteForwardMediaForPlatform({ userId, platform, media: routeMedia })
        : null;
      if (!mediaForDestination) {
        logRouteMediaDebug("route.process.blocked.missing_image_required.outbound", {
          userId,
          sessionId,
          routeId: route.id,
          routeName: route.name,
          destinationPlatform: platform,
          destinationGroupId: group.id,
          destinationGroupName: group.name,
          sourceMedia: summarizeRouteForwardMedia(routeMedia),
        });
        await execute(
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'outbound','text','blocked','missing_image_required','media_requirements')",
          [uuid(), userId, sourceName, group.name, JSON.stringify({
            message: outboundText,
            routeId: route.id,
            routeName: route.name,
            platform,
            reason: "missing_image_required",
            hasMedia: false,
          })],
        );
        continue;
      }
      const formattedOutboundText = formatMessageForDestinationPlatform(outboundText, platform);
      const outboundTextSafe = formattedOutboundText.trim();
      if (!outboundTextSafe) {
        logRouteMediaDebug("route.process.blocked.missing_text_required.outbound", {
          userId,
          sessionId,
          routeId: route.id,
          routeName: route.name,
          destinationPlatform: platform,
          destinationGroupId: group.id,
          destinationGroupName: group.name,
          media: summarizeRouteForwardMedia(mediaForDestination),
        });
        await execute(
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'outbound','text','blocked','missing_text_required','message_validation')",
          [uuid(), userId, sourceName, group.name, JSON.stringify({
            message: outboundText,
            routeId: route.id,
            routeName: route.name,
            platform,
            reason: "missing_text_required",
            hasMedia: true,
          })],
        );
        continue;
      }
      let result = { data: null as unknown, error: { message: "Plataforma inválida" } as { message: string } | null };
      if (platform === "whatsapp" && WHATSAPP_URL) {
        result = await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", {
          sessionId: destinationSessionId,
          jid: destinationExternalId,
          content: outboundTextSafe,
          media: mediaForDestination ?? undefined,
        }, scopedHeaders);
      } else if (platform === "telegram" && TELEGRAM_URL) {
        result = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/send-message", "POST", {
          sessionId: destinationSessionId,
          chatId: destinationExternalId,
          message: outboundTextSafe,
          media: mediaForDestination ?? undefined,
        }, scopedHeaders);
      }

      if (result.error) {
        logRouteMediaDebug("route.process.failed.destination_send_failed", {
          userId,
          sessionId,
          routeId: route.id,
          routeName: route.name,
          destinationPlatform: platform,
          destinationGroupId: group.id,
          destinationGroupName: group.name,
          hasText: Boolean(outboundTextSafe),
          textLength: outboundTextSafe.length,
          media: summarizeRouteForwardMedia(mediaForDestination),
          error: result.error.message,
        });
        await execute(
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'error',$5,'outbound',$6,'failed','destination_send_failed','send_message')",
          [uuid(), userId, sourceName, group.name, JSON.stringify({ message: outboundTextSafe, routeId: route.id, routeName: route.name, error: result.error.message, platform, hasMedia: !!mediaForDestination }), mediaForDestination ? "image" : "text"],
        );
        continue;
      }

      dispatched += 1;
      routeDispatched += 1;
      if (mediaForDestination) {
        mediaUsedInSuccessfulDispatch = true;
      }
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'success',$5,'outbound',$6,'sent','','')",
        [uuid(), userId, sourceName, group.name, JSON.stringify({ message: outboundTextSafe, platform, routeId: route.id, routeName: route.name, hasMedia: !!mediaForDestination, ...(autoImageSource ? { autoImageSource } : {}) }), mediaForDestination ? "image" : "text"],
      );
    }

    if (routeDispatched > 0) {
      await execute(
        `UPDATE routes
           SET rules = jsonb_set(
                 COALESCE(rules, '{}'::jsonb),
                 '{messagesForwarded}',
                 to_jsonb(
                   (
                     CASE
                       WHEN COALESCE(rules->>'messagesForwarded', '') ~ '^[0-9]+$'
                         THEN (rules->>'messagesForwarded')::bigint
                       ELSE 0
                     END
                   ) + $1::bigint
                 ),
                 true
               ),
               updated_at = NOW()
         WHERE id = $2 AND user_id = $3`,
        [routeDispatched, route.id, userId],
      );
    }
  }

  if (mediaUsedInSuccessfulDispatch) {
    await scheduleRouteForwardMediaDeletion({
      userId,
      media,
      delayMs: 120_000,
    });
  }

  return { dispatched, routesMatched: matching.length };
}

async function pollWhatsAppEventsForSession(userId: string, sessionId: string): Promise<number> {
  const headers = buildUserScopedHeaders(userId);
  const upstream = await proxyMicroservice(
    WHATSAPP_URL,
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    "GET",
    null,
    headers,
  );
  if (upstream.error) {
    if (isNotFoundSessionError(upstream.error.message)) {
      await execute(
        "UPDATE whatsapp_sessions SET status='offline', connected_at=NULL, qr_code='', error_message='Sessão não encontrada no serviço WhatsApp. Conecte novamente para recriar.', updated_at=NOW() WHERE id=$1 AND user_id=$2",
        [sessionId, userId],
      );
      return 0;
    }
    await execute(
      "UPDATE whatsapp_sessions SET status='warning', connected_at=NULL, error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
      [upstream.error.message, sessionId, userId],
    );
    return 0;
  }
  const events = toIntegrationEvents(upstream.data);
  if (events.length === 0) return 0;
  await applyWhatsAppEvents(userId, sessionId, events);
  return events.length;
}

async function pollTelegramEventsForSession(userId: string, sessionId: string): Promise<number> {
  const headers = buildUserScopedHeaders(userId);
  const upstream = await proxyMicroservice(
    TELEGRAM_URL,
    `/api/telegram/events/${encodeURIComponent(sessionId)}`,
    "GET",
    null,
    headers,
  );
  if (upstream.error) {
    if (isNotFoundSessionError(upstream.error.message)) {
      await execute(
        "UPDATE telegram_sessions SET status='offline', connected_at=NULL, phone_code_hash='', error_message='Sessão não encontrada no serviço Telegram. Inicie uma nova conexão.', updated_at=NOW() WHERE id=$1 AND user_id=$2",
        [sessionId, userId],
      );
      return 0;
    }
    await execute(
      "UPDATE telegram_sessions SET status='warning', connected_at=NULL, error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
      [upstream.error.message, sessionId, userId],
    );
    return 0;
  }
  const events = toIntegrationEvents(upstream.data);
  if (events.length === 0) return 0;
  await applyTelegramEvents(userId, sessionId, events);
  return events.length;
}

async function pollChannelEventsInScope(input: {
  requesterUserId: string;
  canRunGlobal: boolean;
}): Promise<{
  scope: "user" | "global";
  whatsappSessions: number;
  whatsappEvents: number;
  telegramSessions: number;
  telegramEvents: number;
  failed: number;
}> {
  const scope: "user" | "global" = input.canRunGlobal ? "global" : "user";
  const scopeParams: unknown[] = [];
  const scopeFilter = input.canRunGlobal ? "" : "AND user_id = $1";
  if (!input.canRunGlobal) scopeParams.push(input.requesterUserId);

  let whatsappSessions = 0;
  let whatsappEvents = 0;
  let telegramSessions = 0;
  let telegramEvents = 0;
  let failed = 0;

  if (WHATSAPP_URL) {
    const sessions = await query<{ id: string; user_id: string }>(
      `SELECT id, user_id
       FROM whatsapp_sessions
       WHERE COALESCE(status, '') <> 'offline'
       ${scopeFilter}`,
      scopeParams,
    );
    whatsappSessions = sessions.length;

    for (const session of sessions) {
      try {
        whatsappEvents += await pollWhatsAppEventsForSession(String(session.user_id), String(session.id));
      } catch {
        failed += 1;
      }
    }
  }

  if (TELEGRAM_URL) {
    const sessions = await query<{ id: string; user_id: string }>(
      `SELECT id, user_id
       FROM telegram_sessions
       WHERE COALESCE(status, '') <> 'offline'
          OR COALESCE(session_string, '') <> ''
       ${scopeFilter}`,
      scopeParams,
    );
    telegramSessions = sessions.length;

    for (const session of sessions) {
      try {
        telegramEvents += await pollTelegramEventsForSession(String(session.user_id), String(session.id));
      } catch {
        failed += 1;
      }
    }
  }

  return {
    scope,
    whatsappSessions,
    whatsappEvents,
    telegramSessions,
    telegramEvents,
    failed,
  };
}

function spawnOpsControlLocal(targetPort: number): { ok: true; pid: number } | { ok: false; error: string } {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // services/api/src -> project root
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const entry = path.join(projectRoot, "services", "ops-control", "src", "server.mjs");

  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k || v == null) continue;
      env[k] = String(v);
    }

    // Ensure ops-control binds the expected port, and inherits security token if configured.
    env.PORT = String(targetPort);
    env.HOST = env.HOST || "0.0.0.0";
    if (OPS_TOKEN && !String(env.OPS_CONTROL_TOKEN || "").trim()) {
      env.OPS_CONTROL_TOKEN = OPS_TOKEN;
    }

    const child = spawn(process.execPath, [entry], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: true,
    });
    child.unref();

    const pid = Number(child.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { ok: false, error: "Falha ao iniciar ops-control (PID inválido)" };
    }

    return { ok: true, pid };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Module-level cache for admin_config â€” TTL 60s.
// The value changes only when an admin explicitly reconfigures plans/limits,
// so a 1-minute cache is safe and eliminates a DB round-trip on every
// admin-users and account-plan request.
let _cpCache: { value: Record<string, unknown>; expiresAt: number } | null = null;
async function loadControlPlane() {
  if (_cpCache && _cpCache.expiresAt > Date.now()) return _cpCache.value;
  const row = await queryOne("SELECT value FROM system_settings WHERE key = 'admin_config'");
  const value = (row?.value ?? {}) as Record<string, unknown>;
  _cpCache = { value, expiresAt: Date.now() + 60_000 };
  return value;
}
// Inválidate the cache immediately after any write to admin_config.
function inválidateControlPlaneCache() { _cpCache = null; }

// Built-in plan catalog â€” mirrors src/lib/plans.ts. Acts as fallback when
// admin_config has not yet been configured via the admin panel.
const BUILTIN_PLANS: Array<{ id: string; period: string; isActive: boolean }> = [
  { id: "plan-starter",        period: "7 dias",   isActive: true },
  { id: "plan-start",          period: "30 dias",  isActive: true },
  { id: "plan-pro",            period: "30 dias",  isActive: true },
  { id: "plan-business",       period: "30 dias",  isActive: true },
  { id: "plan-start-annual",   period: "365 dias", isActive: true },
  { id: "plan-pro-annual",     period: "365 dias", isActive: true },
  { id: "plan-business-annual",period: "365 dias", isActive: true },
];
const BUILTIN_PLAN_IDS = new Set(BUILTIN_PLANS.map((p) => p.id));
const ADMIN_PANEL_PLAN_ID = "admin";
const MERCADO_LIVRE_FEATURE_KEY = "mercadoLivre";
const MERCADO_LIVRE_FALLBACK_ENABLED_PLANS = new Set([
  "plan-starter",
  "plan-business",
  "plan-business-annual",
]);
const MERCADO_LIVRE_BLOCKED_MESSAGE = "Mercado Livre não está disponível no seu plano ou nível de acesso.";

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getValidPlanIds(cp) {
  const plans = Array.isArray(cp.plans) ? cp.plans : [];
  const configured = new Set(plans.map((p) => String(p.id ?? "").trim()).filter(Boolean));
  // Fall back to built-in IDs when admin hasn't configured plans yet
  return configured.size > 0 ? configured : BUILTIN_PLAN_IDS;
}

function getFallbackPlanId(cp) {
  const plans = Array.isArray(cp.plans) ? cp.plans : [];
  const preferred = String(cp.defaultSignupPlanId ?? "").trim();
  const ids = getValidPlanIds(cp);
  if (preferred && ids.has(preferred)) return preferred;
  const active = plans.find((p) => p.isActive && String(p.id ?? "").trim());
  return active ? String(active.id) : (plans[0] ? String(plans[0].id) : "plan-starter");
}

function resolvePlanPeriodMs(cp, planId) {
  const plans = Array.isArray(cp.plans) ? cp.plans : [];
  const plan = plans.find((p) => String(p.id ?? "") === planId);
  // Fall back to built-in periods when admin hasn't configured plans yet
  const period = String(plan?.period ?? (BUILTIN_PLANS.find((p) => p.id === planId)?.period ?? "")).toLowerCase().trim();
  if (!period) return null;
  const month = 30 * 24 * 60 * 60 * 1000, year = 365 * 24 * 60 * 60 * 1000;
  const m = period.match(/(\d+)\s*(dia|mes|m[ês]s|ano)/i);
  if (m) {
    const n = Number(m[1]), u = m[2].toLowerCase();
    if (u.startsWith("dia")) return n * 86400000;
    if (u.startsWith("mes") || u.startsWith("mês")) return n * month;
    if (u.startsWith("ano")) return n * year;
  }
  if (period.includes("ano")) return year;
  if (period.includes("mes") || period.includes("mês")) return month;
  return null;
}

function planExpiresAt(cp, planId, baseMs = Date.now()) {
  const ms = resolvePlanPeriodMs(cp, planId);
  return ms ? new Date(baseMs + ms).toISOString() : null;
}

function normalizeTargetFilter(raw) {
  const s = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const arr = (v) => Array.isArray(v) ? v.filter((i) => typeof i === "string") : [];
  return { planIds: arr(s.planIds), accessLevelIds: arr(s.accessLevelIds), roles: arr(s.roles), userIds: arr(s.userIds), matchMode: s.matchMode === "all" ? "all" : "any" };
}

function isAnnouncementActiveNow(row) {
  if (row.is_active === false) return false;
  const now = Date.now();
  if (row.starts_at && Date.parse(String(row.starts_at)) > now) return false;
  if (row.ends_at && Date.parse(String(row.ends_at)) < now) return false;
  return true;
}

async function appendAudit(action, actorId, targetId, details) {
  await execute(
    "INSERT INTO admin_audit_logs (id, user_id, action, target_user_id, details) VALUES ($1,(SELECT id FROM users WHERE id=$2),$3,(SELECT id FROM users WHERE id=$4),$5)",
    [uuid(), actorId || null, action, targetId || null, JSON.stringify(details)],
  );
}

async function isPlanExpired(userId) {
  const row = await queryOne("SELECT plan_expires_at FROM profiles WHERE user_id = $1", [userId]);
  if (!row?.plan_expires_at) return false;
  return Date.parse(row.plan_expires_at) <= Date.now();
}

async function getUserPlanId(userId: string): Promise<string> {
  const row = await queryOne<{ plan_id: string | null }>(
    "SELECT plan_id FROM profiles WHERE user_id = $1",
    [userId],
  );
  return String(row?.plan_id || "plan-starter").trim() || "plan-starter";
}

function hasPositiveLimit(value: unknown): boolean | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n === -1 || n > 0;
}

async function resolveMercadoLivreFeatureAccess(userId: string): Promise<{ allowed: boolean; message: string }> {
  const planId = await getUserPlanId(userId);
  const cp = await loadControlPlane();

  const plans = Array.isArray(cp?.plans) ? cp.plans : [];
  const accessLevels = Array.isArray(cp?.accessLevels) ? cp.accessLevels : [];

  const plan = plans.find((entry) => String(entry?.id || "").trim() === planId) || null;
  let fallbackAllowed = MERCADO_LIVRE_FALLBACK_ENABLED_PLANS.has(planId);

  if (plan && typeof plan === "object" && !Array.isArray(plan)) {
    const limits = (plan as Record<string, unknown>).limits;
    if (limits && typeof limits === "object" && !Array.isArray(limits)) {
      const byLimit = hasPositiveLimit((limits as Record<string, unknown>).meliSessions);
      if (byLimit !== null) fallbackAllowed = byLimit;
    }
  }

  let blockedMessage = MERCADO_LIVRE_BLOCKED_MESSAGE;

  if (plan && typeof plan === "object" && !Array.isArray(plan)) {
    const accessLevelId = String((plan as Record<string, unknown>).accessLevelId || "").trim();
    if (accessLevelId) {
      const accessLevel = accessLevels.find((entry) => String(entry?.id || "").trim() === accessLevelId) || null;
      if (accessLevel && typeof accessLevel === "object" && !Array.isArray(accessLevel)) {
        const featureRules = (accessLevel as Record<string, unknown>).featureRules;
        if (featureRules && typeof featureRules === "object" && !Array.isArray(featureRules)) {
          const featureRuleRaw = (featureRules as Record<string, unknown>)[MERCADO_LIVRE_FEATURE_KEY];
          if (featureRuleRaw && typeof featureRuleRaw === "object" && !Array.isArray(featureRuleRaw)) {
            const featureRule = featureRuleRaw as Record<string, unknown>;
            const mode = String(featureRule.mode || "").trim().toLowerCase();
            const customBlockedMessage = String(featureRule.blockedMessage || "").trim();
            if (customBlockedMessage) blockedMessage = customBlockedMessage;
            if (mode === "enabled") return { allowed: true, message: "" };
            if (mode === "hidden" || mode === "blocked") return { allowed: false, message: blockedMessage };
          }
        }
      }
    }
  }

  if (fallbackAllowed) return { allowed: true, message: "" };
  return { allowed: false, message: blockedMessage };
}

async function listUsersWithMeta() {
  // Single JOIN instead of 3 sequential round-trips â€” reduces latency under load
  // and frees 2 pool connections per call.
  const rows = await query(`
    SELECT u.id, u.email, u.metadata, u.created_at,
           CASE
             WHEN COALESCE(r.role, 'user') = 'admin' THEN '${ADMIN_PANEL_PLAN_ID}'
             ELSE COALESCE(p.plan_id, 'plan-starter')
           END AS plan_id,
           CASE
             WHEN COALESCE(r.role, 'user') = 'admin' THEN NULL
             ELSE p.plan_expires_at
           END AS plan_expires_at,
           p.name AS profile_name,
           COALESCE(r.role, 'user') AS role
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    LEFT JOIN user_roles r ON r.user_id = u.id
    ORDER BY u.created_at
  `);
  return rows.map((u) => ({
    id: u.id, user_id: u.id,
    name: String(u.profile_name ?? u.metadata?.name ?? "Usuário"),
    email: u.email,
    plan_id: u.plan_id,
    plan_expires_at: u.plan_expires_at ?? null,
    created_at: u.created_at,
    role: u.role,
    account_status: String(u.metadata?.account_status ?? "active"),
  }));
}

async function deliverAnnouncement(announcement) {
  const filter = normalizeTargetFilter(announcement.target_filter);
  const users = await listUsersWithMeta();
  const toDeliver = [];
  for (const u of users) {
    if (["inactive","blocked","archived"].includes(u.account_status)) continue;
    const { planIds, roles: filterRoles, userIds, matchMode } = filter;
    let match = false;
    if (planIds.length === 0 && filterRoles.length === 0 && userIds.length === 0) {
      match = true;
    } else if (matchMode === "all") {
      const checks = [
        planIds.length === 0 || planIds.includes(u.plan_id),
        filterRoles.length === 0 || filterRoles.includes(u.role),
        userIds.length === 0 || userIds.includes(u.user_id),
      ];
      match = checks.every(Boolean);
    } else {
      match = planIds.includes(u.plan_id) || filterRoles.includes(u.role) || userIds.includes(u.user_id);
    }
    if (match) toDeliver.push(u.user_id);
  }
  if (toDeliver.length > 0) {
    // Bulk-insert all notifications in a single query instead of N sequential INSERTs.
    // UNNEST avoids a large VALUES list while still being a single round-trip.
    const ids = toDeliver.map(() => uuid());
    await execute(
      `INSERT INTO user_notifications (id, user_id, announcement_id, status, delivered_at)
       SELECT UNNEST($1::uuid[]), UNNEST($2::uuid[]), $3, 'unread', NOW()
       ON CONFLICT (user_id, announcement_id) DO NOTHING`,
      [ids, toDeliver, announcement.id]
    );
  }
  await execute("UPDATE system_announcements SET last_delivered_at = NOW() WHERE id = $1", [announcement.id]);
  return { delivered: toDeliver.length, matchedUsers: toDeliver.length };
}

// â”€â”€â”€ POST /functions/v1/rpc â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
rpcRouter.post("/rpc", async (req, res) => {
  const userId = req.currentUser?.sub;
  const userIsAdmin = req.currentUser?.role === "admin";
  const isService = !!(req.currentUser)?.isService;
  const effectiveAdmin = userIsAdmin || isService;

  if (!userId) { fail(res, "Não autenticado", 401); return; }

  const { name, ...params } = req.body;
  const funcName = String(name ?? "");
  if (!funcName) { fail(res, "Nome da função obrigatório", 400); return; }

  if (!isService) {
    const rateScopeKey = userId || (req.ip ?? req.socket.remoteAddress ?? "unknown");
    const rateResult = consumeRpcFunctionRateLimit(rateScopeKey, funcName);
    if (!rateResult.allowed) {
      fail(res, rateResult.policy?.message || "Limite de chamadas excedido. Aguarde alguns segundos.", 429);
      return;
    }
  }

  // Plan expiry check
  if (!PLAN_EXPIRY_ALLOWED.has(funcName) && !effectiveAdmin) {
    if (await isPlanExpired(userId)) { fail(res, "Plano expirado. Renove ou troque de plano."); return; }
  }

  const isMeliFunction = funcName.startsWith("meli-");
  if (isMeliFunction && !effectiveAdmin) {
    try {
      const featureAccess = await resolveMercadoLivreFeatureAccess(userId);
      if (!featureAccess.allowed) {
        fail(res, featureAccess.message || MERCADO_LIVRE_BLOCKED_MESSAGE, 403);
        return;
      }
    } catch {
      fail(res, "Não foi possível válidar o acesso ao módulo Mercado Livre.", 503);
      return;
    }
  }

  try {
    // â”€â”€ poll-channel-events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "poll-channel-events") {
      const canRunGlobalChannelPolling = isService || (effectiveAdmin && !userIsAdmin);
      const polled = await pollChannelEventsInScope({
        requesterUserId: userId,
        canRunGlobal: canRunGlobalChannelPolling,
      });
      ok(res, { ok: true, source: String(params.source ?? "frontend"), ...polled }); return;
    }

    // â”€â”€ whatsapp-connect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "whatsapp-connect") {
      const action = String(params.action ?? "");
      const sessionId = String(params.sessionId ?? "");
      if (!WHATSAPP_URL) {
        if (action === "health") { ok(res, { online: false, url: "", uptimeSec: null, sessions: [], error: "WHATSAPP_MICROSERVICE_URL não definido" }); return; }
        if (action === "poll_events_all" || action === "poll_events") { ok(res, { success: true, sessions: 0, events: 0 }); return; }
        fail(res, "WHATSAPP_MICROSERVICE_URL não definido"); return;
      }
      if (action === "health") {
        const r = await proxyMicroservice(
          WHATSAPP_URL,
          "/health",
          "GET",
          null,
          buildUserScopedHeaders(userId),
        );
        if (r.error) { ok(res, { online: false, url: WHATSAPP_URL, uptimeSec: null, sessions: [], error: r.error.message }); return; }
        const payload: Record<string, unknown> = (r.data && typeof r.data === "object") ? (r.data as Record<string, unknown>) : {};
        ok(res, {
          online: payload.ok === true || payload.online === true,
          url: WHATSAPP_URL,
          uptimeSec: Number.isFinite(Number(payload.uptimeSec)) ? Number(payload.uptimeSec) : null,
          sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
          error: null,
        });
        return;
      }
      if (action === "poll_events_all") {
        await reconcileWhatsAppSessionsFromHealth(userId).catch(() => ({ reconciled: 0, online: false }));
        const sessions = await query<{ id: string }>("SELECT id FROM whatsapp_sessions WHERE user_id = $1", [userId]);
        let totalEvents = 0;
        for (const row of sessions) {
          if (!row?.id) continue;
          try {
            totalEvents += await pollWhatsAppEventsForSession(userId, String(row.id));
          } catch {
            // best effort polling
          }
        }
        ok(res, { success: true, sessions: sessions.length, events: totalEvents }); return;
      }
      // Ownership guard: verify session belongs to this user before any session-specific action
      if (sessionId && action !== "health" && action !== "poll_events_all") {
        const ownedWa = await queryOne("SELECT id FROM whatsapp_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        if (!ownedWa) { fail(res, "Sessão não encontrada"); return; }
      }
      if (action === "poll_events") {
        const events = await pollWhatsAppEventsForSession(userId, sessionId);
        ok(res, { success: true, events }); return;
      }
      if (action === "connect") {
        const sess = await queryOne("SELECT auth_method, phone, name FROM whatsapp_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        if (!sess) { fail(res, "Sessão não encontrada"); return; }
        const authMethod = "qr";
        const phone = String(sess.phone ?? "").trim();
        await execute(
          "UPDATE whatsapp_sessions SET auth_method='qr', status='connecting', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2",
          [sessionId, userId],
        );
        const waHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(WHATSAPP_URL, `/api/sessions/${encodeURIComponent(sessionId)}/connect`, "POST", {
          userId,
          webhookUrl: "",
          phone,
          authMethod,
          sessionName: String(sess.name ?? sessionId),
        }, waHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        await pollWhatsAppEventsForSession(userId, sessionId).catch(() => 0);
        const status = (r.data && typeof r.data === "object" && typeof (r.data as Record<string, unknown>).status === "string")
          ? String((r.data as Record<string, unknown>).status)
          : "connecting";
        ok(res, { success: true, status, waiting_webhook: false }); return;
      }
      if (action === "disconnect") {
        const waHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(
          WHATSAPP_URL,
          `/api/sessions/${encodeURIComponent(sessionId)}/disconnect`,
          "POST",
          { sessionId },
          waHeaders,
        );
        if (r.error) { fail(res, r.error.message); return; }
        await execute("UPDATE whatsapp_sessions SET status='offline', connected_at=NULL, qr_code='', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2", [sessionId, userId]);
        await pollWhatsAppEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, { success: true, status: "offline" }); return;
      }
      if (action === "sync_groups") {
        const waHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(
          WHATSAPP_URL,
          `/api/sessions/${encodeURIComponent(sessionId)}/sync-groups`,
          "POST",
          { sessionId },
          waHeaders,
        );
        if (r.error) { fail(res, r.error.message); return; }
        const remoteGroups: Array<Record<string, unknown>> = (r.data && typeof r.data === "object" && Array.isArray((r.data as Record<string, unknown>).groups))
          ? ((r.data as Record<string, unknown>).groups as Array<Record<string, unknown>>)
          : [];
        await syncWhatsAppGroupsWithReconciliation(userId, sessionId, remoteGroups);
        const inviteSync = await syncMasterGroupWhatsAppInviteLinks(userId, sessionId).catch(() => ({ checked: 0, updated: 0, failed: 0 }));
        const events = await pollWhatsAppEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, {
          success: true,
          count: remoteGroups.length,
          events,
          masterGroupInviteSync: inviteSync,
        }); return;
      }
      if (action === "group_invite") {
        const groupId = String(params.groupId ?? "").trim();
        if (!groupId) { fail(res, "groupId é obrigatório"); return; }

        const waHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(
          WHATSAPP_URL,
          `/api/sessions/${encodeURIComponent(sessionId)}/group-invite`,
          "POST",
          { groupId },
          waHeaders,
        );
        if (r.error) { fail(res, r.error.message); return; }
        ok(res, r.data ?? { success: true }); return;
      }
      if (action === "send_message") {
        const jid = String(params.groupId ?? params.jid ?? "").trim();
        const content = String(params.text ?? params.content ?? "").trim();
        if (!jid || !content) { fail(res, "groupId/jid e text/content são obrigatórios"); return; }
        const outboundContent = formatMessageForPlatform(content, "whatsapp");
        const waHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", {
          sessionId,
          jid,
          content: outboundContent,
          media: params.media ?? undefined,
        }, waHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        await pollWhatsAppEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, r.data ?? { success: true }); return;
      }
      fail(res, "Ação WhatsApp inválida"); return;
    }

    // â”€â”€ telegram-connect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "telegram-connect") {
      const action = String(params.action ?? "");
      const sessionId = String(params.sessionId ?? "");
      if (!TELEGRAM_URL) {
        if (action === "health") { ok(res, { online: false, url: "", uptimeSec: null, sessions: [], error: "TELEGRAM_MICROSERVICE_URL não definido" }); return; }
        if (action === "poll_events_all" || action === "poll_events") { ok(res, { success: true, sessions: 0, events: 0 }); return; }
        fail(res, "TELEGRAM_MICROSERVICE_URL não definido"); return;
      }
      if (action === "health") {
        const r = await proxyMicroservice(
          TELEGRAM_URL,
          "/health",
          "GET",
          null,
          buildUserScopedHeaders(userId),
        );
        if (r.error) { ok(res, { online: false, url: TELEGRAM_URL, uptimeSec: null, sessions: [], error: r.error.message }); return; }
        const payload: Record<string, unknown> = (r.data && typeof r.data === "object") ? (r.data as Record<string, unknown>) : {};
        ok(res, {
          online: payload.ok === true || payload.online === true,
          url: TELEGRAM_URL,
          uptimeSec: Number.isFinite(Number(payload.uptimeSec)) ? Number(payload.uptimeSec) : null,
          sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
          error: null,
        });
        return;
      }
      if (action === "poll_events_all") {
        const sessions = await query<{ id: string }>("SELECT id FROM telegram_sessions WHERE user_id = $1", [userId]);
        let totalEvents = 0;
        for (const row of sessions) {
          if (!row?.id) continue;
          try {
            totalEvents += await pollTelegramEventsForSession(userId, String(row.id));
          } catch {
            // best effort polling
          }
        }
        ok(res, { success: true, sessions: sessions.length, events: totalEvents }); return;
      }
      if (action === "refresh_status") {
        const touched = await refreshTelegramHealthState(userId).catch(() => 0);
        const sessions = await query<{ id: string }>("SELECT id FROM telegram_sessions WHERE user_id = $1", [userId]);
        let totalEvents = 0;
        for (const row of sessions) {
          if (!row?.id) continue;
          try {
            totalEvents += await pollTelegramEventsForSession(userId, String(row.id));
          } catch {
            // best effort polling
          }
        }
        ok(res, { success: true, sessions: sessions.length, events: totalEvents, touched }); return;
      }
      // Ownership guard: verify session belongs to this user before any session-specific action
      if (sessionId && action !== "health" && action !== "poll_events_all") {
        const ownedTg = await queryOne("SELECT id FROM telegram_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        if (!ownedTg) { fail(res, "Sessão não encontrada"); return; }
      }
      if (action === "poll_events") {
        const events = await pollTelegramEventsForSession(userId, sessionId);
        ok(res, { success: true, events }); return;
      }
      if (action === "send_code") {
        const sess = await queryOne("SELECT phone, session_string FROM telegram_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        if (!sess) { fail(res, "Sessão não encontrada"); return; }
        await execute("UPDATE telegram_sessions SET status='connecting', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2", [sessionId, userId]);
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/send_code", "POST", {
          sessionId,
          userId,
          phone: String(params.phone ?? sess.phone ?? ""),
          webhookUrl: "",
          sessionString: String(sess.session_string ?? ""),
        }, tgHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        const status = (r.data && typeof r.data === "object" && typeof (r.data as Record<string, unknown>).status === "string")
          ? String((r.data as Record<string, unknown>).status)
          : "connecting";
        ok(res, { status }); return;
      }
      if (action === "verify_code") {
        await execute("UPDATE telegram_sessions SET status='connecting', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2", [sessionId, userId]);
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/verify_code", "POST", { sessionId, code: params.code }, tgHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, r.data ?? { status: "connecting" }); return;
      }
      if (action === "verify_password") {
        await execute("UPDATE telegram_sessions SET status='connecting', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2", [sessionId, userId]);
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/verify_password", "POST", { sessionId, password: params.password }, tgHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, r.data ?? { status: "connecting" }); return;
      }
      if (action === "disconnect") {
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/disconnect", "POST", { sessionId }, tgHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        await execute("UPDATE telegram_sessions SET status='offline', connected_at=NULL, phone_code_hash='', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2", [sessionId, userId]);
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, { status: "offline" }); return;
      }
      if (action === "sync_groups") {
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/sync_groups", "POST", { sessionId }, tgHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        const events = await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        const payload = (r.data && typeof r.data === "object") ? r.data as Record<string, unknown> : {};
        ok(res, { ...payload, events }); return;
      }
      if (action === "send_message") {
        const chatId = String(params.groupId ?? params.chatId ?? "").trim();
        const message = String(params.text ?? params.message ?? "").trim();
        if (!chatId || !message) { fail(res, "groupId/chatId e text/message são obrigatórios"); return; }
        const outboundMessage = formatMessageForPlatform(message, "telegram");
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/send-message", "POST", {
          sessionId,
          chatId,
          message: outboundMessage,
          media: params.media ?? undefined,
        }, tgHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, r.data ?? { status: "online" }); return;
      }
      fail(res, "Ação Telegram inválida"); return;
    }

    // â”€â”€ dispatch-messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "dispatch-messages") {
      // Rescue stuck jobs: posts left in 'processing' after a crash or timeout.
      // Reset them to 'pending' so they are retried in this or the next cycle.
      const stuckRows = await query<{ id: string; updated_at: string }>(
        `UPDATE scheduled_posts SET status = 'pending', updated_at = NOW()
         WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes'
         RETURNING id, updated_at`
      );
      if (stuckRows.length > 0) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(), svc: "api", event: "dispatch_released_stuck_jobs",
          count: stuckRows.length, ids: stuckRows.map((r) => r.id),
        }));
      }

      await cleanupExpiredScheduledPostMedia();

      const limit = Math.min(Number(params.limit ?? 20), 50);
      // Atomic claim: UPDATE status â†’ 'processing' using FOR UPDATE SKIP LOCKED so that
      // concurrent calls from the frontend and the scheduler never process the same post.
      // Only rows still 'pending' at the moment of the UPDATE are claimed, preventing
      // double-dispatch (SQL-5).
      const canRunGlobalDispatch = isService || (effectiveAdmin && !userIsAdmin);
      const claimedRows = canRunGlobalDispatch
        ? await query(
            `UPDATE scheduled_posts SET status = 'processing', updated_at = NOW()
             WHERE id IN (
               SELECT id FROM scheduled_posts
               WHERE status = 'pending' AND scheduled_at <= NOW()
               ORDER BY scheduled_at LIMIT $1
               FOR UPDATE SKIP LOCKED
             ) RETURNING *`,
            [limit]
          )
        : await query(
            `UPDATE scheduled_posts SET status = 'processing', updated_at = NOW()
             WHERE id IN (
               SELECT id FROM scheduled_posts
               WHERE status = 'pending' AND scheduled_at <= NOW() AND user_id = $2
               ORDER BY scheduled_at LIMIT $1
               FOR UPDATE SKIP LOCKED
             ) RETURNING *`,
            [limit, userId]
          );
      // Load destinations for all claimed posts in a single query (avoids per-post N+1)
      const claimedIds = claimedRows.map((r: { id: string }) => r.id);
      const destRows = claimedIds.length > 0
        ? await query(
            `SELECT post_id, group_id FROM scheduled_post_destinations WHERE post_id = ANY($1)`,
            [claimedIds]
          )
        : [];
      const destsByPost = new Map<string, string[]>();
      for (const d of destRows) {
        const list = destsByPost.get(d.post_id) ?? [];
        list.push(d.group_id);
        destsByPost.set(d.post_id, list);
      }
      const pending = claimedRows.map((r: Record<string, unknown>) => ({
        ...r,
        dest_ids: destsByPost.get(r.id as string) ?? [],
      })) as Array<{
        id: string; user_id: string; content: string;
        metadata: Record<string, unknown>; recurrence: string;
        scheduled_at: string;
        dest_ids: string[];
        [k: string]: unknown;
      }>;
      let sent = 0, failed = 0, skipped = 0;
      const scheduleTemplateCache = new Map<string, string | null>();
      const insertScheduleFailedHistory = async (input: {
        userId: string;
        destination: string;
        message: string;
        reason: string;
        errorStep: string;
        platform?: string;
        error?: string;
        messageType?: "text" | "image";
      }) => {
        await execute(
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'schedule_sent','Agendamento',$3,'error',$4,'outbound',$5,'failed',$6,$7)",
          [
            uuid(),
            input.userId,
            input.destination,
            JSON.stringify({
              message: input.message,
              platform: input.platform || "",
              reason: input.reason,
              error: input.error || "",
            }),
            input.messageType || "text",
            input.reason,
            input.errorStep,
          ],
        );
      };
      for (const post of pending) {
        const nowMs = Date.now();
        const meta = parseScheduleMetadata(post.metadata);
        const recurrence = normalizeScheduleRecurrence(post.recurrence);
        const dueSlotKey = getDueScheduleSlotKey(
          {
            recurrence: post.recurrence,
            scheduled_at: post.scheduled_at,
            metadata: meta,
          },
          nowMs,
        );
        if (!dueSlotKey) {
          skipped += 1;
          if (recurrence === "none") {
            await execute("UPDATE scheduled_posts SET status='cancelled', updated_at=NOW() WHERE id=$1", [post.id]);
          } else {
            let nextAt = computeNextRecurringScheduleAt(
              {
                recurrence: post.recurrence,
                scheduled_at: post.scheduled_at,
                metadata: meta,
              },
              nowMs,
            );
            const nextAtMs = Date.parse(nextAt);
            if (!Number.isFinite(nextAtMs) || nextAtMs <= nowMs) {
              nextAt = new Date(nowMs + 60_000).toISOString();
            }
            await execute("UPDATE scheduled_posts SET status='pending', scheduled_at=$1, updated_at=NOW() WHERE id=$2", [nextAt, post.id]);
          }
          continue;
        }

        const mgids = Array.isArray(meta.masterGroupIds)
          ? meta.masterGroupIds.filter((item): item is string => typeof item === "string")
          : [];
        const directIds = Array.isArray(post.dest_ids) ? post.dest_ids : [];
        let linkedIds = [];
        if (mgids.length > 0) {
          const links = await query<{ group_id: string }>(
            `SELECT l.group_id
               FROM master_group_links l
               JOIN master_groups mg
                 ON mg.id = l.master_group_id
              WHERE l.master_group_id = ANY($1)
                AND l.is_active <> FALSE
                AND mg.user_id = $2`,
            [mgids, post.user_id],
          );
          linkedIds = links.map((l) => l.group_id);
        }
        const destIds = [...new Set([...directIds, ...linkedIds])];
        let message = typeof meta.finalContent === "string" ? meta.finalContent : String(post.content ?? "");
        const rawTemplateId = typeof meta.templateId === "string" ? meta.templateId.trim() : "";
        if (rawTemplateId) {
          const cacheKey = `${post.user_id}:${rawTemplateId}`;
          let templateContent = scheduleTemplateCache.get(cacheKey);
          if (templateContent === undefined) {
            const templateRow = await queryOne<{ content: string }>(
              "SELECT content FROM templates WHERE user_id = $1 AND id = $2",
              [post.user_id, rawTemplateId],
            );
            templateContent = templateRow && typeof templateRow.content === "string"
              ? templateRow.content
              : null;
            scheduleTemplateCache.set(cacheKey, templateContent);
          }
          const templateData = parseScheduleTemplateData(meta);
          if (templateContent && Object.keys(templateData).length > 0) {
            message = applyPlaceholders(templateContent, templateData);
          }
        }
        let scheduleMedia = parseScheduledPostMedia(meta);
        const requiresScheduleImage = scheduleRequiresMandatoryImage(meta);
        if (!scheduleMedia && requiresScheduleImage) {
          const productImageUrl = extractScheduleProductImageUrl(meta);
          if (productImageUrl) {
            try {
              scheduleMedia = await buildAutomationImageMedia({ imageUrl: productImageUrl });
            } catch {
              scheduleMedia = null;
            }
          }
        }

        if (destIds.length === 0) {
          skipped += 1;
          const cancelledMeta = markScheduledPostMediaCleanup(meta, nowMs);
          await execute(
            "UPDATE scheduled_posts SET status='cancelled', metadata=$1::jsonb, updated_at=NOW() WHERE id=$2",
            [JSON.stringify(cancelledMeta), post.id],
          );
          scheduleScheduledPostMediaCleanup({
            userId: String(post.user_id),
            postId: String(post.id),
            metadata: cancelledMeta,
          });
          await insertScheduleFailedHistory({
            userId: String(post.user_id),
            destination: String(post.id),
            message,
            reason: "no_destination_groups",
            errorStep: "route_targets",
            error: "Agendamento cancelado: nenhum destino válido.",
            messageType: scheduleMedia ? "image" : "text",
          });
          continue;
        }

        if (requiresScheduleImage && !scheduleMedia) {
          failed += 1;
          skipped += 1;
          const cancelledMeta = markScheduledPostMediaCleanup(meta, nowMs);
          await execute(
            "UPDATE scheduled_posts SET status='cancelled', metadata=$1::jsonb, updated_at=NOW() WHERE id=$2",
            [JSON.stringify(cancelledMeta), post.id],
          );
          scheduleScheduledPostMediaCleanup({
            userId: String(post.user_id),
            postId: String(post.id),
            metadata: cancelledMeta,
          });
          await execute(
            "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'schedule_sent','Agendamento',$3,'warning',$4,'outbound','text','blocked','missing_image_required','media_requirements')",
            [uuid(), post.user_id, String(post.id), JSON.stringify({
              message,
              reason: "missing_image_required",
              requiresImage: true,
              hasMedia: false,
            })],
          );
          continue;
        }

        let ok_ = true;
        let postSentCount = 0;
        // Batch load all destination groups in one query (avoids N+1)
        const groupRows = destIds.length > 0
          ? await query("SELECT id, name, platform, session_id, external_id FROM groups WHERE id = ANY($1) AND user_id = $2", [destIds, post.user_id])
          : [];
        const groupMap = new Map(groupRows.map((g) => [g.id, g]));
        for (const gid of destIds) {
          const g = groupMap.get(gid);
          if (!g) {
            ok_ = false;
            failed += 1;
            await insertScheduleFailedHistory({
              userId: String(post.user_id),
              destination: String(gid),
              message,
              reason: "destination_not_found",
              errorStep: "destination_lookup",
              error: `Grupo destino não encontrado: ${gid}`,
              messageType: scheduleMedia ? "image" : "text",
            });
            break;
          }

          const platform = String(g.platform ?? "");
          const session = String(g.session_id ?? "");
          const externalId = String(g.external_id ?? "");
          if (!session || !externalId) {
            ok_ = false;
            failed += 1;
            await insertScheduleFailedHistory({
              userId: String(post.user_id),
              destination: String(g.name || gid),
              message,
              platform,
              reason: "destination_session_offline",
              errorStep: "destination_válidation",
              error: "Sessão do destino offline ou grupo sem identificador externo.",
              messageType: scheduleMedia ? "image" : "text",
            });
            break;
          }

          const scopedHeaders = buildUserScopedHeaders(String(post.user_id));
          const mediaForDestination = await resolveRouteForwardMediaForPlatform({
            userId: String(post.user_id),
            platform,
            media: scheduleMedia,
          });
          if (requiresScheduleImage && !mediaForDestination) {
            ok_ = false;
            failed += 1;
            await execute(
              "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'schedule_sent','Agendamento',$3,'warning',$4,'outbound','text','blocked','missing_image_required','media_requirements')",
              [uuid(), post.user_id, g.name, JSON.stringify({
                message,
                platform,
                reason: "missing_image_required",
                requiresImage: true,
                hasMedia: false,
              })],
            );
            break;
          }
          const outboundMessage = formatMessageForDestinationPlatform(message, platform) || " ";
          let sentResult = { data: null, error: { message: "Plataforma inválida" } };
          if (platform === "whatsapp" && WHATSAPP_URL) {
            sentResult = await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", {
              sessionId: session,
              jid: externalId,
              content: outboundMessage,
              media: mediaForDestination ?? undefined,
            }, scopedHeaders);
          } else if (platform === "telegram" && TELEGRAM_URL) {
            sentResult = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/send-message", "POST", {
              sessionId: session,
              chatId: externalId,
              message: outboundMessage,
              media: mediaForDestination ?? undefined,
            }, scopedHeaders);
          } else {
            sentResult = { data: null, error: { message: `Serviço ${platform || "desconhecido"} indisponível` } };
          }
          if (sentResult.error) {
            ok_ = false;
            failed += 1;
            await insertScheduleFailedHistory({
              userId: String(post.user_id),
              destination: String(g.name || gid),
              message,
              platform,
              reason: "destination_send_failed",
              errorStep: "send_message",
              error: String(sentResult.error.message || "Falha ao enviar para o destino."),
              messageType: mediaForDestination ? "image" : "text",
            });
            break;
          }

          await execute("INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'schedule_sent','Agendamento',$3,'success',$4,'outbound',$5,'sent','','')",
            [uuid(), post.user_id, g.name, JSON.stringify({ message, platform: g.platform, hasMedia: !!mediaForDestination }), mediaForDestination ? "image" : "text"]);
          sent++;
          postSentCount += 1;
        }
        if (!ok_) {
          const cancelledMeta = markScheduledPostMediaCleanup(meta, nowMs);
          await execute(
            "UPDATE scheduled_posts SET status='cancelled', metadata=$1::jsonb, updated_at=NOW() WHERE id=$2",
            [JSON.stringify(cancelledMeta), post.id],
          );
          scheduleScheduledPostMediaCleanup({
            userId: String(post.user_id),
            postId: String(post.id),
            metadata: cancelledMeta,
          });
        } else if (recurrence !== "none") {
          const mergedMeta = {
            ...meta,
            lastDispatchSlot: dueSlotKey,
          };
          let nextAt = computeNextRecurringScheduleAt(
            {
              recurrence: post.recurrence,
              scheduled_at: post.scheduled_at,
              metadata: mergedMeta,
            },
            nowMs,
          );
          const nextAtMs = Date.parse(nextAt);
          if (!Number.isFinite(nextAtMs) || nextAtMs <= nowMs) {
            nextAt = new Date(nowMs + 60_000).toISOString();
          }
          await execute("UPDATE scheduled_posts SET status='pending', scheduled_at=$1, metadata=$2::jsonb, updated_at=NOW() WHERE id=$3", [nextAt, JSON.stringify(mergedMeta), post.id]);
        } else {
          const sentMeta = markScheduledPostMediaCleanup(meta, nowMs);
          await execute(
            "UPDATE scheduled_posts SET status='sent', metadata=$1::jsonb, updated_at=NOW() WHERE id=$2",
            [JSON.stringify(sentMeta), post.id],
          );
          scheduleScheduledPostMediaCleanup({
            userId: String(post.user_id),
            postId: String(post.id),
            metadata: sentMeta,
          });
        }

        if (postSentCount > 0) {
          await scheduleRouteForwardMediaDeletion({
            userId: String(post.user_id),
            media: scheduleMedia,
            delayMs: 120_000,
          });
        }
      }
      ok(res, { ok: true, source: String(params.source ?? "frontend"), scanned: pending.length, processed: pending.length, sent, failed, skipped }); return;
    }

    // â”€â”€ route-process-message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "route-process-message") {
      const sessionId = String(params.sessionId ?? "");
      const sourceExternalId = String(params.groupId ?? params.sourceExternalId ?? "");
      const sourceName = String(params.groupName ?? params.sourceName ?? "Grupo");
      const message = String(params.message ?? "");
      if (!sessionId || !sourceExternalId || !message) { fail(res, "sessionId, groupId e message são obrigatórios"); return; }
      const processed = await processRouteMessageForUser({
        userId,
        sessionId,
        sourceExternalId,
        sourceName,
        message,
      });
      ok(res, { ok: true, dispatched: processed.dispatched, routesMatched: processed.routesMatched }); return;
    }

    // â”€â”€ shopee handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "shopee-service-health") {
      if (!SHOPEE_URL) {
        ok(res, {
          online: false,
          url: "",
          uptimeSec: null,
          error: "Shopee microservice não configurado.",
          service: "shopee-affiliate",
          stats: null,
        });
        return;
      }
      const r = await proxyMicroservice(SHOPEE_URL, "/health", "GET", null);
      if (r.error) {
        ok(res, {
          online: false,
          url: SHOPEE_URL,
          uptimeSec: null,
          error: r.error.message,
          service: "shopee-affiliate",
          stats: null,
        });
        return;
      }
      const payload: Record<string, unknown> = (r.data && typeof r.data === "object")
        ? (r.data as Record<string, unknown>)
        : {};
      ok(res, {
        online: payload.ok === true || payload.online === true,
        url: SHOPEE_URL,
        uptimeSec: Number.isFinite(Number(payload.uptimeSec)) ? Number(payload.uptimeSec) : null,
        error: null,
        service: String(payload.service || "shopee-affiliate"),
        stats: (payload.stats && typeof payload.stats === "object") ? payload.stats : null,
      });
      return;
    }
    if (funcName === "shopee-test-connection") {
      if (!SHOPEE_URL) { ok(res, { success: false, reason: "Shopee microservice não configurado.", region: "BR" }); return; }
      const cred = await queryOne("SELECT app_id, secret_key, region FROM api_credentials WHERE user_id=$1 AND provider='shopee'", [userId]);
      if (!cred) { ok(res, { success: false, reason: "Credenciais Shopee não configuradas.", region: "BR" }); return; }
      const fallbackRegion = String(cred.region || "BR").toUpperCase();
      const shopeeHeaders = buildUserScopedHeaders(userId);
      const r = await proxyMicroservice(
        SHOPEE_URL,
        "/api/shopee/test-connection",
        "POST",
        { appId: cred.app_id, secret: cred.secret_key, region: cred.region },
        shopeeHeaders,
        30_000,
      );
      if (r.error) {
        ok(res, { success: false, reason: r.error.message || "Falha na conexão", region: fallbackRegion });
        return;
      }
      const payload: Record<string, unknown> = (r.data && typeof r.data === "object")
        ? (r.data as Record<string, unknown>)
        : {};
      const success = payload.success === true || payload.connected === true;
      const region = String(payload.region || fallbackRegion || "BR").toUpperCase();
      const reason = String(payload.reason || payload.error || payload.message || "Falha na conexão");
      ok(res, success ? { success: true, region } : { success: false, reason, region });
      return;
    }
    if (funcName === "shopee-convert-link") {
      if (!SHOPEE_URL) { fail(res, "Shopee microservice não configurado."); return; }
      const cred = await queryOne("SELECT app_id, secret_key, region FROM api_credentials WHERE user_id=$1 AND provider='shopee'", [userId]);
      if (!cred) { fail(res, "Credenciais Shopee não configuradas."); return; }
      const sourceUrl = String(params.url ?? params.link ?? "").trim();
      if (!sourceUrl) { fail(res, "URL Shopee obrigatoria"); return; }
      if (sourceUrl.length > MAX_URL_LENGTH) { fail(res, "URL Shopee excede o tamanho maximo permitido"); return; }
      if (!isShopeeProductUrlLike(sourceUrl)) { fail(res, "URL informada não parece ser da Shopee"); return; }
      const shopeeHeaders = buildUserScopedHeaders(userId);
      const r = await proxyMicroservice(SHOPEE_URL, "/api/shopee/convert-link", "POST", {
        url: sourceUrl,
        appId: cred.app_id,
        secret: cred.secret_key,
        region: cred.region,
      }, shopeeHeaders, 30_000);
      if (r.error) { fail(res, r.error.message); return; }
      ok(res, r.data); return;
    }
    if (funcName === "shopee-convert-links") {
      if (!SHOPEE_URL) { fail(res, "Shopee microservice não configurado."); return; }
      const cred = await queryOne("SELECT app_id, secret_key, region FROM api_credentials WHERE user_id=$1 AND provider='shopee'", [userId]);
      if (!cred) { fail(res, "Credenciais Shopee não configuradas."); return; }
      const urlsRaw = Array.isArray(params.urls) ? params.urls : (Array.isArray(params.links) ? params.links : []);
      const urls = urlsRaw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      const dedupedUrls: string[] = [...new Set<string>(urls)];
      if (dedupedUrls.length === 0) { fail(res, "Lista de URLs Shopee obrigatoria"); return; }
      if (dedupedUrls.length > MAX_SHOPEE_CONVERT_BATCH) { fail(res, `Limite de ${MAX_SHOPEE_CONVERT_BATCH} URLs por lote Shopee`); return; }
      if (dedupedUrls.some((item) => item.length > MAX_URL_LENGTH)) { fail(res, "Uma ou mais URLs excedem o tamanho maximo permitido"); return; }
      if (dedupedUrls.some((item) => !isShopeeProductUrlLike(item))) { fail(res, "Uma ou mais URLs não parecem ser da Shopee"); return; }
      const shopeeHeaders = buildUserScopedHeaders(userId);

      const conversions = [];
      for (const originalLink of dedupedUrls) {
        const r = await proxyMicroservice(SHOPEE_URL, "/api/shopee/convert-link", "POST", {
          url: originalLink,
          appId: cred.app_id,
          secret: cred.secret_key,
          region: cred.region,
        }, shopeeHeaders, 30_000);
        if (r.error) {
          conversions.push({
            originalLink,
            resolvedLink: originalLink,
            affiliateLink: originalLink,
            usedService: false,
            product: null,
            error: r.error.message,
          });
          continue;
        }
        const payload = (r.data && typeof r.data === "object") ? r.data as Record<string, unknown> : {};
        conversions.push({
          originalLink,
          resolvedLink: String(payload.resolvedUrl ?? originalLink),
          affiliateLink: String(payload.affiliateLink ?? originalLink),
          usedService: true,
          product: payload.product ?? null,
          error: null,
        });
      }
      ok(res, { conversions }); return;
    }
    if (funcName === "shopee-batch") {
      if (!SHOPEE_URL) { fail(res, "Shopee microservice não configurado."); return; }
      const cred = await queryOne("SELECT app_id, secret_key, region FROM api_credentials WHERE user_id=$1 AND provider='shopee'", [userId]);
      if (!cred) { fail(res, "Credenciais Shopee não configuradas."); return; }
      const queries = Array.isArray(params.queries) ? params.queries : [];
      if (queries.length > MAX_SHOPEE_BATCH_QUERIES) {
        fail(res, `Limite de ${MAX_SHOPEE_BATCH_QUERIES} consultas por lote Shopee`);
        return;
      }
      const shopeeHeaders = buildUserScopedHeaders(userId);
      const r = await proxyMicroservice(
        SHOPEE_URL,
        "/api/shopee/batch",
        "POST",
        { ...params, appId: cred.app_id, secret: cred.secret_key, region: cred.region },
        shopeeHeaders,
        120_000,
      );
      if (r.error) { fail(res, r.error.message); return; }
      ok(res, r.data); return;
    }
    if (funcName === "shopee-automation-run") {
      if (!SHOPEE_URL) { fail(res, "Shopee microservice não configurado."); return; }
      if (!WHATSAPP_URL && !TELEGRAM_URL) {
        fail(res, "Nenhum canal de envio configurado (WhatsApp/Telegram).");
        return;
      }
      const requestedAutomationId = String(params.automationId ?? "").trim();
      const source = String(params.source ?? "manual").trim() || "manual";
      const runAllUsers = isService || (effectiveAdmin && !userIsAdmin && params.allUsers === true);
      const limit = Math.max(1, Math.min(toInt(params.limit, runAllUsers ? 120 : 30), runAllUsers ? 300 : 100));

      const dueClause = `
        status = 'active' AND is_active = TRUE
        AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'shopee'
        AND (
          last_run_at IS NULL
          OR last_run_at <= NOW() - (GREATEST(COALESCE(interval_minutes, 1), 1) * INTERVAL '1 minute')
        )
      `;

      const automations = requestedAutomationId
        ? (runAllUsers
            ? await query(
                "SELECT * FROM shopee_automations WHERE id = $1 AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'shopee' LIMIT 1",
                [requestedAutomationId],
              )
            : await query(
                "SELECT * FROM shopee_automations WHERE id = $1 AND user_id = $2 AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'shopee' LIMIT 1",
                [requestedAutomationId, userId],
              ))
        : (runAllUsers
            ? await query(
                `SELECT * FROM shopee_automations
                 WHERE ${dueClause}
                 ORDER BY COALESCE(last_run_at, to_timestamp(0)) ASC
                 LIMIT $1`,
                [limit],
              )
            : await query(
                `SELECT * FROM shopee_automations
                 WHERE user_id = $1 AND ${dueClause}
                 ORDER BY COALESCE(last_run_at, to_timestamp(0)) ASC
                 LIMIT $2`,
                [userId, limit],
              ));

      if (requestedAutomationId && automations.length === 0) { fail(res, "Automação não encontrada"); return; }
      if (automations.length === 0) {
        ok(res, {
          ok: true,
          source,
          scope: runAllUsers ? "global" : "user",
          active: 0,
          processed: 0,
          sent: 0,
          skipped: 0,
          failed: 0,
          errors: [],
          message: "Nenhuma automação elegível para execução neste ciclo.",
        });
        return;
      }

      const uniqueUserIds = [...new Set(automations.map((row) => String(row.user_id || "").trim()).filter(Boolean))];
      const credRows = uniqueUserIds.length > 0
        ? await query<{ user_id: string; app_id: string; secret_key: string; region: string }>(
            "SELECT user_id, app_id, secret_key, region FROM api_credentials WHERE provider='shopee' AND user_id = ANY($1)",
            [uniqueUserIds],
          )
        : [];
      const credsByUser = new Map(credRows.map((row) => [String(row.user_id), row]));

      let processed = 0;
      let sent = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const auto of automations) {
        const ownerUserId = String(auto.user_id || "").trim();
        const automationName = String(auto.name || auto.id || "Automação Shopee");
        const automationId = String(auto.id || "").trim();
        if (!ownerUserId || !automationId) {
          skipped += 1;
          errors.push(`${automationName}: dados da automação inválidos`);
          continue;
        }

        if (!inAutomationTimeWindow(auto.active_hours_start, auto.active_hours_end)) {
          skipped += 1;
          continue;
        }

        const cred = credsByUser.get(ownerUserId);
        if (!cred) {
          skipped += 1;
          errors.push(`${automationName}: credenciais Shopee ausentes`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "warning",
            processingStatus: "blocked",
            message: "Credenciais Shopee ausentes para execução da automação.",
            details: { automationId, source, reason: "missing_credentials" },
            blockReason: "missing_credentials",
            errorStep: "automation_setup",
          });
          continue;
        }

        const claimed = await queryOne<Record<string, unknown>>(
          `UPDATE shopee_automations
             SET last_run_at = NOW(),
                 updated_at = NOW()
           WHERE id = $1
             AND user_id = $2
             AND status = 'active'
             AND is_active = TRUE
             AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'shopee'
             AND (
               last_run_at IS NULL
               OR last_run_at <= NOW() - (GREATEST(COALESCE(interval_minutes, 1), 1) * INTERVAL '1 minute')
             )
           RETURNING *`,
          [automationId, ownerUserId],
        );
        if (!claimed) {
          skipped += 1;
          continue;
        }

        const automationConfig = claimed.config && typeof claimed.config === "object" && !Array.isArray(claimed.config)
          ? claimed.config as Record<string, unknown>
          : {};
        const offerSourceMode = normalizeAutomationOfferSourceMode(automationConfig.offerSourceMode);
        const vitrineTabs = normalizeAutomationVitrineTabs(automationConfig.vitrineTabs);

        const templateIdRaw = claimed.template_id == null ? "" : String(claimed.template_id);
        const templateId = isUuid(templateIdRaw) ? templateIdRaw : "";
        const template = await queryOne<{ id: string; name: string; content: string; is_default: boolean }>(
          `SELECT id, name, content, is_default
             FROM templates
            WHERE user_id = $1
              AND ($2::uuid IS NULL OR id = $2 OR is_default = TRUE)
            ORDER BY CASE WHEN id = $2 THEN 0 WHEN is_default = TRUE THEN 1 ELSE 2 END
            LIMIT 1`,
          [ownerUserId, templateId || null],
        );

        const queries = buildShopeeAutomationQueries({
          categories: claimed.categories,
          automationName,
          sourceMode: offerSourceMode,
          vitrineTabs,
        });

        const batchResult = await proxyMicroservice(
          SHOPEE_URL,
          "/api/shopee/batch",
          "POST",
          {
            appId: cred.app_id,
            secret: cred.secret_key,
            region: cred.region,
            queries,
          },
          buildUserScopedHeaders(ownerUserId),
          120_000,
        );
        if (batchResult.error) {
          failed += 1;
          errors.push(`${automationName}: ${batchResult.error.message}`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "error",
            processingStatus: "failed",
            message: `Falha ao buscar ofertas Shopee: ${batchResult.error.message}`,
            details: { automationId, source, reason: "offer_lookup_failed" },
            blockReason: "offer_lookup_failed",
            errorStep: "offer_lookup",
          });
          continue;
        }

        const batchPayload = (batchResult.data && typeof batchResult.data === "object")
          ? batchResult.data as Record<string, unknown>
          : {};
        const batchResults = (batchPayload.results && typeof batchPayload.results === "object")
          ? batchPayload.results as Record<string, unknown>
          : {};

        const minDiscount = Math.max(0, toNumber(claimed.min_discount, 0));
        const minPrice = Math.max(0, toNumber(claimed.min_price, 0));
        const maxPriceRaw = Math.max(0, toNumber(claimed.max_price, 999999));
        const maxPrice = maxPriceRaw > 0 ? maxPriceRaw : 999999;
        const positiveKeywords = toRouteKeywordList(automationConfig.positiveKeywords);
        const negativeKeywords = toRouteKeywordList(automationConfig.negativeKeywords);

        const candidates: Record<string, unknown>[] = [];
        for (const result of Object.values(batchResults)) {
          const row = (result && typeof result === "object") ? result as Record<string, unknown> : {};
          const products = Array.isArray(row.products) ? row.products : [];
          for (const product of products) {
            if (!product || typeof product !== "object") continue;
            const item = product as Record<string, unknown>;
            const salePrice = Math.max(0, toNumber(item.salePrice, 0));
            const discount = Math.max(0, toNumber(item.discount, 0));
            const affiliateLink = extractValidShopeeAffiliateLink(item);
            const productText = buildAutomationProductKeywordText(item);
            if (!affiliateLink) continue;
            if (discount < minDiscount) continue;
            if (salePrice < minPrice) continue;
            if (salePrice > maxPrice) continue;
            if (negativeKeywords.length > 0 && routeTextMatchesAnyKeyword(productText, negativeKeywords)) continue;
            if (positiveKeywords.length > 0 && !routeTextMatchesAnyKeyword(productText, positiveKeywords)) continue;
            candidates.push(item);
          }
        }

        if (candidates.length === 0) {
          skipped += 1;
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "warning",
            processingStatus: "blocked",
            message: "Nada compatível com seus filtros agora. Vamos tentar de novo no próximo ciclo.",
            details: {
              automationId,
              source,
              reason: "no_eligible_offer",
              positiveKeywordsCount: positiveKeywords.length,
              negativeKeywordsCount: negativeKeywords.length,
            },
            blockReason: "no_eligible_offer",
            errorStep: "offer_filter",
          });
          continue;
        }

        const recentOfferTitles = await loadRecentAutomationOfferTitleSet({
          userId: ownerUserId,
          automationId,
          automationName,
        });
        let duplicateRejectedCount = 0;
        let selectedProduct: Record<string, unknown> | null = null;
        for (const candidate of candidates) {
          const normalizedTitle = normalizeOfferTitle(candidate.title);
          if (normalizedTitle && recentOfferTitles.has(normalizedTitle)) {
            duplicateRejectedCount += 1;
            continue;
          }
          selectedProduct = candidate;
          break;
        }
        if (!selectedProduct) {
          skipped += 1;
          errors.push(`${automationName}: sem nova oferta disponível (duplicadas descartadas: ${duplicateRejectedCount})`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "warning",
            processingStatus: "blocked",
            message: "Sem oferta nova agora. As opções disponíveis já foram enviadas recentemente.",
            details: {
              automationId,
              source,
              reason: "offer_duplicate_blocked",
              duplicateRejectedCount,
              recentMemorySize: recentOfferTitles.size,
            },
            blockReason: "offer_duplicate_blocked",
            errorStep: "offer_dedupe",
          });
          continue;
        }

        const affiliateLink = extractValidShopeeAffiliateLink(selectedProduct);
        if (!affiliateLink) {
          skipped += 1;
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "warning",
            processingStatus: "blocked",
            message: "Encontramos uma oferta, mas ela veio sem link de afiliado válido.",
            details: { automationId, source, reason: "missing_affiliate_link" },
            blockReason: "missing_affiliate_link",
            errorStep: "offer_válidate",
          });
          continue;
        }

        const templateContent = template && typeof template.content === "string" ? template.content : "";
        const fallbackTitle = String(selectedProduct.title || "Oferta Shopee");
        const message = templateContent
          ? buildShopeeAutomationMessage(templateContent, selectedProduct, affiliateLink)
          : `${fallbackTitle}\n${affiliateLink}`;

        const directGroupIds = toStringArray(claimed.destination_group_ids);
        const masterGroupIds = toStringArray(claimed.master_group_ids);
        const linkedGroupIds = masterGroupIds.length > 0
          ? (await query<{ group_id: string }>(
              `SELECT l.group_id
                 FROM master_group_links l
                 JOIN master_groups mg
                   ON mg.id = l.master_group_id
                WHERE l.master_group_id = ANY($1)
                  AND l.is_active <> FALSE
                  AND mg.user_id = $2`,
              [masterGroupIds, ownerUserId],
            )).map((row) => String(row.group_id || "").trim()).filter(Boolean)
          : [];

        const destinationIds = [...new Set([...directGroupIds, ...linkedGroupIds])];
        if (destinationIds.length === 0) {
          failed += 1;
          errors.push(`${automationName}: nenhum grupo de destino configurado`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "error",
            processingStatus: "failed",
            message: "Automação sem grupos de destino configurados.",
            details: { automationId, source, reason: "no_destination_groups" },
            blockReason: "no_destination_groups",
            errorStep: "destination_resolve",
          });
          continue;
        }

        const allDestinationGroups = await query<{
          id: string;
          name: string;
          platform: string;
          session_id: string;
          external_id: string;
        }>(
          "SELECT id, name, platform, session_id, external_id FROM groups WHERE user_id = $1 AND id = ANY($2)",
          [ownerUserId, destinationIds],
        );
        const automationSessionId = String(claimed.session_id || "").trim();
        const destinationGroups = automationSessionId
          ? allDestinationGroups.filter((group) => String(group.session_id || "").trim() === automationSessionId)
          : allDestinationGroups;

        if (destinationGroups.length === 0) {
          failed += 1;
          errors.push(`${automationName}: nenhum grupo de destino válido para a sessão configurada`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "error",
            processingStatus: "failed",
            message: "Nenhum grupo válido para a sessão selecionada.",
            details: { automationId, source, reason: "no_destination_groups_for_session" },
            blockReason: "no_destination_groups_for_session",
            errorStep: "destination_resolve",
          });
          continue;
        }

        let automationMedia: RouteForwardMedia | null = null;
        try {
          automationMedia = await buildAutomationImageMedia(selectedProduct);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Envio cancelado: falha ao anexar imagem.";
          failed += destinationGroups.length;
          errors.push(`${automationName}: ${reason}`);
          for (const group of destinationGroups) {
            const groupName = String(group.name || group.id || "Grupo");
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "warning",
              processingStatus: "blocked",
              message,
              details: {
                automationId,
                source,
                platform: String(group.platform || ""),
                reason: "missing_image_required",
                mediaError: reason,
                product: selectedProduct,
                hasMedia: false,
              },
              blockReason: "missing_image_required",
              errorStep: "automation_media_failed",
              messageType: "text",
            });
          }
          continue;
        }

        const waSessionIds = [...new Set(
          destinationGroups
            .filter((group) => String(group.platform || "").trim() === "whatsapp")
            .map((group) => String(group.session_id || "").trim())
            .filter(Boolean),
        )];
        const tgSessionIds = [...new Set(
          destinationGroups
            .filter((group) => String(group.platform || "").trim() === "telegram")
            .map((group) => String(group.session_id || "").trim())
            .filter(Boolean),
        )];
        const [waSessionRows, tgSessionRows] = await Promise.all([
          waSessionIds.length > 0
            ? query<{ id: string; status: string }>(
                "SELECT id, status FROM whatsapp_sessions WHERE user_id = $1 AND id = ANY($2)",
                [ownerUserId, waSessionIds],
              )
            : Promise.resolve([]),
          tgSessionIds.length > 0
            ? query<{ id: string; status: string }>(
                "SELECT id, status FROM telegram_sessions WHERE user_id = $1 AND id = ANY($2)",
                [ownerUserId, tgSessionIds],
              )
            : Promise.resolve([]),
        ]);
        const onlineWaSessions = new Set(
          waSessionRows
            .filter((row) => isSessionOnlineStatus(row.status))
            .map((row) => String(row.id || "").trim())
            .filter(Boolean),
        );
        const onlineTgSessions = new Set(
          tgSessionRows
            .filter((row) => isSessionOnlineStatus(row.status))
            .map((row) => String(row.id || "").trim())
            .filter(Boolean),
        );

        let sentNow = 0;
        for (const group of destinationGroups) {
          const groupName = String(group.name || group.id || "Grupo");
          const platform = String(group.platform || "").trim();
          const sessionId = String(group.session_id || "").trim();
          const externalId = String(group.external_id || "").trim();
          if (!sessionId || !externalId) {
            failed += 1;
            errors.push(`${automationName} -> ${groupName}: grupo sem sessão/external_id`);
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "error",
              processingStatus: "failed",
              message,
              details: {
                automationId,
                source,
                platform,
                reason: "invalid_destination",
              },
              blockReason: "invalid_destination",
              errorStep: "destination_válidate",
            });
            continue;
          }

          const isOnline = platform === "whatsapp"
            ? onlineWaSessions.has(sessionId)
            : platform === "telegram"
              ? onlineTgSessions.has(sessionId)
              : false;
          if (!isOnline) {
            skipped += 1;
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "info",
              processingStatus: "blocked",
              message,
              details: {
                automationId,
                source,
                platform,
                reason: "destination_session_offline",
              },
              blockReason: "destination_session_offline",
              errorStep: "destination_precheck",
            });
            continue;
          }

          const scopedHeaders = buildUserScopedHeaders(ownerUserId);
          const mediaForDestination = await resolveRouteForwardMediaForPlatform({
            userId: ownerUserId,
            platform,
            media: automationMedia,
          });
          if (!mediaForDestination) {
            failed += 1;
            errors.push(`${automationName} -> ${groupName}: imagem obrigatoria ausente`);
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "warning",
              processingStatus: "blocked",
              message,
              details: {
                automationId,
                source,
                platform,
                reason: "missing_image_required",
                product: selectedProduct,
                hasMedia: false,
              },
              blockReason: "missing_image_required",
              errorStep: "media_requirements",
              messageType: "text",
            });
            continue;
          }
          const outboundMessage = formatMessageForDestinationPlatform(message, platform) || " ";
          const sendResult = platform === "whatsapp" && WHATSAPP_URL
            ? await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", {
                sessionId,
                jid: externalId,
                content: outboundMessage,
                media: mediaForDestination,
              }, scopedHeaders)
            : platform === "telegram" && TELEGRAM_URL
              ? await proxyMicroservice(TELEGRAM_URL, "/api/telegram/send-message", "POST", {
                  sessionId,
                  chatId: externalId,
                  message: outboundMessage,
                  media: mediaForDestination,
                }, scopedHeaders)
              : { data: null, error: { message: `Plataforma ${platform || "desconhecida"} indisponível` } };

          if (sendResult.error) {
            failed += 1;
            errors.push(`${automationName} -> ${groupName}: ${sendResult.error.message}`);
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "error",
              processingStatus: "failed",
              message,
              details: {
                automationId,
                source,
                platform,
                reason: "destination_send_failed",
                error: sendResult.error.message,
                product: selectedProduct,
                hasMedia: true,
              },
              blockReason: "destination_send_failed",
              errorStep: "automation_send",
              messageType: "image",
            });
            continue;
          }

          sent += 1;
          sentNow += 1;
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: groupName,
            status: "success",
            processingStatus: "sent",
            message,
            details: {
              automationId,
              source,
              platform,
              product: selectedProduct,
              hasMedia: true,
            },
            messageType: "image",
          });
        }

        if (sentNow > 0) {
          await scheduleRouteForwardMediaDeletion({
            userId: ownerUserId,
            media: automationMedia,
            delayMs: 120_000,
          });
          processed += 1;
          await execute(
            "UPDATE shopee_automations SET products_sent = products_sent + $1, updated_at = NOW() WHERE id = $2 AND user_id = $3",
            [sentNow, automationId, ownerUserId],
          );
        }
      }

      ok(res, {
        ok: failed === 0,
        source,
        scope: runAllUsers ? "global" : "user",
        active: automations.length,
        processed,
        sent,
        skipped,
        failed,
        errors: errors.slice(0, 30),
      });
      return;
    }

    if (funcName === "meli-automation-run") {
      if (!MELI_URL) { fail(res, "Servico Mercado Livre não configurado."); return; }
      if (!WHATSAPP_URL && !TELEGRAM_URL) {
        fail(res, "Nenhum canal de envio configurado (WhatsApp/Telegram).");
        return;
      }

      const requestedAutomationId = String(params.automationId ?? "").trim();
      const source = String(params.source ?? "manual").trim() || "manual";
      const runAllUsers = isService || (effectiveAdmin && !userIsAdmin && params.allUsers === true);
      const limit = Math.max(1, Math.min(toInt(params.limit, runAllUsers ? 120 : 30), runAllUsers ? 300 : 100));

      const dueClause = `
        status = 'active' AND is_active = TRUE
        AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'meli'
        AND (
          last_run_at IS NULL
          OR last_run_at <= NOW() - (GREATEST(COALESCE(interval_minutes, 1), 1) * INTERVAL '1 minute')
        )
      `;

      const automations = requestedAutomationId
        ? (runAllUsers
            ? await query(
                "SELECT * FROM shopee_automations WHERE id = $1 AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'meli' LIMIT 1",
                [requestedAutomationId],
              )
            : await query(
                "SELECT * FROM shopee_automations WHERE id = $1 AND user_id = $2 AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'meli' LIMIT 1",
                [requestedAutomationId, userId],
              ))
        : (runAllUsers
            ? await query(
                `SELECT * FROM shopee_automations
                 WHERE ${dueClause}
                 ORDER BY COALESCE(last_run_at, to_timestamp(0)) ASC
                 LIMIT $1`,
                [limit],
              )
            : await query(
                `SELECT * FROM shopee_automations
                 WHERE user_id = $1 AND ${dueClause}
                 ORDER BY COALESCE(last_run_at, to_timestamp(0)) ASC
                 LIMIT $2`,
                [userId, limit],
              ));

      if (requestedAutomationId && automations.length === 0) { fail(res, "Automação não encontrada"); return; }
      if (automations.length === 0) {
        ok(res, {
          ok: true,
          source,
          scope: runAllUsers ? "global" : "user",
          active: 0,
          processed: 0,
          sent: 0,
          skipped: 0,
          failed: 0,
          errors: [],
          message: "Nenhuma automação ML elegível para execução neste ciclo.",
        });
        return;
      }

      let processed = 0;
      let sent = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];
      const meliAccessByUser = new Map<string, boolean>();

      for (const auto of automations) {
        const ownerUserId = String(auto.user_id || "").trim();
        const automationName = String(auto.name || auto.id || "Automação Mercado Livre");
        const automationId = String(auto.id || "").trim();
        if (!ownerUserId || !automationId) {
          skipped += 1;
          errors.push(`${automationName}: dados da automação inválidos`);
          continue;
        }

        if (runAllUsers) {
          let ownerHasAccess = meliAccessByUser.get(ownerUserId);
          if (ownerHasAccess === undefined) {
            try {
              const access = await resolveMercadoLivreFeatureAccess(ownerUserId);
              ownerHasAccess = access.allowed;
            } catch {
              ownerHasAccess = false;
            }
            meliAccessByUser.set(ownerUserId, ownerHasAccess);
          }
          if (!ownerHasAccess) {
            skipped += 1;
            continue;
          }
        }

        if (!inAutomationTimeWindow(auto.active_hours_start, auto.active_hours_end)) {
          skipped += 1;
          continue;
        }

        const claimed = await queryOne<Record<string, unknown>>(
          `UPDATE shopee_automations
             SET last_run_at = NOW(),
                 updated_at = NOW()
           WHERE id = $1
             AND user_id = $2
             AND status = 'active'
             AND is_active = TRUE
             AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'meli'
             AND (
               last_run_at IS NULL
               OR last_run_at <= NOW() - (GREATEST(COALESCE(interval_minutes, 1), 1) * INTERVAL '1 minute')
             )
           RETURNING *`,
          [automationId, ownerUserId],
        );
        if (!claimed) {
          skipped += 1;
          continue;
        }

        const automationConfig = claimed.config && typeof claimed.config === "object" && !Array.isArray(claimed.config)
          ? claimed.config as Record<string, unknown>
          : {};
        const configTabs = normalizeMeliAutomationVitrineTabs(automationConfig.vitrineTabs);
        const fallbackTabs = configTabs.length > 0
          ? configTabs
          : normalizeMeliAutomationVitrineTabs(claimed.categories);
        const vitrineTabs = fallbackTabs.length > 0 ? fallbackTabs : ["destaques"];

        const templateIdRaw = claimed.template_id == null ? "" : String(claimed.template_id);
        const templateId = isUuid(templateIdRaw) ? templateIdRaw : "";
        const template = await queryOne<{ id: string; name: string; content: string; is_default: boolean }>(
          `SELECT id, name, content, is_default
             FROM templates
            WHERE user_id = $1
              AND scope = 'meli'
              AND ($2::uuid IS NULL OR id = $2 OR is_default = TRUE)
            ORDER BY CASE WHEN id = $2 THEN 0 WHEN is_default = TRUE THEN 1 ELSE 2 END
            LIMIT 1`,
          [ownerUserId, templateId || null],
        );

        const products = await query<{
          id: string;
          tab_key: string;
          title: string;
          product_url: string;
          image_url: string;
          price_cents: string | number;
          old_price_cents: string | number | null;
          seller: string;
          rating: string | number | null;
          reviews_count: string | number | null;
          installments_text: string;
        }>(
          `SELECT id, tab_key, title, product_url, image_url, price_cents, old_price_cents, seller, rating, reviews_count, installments_text
             FROM meli_vitrine_products
            WHERE is_active = TRUE
              AND tab_key = ANY($1::text[])
            ORDER BY updated_at DESC, collected_at DESC
            LIMIT 600`,
          [vitrineTabs],
        );

        const minPrice = Math.max(0, toNumber(claimed.min_price, 0));
        const maxPriceRaw = Math.max(0, toNumber(claimed.max_price, 999999));
        const maxPrice = maxPriceRaw > 0 ? maxPriceRaw : 999999;
        const positiveKeywords = toRouteKeywordList(automationConfig.positiveKeywords);
        const negativeKeywords = toRouteKeywordList(automationConfig.negativeKeywords);

        const candidates: Record<string, unknown>[] = [];
        for (const row of products) {
          const title = String(row.title || "").trim();
          const productUrl = String(row.product_url || "").trim();
          const imageUrl = String(row.image_url || "").trim();
          const price = Number((Math.max(0, toNumber(row.price_cents, 0)) / 100).toFixed(2));
          const oldPriceRaw = toNumber(row.old_price_cents, 0);
          const oldPrice = oldPriceRaw > 0 ? Number((oldPriceRaw / 100).toFixed(2)) : 0;
          const seller = String(row.seller || "").trim();
          const productText = buildAutomationProductKeywordText({
            title,
            shopName: seller,
          });
          if (!title || !productUrl || !imageUrl || price <= 0) continue;
          if (price < minPrice) continue;
          if (price > maxPrice) continue;
          if (negativeKeywords.length > 0 && routeTextMatchesAnyKeyword(productText, negativeKeywords)) continue;
          if (positiveKeywords.length > 0 && !routeTextMatchesAnyKeyword(productText, positiveKeywords)) continue;

          candidates.push({
            id: String(row.id || ""),
            tab: String(row.tab_key || ""),
            title,
            productUrl,
            imageUrl,
            price,
            oldPrice: oldPrice > 0 ? oldPrice : null,
            seller,
            rating: toNumber(row.rating, 0),
            reviewsCount: Math.max(0, Math.floor(toNumber(row.reviews_count, 0))),
            installmentsText: String(row.installments_text || ""),
          });
        }

        if (candidates.length === 0) {
          skipped += 1;
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "warning",
            processingStatus: "blocked",
            message: "Nada compativel com seus filtros agora. Vamos tentar de novo no proximo ciclo.",
            details: {
              automationId,
              source,
              reason: "no_eligible_offer",
              positiveKeywordsCount: positiveKeywords.length,
              negativeKeywordsCount: negativeKeywords.length,
            },
            blockReason: "no_eligible_offer",
            errorStep: "offer_filter",
          });
          continue;
        }

        const recentOfferTitles = await loadRecentAutomationOfferTitleSet({
          userId: ownerUserId,
          automationId,
          automationName,
        });

        let duplicateRejectedCount = 0;
        let selectedProduct: Record<string, unknown> | null = null;
        for (const candidate of candidates) {
          const normalizedTitle = normalizeOfferTitle(candidate.title);
          if (normalizedTitle && recentOfferTitles.has(normalizedTitle)) {
            duplicateRejectedCount += 1;
            continue;
          }
          selectedProduct = candidate;
          break;
        }

        if (!selectedProduct) {
          skipped += 1;
          errors.push(`${automationName}: sem nova oferta disponível (duplicadas descartadas: ${duplicateRejectedCount})`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "warning",
            processingStatus: "blocked",
            message: "Sem oferta nova agora. As opcoes disponiveis ja foram enviadas recentemente.",
            details: {
              automationId,
              source,
              reason: "offer_duplicate_blocked",
              duplicateRejectedCount,
              recentMemorySize: recentOfferTitles.size,
            },
            blockReason: "offer_duplicate_blocked",
            errorStep: "offer_dedupe",
          });
          continue;
        }

        const configuredMeliSessionId = String(automationConfig.meliSessionId || "").trim();
        const meliSessionId = await resolveRouteMeliSessionId(ownerUserId, configuredMeliSessionId);
        if (!meliSessionId) {
          skipped += 1;
          errors.push(`${automationName}: nenhuma sessão Mercado Livre ativa para conversão`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "warning",
            processingStatus: "blocked",
            message: "Nenhuma sessão Mercado Livre ativa para converter links da automação.",
            details: { automationId, source, reason: "missing_meli_session" },
            blockReason: "missing_meli_session",
            errorStep: "automation_setup",
          });
          continue;
        }

        const scopedSessionId = buildScopedMeliSessionId(ownerUserId, meliSessionId);
        const meliHeaders = buildUserScopedHeaders(ownerUserId);
        const conversion = await proxyMicroservice(
          MELI_URL,
          "/api/meli/convert",
          "POST",
          {
            sessionId: scopedSessionId,
            productUrl: String(selectedProduct.productUrl || "").trim(),
            url: String(selectedProduct.productUrl || "").trim(),
            source: "meli-automation",
          },
          meliHeaders,
          60_000,
        );
        if (conversion.error) {
          failed += 1;
          errors.push(`${automationName}: ${conversion.error.message}`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "error",
            processingStatus: "failed",
            message: `Falha ao converter link Mercado Livre: ${conversion.error.message}`,
            details: { automationId, source, reason: "meli_conversion_failed" },
            blockReason: "meli_conversion_failed",
            errorStep: "link_conversion",
          });
          continue;
        }

        const conversionPayload = (conversion.data && typeof conversion.data === "object")
          ? conversion.data as Record<string, unknown>
          : {};
        const affiliateLink = String(conversionPayload.affiliateLink || "").trim();
        if (!affiliateLink) {
          skipped += 1;
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "warning",
            processingStatus: "blocked",
            message: "Conversão sem link afiliado válido.",
            details: { automationId, source, reason: "missing_affiliate_link" },
            blockReason: "missing_affiliate_link",
            errorStep: "link_conversion",
          });
          continue;
        }

        const templateContent = template && typeof template.content === "string" ? template.content : "";
        const fallbackTitle = String(selectedProduct.title || "Oferta Mercado Livre");
        const message = templateContent
          ? buildMeliAutomationMessage(templateContent, selectedProduct, affiliateLink)
          : `${fallbackTitle}\n${affiliateLink}`;

        const directGroupIds = toStringArray(claimed.destination_group_ids);
        const masterGroupIds = toStringArray(claimed.master_group_ids);
        const linkedGroupIds = masterGroupIds.length > 0
          ? (await query<{ group_id: string }>(
              `SELECT l.group_id
                 FROM master_group_links l
                 JOIN master_groups mg
                   ON mg.id = l.master_group_id
                WHERE l.master_group_id = ANY($1)
                  AND l.is_active <> FALSE
                  AND mg.user_id = $2`,
              [masterGroupIds, ownerUserId],
            )).map((row) => String(row.group_id || "").trim()).filter(Boolean)
          : [];

        const destinationIds = [...new Set([...directGroupIds, ...linkedGroupIds])];
        if (destinationIds.length === 0) {
          failed += 1;
          errors.push(`${automationName}: nenhum grupo de destino configurado`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "error",
            processingStatus: "failed",
            message: "Automação sem grupos de destino configurados.",
            details: { automationId, source, reason: "no_destination_groups" },
            blockReason: "no_destination_groups",
            errorStep: "destination_resolve",
          });
          continue;
        }

        const allDestinationGroups = await query<{
          id: string;
          name: string;
          platform: string;
          session_id: string;
          external_id: string;
        }>(
          "SELECT id, name, platform, session_id, external_id FROM groups WHERE user_id = $1 AND id = ANY($2)",
          [ownerUserId, destinationIds],
        );
        const automationSessionId = String(claimed.session_id || "").trim();
        const destinationGroups = automationSessionId
          ? allDestinationGroups.filter((group) => String(group.session_id || "").trim() === automationSessionId)
          : allDestinationGroups;

        if (destinationGroups.length === 0) {
          failed += 1;
          errors.push(`${automationName}: nenhum grupo de destino válido para a sessão configurada`);
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: "error",
            processingStatus: "failed",
            message: "Nenhum grupo válido para a sessão selecionada.",
            details: { automationId, source, reason: "no_destination_groups_for_session" },
            blockReason: "no_destination_groups_for_session",
            errorStep: "destination_resolve",
          });
          continue;
        }

        let automationMedia: RouteForwardMedia | null = null;
        try {
          automationMedia = await buildAutomationImageMedia(selectedProduct);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Envio cancelado: falha ao anexar imagem.";
          failed += destinationGroups.length;
          errors.push(`${automationName}: ${reason}`);
          for (const group of destinationGroups) {
            const groupName = String(group.name || group.id || "Grupo");
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "warning",
              processingStatus: "blocked",
              message,
              details: {
                automationId,
                source,
                platform: String(group.platform || ""),
                reason: "missing_image_required",
                mediaError: reason,
                product: selectedProduct,
                hasMedia: false,
              },
              blockReason: "missing_image_required",
              errorStep: "automation_media_failed",
              messageType: "text",
            });
          }
          continue;
        }

        const waSessionIds = [...new Set(
          destinationGroups
            .filter((group) => String(group.platform || "").trim() === "whatsapp")
            .map((group) => String(group.session_id || "").trim())
            .filter(Boolean),
        )];
        const tgSessionIds = [...new Set(
          destinationGroups
            .filter((group) => String(group.platform || "").trim() === "telegram")
            .map((group) => String(group.session_id || "").trim())
            .filter(Boolean),
        )];
        const [waSessionRows, tgSessionRows] = await Promise.all([
          waSessionIds.length > 0
            ? query<{ id: string; status: string }>(
                "SELECT id, status FROM whatsapp_sessions WHERE user_id = $1 AND id = ANY($2)",
                [ownerUserId, waSessionIds],
              )
            : Promise.resolve([]),
          tgSessionIds.length > 0
            ? query<{ id: string; status: string }>(
                "SELECT id, status FROM telegram_sessions WHERE user_id = $1 AND id = ANY($2)",
                [ownerUserId, tgSessionIds],
              )
            : Promise.resolve([]),
        ]);
        const onlineWaSessions = new Set(
          waSessionRows
            .filter((row) => isSessionOnlineStatus(row.status))
            .map((row) => String(row.id || "").trim())
            .filter(Boolean),
        );
        const onlineTgSessions = new Set(
          tgSessionRows
            .filter((row) => isSessionOnlineStatus(row.status))
            .map((row) => String(row.id || "").trim())
            .filter(Boolean),
        );

        let sentNow = 0;
        for (const group of destinationGroups) {
          const groupName = String(group.name || group.id || "Grupo");
          const platform = String(group.platform || "").trim();
          const sessionId = String(group.session_id || "").trim();
          const externalId = String(group.external_id || "").trim();
          if (!sessionId || !externalId) {
            failed += 1;
            errors.push(`${automationName} -> ${groupName}: grupo sem sessão/external_id`);
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "error",
              processingStatus: "failed",
              message,
              details: {
                automationId,
                source,
                platform,
                reason: "invalid_destination",
              },
              blockReason: "invalid_destination",
              errorStep: "destination_válidate",
            });
            continue;
          }

          const isOnline = platform === "whatsapp"
            ? onlineWaSessions.has(sessionId)
            : platform === "telegram"
              ? onlineTgSessions.has(sessionId)
              : false;
          if (!isOnline) {
            skipped += 1;
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "info",
              processingStatus: "blocked",
              message,
              details: {
                automationId,
                source,
                platform,
                reason: "destination_session_offline",
              },
              blockReason: "destination_session_offline",
              errorStep: "destination_precheck",
            });
            continue;
          }

          const scopedHeaders = buildUserScopedHeaders(ownerUserId);
          const mediaForDestination = await resolveRouteForwardMediaForPlatform({
            userId: ownerUserId,
            platform,
            media: automationMedia,
          });
          if (!mediaForDestination) {
            failed += 1;
            errors.push(`${automationName} -> ${groupName}: imagem obrigatoria ausente`);
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "warning",
              processingStatus: "blocked",
              message,
              details: {
                automationId,
                source,
                platform,
                reason: "missing_image_required",
                product: selectedProduct,
                hasMedia: false,
              },
              blockReason: "missing_image_required",
              errorStep: "media_requirements",
              messageType: "text",
            });
            continue;
          }

          const outboundMessage = formatMessageForDestinationPlatform(message, platform) || " ";
          const sendResult = platform === "whatsapp" && WHATSAPP_URL
            ? await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", {
                sessionId,
                jid: externalId,
                content: outboundMessage,
                media: mediaForDestination,
              }, scopedHeaders)
            : platform === "telegram" && TELEGRAM_URL
              ? await proxyMicroservice(TELEGRAM_URL, "/api/telegram/send-message", "POST", {
                  sessionId,
                  chatId: externalId,
                  message: outboundMessage,
                  media: mediaForDestination,
                }, scopedHeaders)
              : { data: null, error: { message: `Plataforma ${platform || "desconhecida"} indisponível` } };

          if (sendResult.error) {
            failed += 1;
            errors.push(`${automationName} -> ${groupName}: ${sendResult.error.message}`);
            await insertAutomationHistoryEntry({
              userId: ownerUserId,
              automationName,
              destination: groupName,
              status: "error",
              processingStatus: "failed",
              message,
              details: {
                automationId,
                source,
                platform,
                reason: "destination_send_failed",
                error: sendResult.error.message,
                product: selectedProduct,
                hasMedia: true,
              },
              blockReason: "destination_send_failed",
              errorStep: "automation_send",
              messageType: "image",
            });
            continue;
          }

          sent += 1;
          sentNow += 1;
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: groupName,
            status: "success",
            processingStatus: "sent",
            message,
            details: {
              automationId,
              source,
              platform,
              product: selectedProduct,
              hasMedia: true,
            },
            messageType: "image",
          });
        }

        if (sentNow > 0) {
          await scheduleRouteForwardMediaDeletion({
            userId: ownerUserId,
            media: automationMedia,
            delayMs: 120_000,
          });
          processed += 1;
          await execute(
            "UPDATE shopee_automations SET products_sent = products_sent + $1, updated_at = NOW() WHERE id = $2 AND user_id = $3",
            [sentNow, automationId, ownerUserId],
          );
        }
      }

      ok(res, {
        ok: failed === 0,
        source,
        scope: runAllUsers ? "global" : "user",
        active: automations.length,
        processed,
        sent,
        skipped,
        failed,
        errors: errors.slice(0, 30),
      });
      return;
    }

    // â”€â”€ meli handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "meli-vitrine-sync") {
      const isPrivilegedSync = Boolean(effectiveAdmin || isService);
      if (!isPrivilegedSync && params.force === true) {
        fail(res, "Acesso negado", 403);
        return;
      }

      const source = String(
        params.source
        ?? (isService ? "scheduler" : isPrivilegedSync ? "manual-admin" : "manual-user"),
      ).trim() || (isService ? "scheduler" : isPrivilegedSync ? "manual-admin" : "manual-user");
      const force = isPrivilegedSync && params.force === true;
      const onlyIfStale = isPrivilegedSync
        ? params.onlyIfStale !== false
        : true;

      const result = await syncMeliVitrine({ source, force, onlyIfStale });
      if (!result.success) { fail(res, result.message); return; }
      ok(res, result);
      return;
    }

    if (funcName === "meli-vitrine-list") {
      const payload = await listMeliVitrine({
        tab: params.tab,
        page: params.page,
        limit: params.limit,
      });

      ok(res, payload);
      return;
    }

    if (funcName === "meli-service-health") {
      if (!MELI_URL) {
        ok(res, {
          online: false,
          url: "",
          uptimeSec: null,
          error: "MeLi RPA não configurado.",
          service: "mercadolivre-rpa",
          stats: null,
        });
        return;
      }
      const meliHeaders = { "x-autolinks-user-id": userId };
      const r = await proxyMicroservice(MELI_URL, "/api/meli/health", "GET", null, meliHeaders);
      if (r.error) {
        ok(res, {
          online: false,
          url: MELI_URL,
          uptimeSec: null,
          error: r.error.message,
          service: "mercadolivre-rpa",
          stats: null,
        });
        return;
      }
      const payload: Record<string, unknown> = (r.data && typeof r.data === "object")
        ? (r.data as Record<string, unknown>)
        : {};
      ok(res, {
        online: payload.ok === true || payload.online === true,
        url: MELI_URL,
        uptimeSec: null,
        error: null,
        service: String(payload.service || "mercadolivre-rpa"),
        stats: (payload.stats && typeof payload.stats === "object") ? payload.stats : null,
      });
      return;
    }
    if (funcName === "meli-save-session") {
      if (!MELI_URL) { fail(res, "MeLi RPA não configurado."); return; }

      const sessionId = String(params.sessionId ?? "").trim();
      if (!sessionId) { fail(res, "sessionId e obrigatório"); return; }
      if (!isUuid(sessionId)) { fail(res, "sessionId inválido"); return; }
      if (params.cookies == null) { fail(res, "cookies e obrigatório"); return; }

      const existingSession = await queryOne<{ user_id: string; name: string }>(
        "SELECT user_id, name FROM meli_sessions WHERE id = $1",
        [sessionId],
      );
      if (existingSession && String(existingSession.user_id) !== userId) {
        fail(res, "Sessão ja pertence a outro usuario", 403);
        return;
      }

      const userSessions = await query<{ id: string; name: string }>(
        "SELECT id, name FROM meli_sessions WHERE user_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC",
        [userId],
      );
      const canonicalSessionId = String(userSessions[0]?.id || sessionId).trim();
      const canonicalSessionName = userSessions.find((row) => String(row.id) === canonicalSessionId)?.name || "";
      const staleSessionIds = userSessions
        .map((row) => String(row.id || "").trim())
        .filter((id) => id && id !== canonicalSessionId);

      const scopedSessionId = buildScopedMeliSessionId(userId, canonicalSessionId);
      const meliHeaders = { "x-autolinks-user-id": userId };
      const upstream = await proxyMicroservice(
        MELI_URL,
        "/api/meli/sessions",
        "POST",
        { sessionId: scopedSessionId, cookies: params.cookies },
        meliHeaders,
        45_000,
      );
      if (upstream.error) { fail(res, upstream.error.message); return; }

      const upstreamData: Record<string, unknown> = (upstream.data && typeof upstream.data === "object")
        ? (upstream.data as Record<string, unknown>)
        : {};
      const rawStatus = String(upstreamData.status || "untested").trim().toLowerCase();
      const allowedStatuses = new Set(["active", "expired", "error", "untested", "not_found", "no_affiliate"]);
      const status = allowedStatuses.has(rawStatus) ? rawStatus : "error";
      const accountName = String(upstreamData.accountName || "");
      const mlUserId = String(upstreamData.mlUserId || "");
      const logs = Array.isArray(upstreamData.logs) ? upstreamData.logs : [];
      const inputName = String(params.name ?? "").trim();
      const fallbackName = `Conta ${canonicalSessionId.slice(0, 8)}`;
      const finalName = inputName || String(canonicalSessionName || existingSession?.name || "").trim() || fallbackName;
      const unknownStatusMessage = rawStatus && !allowedStatuses.has(rawStatus)
        ? `Status inválido retornado pelo servico Mercado Livre (${rawStatus})`
        : "";
      const errorMessage = status === "error"
        ? String((upstreamData as { error?: unknown }).error || unknownStatusMessage || "Falha ao salvar cookies")
        : "";

      await execute(
        `INSERT INTO meli_sessions (id, user_id, name, account_name, ml_user_id, status, last_checked_at, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
         ON CONFLICT (id) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             name = EXCLUDED.name,
             account_name = EXCLUDED.account_name,
             ml_user_id = EXCLUDED.ml_user_id,
             status = EXCLUDED.status,
             last_checked_at = EXCLUDED.last_checked_at,
             error_message = EXCLUDED.error_message,
             updated_at = NOW()`,
        [canonicalSessionId, userId, finalName, accountName, mlUserId, status, errorMessage],
      );

      if (staleSessionIds.length > 0) {
        await execute("DELETE FROM meli_sessions WHERE user_id = $1 AND id = ANY($2)", [userId, staleSessionIds]);
        for (const staleSessionId of staleSessionIds) {
          const staleScopedId = buildScopedMeliSessionId(userId, staleSessionId);
          await proxyMicroservice(
            MELI_URL,
            `/api/meli/sessions/${encodeURIComponent(staleScopedId)}`,
            "DELETE",
            null,
            meliHeaders,
            20_000,
          );
        }
      }

      ok(res, {
        success: true,
        sessionId: canonicalSessionId,
        status,
        accountName,
        mlUserId,
        logs,
      });
      return;
    }
    if (funcName === "meli-test-session") {
      if (!MELI_URL) { fail(res, "MeLi RPA não configurado."); return; }

      const sessionId = String(params.sessionId ?? "").trim();
      if (!sessionId) { fail(res, "sessionId e obrigatório"); return; }
      if (!isUuid(sessionId)) { fail(res, "sessionId inválido"); return; }

      const owned = await queryOne<{ id: string }>(
        "SELECT id FROM meli_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, userId],
      );
      if (!owned) { fail(res, "Sessão não encontrada"); return; }

      const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);
      const meliHeaders = { "x-autolinks-user-id": userId };
      const upstream = await proxyMicroservice(
        MELI_URL,
        `/api/meli/sessions/${encodeURIComponent(scopedSessionId)}/test`,
        "POST",
        {},
        meliHeaders,
        45_000,
      );

      if (upstream.error) {
        const transientFailure = isTransientMicroserviceError(upstream.error);
        if (transientFailure) {
          await execute(
            "UPDATE meli_sessions SET last_checked_at=NOW(), error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
            [`Falha temporária ao válidar sessão: ${upstream.error.message}`, sessionId, userId],
          );
        } else {
          await execute(
            "UPDATE meli_sessions SET status='error', last_checked_at=NOW(), error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
            [upstream.error.message, sessionId, userId],
          );
        }
        fail(res, upstream.error.message, transientFailure ? 503 : 502);
        return;
      }

      const upstreamData: Record<string, unknown> = (upstream.data && typeof upstream.data === "object")
        ? (upstream.data as Record<string, unknown>)
        : {};
      const status = String(upstreamData.status || "error");
      const accountName = String(upstreamData.accountName || "");
      const mlUserId = String(upstreamData.mlUserId || "");
      const logs = Array.isArray(upstreamData.logs) ? upstreamData.logs : [];
      const firstErrorLog = logs.find((item) => {
        if (!item || typeof item !== "object") return false;
        const lvl = String((item as { level?: unknown }).level || "").toLowerCase();
        return lvl === "error";
      });
      const errorMessage = status === "active"
        ? ""
        : String(
          (upstreamData as { error?: unknown }).error
          || ((firstErrorLog && typeof firstErrorLog === "object")
            ? (firstErrorLog as { message?: unknown }).message
            : "")
          || "Sessão expirada",
        );

      const transientValidationFailure = isTransientMeliSessionValidationResult({
        status,
        errorMessage,
        logs,
      });
      if (transientValidationFailure) {
        await execute(
          "UPDATE meli_sessions SET last_checked_at=NOW(), error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
          [`Falha temporária ao válidar sessão: ${errorMessage || "instabilidade no serviço Mercado Livre"}`, sessionId, userId],
        );
        fail(res, errorMessage || "Falha temporária ao válidar sessão automaticamente", 503);
        return;
      }

      await execute(
        "UPDATE meli_sessions SET status=$1, account_name=$2, ml_user_id=$3, last_checked_at=NOW(), error_message=$4 WHERE id=$5 AND user_id=$6",
        [status, accountName, mlUserId, errorMessage, sessionId, userId],
      );

      ok(res, {
        status,
        accountName,
        mlUserId,
        errorMessage,
        logs,
      });
      return;
    }
    if (funcName === "meli-list-sessions") {
      const data = await query<{ id: string; name: string; account_name: string; ml_user_id: string; status: string; last_checked_at: string | null; error_message: string; created_at: string }>(
        "SELECT id, name, account_name, ml_user_id, status, last_checked_at, error_message, created_at FROM meli_sessions WHERE user_id=$1 ORDER BY updated_at DESC NULLS LAST, created_at DESC",
        [userId],
      );
      const canonical = data[0] || null;
      const staleSessionIds = data.slice(1).map((row) => String(row.id || "").trim()).filter(Boolean);
      if (staleSessionIds.length > 0) {
        await execute("DELETE FROM meli_sessions WHERE user_id = $1 AND id = ANY($2)", [userId, staleSessionIds]);
        if (MELI_URL) {
          const meliHeaders = { "x-autolinks-user-id": userId };
          for (const staleSessionId of staleSessionIds) {
            const staleScopedId = buildScopedMeliSessionId(userId, staleSessionId);
            await proxyMicroservice(
              MELI_URL,
              `/api/meli/sessions/${encodeURIComponent(staleScopedId)}`,
              "DELETE",
              null,
              meliHeaders,
              20_000,
            );
          }
        }
      }
      ok(res, { sessions: canonical ? [canonical] : [] });
      return;
    }
    if (funcName === "meli-delete-session") {
      const sessionId = String(params.sessionId ?? "").trim();
      if (!sessionId) { fail(res, "sessionId e obrigatório"); return; }
      if (!isUuid(sessionId)) { fail(res, "sessionId inválido"); return; }

      const owned = await queryOne<{ id: string }>(
        "SELECT id FROM meli_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, userId],
      );
      if (!owned) { fail(res, "Sessão não encontrada"); return; }

      let warning: string | null = null;
      if (MELI_URL) {
        const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);
        const meliHeaders = { "x-autolinks-user-id": userId };
        const upstream = await proxyMicroservice(
          MELI_URL,
          `/api/meli/sessions/${encodeURIComponent(scopedSessionId)}`,
          "DELETE",
          {},
          meliHeaders,
          30_000,
        );
        if (upstream.error) warning = upstream.error.message;
      }

      await execute("DELETE FROM meli_sessions WHERE id=$1 AND user_id=$2", [sessionId, userId]);
      ok(res, { success: true, warning });
      return;
    }
    if (funcName === "meli-convert-link") {
      if (!MELI_URL) { fail(res, "MeLi RPA não configurado."); return; }

      const productUrl = String(params.productUrl ?? params.url ?? "").trim();
      const requestedSessionId = String(params.sessionId ?? "").trim();
      if (!productUrl) { fail(res, "URL do produto e obrigatoria"); return; }
      if (productUrl.length > MAX_URL_LENGTH) { fail(res, "URL do produto excede o tamanho maximo permitido"); return; }
      if (!isMercadoLivreProductUrlLike(productUrl)) { fail(res, "URL informada não parece ser do Mercado Livre"); return; }
      const sessionId = await resolveRouteMeliSessionId(userId, requestedSessionId);
      if (!sessionId) { fail(res, "Nenhuma sessão Mercado Livre disponível para conversão."); return; }

      const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);
      const meliHeaders = { "x-autolinks-user-id": userId };
      const upstream = await proxyMicroservice(
        MELI_URL,
        "/api/meli/convert",
        "POST",
        { productUrl, sessionId: scopedSessionId },
        meliHeaders,
        90_000,
      );
      if (upstream.error) { fail(res, upstream.error.message); return; }

      const payload: Record<string, unknown> = (upstream.data && typeof upstream.data === "object")
        ? (upstream.data as Record<string, unknown>)
        : {};
      if (payload.success !== true) {
        fail(res, String(payload.error || "Falha ao converter link do Mercado Livre"));
        return;
      }

      ok(res, {
        success: true,
        originalLink: String(payload.originalUrl || productUrl),
        resolvedLink: String(payload.resolvedUrl || payload.originalUrl || productUrl),
        affiliateLink: String(payload.affiliateLink || productUrl),
        cached: payload.cached === true,
        conversionTimeMs: Number.isFinite(Number(payload.conversionTimeMs))
          ? Number(payload.conversionTimeMs)
          : undefined,
      });
      return;
    }
    if (funcName === "meli-product-snapshot") {
      const productUrl = String(params.productUrl ?? params.url ?? "").trim();
      if (!productUrl) { fail(res, "URL do produto e obrigatoria"); return; }
      if (productUrl.length > MAX_URL_LENGTH) { fail(res, "URL do produto excede o tamanho maximo permitido"); return; }
      if (!isMercadoLivreProductUrlLike(productUrl)) { fail(res, "URL informada não parece ser do Mercado Livre"); return; }

      try {
        const snapshot = await getMeliProductSnapshot(productUrl);
        ok(res, {
          success: true,
          ...snapshot,
        });
      } catch (error) {
        fail(res, error instanceof Error ? error.message : "Falha ao extrair dados do produto Mercado Livre");
      }
      return;
    }
    if (funcName === "meli-convert-links") {
      if (!MELI_URL) { fail(res, "MeLi RPA não configurado."); return; }

      const urls = Array.isArray(params.urls)
        ? params.urls.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      const requestedSessionId = String(params.sessionId ?? "").trim();
      const dedupedUrls: string[] = [...new Set<string>(urls)];
      if (dedupedUrls.length === 0) { fail(res, "urls deve ser um array não vazio"); return; }
      if (dedupedUrls.length > MAX_MELI_CONVERT_BATCH) { fail(res, `Limite de ${MAX_MELI_CONVERT_BATCH} URLs por lote Mercado Livre`); return; }
      if (dedupedUrls.some((item) => item.length > MAX_URL_LENGTH)) { fail(res, "Uma ou mais URLs excedem o tamanho maximo permitido"); return; }
      if (dedupedUrls.some((item) => !isMercadoLivreProductUrlLike(item))) { fail(res, "Uma ou mais URLs não parecem ser do Mercado Livre"); return; }
      const sessionId = await resolveRouteMeliSessionId(userId, requestedSessionId);
      if (!sessionId) { fail(res, "Nenhuma sessão Mercado Livre disponível para conversão."); return; }

      const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);
      const meliHeaders = { "x-autolinks-user-id": userId };
      const upstream = await proxyMicroservice(
        MELI_URL,
        "/api/meli/convert/batch",
        "POST",
        { urls: dedupedUrls, sessionId: scopedSessionId },
        meliHeaders,
        120_000,
      );
      if (upstream.error) { fail(res, upstream.error.message); return; }

      const payload: Record<string, unknown> = (upstream.data && typeof upstream.data === "object")
        ? (upstream.data as Record<string, unknown>)
        : {};
      const rawResults = Array.isArray(payload.results) ? payload.results : [];
      const results = rawResults.map((item) => {
        const row = (item && typeof item === "object") ? item as Record<string, unknown> : {};
        return {
          success: row.success === true,
          originalLink: String(row.originalUrl || row.originalLink || ""),
          affiliateLink: row.success === true ? String(row.affiliateLink || "") : "",
          cached: row.cached === true,
          conversionTimeMs: Number.isFinite(Number(row.conversionTimeMs))
            ? Number(row.conversionTimeMs)
            : undefined,
          error: row.success === true ? undefined : String(row.error || "Falha na conversão"),
        };
      });

      ok(res, {
        total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : dedupedUrls.length,
        successful: Number.isFinite(Number(payload.successful))
          ? Number(payload.successful)
          : results.filter((item) => item.success).length,
        results,
      });
      return;
    }
    if (funcName === "process-queue-health") {
      const queues = await collectProcessQueueSnapshot();
      ok(res, { queues, timestamp: nowIso() }); return;
    }
    if (funcName === "ops-service-health") {
      if (!OPS_URL) { ok(res, { online: false, services: [] }); return; }
      const opsHeaders = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};
      const r = await proxyMicroservice(OPS_URL, "/api/services", "GET", null, opsHeaders, 20_000);
      ok(res, r.data ?? { online: false, services: [] }); return;
    }
    if (funcName === "ops-service-control") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      if (!OPS_URL) { fail(res, "Ops Control não configurado."); return; }
      const svc = String(params.service ?? "").trim().toLowerCase();
      const op = String(params.operation ?? params.action ?? "").trim().toLowerCase();
      if (!svc || !["whatsapp","telegram","shopee","meli","all"].includes(svc)) { fail(res, "Serviço inválido"); return; }
      if (!["start","stop","restart"].includes(op)) { fail(res, "Ação inválida"); return; }
      const opsHeaders = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};
      const r = await proxyMicroservice(OPS_URL, `/api/services/${encodeURIComponent(svc)}/${encodeURIComponent(op)}`, "POST", { source: "admin-panel-api" }, opsHeaders, svc === "all" ? 120_000 : 60_000);
      if (r.error) { fail(res, r.error.message); return; }
      ok(res, r.data); return;
    }

    if (funcName === "ops-service-ports") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      if (!OPS_URL) { fail(res, "Ops Control não configurado."); return; }
      const opsHeaders = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};
      const r = await proxyMicroservice(OPS_URL, "/api/config/ports", "GET", null, opsHeaders, 20_000);
      if (r.error) { fail(res, r.error.message); return; }
      ok(res, r.data); return;
    }

    if (funcName === "ops-service-port") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      if (!OPS_URL) { fail(res, "Ops Control não configurado."); return; }
      const svc = String(params.service ?? params.id ?? "").trim().toLowerCase();
      const portRaw = params.port;
      const port = Number(portRaw);
      if (!svc || !["whatsapp","telegram","shopee","meli"].includes(svc)) { fail(res, "Serviço inválido"); return; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { fail(res, "Porta inválida"); return; }
      const opsHeaders = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};
      const r = await proxyMicroservice(OPS_URL, "/api/config/ports", "POST", { service: svc, port }, opsHeaders, 20_000);
      if (r.error) { fail(res, r.error.message); return; }
      ok(res, r.data); return;
    }

    // â”€â”€ ops-bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Ensures ops-control is online. In local/dev environments, if OPS_URL points
    // to localhost and ops-control is down, we attempt to spawn it.
    if (funcName === "ops-bootstrap") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      if (!OPS_URL) { fail(res, "Ops Control não configurado."); return; }

      const opsHeaders = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};
      const probe = await proxyMicroservice(OPS_URL, `/api/services?_ts=${Date.now()}`, "GET", null, opsHeaders, 5000);
      if (!probe.error) {
        ok(res, { ok: true, online: true, started: false, url: OPS_URL });
        return;
      }

      if (!isLocalhostUrl(OPS_URL)) {
        fail(res, `Ops Control offline em ${OPS_URL}. Bootstrap automático só é suportado quando OPS_CONTROL_URL aponta para localhost.`);
        return;
      }

      const targetPort = inferPortFromUrl(OPS_URL, 3115);
      const started = spawnOpsControlLocal(targetPort);
      if (!started.ok) {
        const startError = "error" in started ? started.error : "erro desconhecido";
        fail(res, `Falha ao iniciar Ops Control: ${startError}`);
        return;
      }

      const deadline = Date.now() + 25_000;
      let lastError = probe.error?.message ?? "offline";
      while (Date.now() < deadline) {
        const r = await proxyMicroservice(OPS_URL, `/api/services?_ts=${Date.now()}`, "GET", null, opsHeaders, 3500);
        if (!r.error) {
          ok(res, { ok: true, online: true, started: true, pid: started.pid, url: OPS_URL });
          return;
        }
        lastError = r.error.message;
        await sleep(800);
      }

      fail(res, `Ops Control não respondeu após iniciar (pid=${started.pid}). Último erro: ${lastError}`);
      return;
    }
    if (funcName === "admin-system-observability") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      const [
        usersRows,
        routesAggRows,
        automationsAggRows,
        groupsAggRows,
        waAggRows,
        tgAggRows,
        meliAggRows,
        schedulesAggRows,
        historyAggRows,
        activityAggRows,
        maintenanceRow,
        queueSnapshot,
      ] = await Promise.all([
        query<{
          user_id: string;
          email: string;
          name: string;
          role: string;
          account_status: string;
          plan_id: string;
          created_at: string;
        }>(
          `SELECT u.id AS user_id, u.email,
                  COALESCE(p.name, u.metadata->>'name', 'Usuario') AS name,
                  COALESCE(r.role, 'user') AS role,
                  COALESCE(u.metadata->>'account_status', 'active') AS account_status,
                  CASE
                    WHEN COALESCE(r.role, 'user') = 'admin' THEN '${ADMIN_PANEL_PLAN_ID}'
                    ELSE COALESCE(p.plan_id, 'plan-starter')
                  END AS plan_id,
                  u.created_at
           FROM users u
           LEFT JOIN profiles p ON p.user_id = u.id
           LEFT JOIN user_roles r ON r.user_id = u.id`
        ),
        query<{ user_id: string; routes_total: string | number; routes_active: string | number }>(
          `SELECT user_id,
                  COUNT(*) AS routes_total,
                  COUNT(*) FILTER (WHERE status = 'active') AS routes_active
           FROM routes
           GROUP BY user_id`
        ),
        query<{ user_id: string; automations_total: string | number; automations_active: string | number }>(
          `SELECT user_id,
                  COUNT(*) AS automations_total,
                  COUNT(*) FILTER (WHERE status = 'active' AND is_active = TRUE) AS automations_active
           FROM shopee_automations
           GROUP BY user_id`
        ),
        query<{ user_id: string; groups_total: string | number; groups_whatsapp: string | number; groups_telegram: string | number }>(
          `SELECT user_id,
                  COUNT(*) FILTER (WHERE deleted_at IS NULL) AS groups_total,
                  COUNT(*) FILTER (WHERE deleted_at IS NULL AND platform = 'whatsapp') AS groups_whatsapp,
                  COUNT(*) FILTER (WHERE deleted_at IS NULL AND platform = 'telegram') AS groups_telegram
           FROM groups
           GROUP BY user_id`
        ),
        query<{ user_id: string; wa_sessions_total: string | number; wa_sessions_online: string | number }>(
          `SELECT user_id,
                  COUNT(*) AS wa_sessions_total,
                  COUNT(*) FILTER (WHERE status IN ('online','active','connected','ready')) AS wa_sessions_online
           FROM whatsapp_sessions
           GROUP BY user_id`
        ),
        query<{ user_id: string; tg_sessions_total: string | number; tg_sessions_online: string | number }>(
          `SELECT user_id,
                  COUNT(*) AS tg_sessions_total,
                  COUNT(*) FILTER (WHERE status IN ('online','active','connected','ready')) AS tg_sessions_online
           FROM telegram_sessions
           GROUP BY user_id`
        ),
        query<{ user_id: string; meli_sessions_total: string | number; meli_sessions_active: string | number }>(
          `SELECT user_id,
                  COUNT(*) AS meli_sessions_total,
                  COUNT(*) FILTER (WHERE status = 'active') AS meli_sessions_active
           FROM meli_sessions
           GROUP BY user_id`
        ),
        query<{ user_id: string; schedules_total: string | number; schedules_pending: string | number; schedules_active_recurring: string | number }>(
          `SELECT user_id,
                  COUNT(*) AS schedules_total,
                  (
                    COUNT(*) FILTER (WHERE status = 'pending' AND scheduled_at <= NOW())
                    + COUNT(*) FILTER (WHERE status = 'processing')
                  ) AS schedules_pending,
                  COUNT(*) FILTER (WHERE recurrence IN ('daily','weekly') AND status IN ('pending','processing')) AS schedules_active_recurring
           FROM scheduled_posts
           GROUP BY user_id`
        ),
        query<{ user_id: string; history24h: string | number; history7d: string | number; errors24h: string | number; errors7d: string | number }>(
          `SELECT user_id,
                  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') AS history24h,
                  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS history7d,
                  COUNT(*) FILTER (
                    WHERE created_at >= NOW() - INTERVAL '1 day'
                      AND (status = 'error' OR processing_status IN ('error','blocked'))
                  ) AS errors24h,
                  COUNT(*) FILTER (
                    WHERE created_at >= NOW() - INTERVAL '7 days'
                      AND (status = 'error' OR processing_status IN ('error','blocked'))
                  ) AS errors7d
           FROM history_entries
           GROUP BY user_id`
        ),
        query<{ user_id: string; last_activity_at: string | null }>(
          `SELECT user_id, MAX(activity_at) AS last_activity_at
           FROM (
             SELECT user_id, MAX(created_at) AS activity_at FROM history_entries GROUP BY user_id
             UNION ALL
             SELECT user_id, MAX(updated_at) AS activity_at FROM routes GROUP BY user_id
             UNION ALL
             SELECT user_id, MAX(updated_at) AS activity_at FROM shopee_automations GROUP BY user_id
             UNION ALL
             SELECT user_id, MAX(updated_at) AS activity_at FROM scheduled_posts GROUP BY user_id
             UNION ALL
             SELECT user_id, MAX(updated_at) AS activity_at FROM groups GROUP BY user_id
             UNION ALL
             SELECT user_id, MAX(updated_at) AS activity_at FROM whatsapp_sessions GROUP BY user_id
             UNION ALL
             SELECT user_id, MAX(updated_at) AS activity_at FROM telegram_sessions GROUP BY user_id
             UNION ALL
             SELECT user_id, MAX(updated_at) AS activity_at FROM meli_sessions GROUP BY user_id
           ) activity
           GROUP BY user_id`
        ),
        queryOne<{ maintenance_enabled: boolean }>("SELECT maintenance_enabled FROM app_runtime_flags WHERE id = 'global'"),
        collectProcessQueueSnapshot(),
      ]);

      const byUser = <T extends { user_id: string }>(rows: T[]) =>
        new Map(rows.map((row) => [String(row.user_id), row]));

      const routeMap = byUser(routesAggRows);
      const automationMap = byUser(automationsAggRows);
      const groupMap = byUser(groupsAggRows);
      const waMap = byUser(waAggRows);
      const tgMap = byUser(tgAggRows);
      const meliMap = byUser(meliAggRows);
      const scheduleMap = byUser(schedulesAggRows);
      const historyMap = byUser(historyAggRows);
      const activityMap = byUser(activityAggRows);

      const users = usersRows.map((u) => {
        const uid = String(u.user_id);
        const routeRow = routeMap.get(uid);
        const automationRow = automationMap.get(uid);
        const groupRow = groupMap.get(uid);
        const waRow = waMap.get(uid);
        const tgRow = tgMap.get(uid);
        const meliRow = meliMap.get(uid);
        const scheduleRow = scheduleMap.get(uid);
        const historyRow = historyMap.get(uid);
        const activityRow = activityMap.get(uid);

        const history24h = toInt(historyRow?.history24h, 0);
        const history7d = toInt(historyRow?.history7d, 0);
        const historyExpected = calcExpected24hFrom7d(history7d);
        const errors24h = toInt(historyRow?.errors24h, 0);
        const errors7d = toInt(historyRow?.errors7d, 0);
        const errorsExpected = calcExpected24hFrom7d(errors7d);

        return {
          user_id: uid,
          email: String(u.email || ""),
          name: String(u.name || "Usuario"),
          role: String(u.role || "user"),
          account_status: String(u.account_status || "active"),
          plan_id: String(u.plan_id || ADMIN_PANEL_PLAN_ID),
          created_at: u.created_at,
          usage: {
            routesTotal: toInt(routeRow?.routes_total, 0),
            routesActive: toInt(routeRow?.routes_active, 0),
            automationsTotal: toInt(automationRow?.automations_total, 0),
            automationsActive: toInt(automationRow?.automations_active, 0),
            groupsTotal: toInt(groupRow?.groups_total, 0),
            groupsWhatsapp: toInt(groupRow?.groups_whatsapp, 0),
            groupsTelegram: toInt(groupRow?.groups_telegram, 0),
            waSessionsTotal: toInt(waRow?.wa_sessions_total, 0),
            waSessionsOnline: toInt(waRow?.wa_sessions_online, 0),
            tgSessionsTotal: toInt(tgRow?.tg_sessions_total, 0),
            tgSessionsOnline: toInt(tgRow?.tg_sessions_online, 0),
            meliSessionsTotal: toInt(meliRow?.meli_sessions_total, 0),
            meliSessionsActive: toInt(meliRow?.meli_sessions_active, 0),
            schedulesTotal: toInt(scheduleRow?.schedules_total, 0),
            schedulesPending: toInt(scheduleRow?.schedules_pending, 0),
            schedulesActiveRecurring: toInt(scheduleRow?.schedules_active_recurring, 0),
            history24h,
            history7d,
            history24hExpectedFrom7dAvg: historyExpected,
            history24hGrowthRatio: safeGrowthRatio(history24h, historyExpected),
            errors24h,
            errors7d,
            errors24hExpectedFrom7dAvg: errorsExpected,
            errors24hGrowthRatio: safeGrowthRatio(errors24h, errorsExpected),
            lastActivityAt: activityRow?.last_activity_at ? String(activityRow.last_activity_at) : null,
          },
        };
      });

      const global = {
        usersTotal: usersRows.length,
        usersActive: 0,
        usersInactive: 0,
        usersBlocked: 0,
        usersArchived: 0,
        routesTotal: 0,
        routesActive: 0,
        automationsTotal: 0,
        automationsActive: 0,
        groupsTotal: 0,
        groupsWhatsapp: 0,
        groupsTelegram: 0,
        waSessionsTotal: 0,
        waSessionsOnline: 0,
        tgSessionsTotal: 0,
        tgSessionsOnline: 0,
        meliSessionsTotal: 0,
        meliSessionsActive: 0,
        schedulesTotal: 0,
        schedulesPending: 0,
        history24h: 0,
        history7d: 0,
        history24hExpectedFrom7dAvg: 0,
        history24hGrowthRatio: 0,
        errors24h: 0,
        errors7d: 0,
        errors24hExpectedFrom7dAvg: 0,
        errors24hGrowthRatio: 0,
      };

      for (const user of users) {
        const status = String(user.account_status || "").trim().toLowerCase();
        if (status === "inactive") global.usersInactive += 1;
        else if (status === "blocked") global.usersBlocked += 1;
        else if (status === "archived") global.usersArchived += 1;
        else global.usersActive += 1;

        global.routesTotal += toInt(user.usage.routesTotal, 0);
        global.routesActive += toInt(user.usage.routesActive, 0);
        global.automationsTotal += toInt(user.usage.automationsTotal, 0);
        global.automationsActive += toInt(user.usage.automationsActive, 0);
        global.groupsTotal += toInt(user.usage.groupsTotal, 0);
        global.groupsWhatsapp += toInt(user.usage.groupsWhatsapp, 0);
        global.groupsTelegram += toInt(user.usage.groupsTelegram, 0);
        global.waSessionsTotal += toInt(user.usage.waSessionsTotal, 0);
        global.waSessionsOnline += toInt(user.usage.waSessionsOnline, 0);
        global.tgSessionsTotal += toInt(user.usage.tgSessionsTotal, 0);
        global.tgSessionsOnline += toInt(user.usage.tgSessionsOnline, 0);
        global.meliSessionsTotal += toInt(user.usage.meliSessionsTotal, 0);
        global.meliSessionsActive += toInt(user.usage.meliSessionsActive, 0);
        global.schedulesTotal += toInt(user.usage.schedulesTotal, 0);
        global.schedulesPending += toInt(user.usage.schedulesPending, 0);
        global.history24h += toInt(user.usage.history24h, 0);
        global.history7d += toInt(user.usage.history7d, 0);
        global.errors24h += toInt(user.usage.errors24h, 0);
        global.errors7d += toInt(user.usage.errors7d, 0);
      }
      global.history24hExpectedFrom7dAvg = calcExpected24hFrom7d(global.history7d);
      global.history24hGrowthRatio = safeGrowthRatio(global.history24h, global.history24hExpectedFrom7dAvg);
      global.errors24hExpectedFrom7dAvg = calcExpected24hFrom7d(global.errors7d);
      global.errors24hGrowthRatio = safeGrowthRatio(global.errors24h, global.errors24hExpectedFrom7dAvg);

      // Fetch ops-control health
      let ops: Record<string, unknown> = { online: false, url: OPS_URL, error: "Ops Control não configurado", system: null, services: [] };
      if (OPS_URL) {
        const opsHeaders = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};
        const opsResult = await proxyMicroservice(OPS_URL, `/api/services?_ts=${Date.now()}`, "GET", null, opsHeaders, 20_000);
        if (opsResult.data && !opsResult.error) {
          ops = {
            online: opsResult.data.online === true,
            url: OPS_URL,
            error: opsResult.data.error ?? null,
            system: opsResult.data.system ?? null,
            services: Array.isArray(opsResult.data.services) ? opsResult.data.services : [],
          };
        } else {
          ops = {
            online: false,
            url: OPS_URL,
            error: opsResult.error?.message ?? "Falha ao conectar ao Ops Control",
            system: null,
            services: [],
          };
        }
      }

      const scoringRows = users.map((user) => {
        const usage = user.usage;
        const loadScore = Number((
          usage.routesActive * 2
          + usage.automationsActive * 3
          + usage.schedulesPending * 2
          + usage.groupsTotal
          + usage.waSessionsOnline
          + usage.tgSessionsOnline
          + usage.meliSessionsActive
          + usage.history24h * 0.2
        ).toFixed(2));
        const errorsScore = Number((usage.errors24h * 4 + usage.errors7d * 0.5).toFixed(2));
        const spikeScore = Number((
          Math.max(usage.history24hGrowthRatio, usage.errors24hGrowthRatio)
          * (usage.history24h + usage.errors24h + 1)
        ).toFixed(2));
        return { ...user, loadScore, errorsScore, spikeScore };
      });

      const rankings = {
        byErrors: scoringRows
          .filter((row) => row.errorsScore > 0)
          .sort((a, b) => b.errorsScore - a.errorsScore)
          .slice(0, 10)
          .map((row) => ({ user_id: row.user_id, name: row.name, email: row.email, score: row.errorsScore, usage: row.usage })),
        byLoad: scoringRows
          .sort((a, b) => b.loadScore - a.loadScore)
          .slice(0, 10)
          .map((row) => ({ user_id: row.user_id, name: row.name, email: row.email, score: row.loadScore, usage: row.usage })),
        bySpike: scoringRows
          .filter((row) => row.spikeScore > 1)
          .sort((a, b) => b.spikeScore - a.spikeScore)
          .slice(0, 10)
          .map((row) => ({ user_id: row.user_id, name: row.name, email: row.email, score: row.spikeScore, usage: row.usage })),
      };

      const anomalies: Array<Record<string, unknown>> = [];
      const maintenanceEnabled = maintenanceRow?.maintenance_enabled === true;
      if (maintenanceEnabled) {
        anomalies.push({
          id: "maintenance-enabled",
          severity: "warning",
          title: "Modo manutenção ativo",
          message: "Clientes podem ter funcionalidades limitadas ate o retorno operacional.",
          metric: "maintenance",
        });
      }

      if (ops.online !== true) {
        anomalies.push({
          id: "ops-offline",
          severity: "critical",
          title: "Ops Control indisponível",
          message: String(ops.error || "Não foi possivel obter telemetria do Ops Control."),
          metric: "ops",
        });
      } else {
        const system = (ops.system && typeof ops.system === "object") ? ops.system as Record<string, unknown> : {};
        const pressure = String(system.pressure || "").toLowerCase();
        if (pressure === "critical" || pressure === "warn") {
          anomalies.push({
            id: `ops-pressure-${pressure || "unknown"}`,
            severity: pressure === "critical" ? "critical" : "warning",
            title: pressure === "critical" ? "Host em pressao critica" : "Host em estado de alerta",
            message: `Pressao atual do host reportada pelo Ops Control: ${pressure || "unknown"}.`,
            metric: "host_pressure",
          });
        }

        const services = Array.isArray(ops.services) ? ops.services : [];
        for (const service of services) {
          const row = (service && typeof service === "object") ? service as Record<string, unknown> : {};
          const serviceId = String(row.id || row.appName || "service");
          const serviceLabel = serviceId.toUpperCase();
          const processOnline = row.processOnline === true || row.online === true || isSessionOnlineStatus(row.processStatus);
          const componentOnline = row.componentOnline === true || row.online === true;
          if (!processOnline) {
            anomalies.push({
              id: `service-${serviceId}-process-offline`,
              severity: "critical",
              title: `${serviceLabel} parado`,
              message: "Processo principal indisponível no orchestrator.",
              metric: "service_process",
            });
          } else if (!componentOnline) {
            anomalies.push({
              id: `service-${serviceId}-component-offline`,
              severity: "warning",
              title: `${serviceLabel} sem resposta`,
              message: String(row.componentError || "Processo ativo, mas endpoint de health falhou."),
              metric: "service_component",
            });
          }
        }
      }

      const queueBuckets = {
        route: normalizeQueueBucket(queueSnapshot.route, 200),
        dispatch: normalizeQueueBucket(queueSnapshot.dispatch, Math.max(10, toInt(process.env.DISPATCH_LIMIT, 100))),
        automation: normalizeQueueBucket(queueSnapshot.automation, 50),
        convert: normalizeQueueBucket(queueSnapshot.convert, 1),
      };

      const queueThresholds = [
        { id: "dispatch", title: "Fila de agendamentos", bucket: queueBuckets.dispatch },
        { id: "automation", title: "Fila de automacoes", bucket: queueBuckets.automation },
        { id: "convert", title: "Fila de conversão MeLi", bucket: queueBuckets.convert },
        { id: "route", title: "Fila de roteamento", bucket: queueBuckets.route },
      ];
      for (const item of queueThresholds) {
        const hard = Math.max(item.bucket.limit * 2, 20);
        if (item.bucket.pending >= hard) {
          anomalies.push({
            id: `queue-${item.id}-critical`,
            severity: "critical",
            title: `${item.title} congestionada`,
            message: `Pendentes: ${item.bucket.pending} (limite recomendado ${item.bucket.limit}).`,
            metric: `queue_${item.id}`,
            value: item.bucket.pending,
            threshold: item.bucket.limit,
          });
        } else if (item.bucket.pending > item.bucket.limit) {
          anomalies.push({
            id: `queue-${item.id}-warn`,
            severity: "warning",
            title: `${item.title} acima do limite`,
            message: `Pendentes: ${item.bucket.pending} (limite recomendado ${item.bucket.limit}).`,
            metric: `queue_${item.id}`,
            value: item.bucket.pending,
            threshold: item.bucket.limit,
          });
        }
      }

      for (const row of scoringRows) {
        if (row.usage.errors24h >= 10) {
          anomalies.push({
            id: `user-errors-${row.user_id}`,
            severity: row.usage.errors24h >= 20 ? "critical" : "warning",
            title: `Alta taxa de erro: ${row.name}`,
            message: `${row.usage.errors24h} erros nas ultimas 24h.`,
            user_id: row.user_id,
            metric: "errors24h",
            value: row.usage.errors24h,
            threshold: 10,
          });
        }
        if (row.usage.history24h >= 40 && row.usage.history24hGrowthRatio >= 2.5) {
          anomalies.push({
            id: `user-spike-history-${row.user_id}`,
            severity: "warning",
            title: `Pico de volume: ${row.name}`,
            message: `Volume 24h em ${row.usage.history24hGrowthRatio.toFixed(2)}x da media semanal.`,
            user_id: row.user_id,
            metric: "history24hGrowthRatio",
            value: row.usage.history24hGrowthRatio,
            threshold: 2.5,
          });
        }
        if (row.usage.schedulesPending >= 50) {
          anomalies.push({
            id: `user-schedule-backlog-${row.user_id}`,
            severity: "warning",
            title: `Backlog de agendamentos: ${row.name}`,
            message: `${row.usage.schedulesPending} itens aguardando processamento.`,
            user_id: row.user_id,
            metric: "schedulesPending",
            value: row.usage.schedulesPending,
            threshold: 50,
          });
        }
      }

      const severityWeight: Record<string, number> = { critical: 3, warning: 2, info: 1 };
      const anomalyMap = new Map<string, Record<string, unknown>>();
      for (const anomaly of anomalies) {
        anomalyMap.set(String(anomaly.id), anomaly);
      }
      const sortedAnomalies = [...anomalyMap.values()]
        .sort((a, b) => {
          const wa = severityWeight[String(a.severity || "info")] ?? 0;
          const wb = severityWeight[String(b.severity || "info")] ?? 0;
          if (wb !== wa) return wb - wa;
          const va = Number(a.value ?? 0);
          const vb = Number(b.value ?? 0);
          return vb - va;
        })
        .slice(0, 20);

      ok(res, {
        ok: true,
        checkedAt: nowIso(),
        global,
        users,
        rankings,
        anomalies: sortedAnomalies,
        workers: {
          ops,
          queues: queueBuckets,
          queueTelemetry: queueSnapshot.telemetry,
        },
      }); return;
    }

    if (funcName === "admin-export-diagnostics") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }

      const requestedWindowHours = toInt(params.windowHours ?? params.hours, 24);
      const windowHours = Math.max(1, Math.min(24 * 14, requestedWindowHours));
      const requestedLimit = toInt(params.limit, 1500);
      const logsLimit = Math.max(200, Math.min(10_000, requestedLimit));
      const auditLimit = Math.max(100, Math.min(2_000, Math.floor(logsLimit / 2)));

      const serviceHeaders = buildUserScopedHeaders(userId);
      const opsHeaders = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};

      const probeServiceHealth = async (
        service: "whatsapp" | "telegram" | "shopee" | "meli",
        baseUrl: string,
        path: string,
      ) => {
        if (!baseUrl) {
          return {
            service,
            configured: false,
            online: false,
            error: `${service.toUpperCase()}_MICROSERVICE_URL não configurado`,
            url: "",
            uptimeSec: null as number | null,
            checkedAt: nowIso(),
          };
        }

        const upstream = await proxyMicroservice(baseUrl, path, "GET", null, serviceHeaders, 10_000);
        if (upstream.error) {
          return {
            service,
            configured: true,
            online: false,
            error: upstream.error.message,
            url: baseUrl,
            uptimeSec: null as number | null,
            checkedAt: nowIso(),
          };
        }

        const payload = (upstream.data && typeof upstream.data === "object")
          ? upstream.data as Record<string, unknown>
          : {};
        const uptimeRaw = Number(payload.uptimeSec);
        return {
          service,
          configured: true,
          online: payload.ok === true || payload.online === true || payload.success === true,
          error: null as string | null,
          url: baseUrl,
          uptimeSec: Number.isFinite(uptimeRaw) ? uptimeRaw : null,
          checkedAt: nowIso(),
          raw: payload,
        };
      };

      const [
        queueSnapshot,
        opsHealthResult,
        waHealth,
        tgHealth,
        shopeeHealth,
        meliHealth,
        recentHistoryRows,
        recentRouteRows,
        historySummaryRows,
        recentAuditRows,
        recentFailuresByUser,
        waSessionsRows,
        tgSessionsRows,
        groupsByPlatformRows,
        routesByStatusRows,
      ] = await Promise.all([
        collectProcessQueueSnapshot(),
        OPS_URL
          ? proxyMicroservice(OPS_URL, `/api/services?_ts=${Date.now()}`, "GET", null, opsHeaders, 20_000)
          : Promise.resolve({ data: null, error: { message: "OPS_CONTROL_URL não configurado" } }),
        probeServiceHealth("whatsapp", WHATSAPP_URL, "/health"),
        probeServiceHealth("telegram", TELEGRAM_URL, "/health"),
        probeServiceHealth("shopee", SHOPEE_URL, "/health"),
        probeServiceHealth("meli", MELI_URL, "/api/meli/health"),
        query<{
          id: string;
          created_at: string;
          user_id: string;
          type: string;
          source: string;
          destination: string;
          status: string;
          direction: string;
          message_type: string;
          processing_status: string;
          block_reason: string;
          error_step: string;
          details: unknown;
        }>(
          `SELECT id, created_at, user_id, type, source, destination, status, direction, message_type, processing_status, block_reason, error_step, details
             FROM history_entries
            WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
            ORDER BY created_at DESC
            LIMIT $2`,
          [windowHours, logsLimit],
        ),
        query<{
          id: string;
          created_at: string;
          user_id: string;
          source: string;
          destination: string;
          status: string;
          processing_status: string;
          block_reason: string;
          error_step: string;
          message_type: string;
          details: unknown;
        }>(
          `SELECT id, created_at, user_id, source, destination, status, processing_status, block_reason, error_step, message_type, details
             FROM history_entries
            WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
              AND type IN ('route_forward', 'schedule_sent', 'automation_run')
            ORDER BY created_at DESC
            LIMIT $2`,
          [windowHours, Math.min(3000, logsLimit)],
        ),
        query<{
          type: string;
          status: string;
          processing_status: string;
          block_reason: string;
          error_step: string;
          message_type: string;
          total: string | number;
        }>(
          `SELECT COALESCE(type, '') AS type,
                  COALESCE(status, '') AS status,
                  COALESCE(processing_status, '') AS processing_status,
                  COALESCE(block_reason, '') AS block_reason,
                  COALESCE(error_step, '') AS error_step,
                  COALESCE(message_type, '') AS message_type,
                  COUNT(*) AS total
             FROM history_entries
            WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
            GROUP BY type, status, processing_status, block_reason, error_step, message_type
            ORDER BY COUNT(*) DESC
            LIMIT 200`,
          [windowHours],
        ),
        query<{
          id: string;
          created_at: string;
          user_id: string;
          target_user_id: string | null;
          action: string;
          details: unknown;
        }>(
          `SELECT id, created_at, user_id, target_user_id, action, details
             FROM admin_audit_logs
            WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
            ORDER BY created_at DESC
            LIMIT $2`,
          [windowHours, auditLimit],
        ),
        query<{
          user_id: string;
          total: string | number;
        }>(
          `SELECT user_id, COUNT(*) AS total
             FROM history_entries
            WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
              AND (status = 'error' OR processing_status IN ('error', 'blocked'))
            GROUP BY user_id
            ORDER BY COUNT(*) DESC
            LIMIT 30`,
          [windowHours],
        ),
        query<{
          id: string;
          user_id: string;
          name: string;
          status: string;
          connected_at: string | null;
          error_message: string;
          updated_at: string;
          phone: string;
        }>(
          `SELECT id, user_id, name, status, connected_at, error_message, updated_at, phone
             FROM whatsapp_sessions
            ORDER BY updated_at DESC
            LIMIT 500`,
        ),
        query<{
          id: string;
          user_id: string;
          name: string;
          status: string;
          connected_at: string | null;
          error_message: string;
          updated_at: string;
          phone: string;
        }>(
          `SELECT id, user_id, name, status, connected_at, error_message, updated_at, phone
             FROM telegram_sessions
            ORDER BY updated_at DESC
            LIMIT 500`,
        ),
        query<{
          platform: string;
          total: string | number;
        }>(
          `SELECT platform, COUNT(*) AS total
             FROM groups
            WHERE deleted_at IS NULL
            GROUP BY platform
            ORDER BY platform`,
        ),
        query<{
          status: string;
          total: string | number;
        }>(
          `SELECT COALESCE(status, '') AS status, COUNT(*) AS total
             FROM routes
            GROUP BY status
            ORDER BY COUNT(*) DESC`,
        ),
      ]);

      const opsSnapshot = (() => {
        if (opsHealthResult.error) {
          return {
            configured: Boolean(OPS_URL),
            online: false,
            url: OPS_URL,
            error: opsHealthResult.error.message,
            checkedAt: nowIso(),
            services: [] as unknown[],
            system: null as unknown,
          };
        }
        const payload = (opsHealthResult.data && typeof opsHealthResult.data === "object")
          ? opsHealthResult.data as Record<string, unknown>
          : {};
        return {
          configured: Boolean(OPS_URL),
          online: payload.online === true || payload.ok === true,
          url: OPS_URL,
          error: payload.error ? String(payload.error) : null,
          checkedAt: nowIso(),
          services: Array.isArray(payload.services) ? payload.services : [],
          system: payload.system ?? null,
        };
      })();

      const usersForMap = await listUsersWithMeta();
      const userMap = new Map(usersForMap.map((row) => [String(row.user_id), {
        name: String(row.name || "Usuario"),
        email: String(row.email || ""),
        role: String(row.role || "user"),
      }]));

      const addUserMeta = <T extends { user_id?: unknown }>(rows: T[]) =>
        rows.map((row) => {
          const uid = String(row.user_id || "");
          const meta = uid ? userMap.get(uid) : null;
          return {
            ...row,
            user_name: meta?.name || "",
            user_email: meta?.email || "",
            user_role: meta?.role || "",
          };
        });

      const exportPayload = {
        meta: {
          generatedAt: nowIso(),
          windowHours,
          requestedBy: {
            userId,
            role: userIsAdmin ? "admin" : (isService ? "service" : "user"),
          },
          limits: {
            history: logsLimit,
            adminAudit: auditLimit,
          },
          debugFlags: {
            routeMediaDebug: ROUTE_MEDIA_DEBUG_ENABLED,
            envRouteMediaDebugRaw: String(process.env.ROUTE_MEDIA_DEBUG || ""),
            envMediaCaptureDebugRaw: String(process.env.MEDIA_CAPTURE_DEBUG || ""),
          },
        },
        serviceConfig: {
          apiUrl: process.env.API_PUBLIC_URL || "",
          opsUrl: OPS_URL || "",
          whatsappUrl: WHATSAPP_URL || "",
          telegramUrl: TELEGRAM_URL || "",
          shopeeUrl: SHOPEE_URL || "",
          meliUrl: MELI_URL || "",
        },
        health: {
          services: [waHealth, tgHealth, shopeeHealth, meliHealth],
          ops: opsSnapshot,
        },
        queues: queueSnapshot,
        summary: {
          historyRows: recentHistoryRows.length,
          routeRows: recentRouteRows.length,
          auditRows: recentAuditRows.length,
          whatsappSessions: waSessionsRows.length,
          telegramSessions: tgSessionsRows.length,
        },
        aggregations: {
          historyByOutcome: historySummaryRows.map((row) => ({
            ...row,
            total: toInt(row.total, 0),
          })),
          failuresByUser: addUserMeta(recentFailuresByUser).map((row) => ({
            ...row,
            total: toInt((row as { total: unknown }).total, 0),
          })),
          groupsByPlatform: groupsByPlatformRows.map((row) => ({
            ...row,
            total: toInt(row.total, 0),
          })),
          routesByStatus: routesByStatusRows.map((row) => ({
            ...row,
            total: toInt(row.total, 0),
          })),
        },
        state: {
          whatsappSessions: addUserMeta(waSessionsRows),
          telegramSessions: addUserMeta(tgSessionsRows),
        },
        logs: {
          historyEntries: addUserMeta(recentHistoryRows),
          routeRelatedEntries: addUserMeta(recentRouteRows),
          adminAuditLogs: addUserMeta(recentAuditRows),
        },
      };

      const fileTimestamp = nowIso().replace(/[:.]/g, "-");
      ok(res, {
        ok: true,
        fileName: `autolinks-diagnostico-${fileTimestamp}.json`,
        export: exportPayload,
      });
      return;
    }

    // â”€â”€ admin-maintenance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "admin-maintenance") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      const action = String(params.action ?? "get");
      if (action === "get") {
        const data = await queryOne("SELECT * FROM app_runtime_flags WHERE id = 'global'");
        ok(res, data ?? { maintenance_enabled: false, allow_admin_bypass: true }); return;
      }
      if (action === "set") {
        const upd: Record<string, unknown> = {};
        if (typeof params.maintenance_enabled === "boolean") upd.maintenance_enabled = params.maintenance_enabled;
        if (typeof params.maintenance_title === "string") upd.maintenance_title = params.maintenance_title.trim() || "Sistema em manutenção";
        if (typeof params.maintenance_message === "string") upd.maintenance_message = params.maintenance_message.trim() || "Estamos realizando melhorias.";
        if (params.maintenance_eta !== undefined) upd.maintenance_eta = params.maintenance_eta || null;
        if (typeof params.allow_admin_bypass === "boolean") upd.allow_admin_bypass = params.allow_admin_bypass;
        const keys = Object.keys(upd);
        const updateValues = Object.values(upd);
        // Double-quote identifiers: keys are hardcoded strings, but quoting prevents future injection if pattern is reused
        const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
        await execute(
          `UPDATE app_runtime_flags SET ${setClause}, updated_by_user_id = $${keys.length + 1}, updated_at = NOW() WHERE id = 'global'`,
          [...updateValues, userId]
        );
        await appendAudit("set_maintenance", userId, null, { maintenance_enabled: upd.maintenance_enabled });
        const data = await queryOne("SELECT * FROM app_runtime_flags WHERE id = 'global'");
        ok(res, data); return;
      }
      fail(res, "Ação de manutenção inválida"); return;
    }

    // â”€â”€ user-notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "user-notifications") {
      const action = String(params.action ?? "list");
      if (action === "unread_count") {
        const row = await queryOne("SELECT COUNT(*) AS c FROM user_notifications WHERE user_id=$1 AND status='unread'", [userId]);
        ok(res, { count: Number(row?.c ?? 0) }); return;
      }
      if (action === "list") {
        const VALID_NOTIF_STATUS = new Set(["unread", "read", "dismissed"]);
        const rawStatus = String(params.status ?? "all");
        const validStatus = VALID_NOTIF_STATUS.has(rawStatus) ? rawStatus : null;
        const lim = Math.min(Number(params.limit ?? 50), 200);
        const statusSql = validStatus ? "AND un.status = $3" : "";
        const queryArgs = validStatus ? [userId, lim, validStatus] : [userId, lim];
        const items = await query(`SELECT un.*, row_to_json(sa) AS system_announcements FROM user_notifications un LEFT JOIN system_announcements sa ON sa.id = un.announcement_id WHERE un.user_id=$1 ${statusSql} ORDER BY un.delivered_at DESC LIMIT $2`, queryArgs);
        const unreadRow = await queryOne("SELECT COUNT(*) AS c FROM user_notifications WHERE user_id=$1 AND status='unread'", [userId]);
        ok(res, { items, unread_count: Number(unreadRow?.c ?? 0) }); return;
      }
      if (action === "mark_read") {
        const ids = Array.isArray(params.ids) ? params.ids : (params.id ? [String(params.id)] : []);
        if (!ids.length) { fail(res, "ID obrigatório"); return; }
        await execute("UPDATE user_notifications SET status='read', read_at=NOW(), updated_at=NOW() WHERE user_id=$1 AND id=ANY($2) AND status='unread'", [userId, ids]);
        ok(res, { success: true }); return;
      }
      if (action === "mark_all_read") {
        await execute("UPDATE user_notifications SET status='read', read_at=NOW(), updated_at=NOW() WHERE user_id=$1 AND status='unread'", [userId]);
        ok(res, { success: true }); return;
      }
      if (action === "dismiss") {
        const nid = String(params.id ?? ""); if (!nid) { fail(res, "ID obrigatório"); return; }
        await execute("UPDATE user_notifications SET status='dismissed', dismissed_at=NOW(), updated_at=NOW() WHERE id=$1 AND user_id=$2", [nid, userId]);
        ok(res, { success: true }); return;
      }
      if (action === "login_popup") {
        const items = await query(`SELECT un.*, row_to_json(sa) AS system_announcements FROM user_notifications un LEFT JOIN system_announcements sa ON sa.id = un.announcement_id WHERE un.user_id=$1 AND un.status='unread' ORDER BY un.delivered_at DESC LIMIT 20`, [userId]);
        const candidate = items.find((item) => {
          const ann = item.system_announcements;
          if (!ann) return false;
          if (!isAnnouncementActiveNow(ann)) return false;
          return ann.auto_popup_on_login === true && ann.severity === "critical" && (ann.channel === "modal" || ann.channel === "both");
        });
        if (!candidate) { ok(res, { item: null }); return; }
        await execute("UPDATE user_notifications SET status='read', read_at=NOW(), updated_at=NOW() WHERE id=$1", [candidate.id]);
        ok(res, { item: candidate }); return;
      }
      fail(res, "Ação de notificação inválida"); return;
    }

    // â”€â”€ admin-announcements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "admin-announcements") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      const action = String(params.action ?? "list");
      if (action === "list") {
        const rows = await query("SELECT * FROM system_announcements ORDER BY created_at DESC");
        // Aggregate notification metrics in a single query instead of N+1 per announcement
        const metricsRows = await query(
          `SELECT announcement_id,
            COUNT(*) AS delivered,
            COUNT(*) FILTER (WHERE status='read') AS read_count,
            COUNT(*) FILTER (WHERE status='dismissed') AS dismissed_count
           FROM user_notifications GROUP BY announcement_id`
        );
        const metricsMap = new Map(metricsRows.map((m) => [m.announcement_id, m]));
        const items = rows.map((row) => {
          const m = metricsMap.get(row.id);
          const delivered = Number(m?.delivered ?? 0), read = Number(m?.read_count ?? 0), dismissed = Number(m?.dismissed_count ?? 0);
          return { ...row, metrics: { delivered, read, dismissed, unread: delivered - read - dismissed, read_rate: delivered > 0 ? Math.round((read / delivered) * 100) : 0 } };
        });
        ok(res, { announcements: items }); return;
      }
      if (action === "create") {
        const title = String(params.title ?? "").trim(); const message = String(params.message ?? "").trim();
        if (!title) { fail(res, "Título obrigatório"); return; } if (!message) { fail(res, "Mensagem obrigatória"); return; }
        const id = uuid();
        await execute("INSERT INTO system_announcements (id, created_by_user_id, title, message, severity, channel, auto_popup_on_login, starts_at, ends_at, is_active, target_filter) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [id, userId, title, message, ["critical","warning"].includes(String(params.severity)) ? params.severity : "info", ["modal","both"].includes(String(params.channel)) ? params.channel : "bell", params.auto_popup_on_login === true, params.starts_at || null, params.ends_at || null, params.is_active !== false, JSON.stringify(normalizeTargetFilter(params.target_filter))]);
        const row = await queryOne("SELECT * FROM system_announcements WHERE id=$1", [id]);
        let delivery = { delivered: 0, matchedUsers: 0 };
        if (params.deliver_now !== false) delivery = await deliverAnnouncement(row);
        await appendAudit("create_announcement", userId, null, { announcement_id: id, delivered: delivery.delivered });
        ok(res, { announcement: row, delivery }); return;
      }
      if (action === "update") {
        const aid = String(params.id ?? ""); if (!aid) { fail(res, "ID obrigatório"); return; }
        const updates: Record<string, unknown> = {};
        if (params.title) updates.title = String(params.title).trim();
        if (params.message) updates.message = String(params.message).trim();
        if (["info","warning","critical"].includes(String(params.severity))) updates.severity = params.severity;
        if (["bell","modal","both"].includes(String(params.channel))) updates.channel = params.channel;
        if (typeof params.auto_popup_on_login === "boolean") updates.auto_popup_on_login = params.auto_popup_on_login;
        if (params.starts_at !== undefined) updates.starts_at = params.starts_at || null;
        if (params.ends_at !== undefined) updates.ends_at = params.ends_at || null;
        if (typeof params.is_active === "boolean") updates.is_active = params.is_active;
        if (params.target_filter) updates.target_filter = JSON.stringify(normalizeTargetFilter(params.target_filter));
        const keys = Object.keys(updates);
        if (keys.length > 0) {
          // Double-quote identifiers â€” keys are hardcoded strings above, quoting prevents future injection
          const setClause = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
          await execute(`UPDATE system_announcements SET ${setClause}, updated_at=NOW() WHERE id=$1`, [aid, ...Object.values(updates)]);
        }
        let delivery = { delivered: 0, matchedUsers: 0 };
        if (params.redeliver === true) { const row = await queryOne("SELECT * FROM system_announcements WHERE id=$1", [aid]); if (row) delivery = await deliverAnnouncement(row); }
        await appendAudit("update_announcement", userId, null, { announcement_id: aid });
        ok(res, { success: true, delivery }); return;
      }
      if (action === "deactivate") {
        const aid = String(params.id ?? ""); if (!aid) { fail(res, "ID obrigatório"); return; }
        await execute("UPDATE system_announcements SET is_active=FALSE, updated_at=NOW() WHERE id=$1", [aid]);
        ok(res, { success: true }); return;
      }
      if (action === "delete") {
        const aid = String(params.id ?? ""); if (!aid) { fail(res, "ID obrigatório"); return; }
        await execute("DELETE FROM user_notifications WHERE announcement_id=$1", [aid]);
        await execute("DELETE FROM system_announcements WHERE id=$1", [aid]);
        await appendAudit("delete_announcement", userId, null, { announcement_id: aid });
        ok(res, { success: true }); return;
      }
      if (action === "deliver_now") {
        const aid = String(params.id ?? ""); if (!aid) { fail(res, "ID obrigatório"); return; }
        const row = await queryOne("SELECT * FROM system_announcements WHERE id=$1", [aid]);
        if (!row) { fail(res, "Comunicado não encontrado"); return; }
        const lastMs = row.last_delivered_at ? Date.parse(row.last_delivered_at) : 0;
        if (Date.now() - lastMs < 30000) { fail(res, "Aguarde 30s antes de reenviar."); return; }
        const delivery = await deliverAnnouncement(row);
        ok(res, { success: true, delivery }); return;
      }
      if (action === "preview_recipients") {
        const filter = normalizeTargetFilter(params.target_filter);
        const users = (await listUsersWithMeta()).filter((u) => !["inactive","blocked","archived"].includes(u.account_status)).filter((u) => filter.planIds.length === 0 || filter.planIds.includes(u.plan_id)).slice(0, 200).map((u) => ({ user_id: u.user_id, email: u.email, name: u.name, plan_id: u.plan_id }));
        ok(res, { count: users.length, users }); return;
      }
      fail(res, "Ação de comunicados inválida"); return;
    }

    // â”€â”€ admin-users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "admin-users") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      const action = String(params.action ?? "");
      const cp = await loadControlPlane();
      const validPlanIds = getValidPlanIds(cp);
      const fallbackPlan = getFallbackPlanId(cp);

      if (action === "list_users") { ok(res, { users: await listUsersWithMeta() }); return; }
      if (action === "list_audit") {
        const data = await query("SELECT al.*, u.email AS actor_email, t.email AS target_email FROM admin_audit_logs al LEFT JOIN users u ON u.id = al.user_id LEFT JOIN users t ON t.id = al.target_user_id ORDER BY al.created_at DESC LIMIT 50");
        ok(res, { audit: data }); return;
      }
      if (action === "update_plan") {
        const tid = String(params.user_id ?? ""); const planId = String(params.plan_id ?? "").trim();
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; }
        const roleRow = await queryOne("SELECT role FROM user_roles WHERE user_id=$1", [tid]);
        const targetRole = String(roleRow?.role ?? "user") === "admin" ? "admin" : "user";
        if (targetRole === "admin") { fail(res, "Admins não possuem plano. Ajuste a permissão para usuário se quiser aplicar plano."); return; }
        if (!planId || !validPlanIds.has(planId)) { fail(res, "Plano inválido"); return; }
        const expiresAt = planExpiresAt(cp, planId);
        const upd = await execute("UPDATE profiles SET plan_id=$1, plan_expires_at=$2, updated_at=NOW() WHERE user_id=$3", [planId, expiresAt, tid]);
        if (upd.rowCount <= 0) { fail(res, "Perfil não encontrado"); return; }
        await appendAudit("update_plan", userId, tid, { plan_id: planId });
        ok(res, { success: true }); return;
      }
      if (action === "set_role") {
        const tid = String(params.user_id ?? ""); const role = String(params.role ?? "user") === "admin" ? "admin" : "user";
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; }
        if (tid === userId && role !== "admin") { fail(res, "Não é permitido remover a própria permissão admin"); return; }
        const profile = await queryOne("SELECT plan_id, plan_expires_at FROM profiles WHERE user_id=$1", [tid]);
        if (!profile) { fail(res, "Perfil não encontrado"); return; }
        const rawPlan = String(profile.plan_id ?? "").trim();
        const shouldReassignUserPlan = !rawPlan || rawPlan === ADMIN_PANEL_PLAN_ID || !validPlanIds.has(rawPlan);
        const hasValidExpiry = typeof profile.plan_expires_at === "string" && Number.isFinite(Date.parse(profile.plan_expires_at));
        const nextUserPlan = shouldReassignUserPlan ? fallbackPlan : rawPlan;
        const nextUserPlanExpiry = (shouldReassignUserPlan || !hasValidExpiry)
          ? planExpiresAt(cp, nextUserPlan)
          : (profile.plan_expires_at ?? null);
        // Wrap role change + token inválidation in a transaction â€” DELETE without INSERT leaves user roleless
        await transaction(async (client) => {
          if (role === "admin") {
            await client.query(
              "UPDATE profiles SET plan_id=$1, plan_expires_at=NULL, updated_at=NOW() WHERE user_id=$2",
              [ADMIN_PANEL_PLAN_ID, tid],
            );
          } else if (shouldReassignUserPlan || !hasValidExpiry) {
            await client.query(
              "UPDATE profiles SET plan_id=$1, plan_expires_at=$2, updated_at=NOW() WHERE user_id=$3",
              [nextUserPlan, nextUserPlanExpiry, tid],
            );
          }
          await client.query("DELETE FROM user_roles WHERE user_id=$1", [tid]);
          await client.query("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,$3)", [uuid(), tid, role]);
          // Inválidate all active tokens for the target user â€” JWT embeds role, so old tokens
          // would otherwise remain valid with the previous role until natural expiry.
          await client.query("UPDATE users SET token_inválidated_before = NOW() WHERE id = $1", [tid]);
        });
        await appendAudit("set_role", userId, tid, {
          role,
          plan_id: role === "admin" ? ADMIN_PANEL_PLAN_ID : nextUserPlan,
        });
        ok(res, { success: true }); return;
      }
      if (action === "set_name") {
        const tid = String(params.user_id ?? ""); const name = String(params.name ?? "").trim();
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; } if (!name) { fail(res, "Nome obrigatório"); return; }
        await execute("UPDATE users SET metadata = metadata || $1::jsonb, updated_at=NOW() WHERE id=$2", [JSON.stringify({ name }), tid]);
        await execute("UPDATE profiles SET name=$1, updated_at=NOW() WHERE user_id=$2", [name, tid]);
        await appendAudit("set_name", userId, tid, { name });
        ok(res, { success: true }); return;
      }
      if (action === "set_status") {
        const tid = String(params.user_id ?? ""); const status = String(params.account_status ?? "active");
        if (!["active","inactive","blocked","archived"].includes(status)) { fail(res, "Status inválido"); return; }
        if (tid === userId && status !== "active") { fail(res, "Não é permitido alterar o próprio status"); return; }
        const setInv = status !== "active" ? ", token_inválidated_before = NOW()" : "";
        await execute(`UPDATE users SET metadata = metadata || $1::jsonb${setInv}, updated_at=NOW() WHERE id=$2`, [JSON.stringify({ account_status: status, status_updated_at: nowIso() }), tid]);
        await appendAudit("set_status", userId, tid, { account_status: status });
        ok(res, { success: true }); return;
      }
      if (action === "archive_user") {
        const tid = String(params.user_id ?? ""); if (tid === userId) { fail(res, "Não é permitido arquivar o próprio usuário"); return; }
        await execute("UPDATE users SET metadata = metadata || $1::jsonb, token_inválidated_before = NOW(), updated_at=NOW() WHERE id=$2", [JSON.stringify({ account_status: "archived", archived_at: nowIso(), status_updated_at: nowIso() }), tid]);
        await appendAudit("archive_user", userId, tid, {});
        ok(res, { success: true }); return;
      }
      if (action === "restore_user") {
        const tid = String(params.user_id ?? "");
        await execute("UPDATE users SET metadata = metadata || $1::jsonb, updated_at=NOW() WHERE id=$2", [JSON.stringify({ account_status: "active", status_updated_at: nowIso() }), tid]);
        await appendAudit("restore_user", userId, tid, {});
        ok(res, { success: true }); return;
      }
      if (action === "delete_user") {
        const tid = String(params.user_id ?? ""); if (!tid) { fail(res, "Usuário alvo obrigatório"); return; } if (tid === userId) { fail(res, "Não é permitido apagar o próprio usuário"); return; }
        const target = await queryOne("SELECT email FROM users WHERE id=$1", [tid]);
        if (!target) { fail(res, "Usuário não encontrado"); return; }
        await execute("DELETE FROM users WHERE id=$1", [tid]);
        await appendAudit("delete_user", userId, tid, { deleted_user_id: tid, email: target.email ?? null });
        ok(res, { success: true }); return;
      }
      if (action === "create_user") {
        const email = normalizeEmail(params.email); const password = String(params.password ?? "");
        const name = String(params.name ?? "Usuário").trim() || "Usuário"; const role = String(params.role ?? "user") === "admin" ? "admin" : "user";
        const requestedPlanId = String(params.plan_id ?? "").trim();
        const planId = role === "admin"
          ? ADMIN_PANEL_PLAN_ID
          : (requestedPlanId && validPlanIds.has(requestedPlanId) ? requestedPlanId : fallbackPlan);
        const createPasswordError = getPasswordPolicyError(password);
        if (!email || !isValidEmail(email) || createPasswordError) { fail(res, createPasswordError ? `Senha inválida: ${createPasswordError}` : "Informe email válido"); return; }
        const exists = await queryOne("SELECT id FROM users WHERE email=$1", [email]);
        if (exists) { fail(res, "Email já cadastrado"); return; }
        const hash = await bcrypt.hash(password, 10);
        const newId = uuid();
        // Wrap 3 INSERTs in a transaction â€” if any fails, roll back to avoid orphan user/role/profile
        await transaction(async (client) => {
          await client.query("INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at) VALUES ($1,$2,$3,$4,NOW())", [newId, email, hash, JSON.stringify({ name, account_status: "active", status_updated_at: nowIso() })]);
          await client.query("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,$3)", [uuid(), newId, role]);
          await client.query(
            "INSERT INTO profiles (id, user_id, name, email, plan_id, plan_expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
            [uuid(), newId, name, email, planId, role === "admin" ? null : planExpiresAt(cp, planId)],
          );
        });
        await appendAudit("create_user", userId, newId, { email, role, plan_id: planId });
        ok(res, {
          success: true,
          created_user: {
            id: newId,
            user_id: newId,
            name,
            email,
            plan_id: planId,
            role,
            account_status: "active",
          },
        }); return;
      }
      if (action === "update_user") {
        const tid = String(params.user_id ?? ""); if (!tid) { fail(res, "Usuário alvo obrigatório"); return; }
        const role = String(params.role ?? "user") === "admin" ? "admin" : "user";
        if (tid === userId && role !== "admin") { fail(res, "Não é permitido remover a própria permissão admin"); return; }

        const name = String(params.name ?? "").trim();
        const emailProvided = params.email !== undefined;
        const email = normalizeEmail(params.email);
        if (emailProvided) {
          if (!email || !isValidEmail(email)) { fail(res, "Email inválido"); return; }
          const duplicate = await queryOne("SELECT id FROM users WHERE email=$1 AND id<>$2", [email, tid]);
          if (duplicate) { fail(res, "Email já cadastrado"); return; }
        }

        const accountStatusRaw = String(params.account_status ?? "").trim();
        const hasAccountStatus = accountStatusRaw.length > 0;
        const accountStatus = hasAccountStatus ? accountStatusRaw : null;
        if (hasAccountStatus) {
          if (!["active","inactive","blocked","archived"].includes(accountStatusRaw)) { fail(res, "Status inválido"); return; }
          if (tid === userId && accountStatusRaw !== "active") { fail(res, "Não é permitido alterar o próprio status"); return; }
        }

        const profile = await queryOne("SELECT plan_id, plan_expires_at FROM profiles WHERE user_id=$1", [tid]);
        if (!profile) { fail(res, "Perfil não encontrado"); return; }

        const requestedPlanId = String(params.plan_id ?? "").trim();
        let nextPlanId = String(profile.plan_id ?? "").trim();
        let nextPlanExpiry = profile.plan_expires_at ?? null;
        if (role === "admin") {
          nextPlanId = ADMIN_PANEL_PLAN_ID;
          nextPlanExpiry = null;
        } else if (requestedPlanId) {
          if (!validPlanIds.has(requestedPlanId)) { fail(res, "Plano inválido"); return; }
          nextPlanId = requestedPlanId;
          nextPlanExpiry = planExpiresAt(cp, requestedPlanId);
        } else if (!nextPlanId || nextPlanId === ADMIN_PANEL_PLAN_ID || !validPlanIds.has(nextPlanId)) {
          nextPlanId = fallbackPlan;
          nextPlanExpiry = planExpiresAt(cp, fallbackPlan);
        } else if (!nextPlanExpiry) {
          nextPlanExpiry = planExpiresAt(cp, nextPlanId);
        }

        const metadataPatch: Record<string, unknown> = {};
        if (name) metadataPatch.name = name;
        if (hasAccountStatus && accountStatus) {
          metadataPatch.account_status = accountStatus;
          metadataPatch.status_updated_at = nowIso();
        }

        await transaction(async (client) => {
          if (emailProvided) {
            await client.query("UPDATE users SET email=$1, updated_at=NOW() WHERE id=$2", [email, tid]);
            await client.query("UPDATE profiles SET email=$1, updated_at=NOW() WHERE user_id=$2", [email, tid]);
          }
          if (name) {
            await client.query("UPDATE profiles SET name=$1, updated_at=NOW() WHERE user_id=$2", [name, tid]);
          }
          if (Object.keys(metadataPatch).length > 0) {
            await client.query("UPDATE users SET metadata = metadata || $1::jsonb, updated_at=NOW() WHERE id=$2", [JSON.stringify(metadataPatch), tid]);
          }
          await client.query("UPDATE profiles SET plan_id=$1, plan_expires_at=$2, updated_at=NOW() WHERE user_id=$3", [nextPlanId, nextPlanExpiry, tid]);
          await client.query("DELETE FROM user_roles WHERE user_id=$1", [tid]);
          await client.query("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,$3)", [uuid(), tid, role]);
          // Always inválidate tokens: role is re-set above (JWT embeds role), so existing tokens must be rotated
          await client.query("UPDATE users SET token_inválidated_before = NOW(), updated_at=NOW() WHERE id=$1", [tid]);
        });
        await appendAudit("update_user", userId, tid, {
          name: name || undefined,
          email: emailProvided ? email : undefined,
          plan_id: nextPlanId,
          role,
          account_status: accountStatus || undefined,
        });
        ok(res, { success: true }); return;
      }
      if (action === "extend_plan") {
        const tid = String(params.user_id ?? "");
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; }
        const p = await queryOne("SELECT p.plan_id, p.plan_expires_at, COALESCE(r.role, 'user') AS role FROM profiles p LEFT JOIN user_roles r ON r.user_id = p.user_id WHERE p.user_id=$1", [tid]);
        if (!p) { fail(res, "Perfil não encontrado"); return; }
        if (String(p.role ?? "user") === "admin") { fail(res, "Admins não possuem plano para renovar."); return; }
        const currentPlan = String(p.plan_id ?? "").trim();
        if (!currentPlan || !validPlanIds.has(currentPlan)) { fail(res, "Plano inválido"); return; }
        const base = p.plan_expires_at && Date.parse(p.plan_expires_at) > Date.now() ? Date.parse(p.plan_expires_at) : Date.now();
        const newExpiry = planExpiresAt(cp, currentPlan, base);
        await execute("UPDATE profiles SET plan_expires_at=$1, updated_at=NOW() WHERE user_id=$2", [newExpiry, tid]);
        await appendAudit("extend_plan", userId, tid, { plan_id: currentPlan, plan_expires_at: newExpiry });
        ok(res, { success: true, plan_expires_at: newExpiry }); return;
      }
      if (action === "set_plan_expiry") {
        const tid = String(params.user_id ?? ""); const rawDate = params.expires_at;
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; }
        const roleRow = await queryOne("SELECT role FROM user_roles WHERE user_id=$1", [tid]);
        if (String(roleRow?.role ?? "user") === "admin") { fail(res, "Admins não possuem vencimento de plano."); return; }
        let expiresAt = null;
        if (rawDate !== null && rawDate !== undefined && rawDate !== "" && rawDate !== "never") {
          const ms = Date.parse(String(rawDate));
          if (!Number.isFinite(ms)) { fail(res, "Data de vencimento inválida"); return; }
          expiresAt = new Date(ms).toISOString();
        }
        await execute("UPDATE profiles SET plan_expires_at=$1, updated_at=NOW() WHERE user_id=$2", [expiresAt, tid]);
        await appendAudit("set_plan_expiry", userId, tid, { plan_expires_at: expiresAt });
        ok(res, { success: true, plan_expires_at: expiresAt }); return;
      }
      if (action === "reset_password") {
        const tid = String(params.user_id ?? ""); const pwd = String(params.password ?? "").trim();
        const resetPasswordError = getPasswordPolicyError(pwd);
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; } if (resetPasswordError) { fail(res, resetPasswordError); return; }
        const hash = await bcrypt.hash(pwd, 10);
        // Inválidate all existing tokens immediately â€” the account must be secured after password reset
        await execute("UPDATE users SET password_hash=$1, token_inválidated_before=NOW(), updated_at=NOW() WHERE id=$2", [hash, tid]);
        await appendAudit("reset_password", userId, tid, {});
        ok(res, { success: true }); return;
      }
      if (action === "add_billing_note") {
        const tid = String(params.user_id ?? ""); const reason = String(params.reason ?? "").trim();
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; } if (!reason) { fail(res, "Motivo obrigatório"); return; }
        const noteType = ["refund","credit","note"].includes(String(params.note_type)) ? String(params.note_type) : "note";
        await appendAudit(`billing_${noteType}`, userId, tid, { note_type: noteType, amount: Number(params.amount ?? 0), reason });
        ok(res, { success: true }); return;
      }
      fail(res, "Ação administrativa inválida"); return;
    }

    // â”€â”€ account-plan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "account-plan") {
      const action = String(params.action ?? "");
      if (action !== "change_plan") { fail(res, "Ação de conta inválida"); return; }
      if (userIsAdmin) { fail(res, "Conta admin não possui plano de assinatura."); return; }
      const nextPlanId = String(params.plan_id ?? "").trim(); if (!nextPlanId) { fail(res, "Plano obrigatório"); return; }
      const cp = await loadControlPlane();
      const plans = Array.isArray(cp.plans) ? cp.plans : [];
      const targetPlan = plans.find((p) => String(p.id) === nextPlanId);
      // Only allow self-service if the plan is explicitly marked allowSelfServiceChange.
      // Upgrades to paid plans must go through the admin panel (prevents free upgrades).
      if (!targetPlan || !targetPlan.isActive || !targetPlan.visibleInAccount || !targetPlan.allowSelfServiceChange) { fail(res, "Troca de plano requer ação do administrador. Entre em contato com o suporte em suporte@autolinks.pro."); return; }
      const profile = await queryOne("SELECT * FROM profiles WHERE user_id=$1", [userId]);
      if (!profile) { fail(res, "Perfil não encontrado"); return; }
      const newExpiry = planExpiresAt(cp, nextPlanId);
      await execute("UPDATE profiles SET plan_id=$1, plan_expires_at=$2, updated_at=NOW() WHERE user_id=$3", [nextPlanId, newExpiry, userId]);
      await execute("INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'session_event','Conta','Plano','success',$3,'system','text','processed','','')",
        [uuid(), userId, JSON.stringify({ message: `Plano alterado para ${targetPlan.name}`, plan_id: nextPlanId })]);
      ok(res, { success: true, plan_id: nextPlanId, plan_expires_at: newExpiry }); return;
    }

    fail(res, `Função não implementada: ${funcName}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[rpc] ${funcName} error:`, msg);
    res.status(500).json({ data: null, error: { message: msg } });
  }
});


