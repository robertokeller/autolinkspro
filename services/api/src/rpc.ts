import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { pool, query, queryOne, execute, transaction } from "./db.js";
import { requireAuth, signToken, setSessionCookie } from "./auth.js";
import { getPasswordPolicyError } from "./password-policy.js";
import { decryptCredential, encryptCredential } from "./credential-cipher.js";
import { consumeRateLimit } from "./rate-limit-store.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { getMeliProductSnapshot, listMeliVitrine, syncMeliVitrine } from "./meli-vitrine.js";
import { getAmazonProductSnapshot, listAmazonVitrine, syncAmazonVitrine } from "./amazon-vitrine.js";
import { getDisposableEmailError } from "./disposable-email.js";
import { bustGlobalTableCache } from "./cache.js";
import {
  loadKiwifyConfig, saveKiwifyConfig, clearKiwifyConfigCache,
  kiwifyGetAccountDetails, kiwifyListProducts, kiwifyGetProduct,
  kiwifyListSales, kiwifyGetSale, kiwifyRefundSale,
  kiwifyGetStats, kiwifyGetBalance,
  kiwifyListAffiliates, kiwifyGetAffiliate, kiwifyEditAffiliate,
  kiwifyListWebhooks, kiwifyCreateWebhook, kiwifyDeleteWebhook,
  loadPlanMappings, savePlanMapping, deletePlanMapping,
  KIWIFY_WEBHOOK_TRIGGERS,
} from "./kiwify/client.js";
import { listKiwifyTransactions, linkKiwifyTransactionToUser } from "./kiwify/admin-service.js";
import { listManualOverrideUsers, resumeAutoSyncForUsers } from "./kiwify/manual-override-service.js";
import { logAudit } from "./audit.js";
import { setManualPlanOverride, setAutoPlanSync } from "./plan-sync.js";

// Helper to log admin actions in RPC
async function auditRpcAction(req: Request, action: string, resourceType: string, resourceId?: string, details?: Record<string, unknown>): Promise<void> {
  const actorUserId = req.currentUser?.sub;
  const isAdmin = req.currentUser?.role === "admin" || req.currentUser?.isService;
  if (!isAdmin || !actorUserId) return; // Only audit admin and service actions

  try {
    await logAudit({
      action: action as Parameters<typeof logAudit>[0]["action"],
      actor_user_id: actorUserId,
      target_user_id: (details?.targetUserId as string | undefined) ?? actorUserId,
      resource_type: resourceType,
      resource_id: resourceId,
      details,
      ip_address: req.ip,
      user_agent: req.headers?.["user-agent"],
    });
  } catch (auditErr) {
    console.error("[rpc] audit failed:", auditErr);
  }
}

export const rpcRouter = Router();
// Public RPC is opt-in only. Enable explicitly via ALLOW_PUBLIC_RPC=true.
const _IS_PROD_FOR_RPC = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
const ALLOW_PUBLIC_RPC = String(process.env.ALLOW_PUBLIC_RPC ?? "false").trim().toLowerCase() === "true";
const IS_PRODUCTION = _IS_PROD_FOR_RPC;

if (IS_PRODUCTION && !ALLOW_PUBLIC_RPC) {
  console.warn("[rpc] ALLOW_PUBLIC_RPC=false: public Link Hub and master-group invite pages are disabled");
}

const MAX_URL_LENGTH = Math.max(256, Number(process.env.MAX_URL_LENGTH || "2048") || 2048);
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const OPS_TOKEN = String(process.env.OPS_CONTROL_TOKEN || process.env.OPS_TOKEN || "").trim();

const WHATSAPP_URL = String(
  process.env.WHATSAPP_MICROSERVICE_URL || process.env.WHATSAPP_URL || "",
).trim().replace(/\/$/, "");
const TELEGRAM_URL = String(
  process.env.TELEGRAM_MICROSERVICE_URL || process.env.TELEGRAM_URL || "",
).trim().replace(/\/$/, "");
const SHOPEE_URL = String(
  process.env.SHOPEE_MICROSERVICE_URL || process.env.SHOPEE_URL || "",
).trim().replace(/\/$/, "");
const MELI_URL = String(
  process.env.MELI_RPA_URL || process.env.MELI_URL || "",
).trim().replace(/\/$/, "");
const AMAZON_URL = String(
  process.env.AMAZON_MICROSERVICE_URL || process.env.AMAZON_URL || "",
).trim().replace(/\/$/, "");
const OPS_URL = String(process.env.OPS_CONTROL_URL || "").trim().replace(/\/$/, "");

const MAX_SHOPEE_CONVERT_BATCH = Math.max(1, Math.min(500, Number(process.env.MAX_SHOPEE_CONVERT_BATCH || "200") || 200));
const MAX_SHOPEE_BATCH_QUERIES = Math.max(1, Math.min(100, Number(process.env.MAX_SHOPEE_BATCH_QUERIES || "25") || 25));
const MAX_MELI_CONVERT_BATCH = Math.max(1, Math.min(500, Number(process.env.MAX_MELI_CONVERT_BATCH || "200") || 200));

const MAX_MELI_COOKIES_PER_SESSION = Math.max(1, Math.min(200, Number(process.env.MAX_MELI_COOKIES_PER_SESSION || "80") || 80));
const MAX_MELI_COOKIE_NAME_LENGTH = Math.max(8, Math.min(256, Number(process.env.MAX_MELI_COOKIE_NAME_LENGTH || "120") || 120));
const MAX_MELI_COOKIE_VALUE_LENGTH = Math.max(64, Math.min(8192, Number(process.env.MAX_MELI_COOKIE_VALUE_LENGTH || "4096") || 4096));

const PLAN_EXPIRY_ALLOWED = new Set([
  "account-plan",
  "admin-users",
  "link-hub-public",
  "admin-announcements",
  "user-notifications",
  "admin-wa-broadcast",
  "admin-message-automations",
]);

// â”€â”€ Public: link-hub pages (no authentication required) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
rpcRouter.post("/rpc", async (req, res, next) => {
  if (String(req.body?.name ?? "") !== "link-hub-public") { next(); return; }
  const requesterUserId = String(req.currentUser?.sub ?? "").trim();
  const requesterIsPrivileged = req.currentUser?.role === "admin" || req.currentUser?.isService === true;
  if (!ALLOW_PUBLIC_RPC && !requesterUserId) {
    res.status(401).json({ data: null, error: { message: "Autenticação obrigatória" } });
    return;
  }
  const params = req.body ?? {};
  const slug = String(params.slug ?? "").trim();
  if (!slug) { res.json({ data: null, error: { message: "Slug obrigatório" } }); return; }
  try {
    const page = await queryOne("SELECT slug, title, config, is_active, user_id FROM link_hub_pages WHERE slug = $1 AND is_active = TRUE", [slug]);
    if (!page) { res.json({ data: { page: null, groups: [], groupLabels: {} }, error: null }); return; }
    const ownerUserId = String(page.user_id || "").trim();
    if (!ALLOW_PUBLIC_RPC && !requesterIsPrivileged && requesterUserId !== ownerUserId) {
      res.status(403).json({ data: null, error: { message: "Acesso negado" } });
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
  const requesterUserId = String(req.currentUser?.sub ?? "").trim();
  const requesterIsPrivileged = req.currentUser?.role === "admin" || req.currentUser?.isService === true;
  if (!ALLOW_PUBLIC_RPC && !requesterUserId) {
    res.status(401).json({ data: null, error: { message: "Autenticação obrigatória" } });
    return;
  }

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

    if (!ALLOW_PUBLIC_RPC && !requesterIsPrivileged && requesterUserId !== String(masterGroup.user_id || "").trim()) {
      res.status(403).json({ data: null, error: { message: "Acesso negado" } });
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

    const mode = String(masterGroup.distribution ?? "random").trim().toLowerCase() === "balanced"
      ? "balanced"
      : "random";
    const selected = mode === "balanced"
      ? [...candidates].sort((a, b) => Number(a.member_count ?? 0) - Number(b.member_count ?? 0))[0]
      : candidates[Math.floor(Math.random() * candidates.length)];

    res.json({
      data: {
        redirectUrl: String(selected.redirect_url),
        group: {
          id: String(selected.id),
          name: String(selected.name ?? "Grupo"),
          platform: String(selected.platform ?? "whatsapp"),
          memberCount: Number(selected.member_count ?? 0),
        },
        mode,
        masterGroup: {
          id: String(masterGroup.id),
          name: String(masterGroup.name ?? "Grupo Mestre"),
        },
      },
      error: null,
    });
  } catch {
    res.status(500).json({ data: null, error: { message: "Erro interno" } });
  }
});

const MAX_MELI_COOKIE_DOMAIN_LENGTH = 255;
const MAX_MELI_COOKIE_PATH_LENGTH = 512;
const MELI_COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MELI_COOKIE_DOMAIN_PATTERN = /^[A-Za-z0-9.-]+$/;
// eslint-disable-next-line no-control-regex -- explicit control-char guard for cookie metadata validation
const MELI_COOKIE_CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex -- explicit NUL/CR/LF guard for cookie value sanitization
const MELI_COOKIE_VALUE_FORBIDDEN_PATTERN = /[;\r\n\u0000]/;
const MELI_COOKIE_RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MERCADO_LIVRE_ALLOWED_URL_HOSTS = new Set([
  "meli.la",
  "mlb.am",
  "mercadolivre.com",
  "mercadolivre.com.br",
  "mercadolibre.com",
  "mercadolibre.com.ar",
  "mercadolibre.com.mx",
  "mercadolibre.com.co",
  "mercadolibre.com.cl",
  "mercadolibre.com.uy",
  "mercadolibre.com.pe",
  "mercadolibre.com.ve",
  "mercadolibre.com.ec",
  "mercadolibre.com.bo",
  "mercadopago.com",
  "mercadopago.com.br",
  "mercadopago.com.ar",
  "mercadopago.com.mx",
  "mlstatic.com",
]);
const MERCADO_LIVRE_ALLOWED_COOKIE_DOMAINS = new Set([
  "mercadolivre.com.br",
  "www.mercadolivre.com.br",
  "myaccount.mercadolivre.com.br",
  "auth.mercadolivre.com.br",
  "mercadopago.com.br",
  "www.mercadopago.com.br",
  "mercadolibre.com",
  "www.mercadolibre.com",
  "auth.mercadolibre.com",
  "meli.la",
  "www.meli.la",
]);
const MELI_HEALTH_SESSION_RECHECK_MS = Math.max(
  60_000,
  Number(process.env.MELI_HEALTH_SESSION_RECHECK_MS || "300000"),
);
const ROUTE_MEDIA_DEBUG_ENABLED = new Set(["1", "true", "yes", "on"]).has(
  String(process.env.ROUTE_MEDIA_DEBUG || "").trim().toLowerCase(),
);
const TELEGRAM_BACKFILL_BATCH_LIMIT = Math.max(
  1,
  Math.min(25, Number(process.env.TELEGRAM_BACKFILL_BATCH_LIMIT || "10") || 10),
);
const TELEGRAM_BACKFILL_WINDOW_HOURS = Math.max(
  1,
  Math.min(168, Number(process.env.TELEGRAM_BACKFILL_WINDOW_HOURS || "24") || 24),
);
const TELEGRAM_BACKFILL_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.TELEGRAM_BACKFILL_TIMEOUT_MS || "30000") || 30_000,
);
const BCRYPT_COST = (() => {
  const parsed = Number(process.env.BCRYPT_COST ?? "12");
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(10, Math.min(14, Math.trunc(parsed)));
})();

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
  "amazon-automation-run": {
    max: 6,
    windowMs: 60_000,
    message: "Muitas execucoes de piloto automatico Amazon. Aguarde 1 minuto.",
  },
  "meli-vitrine-sync": {
    max: 6,
    windowMs: 60_000,
    message: "Muitas atualizacoes da vitrine ML. Aguarde 1 minuto.",
  },
  "amazon-vitrine-sync": {
    max: 6,
    windowMs: 60_000,
    message: "Muitas atualizacoes da vitrine Amazon. Aguarde 1 minuto.",
  },
  "amazon-convert-link": {
    max: 40,
    windowMs: 60_000,
    message: "Limite de conversão Amazon atingido. Aguarde 1 minuto.",
  },
  "amazon-product-snapshot": {
    max: 40,
    windowMs: 60_000,
    message: "Limite de consultas Amazon atingido. Aguarde 1 minuto.",
  },
  "amazon-convert-links": {
    max: 12,
    windowMs: 60_000,
    message: "Limite de lote Amazon atingido. Aguarde 1 minuto.",
  },
  "marketplace-convert-link": {
    max: 60,
    windowMs: 60_000,
    message: "Limite do conversor global atingido. Aguarde 1 minuto.",
  },
};

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

function normalizeHostname(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

function hostMatchesAllowlist(hostname: string, allowlist: Set<string>): boolean {
  const host = normalizeHostname(hostname).replace(/^www\./, "");
  if (!host) return false;
  if (allowlist.has(host)) return true;
  for (const allowed of allowlist) {
    if (host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

function isMercadoLivreUrlHost(hostname: string): boolean {
  return hostMatchesAllowlist(hostname, MERCADO_LIVRE_ALLOWED_URL_HOSTS);
}

function isMercadoLivreCookieDomain(domain: string): boolean {
  return hostMatchesAllowlist(domain, MERCADO_LIVRE_ALLOWED_COOKIE_DOMAINS);
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
  return isMercadoLivreUrlHost(parsed.hostname);
}

function isAmazonProductUrlLike(raw: string): boolean {
  const parsed = parseHttpUrl(raw);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return host === "amazon.com.br" || host.endsWith(".amazon.com.br");
}

type AffiliateMarketplace = "shopee" | "mercadolivre" | "amazon";

function detectAffiliateMarketplace(raw: string): AffiliateMarketplace | null {
  if (isAmazonProductUrlLike(raw)) return "amazon";
  if (isMercadoLivreProductUrlLike(raw)) return "mercadolivre";
  if (isShopeeProductUrlLike(raw)) return "shopee";
  const routeMarketplace = detectRoutePartnerMarketplace(raw);
  if (routeMarketplace === "shopee" || routeMarketplace === "mercadolivre") return routeMarketplace;
  return null;
}

function extractAmazonAsin(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const match = parsed.pathname.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i);
  return match?.[1] || null;
}

function extractAmazonPreservedParams(url: string): Record<string, string> {
  const parsed = parseHttpUrl(url);
  if (!parsed) return {};
  const params: Record<string, string> = {};
  const allowedParams = new Set(["psc", "smid", "th"]);
  for (const [key, value] of parsed.searchParams.entries()) {
    if (allowedParams.has(key)) {
      params[key] = String(value || "");
    }
  }
  return params;
}

function canonicalizeAmazonProductUrl(raw: string): string | null {
  const source = String(raw || "").trim();
  if (!source) return null;
  const normalized = /^https?:\/\//i.test(source) ? source : `https://${source}`;
  const parsed = parseHttpUrl(normalized);
  if (!parsed) return null;
  if (!isAmazonProductUrlLike(parsed.toString())) return null;

  const asin = String(extractAmazonAsin(parsed.toString()) || "").trim().toUpperCase();
  if (asin) {
    parsed.pathname = `/dp/${asin}`;
  }

  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function buildAmazonAffiliateLink(asin: string, preservedParams: Record<string, string>, userTag: string): string {
  const base = `https://www.amazon.com.br/dp/${asin}`;
  const queryParts: string[] = [];
  for (const [key, value] of Object.entries(preservedParams)) {
    if (value && value.trim()) {
      queryParts.push(`${key}=${encodeURIComponent(value)}`);
    }
  }
  queryParts.push(`tag=${encodeURIComponent(userTag)}`);
  return `${base}?${queryParts.join("&")}`;
}

type AmazonAffiliateConversionResult = {
  sourceUrl: string;
  resolvedUrl: string;
  affiliateLink: string;
  asin: string;
  userTag: string;
};

async function getAmazonAffiliateTagForUser(userId: string): Promise<string> {
  const tagRow = await queryOne<{ affiliate_tag: string }>(
    "SELECT affiliate_tag FROM amazon_affiliate_tags WHERE user_id = $1",
    [userId],
  );
  return String(tagRow?.affiliate_tag || "").trim();
}

async function buildAmazonAffiliateConversionForUser(
  userId: string,
  rawUrl: string,
): Promise<AmazonAffiliateConversionResult> {
  const sourceUrl = String(rawUrl || "").trim();
  if (!sourceUrl) {
    throw new Error("URL Amazon obrigatoria");
  }
  if (sourceUrl.length > MAX_URL_LENGTH) {
    throw new Error("URL Amazon excede o tamanho maximo permitido");
  }
  if (!isAmazonProductUrlLike(sourceUrl)) {
    throw new Error("URL informada não parece ser da Amazon (deve ser amazon.com.br)");
  }

  const asin = String(extractAmazonAsin(sourceUrl) || "").trim().toUpperCase();
  if (!asin) {
    throw new Error("Não consegui extrair o ASIN da URL. Verifique se é um produto da Amazon.");
  }

  const userTag = await getAmazonAffiliateTagForUser(userId);
  if (!userTag) {
    throw new Error("Configure sua tag de afiliado em /amazon/configuracoes");
  }

  const preservedParams = extractAmazonPreservedParams(sourceUrl);
  const affiliateLink = buildAmazonAffiliateLink(asin, preservedParams, userTag);
  if (!affiliateLink.includes(`tag=${encodeURIComponent(userTag)}`)) {
    throw new Error("Falha ao construir link de afiliado. Tente novamente.");
  }

  return {
    sourceUrl,
    resolvedUrl: sourceUrl,
    affiliateLink,
    asin,
    userTag,
  };
}

// Per-function rate limits are DB-backed (shared across PM2 cluster workers).
// Falls back to a per-worker in-memory limiter if the DB store is unavailable
// to prevent abuse during database outages.
const _memBucket: Map<string, { count: number; resetAt: number }> = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _memBucket) { if (v.resetAt <= now) _memBucket.delete(k); }
}, 5 * 60_000).unref();

async function consumeRpcFunctionRateLimit(scopeKey: string, funcName: string): Promise<{ allowed: boolean; policy: RpcRatePolicy | null; retryAfterSec: number }> {
  const policy = RPC_RATE_BY_FUNCTION[funcName] ?? null;
  if (!policy) return { allowed: true, policy: null, retryAfterSec: 0 };
  try {
    const result = await consumeRateLimit({
      namespace: `rpc:${funcName}`,
      scopeKey,
      max: policy.max,
      windowMs: policy.windowMs,
    });
    return { allowed: result.allowed, policy, retryAfterSec: result.retryAfterSec };
  } catch {
    // DB-backing store unavailable — fall back to in-memory limiter (fail-closed)
    const now = Date.now();
    const bucketKey = `rpc:${funcName}:${scopeKey}`;
    const existing = _memBucket.get(bucketKey);
    if (existing && existing.resetAt > now) {
      if (existing.count >= policy.max) {
        const retryAfterSec = Math.ceil((existing.resetAt - now) / 1000);
        return { allowed: false, policy, retryAfterSec };
      }
      existing.count++;
      return { allowed: true, policy, retryAfterSec: 0 };
    }
    _memBucket.set(bucketKey, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true, policy, retryAfterSec: 0 };
  }
}

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

const ROUTE_QUIET_HOURS_DEFAULT_START = "22:00";
const ROUTE_QUIET_HOURS_DEFAULT_END = "08:00";
const ROUTE_QUIET_HOURS_SCHEDULE_SOURCE = "route_quiet_hours";

function normalizeClockTimeForRules(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return fallback;

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return fallback;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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

function isInRouteQuietHoursWindow(startTime: unknown, endTime: unknown, date = new Date()): boolean {
  const nowMinutes = nowMinutesInTimeZone(date);
  const startMinutes = parseTimeToMinutes(startTime, 22 * 60);
  const endMinutes = parseTimeToMinutes(endTime, 8 * 60);
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function minutesUntilRouteQuietHoursEnd(startTime: unknown, endTime: unknown, date = new Date()): number {
  if (!isInRouteQuietHoursWindow(startTime, endTime, date)) return 0;

  const nowMinutes = nowMinutesInTimeZone(date);
  const startMinutes = parseTimeToMinutes(startTime, 22 * 60);
  const endMinutes = parseTimeToMinutes(endTime, 8 * 60);

  let diff = 0;
  if (startMinutes < endMinutes) {
    diff = endMinutes - nowMinutes;
  } else if (nowMinutes >= startMinutes) {
    diff = (24 * 60 - nowMinutes) + endMinutes;
  } else {
    diff = endMinutes - nowMinutes;
  }

  return Math.max(1, diff);
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

function readAutomationDeliverySessionId(row: { config?: unknown; session_id?: unknown } | null | undefined): string {
  if (!row || typeof row !== "object") return "";
  const config = row.config && typeof row.config === "object" && !Array.isArray(row.config)
    ? row.config as Record<string, unknown>
    : {};
  const configSessionId = String(config.deliverySessionId || "").trim();
  if (configSessionId) return configSessionId;
  return String(row.session_id || "").trim();
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

// Only allow placeholder tokens with simple names so we can safely build
// replacement regexes without accepting arbitrary patterns.
const ALLOWED_PLACEHOLDER_TOKEN = /^[\wáéíóúãõâêôçÁÉÍÓÚÃÕÂÊÔÇ-]{1,64}$/;

function normalizePlaceholderToken(key: string): string | null {
  const normalized = String(key || "").trim();
  if (!normalized) return null;

  const stripped = normalized
    .replace(/^\{\{?/, "")
    .replace(/\}\}?$/, "")
    .trim();

  if (!stripped || !ALLOWED_PLACEHOLDER_TOKEN.test(stripped)) return null;
  return stripped;
}

function applyPlaceholders(template: string, replacements: Record<string, string>): string {
  let output = String(template || "");
  const orderedReplacements = Object.entries(replacements)
    .sort((left, right) => right[0].length - left[0].length);

  for (const [key, value] of orderedReplacements) {
    const token = normalizePlaceholderToken(key);
    if (!token) continue;

    const normalizedValue = String(value ?? "");
    const variants = [`{${token}}`, `{{${token}}}`];
    for (const variant of variants) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      output = output.replace(new RegExp(escaped, "g"), normalizedValue);
    }
  }
  return output;
}

const PLACEHOLDER_IMAGE_LINE_REGEX = /^[ \t]*(?:\{imagem\}|\{\{imagem\}\})[ \t]*(?:\r?\n|$)/gim;
const MELI_TEMPLATE_EMPTY_LINE_REGEX = /^[ \t]+$/gm;
const MELI_TEMPLATE_BLANK_PRICE_LINE_REGEX = /^[ \t]*De R\$\s*por R\$\s*$/gim;
const MELI_TEMPLATE_CURRENT_ONLY_PRICE_LINE_REGEX = /^[ \t]*De R\$\s*por R\$\s*([0-9]+(?:[.,][0-9]{2})?)\s*$/gim;
const MELI_TEMPLATE_EMPTY_STORE_LINE_REGEX = /^[ \t]*Loja:\s*$/gim;
const MELI_TEMPLATE_EMPTY_RATING_LINE_REGEX = /^[ \t]*Nota:\s*(?:\(\s*\))?\s*$/gim;
const MELI_TEMPLATE_PARTIAL_RATING_LINE_REGEX = /^[ \t]*Nota:\s*([0-9]+(?:[.,][0-9])?)\s*\(\s*\)\s*$/gim;

type TemplateScope = "shopee" | "meli" | "amazon";

function stripStandaloneImagePlaceholderLines(templateContent: string): string {
  return String(templateContent || "").replace(PLACEHOLDER_IMAGE_LINE_REGEX, "");
}

function applyMeliTemplatePlaceholdersServer(
  templateContent: string,
  placeholderData: Record<string, string>,
): string {
  const replaced = applyPlaceholders(stripStandaloneImagePlaceholderLines(templateContent), {
    ...(placeholderData || {}),
    "{imagem}": "",
    "{{imagem}}": "",
  });

  return replaced
    .replace(MELI_TEMPLATE_CURRENT_ONLY_PRICE_LINE_REGEX, "R$ $1")
    .replace(MELI_TEMPLATE_BLANK_PRICE_LINE_REGEX, "")
    .replace(MELI_TEMPLATE_EMPTY_STORE_LINE_REGEX, "")
    .replace(MELI_TEMPLATE_EMPTY_RATING_LINE_REGEX, "")
    .replace(MELI_TEMPLATE_PARTIAL_RATING_LINE_REGEX, "Nota: $1")
    .replace(MELI_TEMPLATE_EMPTY_LINE_REGEX, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function applyAmazonTemplatePlaceholdersServer(
  templateContent: string,
  placeholderData: Record<string, string>,
): string {
  const source = placeholderData || {};
  const readPlaceholder = (...keys: string[]): string => {
    for (const key of keys) {
      const value = String(source[key] || "").trim();
      if (value) return value;
    }
    return "";
  };
  const title = readPlaceholder("{titulo}", "{título}");
  const price = readPlaceholder("{preco}", "{preço}");
  const oldPrice = readPlaceholder("{preco_original}", "{preço_original}");
  const badgeText = readPlaceholder("{selo}");
  const asin = readPlaceholder("{asin}");

  const replaced = applyPlaceholders(stripStandaloneImagePlaceholderLines(templateContent), {
    ...source,
    "{titulo}": title,
    "{título}": title,
    "{preco}": price,
    "{preço}": price,
    "{preco_original}": oldPrice,
    "{preço_original}": oldPrice,
    "{imagem}": "",
    "{{imagem}}": "",
    "{selo}": badgeText,
    "{{selo}}": badgeText,
    "{asin}": asin,
    "{{asin}}": asin,
  });

  return replaced
    .replace(/^[ \t]*De R\$\s*por R\$\s*$/gim, "")
    .replace(/^[ \t]*De R\$\s*por R\$\s*([0-9]+(?:[.,][0-9]{2})?)\s*$/gim, "R$ $1")
    .replace(/^[ \t]*(?:Loja|Vendedor|Selo|ASIN|Parcelamento):\s*$/gim, "")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTemplateScope(value: unknown): TemplateScope | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "amazon") return "amazon";
  if (raw === "meli" || raw === "mercadolivre") return "meli";
  if (raw === "shopee") return "shopee";
  return null;
}

function extractTemplateScopeFromTags(tags: unknown): TemplateScope | null {
  if (!Array.isArray(tags)) return null;

  for (const item of tags) {
    const normalized = String(item || "").trim().toLowerCase();
    if (!normalized.startsWith("scope:")) continue;
    const parsed = normalizeTemplateScope(normalized.slice("scope:".length));
    if (parsed) return parsed;
  }

  return null;
}

function inferTemplateScopeFromTemplateRow(row: Record<string, unknown> | null | undefined): TemplateScope {
  if (!row) return "shopee";
  const fromTags = extractTemplateScopeFromTags(row.tags);
  if (fromTags) return fromTags;

  const fromScope = normalizeTemplateScope(row.scope);
  return fromScope || "shopee";
}

function inferTemplateScopeFromScheduleSource(value: unknown): TemplateScope | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes("amazon")) return "amazon";
  if (raw.includes("meli") || raw.includes("mercado")) return "meli";
  if (raw.includes("shopee")) return "shopee";
  return null;
}

function applyScopedTemplatePlaceholders(
  scope: TemplateScope,
  templateContent: string,
  placeholderData: Record<string, string>,
): string {
  if (scope === "amazon") {
    return applyAmazonTemplatePlaceholdersServer(templateContent, placeholderData);
  }
  if (scope === "meli") {
    return applyMeliTemplatePlaceholdersServer(templateContent, placeholderData);
  }

  return applyPlaceholders(stripStandaloneImagePlaceholderLines(templateContent), {
    ...(placeholderData || {}),
    "{imagem}": "",
    "{{imagem}}": "",
  });
}

async function resolveAutomationTemplateForScope(input: {
  userId: string;
  templateId: string;
  scope: TemplateScope;
}): Promise<{ id: string; name: string; content: string; is_default: boolean } | null> {
  const rows = await query<{
    id: string;
    name: string;
    content: string;
    is_default: boolean;
    scope: string | null;
    tags: unknown;
    created_at: string | null;
  }>(
    `SELECT id, name, content, is_default, scope, tags, created_at
       FROM templates
      WHERE user_id = $1
        AND ($2::uuid IS NULL OR id = $2 OR is_default = TRUE)
      ORDER BY CASE WHEN id = $2 THEN 0 WHEN is_default = TRUE THEN 1 ELSE 2 END,
               created_at DESC
      LIMIT 25`,
    [input.userId, input.templateId || null],
  );

  const scopedRows = rows.filter((row) => inferTemplateScopeFromTemplateRow(row as unknown as Record<string, unknown>) === input.scope);
  if (input.templateId) {
    const exact = scopedRows.find((row) => String(row.id || "").trim() === input.templateId);
    if (exact) return exact;
  }

  return scopedRows.find((row) => row.is_default === true) || scopedRows[0] || null;
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
  sourceText = "",
): Record<string, string> {
  const source = product && typeof product === "object" ? product : {};
  const sourceMessage = String(sourceText || "");

  const extractFirstUsefulTitle = (text: string): string => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^https?:\/\//i.test(line));

    for (const line of lines) {
      const cleaned = line
        .replace(/[*_~`]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (cleaned.length >= 3) return cleaned;
    }

    return "";
  };

  const parseMoneyToNumber = (raw: string): number => {
    const normalized = String(raw || "").replace(/\./g, "").replace(",", ".").trim();
    const value = Number(normalized);
    return Number.isFinite(value) ? value : Number.NaN;
  };

  const extractPriceFallback = (text: string): { sale: number; original: number } => {
    const dePorMatch = text.match(/de\s*r\$\s*([0-9.,]+)\s*por\s*r\$\s*([0-9.,]+)/i);
    if (dePorMatch?.[1] && dePorMatch?.[2]) {
      const original = parseMoneyToNumber(dePorMatch[1]);
      const sale = parseMoneyToNumber(dePorMatch[2]);
      if (Number.isFinite(sale) || Number.isFinite(original)) {
        return { sale, original };
      }
    }

    const values = [...text.matchAll(/r\$\s*([0-9]+(?:[.,][0-9]{2})?)/gi)]
      .map((match) => parseMoneyToNumber(match[1] || ""))
      .filter((value) => Number.isFinite(value) && value > 0);

    if (values.length === 0) return { sale: Number.NaN, original: Number.NaN };
    if (values.length === 1) return { sale: values[0], original: values[0] };

    const first = values[0];
    const second = values[1];
    if (first > second) return { sale: second, original: first };
    return { sale: first, original: second };
  };

  const extractPercentFallback = (text: string): number => {
    const matches = [...text.matchAll(/(\d{1,2})\s*%/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 99);
    return matches.length > 0 ? matches[0] : 0;
  };

  const extractRatingFallback = (text: string): number => {
    const explicit = text.match(/nota\s*[:-]?\s*([0-5](?:[.,][0-9])?)/i);
    if (explicit?.[1]) {
      const value = Number(explicit[1].replace(",", "."));
      if (Number.isFinite(value) && value > 0) return value;
    }

    const starred = text.match(/([0-5](?:[.,][0-9])?)\s*(?:⭐|estrel|rating)/i);
    if (starred?.[1]) {
      const value = Number(starred[1].replace(",", "."));
      if (Number.isFinite(value) && value > 0) return value;
    }

    return 0;
  };

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

  const parsedPriceFallback = extractPriceFallback(sourceMessage);
  const fallbackSalePrice = parsedPriceFallback.sale;
  const fallbackOriginalPrice = parsedPriceFallback.original;

  const resolvedSalePrice = Number.isFinite(salePrice) && salePrice > 0
    ? salePrice
    : fallbackSalePrice;
  const resolvedOriginalPrice = Number.isFinite(originalPrice) && originalPrice > 0
    ? originalPrice
    : (Number.isFinite(fallbackOriginalPrice) && fallbackOriginalPrice > 0
      ? fallbackOriginalPrice
      : resolvedSalePrice);

  const formatPrice = (value: number) => (Number.isFinite(value) && value > 0 ? value.toFixed(2) : "");

  const discountFromProduct = toNumber(source.discount ?? source.priceDiscountRate, 0);
  const discountComputed = Number.isFinite(resolvedOriginalPrice) && Number.isFinite(resolvedSalePrice) && resolvedOriginalPrice > resolvedSalePrice
    ? Math.round((1 - resolvedSalePrice / resolvedOriginalPrice) * 100)
    : 0;
  const discountFallback = extractPercentFallback(sourceMessage);
  const discount = Math.max(0, discountFromProduct || discountComputed || discountFallback);

  const title = String(source.title ?? source.productName ?? "").trim() || extractFirstUsefulTitle(sourceMessage);
  const link = String(
    affiliateLink
      || source.affiliateLink
      || source.offerLink
      || source.link
      || source.productLink
      || "",
  ).trim();
  const rating = toNumber(source.rating ?? source.ratingStar, 0) || extractRatingFallback(sourceMessage);

  return {
    "{titulo}": title,
    "{título}": title,
    "{preco}": formatPrice(resolvedSalePrice),
    "{preço}": formatPrice(resolvedSalePrice),
    "{preco_original}": formatPrice(resolvedOriginalPrice),
    "{preço_original}": formatPrice(resolvedOriginalPrice),
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
  return applyMeliTemplatePlaceholdersServer(templateContent, {
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

function formatAmazonTemplatePrice(value: unknown): string {
  const numeric = toNumber(value, 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return numeric.toFixed(2).replace(".", ",");
}

function normalizeAmazonTemplateInstallments(value: unknown): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = normalized.match(/(\d{1,2})x\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) return normalized.replace(/^ou\s+/i, "").trim();
  const suffix = /sem juros/i.test(normalized) ? " sem juros" : "";
  return `${match[1]}x de R$${match[2]}${suffix}`.trim();
}

function deriveAmazonAutomationDiscountText(product: Record<string, unknown>): string {
  const explicit = String(product.discountText || "").trim();
  if (explicit) return explicit;

  const price = toNumber(product.price, 0);
  const oldPrice = toNumber(product.oldPrice, 0);
  if (oldPrice > price && price > 0) {
    const percent = Math.round(((oldPrice - price) / oldPrice) * 100);
    if (Number.isFinite(percent) && percent > 0) return `${percent}% off`;
  }
  return "";
}

function buildAmazonAutomationMessage(templateContent: string, product: Record<string, unknown>, affiliateLink: string): string {
  const title = String(product.title || "Produto Amazon").trim();
  const price = formatAmazonTemplatePrice(product.price);
  const oldPrice = formatAmazonTemplatePrice(product.oldPrice);
  const discount = deriveAmazonAutomationDiscountText(product);
  const installments = normalizeAmazonTemplateInstallments(product.installmentsText);
  const seller = String(product.seller || "").trim();
  const badgeText = String(product.badgeText || product.badge_text || "").trim();
  const asin = String(
    product.asin
    || extractAmazonAsin(String(product.productUrl || product.product_url || ""))
    || "",
  ).trim().toUpperCase();
  const link = String(affiliateLink || "").trim();

  return applyAmazonTemplatePlaceholdersServer(templateContent, {
    "{titulo}": title,
    "{título}": title,
    "{preco}": price,
    "{preço}": price,
    "{preco_original}": oldPrice,
    "{preço_original}": oldPrice,
    "{desconto}": discount,
    "{parcelamento}": installments,
    "{vendedor}": seller,
    "{selo}": badgeText,
    "{asin}": asin,
    "{link}": link,
    "{imagem}": "",
    "{avaliacao}": toNumber(product.rating, 0) > 0 ? Number(toNumber(product.rating, 0)).toFixed(1) : "",
    "{avaliacoes}": toNumber(product.reviewsCount, 0) > 0 ? String(Math.floor(toNumber(product.reviewsCount, 0))) : "",
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
  messageType?: "text" | "image" | "video";
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

// Generic history_entries helper — use this for all new route/session events instead of
// inline SQL.  The existing insertAutomationHistoryEntry covers 'automation_run' (outbound).
// This helper covers 'route_forward' and 'session_event' (inbound / outbound).
async function insertHistoryEntry(input: {
  userId: string;
  type: "route_forward" | "session_event" | "automation_run";
  source: string;
  destination: string;
  status: "success" | "error" | "warning" | "info";
  details: Record<string, unknown>;
  direction: "inbound" | "outbound";
  messageType: "text" | "image" | "video" | string;
  processingStatus: "sent" | "processed" | "failed" | "blocked" | string;
  blockReason?: string;
  errorStep?: string;
}): Promise<void> {
  await execute(
    "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      uuid(),
      input.userId,
      input.type,
      input.source,
      input.destination,
      input.status,
      JSON.stringify(input.details),
      input.direction,
      input.messageType,
      input.processingStatus,
      input.blockReason ?? "",
      input.errorStep ?? "",
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

function unwrapAnalyticsPayload<T = unknown>(payload: unknown): T {
  if (!payload || typeof payload !== "object") return payload as T;
  if (!("data" in payload)) return payload as T;

  const wrapped = payload as Record<string, unknown>;
  return (wrapped.data ?? payload) as T;
}

function formatPermanenceMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function stripSessionIdQueryParam(pathWithQuery: string): string {
  const value = String(pathWithQuery || "");
  if (!value.includes("sessionId=")) return value;
  const [pathname, search = ""] = value.split("?");
  if (!search) return pathname;
  const params = new URLSearchParams(search);
  params.delete("sessionId");
  const next = params.toString();
  return next ? `${pathname}?${next}` : pathname;
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

function normalizeMeliSessionHealthStatus(rawStatus: unknown): string {
  const value = String(rawStatus || "").trim().toLowerCase();
  const allowed = new Set(["active", "expired", "error", "untested", "not_found", "no_affiliate"]);
  return allowed.has(value) ? value : "error";
}

function meliSessionHealthStatusMessage(status: string): string {
  const normalized = normalizeMeliSessionHealthStatus(status);
  if (normalized === "expired") return "Sessão Mercado Livre expirada. Atualize os cookies.";
  if (normalized === "error") return "Falha ao validar sessão Mercado Livre.";
  if (normalized === "not_found") return "Sessão Mercado Livre não encontrada.";
  if (normalized === "no_affiliate") return "Sessão válida, mas sem acesso ao programa de afiliados.";
  if (normalized === "untested") return "Sessão Mercado Livre ainda não testada.";
  return "";
}

function buildUserScopedHeaders(userId: string) {
  return { "x-autolinks-user-id": userId };
}

const MELI_SESSION_COOKIES_PROVIDER = "meli_session_cookies";
const LEGACY_MELI_AUTO_NAME_REGEX = /^conta\s+[0-9a-f]{8}$/i;
let meliSessionCookiesColumnAvailable: boolean | null = null;
let groupsAdminColumnsAvailable: boolean | null = null;
let groupMemberHistoryTableAvailable: boolean | null = null;
let groupMemberHistoryMissingPolicyWarningShown = false;
let groupMemberHistoryWriteBlockedWarningShown = false;
let groupMemberHistoryWriteBlocked = false;

function isLegacyMeliAutoSessionName(raw: unknown): boolean {
  return LEGACY_MELI_AUTO_NAME_REGEX.test(String(raw || "").trim());
}

function buildFriendlyMeliSessionName(sessionId: string, accountName: string): string {
  const normalizedAccountName = String(accountName || "").trim();
  if (normalizedAccountName) return `Conta ML - ${normalizedAccountName}`;

  const shortId = String(sessionId || "").trim().slice(0, 4).toUpperCase();
  return shortId ? `Conta principal ML (${shortId})` : "Conta principal ML";
}

type NormalizedMeliCookiePayload = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    expires?: number;
    sameSite?: "None" | "Lax" | "Strict";
  }>;
};

function normalizeMeliCookieSameSite(raw: unknown): "None" | "Lax" | "Strict" | undefined {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return undefined;
  if (value === "none") return "None";
  if (value === "strict") return "Strict";
  return "Lax";
}

function normalizeMeliCookiesPayload(raw: unknown): NormalizedMeliCookiePayload | null {
  if (raw == null) return null;

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (parsed == null || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed)) {
    const topLevelKeys = Object.keys(parsed as object);
    if (topLevelKeys.some((key) => MELI_COOKIE_RESERVED_KEYS.has(key))) {
      return null;
    }
  }

  const rawCookies = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? (parsed as { cookies: unknown[] }).cookies
      : null;
  if (!rawCookies || rawCookies.length === 0 || rawCookies.length > MAX_MELI_COOKIES_PER_SESSION) {
    return null;
  }

  const dedupe = new Set<string>();
  const normalized: NormalizedMeliCookiePayload["cookies"] = [];

  for (const entry of rawCookies) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => MELI_COOKIE_RESERVED_KEYS.has(key))) continue;

    const name = String(row.name ?? "").trim();
    const value = String(row.value ?? "");
    const domain = normalizeHostname(row.domain);
    const cookiePath = String(row.path ?? "/").trim() || "/";

    if (!name || !value || !domain) continue;
    if (name.length > MAX_MELI_COOKIE_NAME_LENGTH || !MELI_COOKIE_NAME_PATTERN.test(name)) continue;
    if (value.length > MAX_MELI_COOKIE_VALUE_LENGTH || MELI_COOKIE_VALUE_FORBIDDEN_PATTERN.test(value)) continue;
    if (MELI_COOKIE_CONTROL_CHAR_PATTERN.test(value)) continue;
    if (domain.length > MAX_MELI_COOKIE_DOMAIN_LENGTH || !MELI_COOKIE_DOMAIN_PATTERN.test(domain)) continue;
    if (!isMercadoLivreCookieDomain(domain)) continue;
    if (
      !cookiePath.startsWith("/")
      || cookiePath.length > MAX_MELI_COOKIE_PATH_LENGTH
      || MELI_COOKIE_CONTROL_CHAR_PATTERN.test(cookiePath)
    ) {
      continue;
    }

    const dedupeKey = `${name}::${domain}::${cookiePath}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    const normalizedCookie: NormalizedMeliCookiePayload["cookies"][number] = {
      name,
      value,
      domain,
      path: cookiePath,
      httpOnly: row.httpOnly === true,
      secure: row.secure === true,
    };
    const expires = Number(row.expires);
    if (Number.isFinite(expires) && expires > 0) {
      normalizedCookie.expires = expires;
    }
    const sameSite = normalizeMeliCookieSameSite(row.sameSite);
    if (sameSite) {
      normalizedCookie.sameSite = sameSite;
    }
    normalized.push(normalizedCookie);
  }

  if (normalized.length === 0) return null;
  return { cookies: normalized.slice(0, MAX_MELI_COOKIES_PER_SESSION) };
}

function normalizeComparableMessage(raw: unknown): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isMeliSessionFileMissingSignal(raw: unknown): boolean {
  const normalized = normalizeComparableMessage(raw);
  if (!normalized) return false;
  if (normalized.includes("storagestate_meli_")) return true;
  return (
    (normalized.includes("sessao") && (normalized.includes("nao encontrada") || normalized.includes("nao encontrado")))
    || (normalized.includes("arquivo de sessao") && normalized.includes("nao encontrado"))
    || (normalized.includes("session") && normalized.includes("not found"))
  );
}

function isMeliSessionNotFoundStatus(rawStatus: unknown): boolean {
  return normalizeMeliSessionHealthStatus(rawStatus) === "not_found";
}

type RehydrateMeliSessionResult = {
  restored: boolean;
  reason?: string;
};

async function hasMeliSessionCookiesColumn(): Promise<boolean> {
  if (meliSessionCookiesColumnAvailable != null) return meliSessionCookiesColumnAvailable;

  try {
    const row = await queryOne<{ has_column: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'meli_sessions'
           AND column_name = 'cookies_json'
       ) AS has_column`,
      [],
    );
    meliSessionCookiesColumnAvailable = row?.has_column === true;
  } catch {
    // Metadata checks can fail transiently (permissions/pooler/network).
    // Be optimistic so direct SELECT/UPDATE can still use cookies_json when available.
    // If the column is truly absent, direct queries already downgrade the cache to false.
    return true;
  }

  return meliSessionCookiesColumnAvailable;
}

async function hasGroupsAdminColumns(): Promise<boolean> {
  if (groupsAdminColumnsAvailable != null) return groupsAdminColumnsAvailable;

  try {
    const row = await queryOne<{ has_columns: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'groups'
              AND column_name = 'is_admin'
         )
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'groups'
              AND column_name = 'owner_jid'
         )
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'groups'
              AND column_name = 'invite_code'
         )
       ) AS has_columns`,
      [],
    );
    groupsAdminColumnsAvailable = row?.has_columns === true;
  } catch {
    // Prefer compatibility path when metadata cannot be read.
    groupsAdminColumnsAvailable = false;
  }

  return groupsAdminColumnsAvailable;
}

function isMissingGroupsAdminColumnsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown };
  const code = String(err.code ?? "").trim();
  const message = String(err.message ?? "").trim().toLowerCase();

  if (code === "42703" && (message.includes("is_admin") || message.includes("owner_jid") || message.includes("invite_code"))) {
    return true;
  }
  return (
    message.includes(`column "is_admin" of relation "groups" does not exist`)
    || message.includes(`column "owner_jid" of relation "groups" does not exist`)
    || message.includes(`column "invite_code" of relation "groups" does not exist`)
  );
}

async function hasGroupMemberHistoryTable(): Promise<boolean> {
  if (groupMemberHistoryTableAvailable != null) return groupMemberHistoryTableAvailable;
  try {
    const row = await queryOne<{ exists: boolean; has_policies: boolean }>(
      `SELECT
         EXISTS (
           SELECT 1
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'group_member_history_daily'
         ) AS exists,
         EXISTS (
           SELECT 1
             FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'group_member_history_daily'
         ) AS has_policies`,
      [],
    );
    const tableExists = row?.exists === true;
    const hasPolicies = row?.has_policies === true;
    if (tableExists && !hasPolicies && !groupMemberHistoryMissingPolicyWarningShown) {
      console.warn(
        "[analytics] group_member_history_daily exists but has no RLS policies; snapshot writes are disabled until migrations are applied.",
      );
      groupMemberHistoryMissingPolicyWarningShown = true;
    }
    groupMemberHistoryTableAvailable = tableExists && hasPolicies;
  } catch {
    groupMemberHistoryTableAvailable = false;
  }
  return groupMemberHistoryTableAvailable;
}

function isMissingGroupMemberHistoryTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown };
  const code = String(err.code ?? "").trim();
  const message = String(err.message ?? "").trim().toLowerCase();
  return (
    code === "42P01"
    || message.includes(`relation "group_member_history_daily" does not exist`)
  );
}

function isGroupMemberHistoryRlsPolicyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown };
  const code = String(err.code ?? "").trim();
  const message = String(err.message ?? "").trim().toLowerCase();
  if (code !== "42501") return false;
  return (
    message.includes("group_member_history_daily")
    && (
      message.includes("row-level security policy")
      || message.includes("permission denied")
    )
  );
}

async function upsertGroupMemberHistoryDaily(input: {
  userId: string;
  groupId: string;
  sessionId: string;
  memberCount: number;
}): Promise<void> {
  if (groupMemberHistoryWriteBlocked) return;
  if (!await hasGroupMemberHistoryTable()) return;

  const safeMemberCount = Number.isFinite(input.memberCount) ? Math.max(0, Math.trunc(input.memberCount)) : 0;
  try {
    await execute(
      `INSERT INTO group_member_history_daily (user_id, group_id, snapshot_date, member_count, session_id, captured_at, source)
       VALUES ($1, $2, NOW()::date, $3, $4, NOW(), 'group_sync')
       ON CONFLICT (group_id, snapshot_date)
       DO UPDATE SET
         member_count = EXCLUDED.member_count,
         session_id = COALESCE(EXCLUDED.session_id, group_member_history_daily.session_id),
         captured_at = EXCLUDED.captured_at,
         source = EXCLUDED.source,
         updated_at = NOW()`,
      [
        input.userId,
        input.groupId,
        safeMemberCount,
        isUuid(input.sessionId) ? input.sessionId : null,
      ],
    );
  } catch (error) {
    if (isMissingGroupMemberHistoryTableError(error)) {
      groupMemberHistoryTableAvailable = false;
      return;
    }
    if (isGroupMemberHistoryRlsPolicyError(error)) {
      groupMemberHistoryWriteBlocked = true;
      if (!groupMemberHistoryWriteBlockedWarningShown) {
        console.warn(
          "[analytics] group_member_history_daily blocked by RLS policy; skipping snapshot writes to avoid breaking group sync.",
        );
        groupMemberHistoryWriteBlockedWarningShown = true;
      }
      return;
    }
    throw error;
  }
}

async function maybeAlignMeliCookiesBackupOwner(userId: string, sessionId: string): Promise<void> {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return;

  await execute(
    `UPDATE api_credentials
        SET app_id = $1,
            updated_at = NOW()
      WHERE user_id = $2
        AND provider = $3
        AND COALESCE(app_id, '') <> $1`,
    [normalizedSessionId, userId, MELI_SESSION_COOKIES_PROVIDER],
  );
}

async function loadPersistedMeliCookiesPayload(userId: string, sessionId: string): Promise<unknown | null> {
  const hasColumn = await hasMeliSessionCookiesColumn();
  console.info(`[meli:load-cookies] user=${userId} session=${sessionId} hasColumn=${hasColumn}`);

  if (hasColumn) {
    try {
      const row = await queryOne<{ cookies_json: unknown }>(
        "SELECT cookies_json FROM meli_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, userId],
      );
      const payload = normalizeMeliCookiesPayload(row?.cookies_json);
      if (payload) {
        console.info(`[meli:load-cookies] found in cookies_json for session=${sessionId}`);
        return payload;
      }
      console.info(`[meli:load-cookies] cookies_json is null/empty for session=${sessionId}, trying fallback row`);

      // Compatibility fallback: if the requested row is missing cookies_json but
      // another row for the same user still has it, reuse and self-heal.
      const fallbackRow = await queryOne<{ id: string; cookies_json: unknown }>(
        `SELECT id, cookies_json
           FROM meli_sessions
          WHERE user_id = $1
            AND cookies_json IS NOT NULL
          ORDER BY updated_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [userId],
      );
      const fallbackPayload = normalizeMeliCookiesPayload(fallbackRow?.cookies_json);
      if (fallbackPayload) {
        const fallbackSessionId = String(fallbackRow?.id || "").trim();
        console.info(`[meli:load-cookies] found fallback row=${fallbackSessionId} for user=${userId}`);
        if (fallbackSessionId && fallbackSessionId !== sessionId) {
          try {
            await execute(
              "UPDATE meli_sessions SET cookies_json = $1::jsonb, updated_at = NOW() WHERE id = $2 AND user_id = $3 AND cookies_json IS NULL",
              [JSON.stringify(fallbackPayload), sessionId, userId],
            );
          } catch {
            // Non-fatal: returning fallback payload is enough for rehydrate.
          }
        }
        return fallbackPayload;
      }
      console.warn(`[meli:load-cookies] no fallback row with cookies_json for user=${userId}`);
    } catch (error) {
      const message = String(error || "").toLowerCase();
      if (message.includes("cookies_json") && message.includes("does not exist")) {
        meliSessionCookiesColumnAvailable = false;
        console.warn(`[meli:load-cookies] cookies_json column does not exist, disabling for this process`);
      } else {
        console.warn(`[meli:load-cookies] cookies_json query error: ${String(error)}`);
      }
    }
  }

  console.info(`[meli:load-cookies] trying encrypted backup for user=${userId}`);
  const backup = await queryOne<{ provider: string; app_id: string; secret_key: string }>(
    `SELECT provider, app_id, secret_key
       FROM api_credentials
      WHERE user_id = $1
        AND provider = $2
      ORDER BY updated_at DESC NULLS LAST,
               created_at DESC
      LIMIT 1`,
    [userId, MELI_SESSION_COOKIES_PROVIDER],
  );
  if (!backup) {
    console.warn(`[meli:load-cookies] NO backup found in api_credentials for user=${userId} provider=${MELI_SESSION_COOKIES_PROVIDER}`);
    return null;
  }

  console.info(`[meli:load-cookies] backup found, app_id=${backup.app_id}, secret_key length=${(backup.secret_key || "").length}`);
  const backupProvider = String(backup.provider || "").trim();
  const ownerSessionId = String(backup.app_id || "").trim();
  if (backupProvider === MELI_SESSION_COOKIES_PROVIDER && ownerSessionId && ownerSessionId !== sessionId) {
    // Backup is user-scoped (UNIQUE user_id+provider). If app_id drifts from the
    // current canonical session id, reuse the same payload and heal pointer.
    try {
      await maybeAlignMeliCookiesBackupOwner(userId, sessionId);
    } catch {
      // Non-fatal: continue using decrypted payload below.
    }
  }

  let decrypted: string;
  try {
    decrypted = backup.secret_key ? decryptCredential(backup.secret_key) : "";
  } catch (decryptError) {
    console.error(`[meli:load-cookies] decryptCredential FAILED for user=${userId}: ${String(decryptError)}`);
    return null;
  }

  const payload = normalizeMeliCookiesPayload(decrypted);
  if (!payload) {
    console.warn(`[meli:load-cookies] decrypted backup could not be normalized for user=${userId}, decrypted length=${decrypted.length}, starts with=${decrypted.slice(0, 30)}`);
    return null;
  }
  console.info(`[meli:load-cookies] loaded from encrypted backup for user=${userId}`);
  return payload;
}

const _meliDiagLogPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "logs", "meli-persist-diag.log");
function meliDiag(msg: string): void {
  // SECURITY: strip newlines/carriage-returns to prevent log injection into the
  // plain-text diagnostic file, since msg may include user-influenced values
  // (userId, sessionId, cookie key names from parsed payloads).
  const sanitized = String(msg || "").replace(/[\r\n]/g, " ");
  const line = `[${new Date().toISOString()}] ${sanitized}\n`;
  try { appendFileSync(_meliDiagLogPath, line); } catch { /* best effort */ }
  console.info(sanitized);
}

async function persistMeliSessionCookiesPayload(userId: string, sessionId: string, cookiesPayload: unknown): Promise<void> {
  const serialized = JSON.stringify(cookiesPayload);
  let persistedInSessionRow = false;
  let persistedInEncryptedBackup = false;
  let cookiesJsonWriteFailed = false;
  let cookiesJsonWriteFailureReason = "";
  let backupWriteFailed = false;
  let backupWriteFailureReason = "";

  meliDiag(`[meli:persist-cookies] starting for user=${userId} session=${sessionId} payloadLength=${serialized.length}`);

  const hasCol = await hasMeliSessionCookiesColumn();
  meliDiag(`[meli:persist-cookies] hasMeliSessionCookiesColumn=${hasCol} cache=${String(meliSessionCookiesColumnAvailable)}`);
  if (hasCol) {
    try {
      const updated = await execute(
        "UPDATE meli_sessions SET cookies_json = $1::jsonb, updated_at = NOW() WHERE id = $2 AND user_id = $3",
        [serialized, sessionId, userId],
      );
      persistedInSessionRow = updated.rowCount > 0;
      meliDiag(`[meli:persist-cookies] cookies_json UPDATE rowCount=${updated.rowCount}`);
      if (persistedInSessionRow) {
        // Self-heal the cache: if the column write succeeded, the column exists.
        meliSessionCookiesColumnAvailable = true;
      }
      console.info(`[meli:persist-cookies] cookies_json UPDATE rowCount=${updated.rowCount} for session=${sessionId}`);
    } catch (error) {
      const message = String(error || "").toLowerCase();
      if (message.includes("cookies_json") && message.includes("does not exist")) {
        meliSessionCookiesColumnAvailable = false;
        console.warn(`[meli:persist-cookies] cookies_json column does not exist, disabling for this process`);
      } else {
        // Do not abort the session save flow if the JSONB column write fails.
        // The encrypted backup below is authoritative for rehydration fallback.
        cookiesJsonWriteFailed = true;
        cookiesJsonWriteFailureReason = String(error);
        console.warn(`[meli:persist-cookies] cookies_json write FAILED: ${String(error)}`);
      }
    }
  } else {
    console.warn(`[meli:persist-cookies] skipping cookies_json (column unavailable cache)`);
  }

  // Keep a durable encrypted backup keyed by user+session to support rehydration
  // even if cookies_json is unavailable or temporarily not writable.
  try {
    await execute(
      `INSERT INTO api_credentials (id, user_id, provider, app_id, secret_key, region)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, provider) DO UPDATE
       SET app_id = EXCLUDED.app_id,
           secret_key = EXCLUDED.secret_key,
           region = EXCLUDED.region,
           updated_at = NOW()`,
      [uuid(), userId, MELI_SESSION_COOKIES_PROVIDER, sessionId, encryptCredential(serialized), "internal"],
    );
    persistedInEncryptedBackup = true;
    console.info(`[meli:persist-cookies] encrypted backup persisted for user=${userId}`);
  } catch (error) {
    backupWriteFailed = true;
    backupWriteFailureReason = String(error);
    console.error(`[meli:persist-cookies] encrypted backup write FAILED: ${String(error)}`);
  }

  if (!persistedInSessionRow && !persistedInEncryptedBackup) {
    throw new Error("Nao foi possivel persistir cookies Mercado Livre em nenhuma camada de armazenamento.");
  }

  if (!persistedInSessionRow && (await hasMeliSessionCookiesColumn())) {
    console.warn(`[meli:persist-cookies] cookies_json was not updated for user=${userId} session=${sessionId}; using encrypted backup.`);
  }
  if (cookiesJsonWriteFailed) {
    console.warn(
      `[meli:persist-cookies] cookies_json write failed for user=${userId} session=${sessionId}; backup persisted. reason=${cookiesJsonWriteFailureReason}`,
    );
  }
  if (backupWriteFailed) {
    console.warn(
      `[meli:persist-cookies] encrypted backup write failed for user=${userId} session=${sessionId}; cookies_json persisted=${persistedInSessionRow}. reason=${backupWriteFailureReason}`,
    );
  }

  // Round-trip verification: confirm cookies are loadable immediately after save.
  try {
    const verification = await loadPersistedMeliCookiesPayload(userId, sessionId);
    if (!verification) {
      console.error(`[meli:persist-cookies] ROUND-TRIP VERIFICATION FAILED: cookies were just persisted but loadPersistedMeliCookiesPayload returned null for user=${userId} session=${sessionId}. persistedInSessionRow=${persistedInSessionRow} persistedInEncryptedBackup=${persistedInEncryptedBackup}`);
    } else {
      console.info(`[meli:persist-cookies] round-trip verification OK for session=${sessionId}`);
    }
  } catch (verifyError) {
    console.error(`[meli:persist-cookies] round-trip verification threw: ${String(verifyError)}`);
  }
}

async function rehydrateMeliSessionFileFromDatabase(userId: string, sessionId: string): Promise<RehydrateMeliSessionResult> {
  console.info(`[meli:rehydrate] starting for user=${userId} session=${sessionId}`);
  if (!MELI_URL) {
    return { restored: false, reason: "MeLi RPA não configurado." };
  }

  const row = await queryOne<{ id: string }>(
    "SELECT id FROM meli_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  if (!row) {
    console.warn(`[meli:rehydrate] session row NOT FOUND in meli_sessions for user=${userId} session=${sessionId}`);
    return { restored: false, reason: "Sessão não encontrada no banco." };
  }

  const cookiesPayload = await loadPersistedMeliCookiesPayload(userId, sessionId);
  if (!cookiesPayload) {
    console.error(`[meli:rehydrate] loadPersistedMeliCookiesPayload returned NULL for user=${userId} session=${sessionId} — both cookies_json and encrypted backup are empty/missing`);
    return {
      restored: false,
      reason: "Cookies da sessão não foram encontrados no banco. Reimporte os cookies em Configurações ML.",
    };
  }
  console.info(`[meli:rehydrate] cookies loaded, sending to RPA for user=${userId} session=${sessionId}`);

  const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);
  const restore = await proxyMicroservice(
    MELI_URL,
    "/api/meli/sessions",
    "POST",
    { sessionId: scopedSessionId, cookies: cookiesPayload },
    buildUserScopedHeaders(userId),
    45_000,
  );

  if (restore.error) {
    return { restored: false, reason: restore.error.message };
  }

  return { restored: true };
}

type RouteForwardMedia = {
  kind: "image" | "video";
  sourcePlatform?: "whatsapp" | "telegram" | "auto";
  token?: string;
  base64?: string;
  mimeType?: string;
  fileName?: string;
};

function routeMediaDefaultsByKind(kind: RouteForwardMedia["kind"]): { mimeType: string; fileName: string } {
  if (kind === "video") {
    return { mimeType: "video/mp4", fileName: "route_video.mp4" };
  }
  return { mimeType: "image/jpeg", fileName: "route_image.jpg" };
}

function summarizeRouteForwardMedia(media: RouteForwardMedia | null | undefined): Record<string, unknown> {
  if (!media) return { kind: "none" };
  return {
    kind: media.kind,
    sourcePlatform: media.sourcePlatform || "unknown",
    hasToken: Boolean(media.token),
    hasBase64: Boolean(media.base64),
    mimeType: media.mimeType || "",
    fileName: media.fileName || "",
    base64Length: media.base64 ? media.base64.length : 0,
  };
}

function historyRouteForwardMedia(media: RouteForwardMedia | null | undefined): Record<string, unknown> | undefined {
  if (!media) return undefined;
  return {
    kind: media.kind,
    sourcePlatform: media.sourcePlatform || undefined,
    token: media.token || undefined,
    mimeType: media.mimeType || undefined,
    fileName: media.fileName || undefined,
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
  const rawKind = String(row.kind || "").trim().toLowerCase();
  if (rawKind !== "image" && rawKind !== "video") return null;
  const kind = rawKind as RouteForwardMedia["kind"];

  const token = typeof row.token === "string" ? row.token.trim() : "";
  const base64 = typeof row.base64 === "string" ? row.base64.trim() : "";
  if (!token && !base64) return null;
  const defaults = routeMediaDefaultsByKind(kind);
  const sourcePlatformRaw = typeof row.sourcePlatform === "string" ? row.sourcePlatform.trim().toLowerCase() : "";
  const sourcePlatform = sourcePlatformRaw === "whatsapp" || sourcePlatformRaw === "telegram" || sourcePlatformRaw === "auto"
    ? sourcePlatformRaw as "whatsapp" | "telegram" | "auto"
    : undefined;

  return {
    kind,
    sourcePlatform,
    token: token || undefined,
    base64: base64 || undefined,
    mimeType: normalizeSafeMediaMime(row.mimeType, defaults.mimeType),
    fileName: typeof row.fileName === "string" && row.fileName.trim() ? row.fileName.trim() : defaults.fileName,
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
  if (!media || (media.kind !== "image" && media.kind !== "video")) return null;
  if (platform !== "whatsapp" && platform !== "telegram") return null;

  const withDefaults = (partial: Partial<RouteForwardMedia>): RouteForwardMedia => {
    const resolvedKind = (partial.kind === "image" || partial.kind === "video")
      ? partial.kind
      : media.kind;
    const defaults = routeMediaDefaultsByKind(resolvedKind);
    return {
      kind: resolvedKind,
      sourcePlatform: partial.sourcePlatform || media.sourcePlatform,
      token: partial.token,
      base64: partial.base64,
      mimeType: partial.mimeType || media.mimeType || defaults.mimeType,
      fileName: partial.fileName || media.fileName || defaults.fileName,
    };
  };

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
      kind: media.kind,
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
      kind: media.kind,
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
      kind: media.kind,
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
      kind: media.kind,
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

async function materializeRouteMediaForQueue(userId: string, media: RouteForwardMedia | null): Promise<RouteForwardMedia | null> {
  if (!media) return null;
  if (media.base64) return media;
  if (!media.token) return media;

  if (media.sourcePlatform === "whatsapp") {
    const resolved = await resolveRouteForwardMediaForPlatform({
      userId,
      platform: "telegram",
      media,
    });
    return resolved?.base64 ? resolved : media;
  }

  if (media.sourcePlatform === "telegram") {
    const resolved = await resolveRouteForwardMediaForPlatform({
      userId,
      platform: "whatsapp",
      media,
    });
    return resolved?.base64 ? resolved : media;
  }

  const fromTelegram = await resolveRouteForwardMediaForPlatform({
    userId,
    platform: "telegram",
    media,
  });
  if (fromTelegram?.base64) return fromTelegram;

  const fromWhatsApp = await resolveRouteForwardMediaForPlatform({
    userId,
    platform: "whatsapp",
    media,
  });
  if (fromWhatsApp?.base64) return fromWhatsApp;

  return media;
}

async function queueRouteForwardForQuietHours(input: {
  userId: string;
  routeId: string;
  routeName: string;
  sourceName: string;
  sourceExternalId: string;
  sessionId: string;
  content: string;
  media: RouteForwardMedia | null;
  destinationGroupIds: string[];
  quietHoursStart: string;
  quietHoursEnd: string;
  scheduledAtIso: string;
}): Promise<{ queued: boolean; postId?: string; error?: string }> {
  const {
    userId,
    routeId,
    routeName,
    sourceName,
    sourceExternalId,
    sessionId,
    content,
    media,
    destinationGroupIds,
    quietHoursStart,
    quietHoursEnd,
    scheduledAtIso,
  } = input;

  const uniqueDestinationGroupIds = Array.from(
    new Set(destinationGroupIds.map((value) => String(value || "").trim()).filter(Boolean)),
  );
  if (uniqueDestinationGroupIds.length === 0) {
    return { queued: false, error: "Nenhum destino elegivel para enfileirar" };
  }

  const metadata = {
    scheduleName: `Fila da rota: ${routeName}`,
    finalContent: content,
    messageType: media ? media.kind : "text",
    media: media || null,
    scheduleSource: ROUTE_QUIET_HOURS_SCHEDULE_SOURCE,
    routeId,
    routeName,
    sourceName,
    sourceExternalId,
    sourceSessionId: sessionId,
    quietHoursStart,
    quietHoursEnd,
    queuedAt: nowIso(),
  };

  const createdPost = await queryOne<{ id: string }>(
    `INSERT INTO scheduled_posts (user_id, content, status, scheduled_at, recurrence, metadata)
     VALUES ($1, $2, 'pending', $3, 'none', $4::jsonb)
     RETURNING id`,
    [userId, content, scheduledAtIso, JSON.stringify(metadata)],
  );
  if (!createdPost?.id) {
    return { queued: false, error: "Falha ao criar item da fila de rota" };
  }

  try {
    await execute(
      `INSERT INTO scheduled_post_destinations (post_id, group_id)
       SELECT $1::uuid, UNNEST($2::uuid[])
       ON CONFLICT (post_id, group_id) DO NOTHING`,
      [createdPost.id, uniqueDestinationGroupIds],
    );
  } catch (error) {
    await execute("DELETE FROM scheduled_posts WHERE id = $1 AND user_id = $2", [createdPost.id, userId]).catch(() => undefined);
    return {
      queued: false,
      error: error instanceof Error ? error.message : "Falha ao vincular destinos na fila de rota",
    };
  }

  return { queued: true, postId: createdPost.id };
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

// Allowlist for user-supplied mimeType on media uploads — passed to messaging workers.
// Reject anything outside known safe raster types to prevent type confusion.
const SAFE_MEDIA_MIME_ALLOWLIST = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm",
]);

/**
 * Normalizes a user-supplied mimeType string to a known-safe value.
 * Falls back to `fallback` (default "image/jpeg") if the value is not in the allowlist.
 */
function normalizeSafeMediaMime(raw: unknown, fallback = "image/jpeg"): string {
  const mime = String(raw || "").trim().toLowerCase();
  return SAFE_MEDIA_MIME_ALLOWLIST.has(mime) ? mime : fallback;
}

// SSRF protection: block requests to loopback, private RFC-1918/6 ranges,
// link-local, and cloud metadata endpoints. Only public routable IPs are allowed.
function isSsrfSafeUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const hostname = parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  // Block loopback and local
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
  // Block cloud metadata endpoints
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") return false;

  // Block IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number);
    if (a === 10) return false;                                    // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return false;            // 172.16.0.0/12
    if (a === 192 && b === 168) return false;                      // 192.168.0.0/16
    if (a === 127) return false;                                   // 127.0.0.0/8
    if (a === 169 && b === 254) return false;                      // 169.254.0.0/16 link-local
    if (a === 0) return false;                                     // 0.0.0.0/8
    if (a >= 224) return false;                                    // Multicast / reserved
    if (a === 100 && b >= 64 && b <= 127) return false;           // 100.64.0.0/10 CGNAT
  }

  return true;
}

async function fetchImageBuffer(imageUrl: string, signal: AbortSignal): Promise<RouteForwardMedia | null> {
  if (!isSsrfSafeUrl(imageUrl)) return null;
  const response = await fetch(imageUrl, { method: "GET", redirect: "follow", signal });
  // Re-validate after redirect chain: prevents SSRF via public URL → private IP redirect
  if (response.url && !isSsrfSafeUrl(response.url)) return null;
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
  if (!isSsrfSafeUrl(pageUrl)) return null;
  const response = await fetch(pageUrl, {
    method: "GET",
    redirect: "follow",
    signal,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AutolinksBot/1.0)", Accept: "text/html" },
  });
  // Re-validate after redirect chain: prevents SSRF via public URL → private IP redirect
  if (response.url && !isSsrfSafeUrl(response.url)) return null;
  if (!response.ok) return null;

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/html")) return null;

  const html = await response.text();
  const head = html.slice(0, 32_000);
  const match = head.match(OG_IMAGE_REGEX) || head.match(OG_IMAGE_REVERSE_REGEX);
  if (!match || !match[1]) return null;

  const ogUrl = match[1].replace(/&amp;/g, "&").trim();
  if (!ogUrl.startsWith("http") || !isSsrfSafeUrl(ogUrl)) return null;
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
  if (!isSsrfSafeUrl(imageUrl)) {
    throw new Error("Envio cancelado: URL da imagem inválida.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTO_IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    // Validate the final URL after all redirects to prevent SSRF via open redirect
    if (response.url && !isSsrfSafeUrl(response.url)) {
      throw new Error("Envio cancelado: URL da imagem inválida.");
    }
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
  isAdmin?: boolean;
  ownerJid?: string;
  inviteCode?: string;
}): Promise<string | null> {
  const externalId = String(input.externalId || "").trim();
  if (!externalId) return null;
  const normalizedName = String(input.name || "").trim();
  if (!normalizedName) return null;
  const memberCount = Number.isFinite(input.memberCount) ? Math.max(0, Math.trunc(input.memberCount)) : 0;
  const isAdmin = Boolean(input.isAdmin);
  const ownerJid = String(input.ownerJid || "").trim();
  const inviteCode = String(input.inviteCode || "").trim();
  let useGroupAdminColumns = await hasGroupsAdminColumns();
  let resolvedGroupId = "";

  // If a group changed external_id in the provider, recover the previously saved row
  // by matching the same session + normalized name before regular upsert by external_id.
  if (useGroupAdminColumns) {
    try {
      await execute(
        `UPDATE groups g
         SET external_id = $1,
             name = $2,
             member_count = $3,
             is_admin = $7,
             owner_jid = $8,
             invite_code = $9,
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
        [externalId, normalizedName, memberCount, input.userId, input.platform, input.sessionId, isAdmin, ownerJid, inviteCode],
      );
    } catch (error) {
      if (!isMissingGroupsAdminColumnsError(error)) throw error;
      groupsAdminColumnsAvailable = false;
      useGroupAdminColumns = false;
    }
  }

  if (!useGroupAdminColumns) {
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
  }

  const groupId = uuid();
  if (useGroupAdminColumns) {
    try {
      const upserted = await queryOne<{ id: string }>(
        `INSERT INTO groups (id, user_id, name, platform, member_count, session_id, external_id, is_admin, owner_jid, invite_code, deleted_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NOW())
         ON CONFLICT (user_id, session_id, external_id)
         DO UPDATE SET
           name = EXCLUDED.name,
           member_count = EXCLUDED.member_count,
           is_admin = EXCLUDED.is_admin,
           owner_jid = EXCLUDED.owner_jid,
           invite_code = EXCLUDED.invite_code,
           deleted_at = NULL,
           updated_at = NOW()
         RETURNING id`,
        [groupId, input.userId, normalizedName, input.platform, memberCount, input.sessionId, externalId, isAdmin, ownerJid, inviteCode],
      );
      resolvedGroupId = String(upserted?.id || "").trim();
    } catch (error) {
      if (!isMissingGroupsAdminColumnsError(error)) throw error;
      groupsAdminColumnsAvailable = false;
      useGroupAdminColumns = false;
    }
  }

  if (!useGroupAdminColumns) {
    const upserted = await queryOne<{ id: string }>(
      `INSERT INTO groups (id, user_id, name, platform, member_count, session_id, external_id, deleted_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NOW())
       ON CONFLICT (user_id, session_id, external_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         member_count = EXCLUDED.member_count,
         deleted_at = NULL,
         updated_at = NOW()
       RETURNING id`,
      [groupId, input.userId, normalizedName, input.platform, memberCount, input.sessionId, externalId],
    );
    resolvedGroupId = String(upserted?.id || "").trim();
  }

  if (!resolvedGroupId) {
    const row = await queryOne<{ id: string }>(
      `SELECT id
         FROM groups
        WHERE user_id = $1
          AND session_id = $2
          AND external_id = $3
          AND platform = $4
          AND deleted_at IS NULL
        LIMIT 1`,
      [input.userId, input.sessionId, externalId, input.platform],
    );
    resolvedGroupId = String(row?.id || "").trim();
  }

  if (input.platform === "whatsapp" && resolvedGroupId) {
    await upsertGroupMemberHistoryDaily({
      userId: input.userId,
      groupId: resolvedGroupId,
      sessionId: input.sessionId,
      memberCount,
    });
  }

  // Audit: group sync is high-volume and has no req context — logged by the
  // calling route handler if needed. No per-group audit entry to avoid spam.
  return resolvedGroupId || null;
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

  const dbSessions = await query<{
    id: string;
    status: string | null;
    connected_at: string | null;
    error_message: string | null;
  }>(
    "SELECT id, status, connected_at, error_message FROM telegram_sessions WHERE user_id = $1",
    [userId],
  );

  let touched = 0;
  for (const row of dbSessions) {
    const sessionId = String(row?.id ?? "").trim();
    if (!sessionId) continue;

    const runtimeStatus = runtimeStatusBySession.get(sessionId);
    if (!runtimeStatus) continue;

    const currentStatus = String(row.status ?? "").trim();
    const hasConnectedAt = Boolean(row.connected_at);
    const hasErrorMessage = Boolean(String(row.error_message ?? "").trim());
    const shouldUpdate =
      currentStatus !== runtimeStatus
      || (runtimeStatus === "online" && !hasConnectedAt)
      || (!(runtimeStatus === "online" || runtimeStatus === "connecting" || runtimeStatus === "warning") && hasConnectedAt)
      || (runtimeStatus === "online" && hasErrorMessage);

    if (!shouldUpdate) continue;

    await execute(
      `UPDATE telegram_sessions
       SET status = $1,
           connected_at = CASE
             WHEN $1 = 'online' THEN COALESCE(connected_at, NOW())
             WHEN $1 IN ('connecting', 'warning') THEN connected_at
             ELSE NULL
           END,
           error_message = CASE WHEN $1 = 'online' THEN '' ELSE error_message END,
           updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [runtimeStatus, sessionId, userId],
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
  const normalizedUserId = String(userId || "").trim().toLowerCase();
  if (!normalizedUserId) return { reconciled: 0, online: false };

  const reconcileHeaders: Record<string, string> = { ...buildUserScopedHeaders(normalizedUserId) };
  if (WEBHOOK_SECRET) reconcileHeaders["x-webhook-secret"] = WEBHOOK_SECRET;
  const health = await proxyMicroservice(
    WHATSAPP_URL,
    "/health",
    "GET",
    null,
    reconcileHeaders,
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
    if (String(item.userId ?? item.user_id ?? "").trim().toLowerCase() !== normalizedUserId) continue;
    const sessionId = String(item.sessionId ?? "").trim();
    if (!sessionId) continue;
    statusBySessionId.set(sessionId, {
      status: normalizeWhatsAppStatus(item.status),
      queuedEvents: Math.max(0, toInt(item.queuedEvents, 0)),
    });
  }

  const ownSessions = await query<{
    id: string;
    status: string | null;
    connected_at: string | null;
    error_message: string | null;
    qr_code: string | null;
  }>(
    "SELECT id, status, connected_at, error_message, qr_code FROM whatsapp_sessions WHERE user_id = $1",
    [normalizedUserId],
  );
  let reconciled = 0;

  for (const row of ownSessions) {
    const sessionId = String(row?.id ?? "").trim();
    if (!sessionId) continue;

    const fromHealth = statusBySessionId.get(sessionId);
    if (!fromHealth) {
      // Shared DB mode: a session may be owned by another runtime (for example local vs deploy).
      // Absence from *this* connector health check must not destructively mark it offline.
      continue;
    }

    const currentStatus = String(row.status ?? "").trim();
    const hasConnectedAt = Boolean(row.connected_at);
    const hasErrorMessage = Boolean(String(row.error_message ?? "").trim());
    const hasQrCode = Boolean(String(row.qr_code ?? "").trim());
    const shouldUpdate =
      currentStatus !== fromHealth.status
      || (fromHealth.status === "online" && !hasConnectedAt)
      || (!(fromHealth.status === "online" || fromHealth.status === "connecting" || fromHealth.status === "warning") && hasConnectedAt)
      || (!(fromHealth.status === "qr_code" || fromHealth.status === "pairing_code") && hasQrCode)
      || (fromHealth.status !== "warning" && hasErrorMessage);

    if (!shouldUpdate) continue;

    const connectedAt = fromHealth.status === "online" ? nowIso() : null;
    await execute(
      `UPDATE whatsapp_sessions
       SET status = $1,
           connected_at = CASE
             WHEN $1 = 'online' THEN COALESCE(connected_at, $2::timestamptz, NOW())
             WHEN $1 IN ('connecting', 'warning') THEN connected_at
             ELSE NULL
           END,
           qr_code = CASE WHEN $1 IN ('qr_code', 'pairing_code') THEN qr_code ELSE '' END,
           error_message = CASE WHEN $1 = 'warning' THEN error_message ELSE '' END,
           updated_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [fromHealth.status, connectedAt, sessionId, normalizedUserId],
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
  let useGroupAdminColumns = await hasGroupsAdminColumns();

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
        isAdmin: Boolean(group.isAdmin),
        ownerJid: String(group.owner || ""),
        inviteCode: String(group.inviteCode || ""),
      });
      continue;
    }

    const nameKey = normalizeGroupNameKey(name);
    const candidates = nameKey ? (existingByNameKey.get(nameKey) || []) : [];
    const available = candidates.filter((c) => !claimedExistingIds.has(c.id) && !remoteExternalIds.has(String(c.external_id || "").trim()));

    if (available.length === 1) {
      const candidate = available[0];
      const normalizedMemberCount = Number.isFinite(memberCount) ? Math.max(0, Math.trunc(memberCount)) : 0;
      if (useGroupAdminColumns) {
        try {
          await execute(
            `UPDATE groups
             SET external_id = $1,
                 name = $2,
                 member_count = $3,
                 is_admin = $6,
                 owner_jid = $7,
                 invite_code = $8,
                 deleted_at = NULL,
                 updated_at = NOW()
             WHERE id = $4 AND user_id = $5`,
            [externalId, name, normalizedMemberCount, candidate.id, userId, Boolean(group.isAdmin), String(group.owner || ""), String(group.inviteCode || "")],
          );
        } catch (error) {
          if (!isMissingGroupsAdminColumnsError(error)) throw error;
          groupsAdminColumnsAvailable = false;
          useGroupAdminColumns = false;
        }
      }

      if (!useGroupAdminColumns) {
        await execute(
          `UPDATE groups
           SET external_id = $1,
               name = $2,
               member_count = $3,
               deleted_at = NULL,
               updated_at = NOW()
           WHERE id = $4 AND user_id = $5`,
          [externalId, name, normalizedMemberCount, candidate.id, userId],
        );
      }

      await upsertGroupMemberHistoryDaily({
        userId,
        groupId: candidate.id,
        sessionId,
        memberCount: normalizedMemberCount,
      });
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
      isAdmin: Boolean(group.isAdmin),
      ownerJid: String(group.owner || ""),
      inviteCode: String(group.inviteCode || ""),
    });
  }
}

async function syncWhatsAppSessionGroups(input: {
  userId: string;
  sessionId: string;
  includeEventPoll?: boolean;
  timeoutMs?: number;
}): Promise<{
  remoteGroups: Array<Record<string, unknown>>;
  count: number;
  events: number;
  inviteSync: { checked: number; updated: number; failed: number };
}> {
  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.max(5_000, Math.trunc(Number(input.timeoutMs)))
    : 45_000;

  const upstream = await proxyMicroservice(
    WHATSAPP_URL,
    `/api/sessions/${encodeURIComponent(input.sessionId)}/sync-groups`,
    "POST",
    { sessionId: input.sessionId },
    buildUserScopedHeaders(input.userId),
    timeoutMs,
  );
  if (upstream.error) {
    throw new Error(upstream.error.message || "Falha ao sincronizar grupos da sessão");
  }

  const remoteGroups: Array<Record<string, unknown>> =
    (upstream.data && typeof upstream.data === "object" && Array.isArray((upstream.data as Record<string, unknown>).groups))
      ? ((upstream.data as Record<string, unknown>).groups as Array<Record<string, unknown>>)
      : [];

  await syncWhatsAppGroupsWithReconciliation(input.userId, input.sessionId, remoteGroups);
  const inviteSync = await syncMasterGroupWhatsAppInviteLinks(input.userId, input.sessionId).catch(() => ({ checked: 0, updated: 0, failed: 0 }));
  const events = input.includeEventPoll
    ? await pollWhatsAppEventsForSession(input.userId, input.sessionId).catch(() => 0)
    : 0;

  return {
    remoteGroups,
    count: remoteGroups.length,
    events,
    inviteSync,
  };
}

async function loadWhatsAppMembersEvolution(input: {
  userId: string;
  scope: string;
  days: number;
  scopeGroupIds: string[];
}): Promise<{
  scope: "all" | "group";
  groupId: string | null;
  days: number;
  fromDate: string;
  toDate: string;
  series: Array<{ date: string; members: number; groupsRepresented: number }>;
  summary: {
    groupsCount: number;
    snapshotsInWindow: number;
    daysWithData: number;
    coveragePercent: number;
    startMembers: number;
    endMembers: number;
    delta: number;
    deltaPercent: number;
  };
}> {
  const safeDays = Math.max(1, Math.min(365, toInt(input.days, 30)));
  const rawScope = String(input.scope || "all").trim();
  const selectedGroupId = rawScope !== "all" && isUuid(rawScope) ? rawScope : "";
  const scope: "all" | "group" = selectedGroupId ? "group" : "all";
  const requestedGroupIds = Array.from(new Set(input.scopeGroupIds.filter(isUuid)));

  const today = new Date();
  const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - (safeDays - 1));

  const fromDate = startDate.toISOString().slice(0, 10);
  const toDate = endDate.toISOString().slice(0, 10);
  const dateKeys: string[] = [];
  for (let i = 0; i < safeDays; i++) {
    const d = new Date(startDate);
    d.setUTCDate(startDate.getUTCDate() + i);
    dateKeys.push(d.toISOString().slice(0, 10));
  }

  let groups: Array<{ id: string; member_count: number }> = [];
  if (scope === "group") {
    groups = await query<{ id: string; member_count: number }>(
      `SELECT id, COALESCE(member_count, 0)::int AS member_count
         FROM groups
        WHERE user_id = $1
          AND platform = 'whatsapp'
          AND deleted_at IS NULL
          AND id = $2::uuid
        LIMIT 1`,
      [input.userId, selectedGroupId],
    );
  } else if (requestedGroupIds.length > 0) {
    groups = await query<{ id: string; member_count: number }>(
      `SELECT id, COALESCE(member_count, 0)::int AS member_count
         FROM groups
        WHERE user_id = $1
          AND platform = 'whatsapp'
          AND deleted_at IS NULL
          AND id = ANY($2::uuid[])`,
      [input.userId, requestedGroupIds],
    );
  } else {
    groups = await query<{ id: string; member_count: number }>(
      `SELECT id, COALESCE(member_count, 0)::int AS member_count
         FROM groups
        WHERE user_id = $1
          AND platform = 'whatsapp'
          AND deleted_at IS NULL`,
      [input.userId],
    );
  }

  if (groups.length === 0) {
    const emptySeries = dateKeys.map((date) => ({ date, members: 0, groupsRepresented: 0 }));
    return {
      scope,
      groupId: scope === "group" ? selectedGroupId : null,
      days: safeDays,
      fromDate,
      toDate,
      series: emptySeries,
      summary: {
        groupsCount: 0,
        snapshotsInWindow: 0,
        daysWithData: 0,
        coveragePercent: 0,
        startMembers: 0,
        endMembers: 0,
        delta: 0,
        deltaPercent: 0,
      },
    };
  }

  const groupIds = groups.map((group) => group.id);
  const currentMemberCount = new Map<string, number>(
    groups.map((group) => [group.id, Math.max(0, toInt(group.member_count, 0))]),
  );

  const historyRows = await query<{
    group_id: string;
    snapshot_date: string;
    member_count: number;
  }>(
    `SELECT
       group_id::text AS group_id,
       snapshot_date::text AS snapshot_date,
       COALESCE(member_count, 0)::int AS member_count
       FROM group_member_history_daily
      WHERE user_id = $1
        AND group_id = ANY($2::uuid[])
        AND snapshot_date BETWEEN $3::date AND $4::date
      ORDER BY group_id, snapshot_date`,
    [input.userId, groupIds, fromDate, toDate],
  );

  const baselineRows = await query<{
    group_id: string;
    member_count: number;
  }>(
    `SELECT DISTINCT ON (group_id)
       group_id::text AS group_id,
       COALESCE(member_count, 0)::int AS member_count
       FROM group_member_history_daily
      WHERE user_id = $1
        AND group_id = ANY($2::uuid[])
        AND snapshot_date < $3::date
      ORDER BY group_id, snapshot_date DESC`,
    [input.userId, groupIds, fromDate],
  );

  const historyByGroup = new Map<string, Map<string, number>>();
  for (const row of historyRows) {
    const gid = String(row.group_id || "").trim();
    const day = String(row.snapshot_date || "").trim();
    if (!gid || !day) continue;
    let bucket = historyByGroup.get(gid);
    if (!bucket) {
      bucket = new Map<string, number>();
      historyByGroup.set(gid, bucket);
    }
    bucket.set(day, Math.max(0, toInt(row.member_count, 0)));
  }

  const baselineByGroup = new Map<string, number>();
  for (const row of baselineRows) {
    const gid = String(row.group_id || "").trim();
    if (!gid) continue;
    baselineByGroup.set(gid, Math.max(0, toInt(row.member_count, 0)));
  }

  const totalsByDate = new Map<string, number>(dateKeys.map((day) => [day, 0]));
  const representedByDate = new Map<string, number>(dateKeys.map((day) => [day, 0]));
  const todayKey = toDate;

  for (const gid of groupIds) {
    const perDay = historyByGroup.get(gid) || new Map<string, number>();
    const hasAnyHistoricalData = perDay.size > 0 || baselineByGroup.has(gid);
    let carry: number | null = baselineByGroup.has(gid) ? baselineByGroup.get(gid)! : null;

    for (const day of dateKeys) {
      if (perDay.has(day)) {
        carry = perDay.get(day)!;
      }

      let value: number | null = carry;
      if (!hasAnyHistoricalData && day === todayKey) {
        value = currentMemberCount.get(gid) ?? 0;
      }

      if (value !== null) {
        totalsByDate.set(day, (totalsByDate.get(day) || 0) + Math.max(0, value));
        representedByDate.set(day, (representedByDate.get(day) || 0) + 1);
      }
    }
  }

  const series = dateKeys.map((date) => ({
    date,
    members: Math.max(0, toInt(totalsByDate.get(date), 0)),
    groupsRepresented: Math.max(0, toInt(representedByDate.get(date), 0)),
  }));

  const startMembers = series[0]?.members ?? 0;
  const endMembers = series[series.length - 1]?.members ?? 0;
  const delta = endMembers - startMembers;
  const deltaPercent = startMembers > 0
    ? Number(((delta / startMembers) * 100).toFixed(1))
    : (endMembers > 0 ? 100 : 0);
  const daysWithData = series.filter((row) => row.groupsRepresented > 0).length;
  const coveragePercent = Number(((daysWithData / Math.max(1, series.length)) * 100).toFixed(1));

  return {
    scope,
    groupId: scope === "group" ? selectedGroupId : null,
    days: safeDays,
    fromDate,
    toDate,
    series,
    summary: {
      groupsCount: groupIds.length,
      snapshotsInWindow: historyRows.length,
      daysWithData,
      coveragePercent,
      startMembers,
      endMembers,
      delta,
      deltaPercent,
    },
  };
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
        media ? media.kind : "text",
      ],
    );
  } catch {
    // Best-effort history log; do not interrupt event polling.
  }

  console.error(`[rpc] route processing ${platform} failed: ${errorMessage}`);
}

async function appendInboundCaptureHistory(input: {
  userId: string;
  sourceName: string;
  sourceExternalId: string;
  sessionId: string;
  platform: "whatsapp" | "telegram";
  message: string;
  media: RouteForwardMedia | null;
  hasMediaHint: boolean;
  mediaKindHint: string;
  sourceMessageId?: string;
  sourceMessageDate?: string;
}): Promise<void> {
  const {
    userId,
    sourceName,
    sourceExternalId,
    sessionId,
    platform,
    message,
    media,
    hasMediaHint,
    mediaKindHint,
    sourceMessageId,
    sourceMessageDate,
  } = input;

  const capturedAt = nowIso();
  const messageType = media ? media.kind : "text";
  const normalizedMessage = String(message || "").trim();
  const fallbackMessage = (!normalizedMessage && hasMediaHint)
    ? `[midia ${mediaKindHint || "desconhecida"} recebida]`
    : normalizedMessage;

  try {
    await execute(
      "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'session_event',$3,$4,'info',$5,'inbound',$6,'processed','','')",
      [uuid(), userId, sourceName || "Grupo", "-", JSON.stringify({
        message: fallbackMessage,
        sourceExternalId,
        sessionId,
        platform,
        hasMedia: !!media || hasMediaHint,
        mediaKind: mediaKindHint || (media ? media.kind : ""),
        media: historyRouteForwardMedia(media),
        capturedAt,
        sourceMessageId: String(sourceMessageId || "").trim() || undefined,
        sourceMessageDate: String(sourceMessageDate || "").trim() || undefined,
      }), messageType],
    );
  } catch {
    // Capture history is best-effort and must not break the route pipeline.
  }
}

async function applyWhatsAppEvents(userId: string, sessionId: string, events: IntegrationEvent[]) {
  let groupsSynced = 0;
  for (const raw of events) {
    const event = String(raw?.event ?? "").trim();
    const data = raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? raw.data
      : {};

    if (!event) continue;

    try {
      if (event === "connection_update") {
        const status = normalizeWhatsAppStatus(data.status);
        const connectedAt = status === "online" ? nowIso() : null;
        const errorMessage = String(data.errorMessage ?? data.error_message ?? "");
        let qrCode = "";
        if (status === "qr_code") qrCode = String(data.qrCode ?? "");
        if (status === "pairing_code") qrCode = String(data.pairingCode ?? "");
        const phone = sanitizePhone(String(data.phone ?? ""));

        const shouldEnforcePhoneOwnership = status === "online" || status === "connecting" || status === "qr_code" || status === "pairing_code";
        if (shouldEnforcePhoneOwnership && phone && await hasCrossAccountActiveWhatsAppPhone(phone, userId, sessionId)) {
          await execute(
            "UPDATE whatsapp_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
            [WHATSAPP_ALREADY_LINKED_MESSAGE, sessionId, userId],
          );
          continue;
        }

        try {
          await execute(
            `UPDATE whatsapp_sessions
             SET status = $1,
                 connected_at = CASE
                   WHEN $1 = 'online' THEN COALESCE(connected_at, $2::timestamptz, NOW())
                   WHEN $1 IN ('connecting', 'warning') THEN connected_at
                   ELSE NULL
                 END,
                 error_message = $3,
                 qr_code = $4,
                 phone = CASE WHEN $5 <> '' THEN $5 ELSE phone END,
                 updated_at = NOW()
             WHERE id = $6 AND user_id = $7`,
            [status, connectedAt, errorMessage, qrCode, phone, sessionId, userId],
          );
        } catch (updateError) {
          if (isUniqueViolation(updateError)) {
            await execute(
              "UPDATE whatsapp_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
              [WHATSAPP_ALREADY_LINKED_MESSAGE, sessionId, userId],
            );
            continue;
          }
          throw updateError;
        }
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
            isAdmin: Boolean(group.isAdmin),
            ownerJid: String(group.owner ?? ""),
            inviteCode: String(group.inviteCode ?? ""),
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
        const sourceMessageId = String(data.messageId ?? data.message_id ?? "").trim();
        const sourceMessageDate = String(data.messageDate ?? data.message_date ?? "").trim();
        const fromMe = data.fromMe === true || data.from_me === true;
        const media = parseRouteForwardMedia(data.media);
        const mediaKindHint = String(data.mediaKind ?? data.media_kind ?? "").trim().toLowerCase();
        const hasMediaHint = data.hasMedia === true
          || data.has_media === true
          || Boolean(mediaKindHint)
          || Boolean(media);
        logRouteMediaDebug("incoming.whatsapp.message_received", {
          userId,
          sessionId,
          sourceExternalId,
          sourceName,
          fromMe,
          hasText: Boolean(message),
          textLength: message.length,
          hasMediaHint,
          mediaKindHint,
          media: summarizeRouteForwardMedia(media),
        });
        if (!sourceExternalId || (!message && !media && !hasMediaHint)) continue;

        if (fromMe) {
          await execute(
            "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'info',$5,'inbound','text','blocked','from_me_ignored','route_filter')",
            [uuid(), userId, sourceName, "-", JSON.stringify({
              message,
              sourceExternalId,
              sessionId,
              platform: "whatsapp",
              reason: "from_me_ignored",
            })],
          );
          continue;
        }

        await appendInboundCaptureHistory({
          userId,
          sourceName,
          sourceExternalId,
          sessionId,
          platform: "whatsapp",
          message,
          media,
          hasMediaHint,
          mediaKindHint,
          sourceMessageId,
          sourceMessageDate,
        });

        if (!message && !media && hasMediaHint) {
          await execute(
            "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound','text','blocked','unsupported_media_type','media_ingestion')",
            [uuid(), userId, sourceName, "-", JSON.stringify({
              message: "",
              sourceExternalId,
              sessionId,
              platform: "whatsapp",
              reason: "unsupported_media_type",
              mediaKind: mediaKindHint || "unknown",
            })],
          );
          continue;
        }

        try {
          await processRouteMessageForUser({
            userId,
            sessionId,
            sourceExternalId,
            sourceName,
            message,
            media,
            hasMediaHint,
            mediaKindHint,
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sourceExternalId = String(data.groupId ?? data.id ?? "").trim();
      console.error(
        `[poll-channel-events] failed to apply whatsapp event=${event} userId=${userId} sessionId=${sessionId} sourceExternalId=${sourceExternalId || "-"} error=${errorMessage}`,
      );
    }
  }
  return { groupsSynced };
}

async function applyTelegramEvents(userId: string, sessionId: string, events: IntegrationEvent[]) {
  let groupsSynced = 0;
  for (const raw of events) {
    const event = String(raw?.event ?? "").trim();
    const data = raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? raw.data
      : {};

    if (!event) continue;

    try {
      if (event === "connection_update") {
        const status = normalizeTelegramStatus(data.status);
        const connectedAt = status === "online" ? nowIso() : null;
        const errorMessage = String(data.errorMessage ?? data.error_message ?? "");
        const sessionStringRaw = String(data.session_string ?? "");
        // Encrypt session_string at rest — decryptCredential() handles legacy plaintext rows transparently
        const sessionString = sessionStringRaw ? encryptCredential(sessionStringRaw) : "";
        const phone = sanitizePhone(String(data.phone ?? ""));
        const clearSession = data.clear_session === true;

        const shouldEnforcePhoneOwnership = status === "online" || status === "connecting" || status === "awaiting_code" || status === "awaiting_password";
        if (shouldEnforcePhoneOwnership && phone && await hasCrossAccountActiveTelegramPhone(phone, userId, sessionId)) {
          await execute(
            "UPDATE telegram_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
            [TELEGRAM_ALREADY_LINKED_MESSAGE, sessionId, userId],
          );
          continue;
        }

        try {
          await execute(
            `UPDATE telegram_sessions
             SET status = $1,
                 connected_at = CASE
                   WHEN $1 = 'online' THEN COALESCE(connected_at, $2::timestamptz, NOW())
                   WHEN $1 IN ('connecting', 'warning') THEN connected_at
                   ELSE NULL
                 END,
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
        } catch (updateError) {
          if (isUniqueViolation(updateError)) {
            await execute(
              "UPDATE telegram_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
              [TELEGRAM_ALREADY_LINKED_MESSAGE, sessionId, userId],
            );
            continue;
          }
          throw updateError;
        }
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
        const sourceMessageId = String(data.messageId ?? data.message_id ?? "").trim();
        const sourceMessageDate = String(data.messageDate ?? data.message_date ?? "").trim();
        const fromMe = data.fromMe === true || data.from_me === true;
        const media = parseRouteForwardMedia(data.media);
        const mediaKindHint = String(data.mediaKind ?? data.media_kind ?? "").trim().toLowerCase();
        const hasMediaHint = data.hasMedia === true
          || data.has_media === true
          || Boolean(mediaKindHint)
          || Boolean(media);
        logRouteMediaDebug("incoming.telegram.message_received", {
          userId,
          sessionId,
          sourceExternalId,
          sourceName,
          fromMe,
          hasText: Boolean(message),
          textLength: message.length,
          hasMediaHint,
          mediaKindHint,
          media: summarizeRouteForwardMedia(media),
        });
        if (!sourceExternalId || (!message && !media && !hasMediaHint)) continue;

        if (fromMe) {
          await execute(
            "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'info',$5,'inbound','text','blocked','from_me_ignored','route_filter')",
            [uuid(), userId, sourceName, "-", JSON.stringify({
              message,
              sourceExternalId,
              sessionId,
              platform: "telegram",
              reason: "from_me_ignored",
            })],
          );
          continue;
        }

        await appendInboundCaptureHistory({
          userId,
          sourceName,
          sourceExternalId,
          sessionId,
          platform: "telegram",
          message,
          media,
          hasMediaHint,
          mediaKindHint,
          sourceMessageId,
          sourceMessageDate,
        });

        if (!message && !media && hasMediaHint) {
          await execute(
            "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound','text','blocked','unsupported_media_type','media_ingestion')",
            [uuid(), userId, sourceName, "-", JSON.stringify({
              message: "",
              sourceExternalId,
              sessionId,
              platform: "telegram",
              reason: "unsupported_media_type",
              mediaKind: mediaKindHint || "unknown",
            })],
          );
          continue;
        }

        try {
          await processRouteMessageForUser({
            userId,
            sessionId,
            sourceExternalId,
            sourceName,
            message,
            media,
            hasMediaHint,
            mediaKindHint,
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sourceExternalId = String(data.groupId ?? data.id ?? "").trim();
      console.error(
        `[poll-channel-events] failed to apply telegram event=${event} userId=${userId} sessionId=${sessionId} sourceExternalId=${sourceExternalId || "-"} error=${errorMessage}`,
      );
    }
  }
  return { groupsSynced };
}

const ROUTE_LINK_REGEX = /https?:\/\/[^\s<>"'(){}|\\^`[\]]+/gi;

const ROUTE_PARTNER_MARKETPLACE_PATTERNS: Record<string, RegExp[]> = {
  shopee: [/shopee\.com(\.\w+)?/i, /shope\.ee/i, /s\.shopee\./i],
  mercadolivre: [/mercadolivre\.com\.br/i, /mercadolibre\.com/i, /mlb\.am/i, /meli\.la/i],
  amazon: [/amazon\.com\.br/i, /amzn\.to/i],
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
  if (marketplace === "amazon") {
    return rules.autoConvertAmazon !== false;
  }
  return false;
}

function detectRoutePartnerMarketplace(url: string): string | null {
  for (const [name, patterns] of Object.entries(ROUTE_PARTNER_MARKETPLACE_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(url))) return name;
  }
  return null;
}

function hasShopeeProductIdentifiers(url: string): boolean {
  const value = String(url || "").trim();
  if (!value) return false;
  if (/-i\.(\d+)\.(\d+)/i.test(value)) return true;
  if (/\/(\d+)\/(\d+)(?:[/?#]|$)/.test(value)) return true;
  return false;
}

function shouldResolveShopeeLinkForProductData(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "shope.ee" || host.endsWith(".shope.ee")) return true;
  if (/^s\.shopee\./i.test(host)) return true;
  return !hasShopeeProductIdentifiers(parsed.toString());
}

function isPrivateNetworkUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    const host = parsed.hostname.toLowerCase();
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.0\.0\.0$)/.test(host)) return true;
    if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".internal")) return true;
    return false;
  } catch {
    return true;
  }
}

async function resolveRouteLinkWithRedirect(url: string): Promise<string> {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return target;
  if (isPrivateNetworkUrl(target)) return target;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });

    // If the server returned redirect, follow it manually and validate EACH hop
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return target;
      let current = new URL(location, new URL(target)).toString();
      for (let hops = 0; hops < 6; hops++) {
        if (isPrivateNetworkUrl(current)) return target;
        const hopCtrl = new AbortController();
        const hopTimeout = setTimeout(() => hopCtrl.abort(), 3_000);
        try {
          const hopRes = await fetch(current, { method: "GET", redirect: "manual", signal: hopCtrl.signal });
          clearTimeout(hopTimeout);
          if ([301, 302, 303, 307, 308].includes(hopRes.status)) {
            const nextLocation = hopRes.headers.get("location");
            if (!nextLocation) break;
            current = new URL(nextLocation, new URL(current)).toString();
          } else {
            if (isPrivateNetworkUrl(current)) return target;
            return current;
          }
        } catch {
          clearTimeout(hopTimeout);
          return target;
        }
      }
      return target;
    }

    // Non-redirect response — validate the URL that was actually fetched
    const resolvedUrl = response.url || target;
    if (isPrivateNetworkUrl(resolvedUrl)) return target;
    return resolvedUrl;
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
  hasMediaHint?: boolean;
  mediaKindHint?: string;
}) {
  const {
    userId,
    sessionId,
    sourceExternalId,
    sourceName,
    message,
    media = null,
    hasMediaHint = false,
    mediaKindHint = "",
  } = input;
  const normalizedMediaKindHint = String(mediaKindHint || "").trim().toLowerCase();
  const messageType = media ? media.kind : "text";
  logRouteMediaDebug("route.process.start", {
    userId,
    sessionId,
    sourceExternalId,
    sourceName,
    hasText: Boolean(message),
    textLength: message.length,
    hasMediaHint,
    mediaKindHint: normalizedMediaKindHint,
    media: summarizeRouteForwardMedia(media),
  });

  if (await isPlanExpired(userId)) {
    await execute(
      "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,'-','warning',$4,'inbound',$5,'blocked','plan_expired','plan_gate')",
      [
        uuid(),
        userId,
        sourceName,
        JSON.stringify({
          message,
          reason: "plan_expired",
        }),
        messageType,
      ],
    );
    return { dispatched: 0, routesMatched: 0 };
  }

  const shopeeCredentials = await queryOne<{ app_id: string; secret_key: string; region: string }>(
    "SELECT app_id, secret_key, region FROM api_credentials WHERE user_id = $1 AND provider = 'shopee'",
    [userId],
  );
  if (shopeeCredentials) shopeeCredentials.secret_key = decryptCredential(shopeeCredentials.secret_key);
  const shopeeConversionCache = new Map<string, {
    affiliateLink: string;
    resolvedUrl: string;
    ok: boolean;
    error?: string;
    productImageUrl?: string;
    product?: Record<string, unknown>;
  }>();
  const meliConversionCache = new Map<string, { affiliateLink: string; ok: boolean; error?: string }>();
  const amazonConversionCache = new Map<string, {
    affiliateLink: string;
    resolvedUrl: string;
    asin: string;
    ok: boolean;
    error?: string;
  }>();
  const routeMeliSessionCache = new Map<string, string>();
  const routeTemplateCache = new Map<string, { content: string; scope: TemplateScope } | null>();
  const shouldScheduleInboundMediaDeletion = Boolean(media?.token);
  let inboundMediaDeleteDelayMs = 120_000;

  try {

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
     LEFT JOIN groups sg ON sg.id::text = r.source_group_id AND sg.user_id::text = r.user_id::text
     LEFT JOIN route_destinations rd ON rd.route_id = r.id
     WHERE r.user_id::text = $1
       AND r.status = 'active'
       AND (
         r.source_group_id = ANY($2::text[])
         OR EXISTS (
           SELECT 1 FROM groups g
            WHERE g.id::text = r.source_group_id
              AND g.external_id = ANY($3::text[])
              AND g.deleted_at IS NULL
         )
       )
     GROUP BY r.id, sg.external_id`,
    [userId, Array.from(sourceCandidates), sourceExternalCandidates],
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
      [uuid(), userId, sourceName, JSON.stringify({ message, sourceExternalId, sessionId, reason: "no_active_routes", hasMedia: !!media }), media ? media.kind : "text"],
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
       WHERE l.master_group_id = ANY($1::uuid[])
          AND l.is_active <> FALSE
          AND mg.user_id::text = $2`,
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
      "SELECT id, name, platform, session_id, external_id FROM groups WHERE id = ANY($1::uuid[]) AND user_id::text = $2 AND deleted_at IS NULL",
      [[...allTargetGroupIds], userId],
    )
    : [];
  const destGroupMap = new Map(destGroupRows.map((group) => [String(group.id), group]));

  let dispatched = 0;
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
    const shouldResolveUnknownLinks = requirePartnerLink ? true : shouldResolveBeforeValidate;
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
        resolved = await resolveRouteLinkWithRedirect(original);
        resolvedMarketplace = detectRoutePartnerMarketplace(resolved);
      }

      const partnerMarketplace = resolvedMarketplace && enabledPartnerMarketplaces.includes(resolvedMarketplace)
        ? resolvedMarketplace
        : null;
      inspectedLinks.push({ original, resolved, originalMarketplace, resolvedMarketplace, partnerMarketplace });
    }

    const disallowedMarketplaceLink = inspectedLinks.find((item) => {
      const detected = item.originalMarketplace || item.resolvedMarketplace;
      if (!detected || enabledPartnerMarketplaces.includes(detected)) return false;
      // Keep existing hard-block for disabled marketplaces, but Amazon can be ignored when disabled.
      return detected !== "amazon";
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
    let primaryConvertedMarketplace: string | null = null;

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

        const rawConversionSource = link.resolvedMarketplace === "shopee" ? link.resolved : link.original;
        let conversionSource = rawConversionSource;
        if (shouldResolveShopeeLinkForProductData(rawConversionSource)) {
          const resolvedCandidate = await resolveRouteLinkWithRedirect(rawConversionSource);
          if (isShopeeProductUrlLike(resolvedCandidate)) {
            conversionSource = resolvedCandidate;
          }
        }
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
        if (!primaryConvertedMarketplace) {
          primaryConvertedMarketplace = "shopee";
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
        if (!primaryConvertedMarketplace) {
          primaryConvertedMarketplace = "mercadolivre";
        }
        convertedLinks += 1;
        continue;
      }

      if (marketplace === "amazon") {
        linksEligibleForConversion += 1;
        const conversionSource = link.resolvedMarketplace === "amazon" ? link.resolved : link.original;
        const normalizedConversionSource = canonicalizeAmazonProductUrl(conversionSource) || conversionSource;
        const cacheKey = normalizedConversionSource;

        let conversion = amazonConversionCache.get(cacheKey);
        if (!conversion) {
          try {
            const result = await buildAmazonAffiliateConversionForUser(userId, normalizedConversionSource);
            conversion = {
              affiliateLink: String(result.affiliateLink || "").trim(),
              resolvedUrl: String(result.resolvedUrl || normalizedConversionSource),
              asin: String(result.asin || "").trim().toUpperCase(),
              ok: Boolean(String(result.affiliateLink || "").trim()),
            };
          } catch (error) {
            conversion = {
              affiliateLink: "",
              resolvedUrl: normalizedConversionSource,
              asin: "",
              ok: false,
              error: error instanceof Error ? error.message : "Falha ao converter link Amazon.",
            };
          }
          amazonConversionCache.set(cacheKey, conversion);
        }

        if (!conversion.ok || !conversion.affiliateLink) {
          conversionFailure = { reason: "amazon_conversion_failed", error: conversion.error || "Falha ao converter link Amazon." };
          break;
        }

        outboundText = outboundText.split(link.original).join(conversion.affiliateLink);
        if (link.resolved && link.resolved !== link.original) {
          outboundText = outboundText.split(link.resolved).join(conversion.affiliateLink);
        }
        if (!primaryLink || primaryLink === link.original || primaryLink === link.resolved) {
          primaryLink = conversion.affiliateLink;
        }
        if (!primaryConvertedMarketplace) {
          primaryConvertedMarketplace = "amazon";
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

    const readTemplateId = (value: unknown): string => {
      const raw = typeof value === "string" ? value.trim() : "";
      return raw && raw !== "none" && raw !== "original"
        ? raw
        : "";
    };

    const defaultTemplateId = readTemplateId(rules.templateId);
    const amazonTemplateId = readTemplateId(rules.amazonTemplateId);
    const templateId = primaryConvertedMarketplace === "amazon"
      ? amazonTemplateId
      : defaultTemplateId;
    if (templateId && isUuid(templateId)) {
      let templateData = routeTemplateCache.get(templateId);
      if (templateData === undefined) {
        const templateRow = await queryOne<{ content: string; scope: string | null; tags: unknown }>(
          "SELECT content, scope, tags FROM templates WHERE user_id = $1 AND id = $2",
          [userId, templateId],
        );
        templateData = templateRow && typeof templateRow.content === "string"
          ? {
              content: templateRow.content,
              scope: inferTemplateScopeFromTemplateRow(templateRow as unknown as Record<string, unknown>),
            }
          : null;
        routeTemplateCache.set(templateId, templateData);
      }

      if (templateData?.content) {
        const placeholderData = buildRouteTemplatePlaceholderData(primaryProduct, primaryLink, outboundText);
        outboundText = applyScopedTemplatePlaceholders(templateData.scope, templateData.content, placeholderData);
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
    const routeMessageType = routeMedia ? routeMedia.kind : "text";
    if (!routeMedia) {
      const inferredMediaIngestionFailure = hasMediaHint;
      const missingImageReason = inferredMediaIngestionFailure
        ? "image_ingestion_failed"
        : "missing_image_required";
      logRouteMediaDebug("route.process.blocked.missing_image_required.inbound", {
        userId,
        sessionId,
        routeId: route.id,
        routeName: route.name,
        sourceExternalId,
        sourceName,
        hasText: Boolean(outboundText),
        textLength: String(outboundText || "").trim().length,
        reason: missingImageReason,
        hasMediaHint,
        mediaKindHint: normalizedMediaKindHint,
        originalMedia: summarizeRouteForwardMedia(media),
      });
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'warning',$5,'inbound',$6,'blocked',$7,'media_requirements')",
        [uuid(), userId, sourceName, route.name, JSON.stringify({
          message: outboundText,
          routeId: route.id,
          routeName: route.name,
          reason: missingImageReason,
          hasMedia: false,
          hasMediaHint,
          mediaKindHint: normalizedMediaKindHint || undefined,
        }), routeMessageType, missingImageReason],
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

    const quietHoursEnabled = rules.quietHoursEnabled === true;
    const quietHoursStart = normalizeClockTimeForRules(rules.quietHoursStart, ROUTE_QUIET_HOURS_DEFAULT_START);
    const quietHoursEnd = normalizeClockTimeForRules(rules.quietHoursEnd, ROUTE_QUIET_HOURS_DEFAULT_END);
    if (quietHoursEnabled && isInRouteQuietHoursWindow(quietHoursStart, quietHoursEnd)) {
      const queuedMinutes = minutesUntilRouteQuietHoursEnd(quietHoursStart, quietHoursEnd);
      const resumeAtIso = new Date(Date.now() + (queuedMinutes * 60_000) + 15_000).toISOString();
      const queuedMedia = await materializeRouteMediaForQueue(userId, routeMedia);

      if (shouldScheduleInboundMediaDeletion && queuedMedia?.token && !queuedMedia.base64) {
        inboundMediaDeleteDelayMs = Math.max(
          inboundMediaDeleteDelayMs,
          (queuedMinutes * 60_000) + 120_000,
        );
      }

      const queueResult = await queueRouteForwardForQuietHours({
        userId,
        routeId: route.id,
        routeName: route.name,
        sourceName,
        sourceExternalId,
        sessionId,
        content: outboundText,
        media: queuedMedia,
        destinationGroupIds: filteredTargetIds,
        quietHoursStart,
        quietHoursEnd,
        scheduledAtIso: resumeAtIso,
      });

      if (!queueResult.queued) {
        await execute(
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'error',$5,'inbound',$6,'failed','quiet_hours_queue_failed','quiet_hours')",
          [uuid(), userId, sourceName, route.name, JSON.stringify({
            message: outboundText,
            routeId: route.id,
            routeName: route.name,
            reason: "quiet_hours_queue_failed",
            quietHoursStart,
            quietHoursEnd,
            queuedUntil: resumeAtIso,
            destinationCount: filteredTargetIds.length,
            error: queueResult.error || "Falha ao enfileirar durante janela silenciosa",
            hasMedia: !!queuedMedia,
          }), routeMessageType],
        );
      } else {
        await execute(
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'info',$5,'inbound',$6,'blocked','quiet_hours_queued','quiet_hours')",
          [uuid(), userId, sourceName, route.name, JSON.stringify({
            message: outboundText,
            routeId: route.id,
            routeName: route.name,
            reason: "quiet_hours_queued",
            quietHoursStart,
            quietHoursEnd,
            queuedUntil: resumeAtIso,
            destinationCount: filteredTargetIds.length,
            queuePostId: queueResult.postId || null,
            hasMedia: !!queuedMedia,
          }), routeMessageType],
        );
      }

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
          "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'error',$5,'outbound','text','failed','destination_session_offline','destination_validation')",
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
          [uuid(), userId, sourceName, group.name, JSON.stringify({ message: outboundTextSafe, routeId: route.id, routeName: route.name, error: result.error.message, platform, hasMedia: !!mediaForDestination }), mediaForDestination ? mediaForDestination.kind : "text"],
        );
        continue;
      }

      dispatched += 1;
      routeDispatched += 1;
      await execute(
        "INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'route_forward',$3,$4,'success',$5,'outbound',$6,'sent','','')",
        [uuid(), userId, sourceName, group.name, JSON.stringify({ message: outboundTextSafe, platform, routeId: route.id, routeName: route.name, hasMedia: !!mediaForDestination, ...(autoImageSource ? { autoImageSource } : {}) }), mediaForDestination ? mediaForDestination.kind : "text"],
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

  return { dispatched, routesMatched: matching.length };
  } finally {
    if (shouldScheduleInboundMediaDeletion) {
      await scheduleRouteForwardMediaDeletion({
        userId,
        media,
        delayMs: inboundMediaDeleteDelayMs,
      });
    }
  }
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
    pushChannelPollError({
      platform: "whatsapp",
      userId,
      sessionId,
      stage: "fetch_events",
      message: upstream.error.message,
      status: Number((upstream.error as { status?: number }).status) || null,
    });
    if (isNotFoundSessionError(upstream.error.message)) {
      // In shared DB mode another runtime may own this session. Preserve the last known state
      // unless the owning runtime explicitly emits an offline/close event.
      return 0;
    }
    if (isTransientMicroserviceError(upstream.error)) {
      return 0;
    }
    await execute(
      "UPDATE whatsapp_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
      [upstream.error.message, sessionId, userId],
    );
    return 0;
  }
  const events = toIntegrationEvents(upstream.data);
  if (events.length === 0) return 0;
  try {
    await applyWhatsAppEvents(userId, sessionId, events);
  } catch (error) {
    pushChannelPollError({
      platform: "whatsapp",
      userId,
      sessionId,
      stage: "apply_events",
      message: error instanceof Error ? error.message : String(error),
      status: null,
    });
    throw error;
  }
  return events.length;
}

type TelegramBackfillTarget = {
  chatId: string;
  minMessageId: number;
  since: string | null;
  limit: number;
};

async function loadTelegramBackfillTargets(userId: string, sessionId: string): Promise<TelegramBackfillTarget[]> {
  const rows = await query<{
    chat_id: string;
    last_message_id: string | number | null;
    since_at: string | null;
  }>(
    `WITH active_sources AS (
       SELECT
         COALESCE(sg.external_id, '') AS chat_id,
         MIN(r.created_at) AS first_route_created_at
       FROM routes r
       JOIN groups sg
         ON sg.id::text = r.source_group_id
        AND sg.user_id::text = r.user_id::text
      WHERE r.user_id::text = $1
        AND r.status = 'active'
        AND sg.platform = 'telegram'
        AND COALESCE(sg.session_id::text, '') = $2
        AND sg.deleted_at IS NULL
        AND COALESCE(sg.external_id, '') <> ''
      GROUP BY 1
     ),
     capture_state AS (
       SELECT
         COALESCE(details->>'sourceExternalId', '') AS chat_id,
         MAX(
           CASE
             WHEN COALESCE(details->>'sourceMessageId', '') ~ '^[0-9]+$'
               THEN (details->>'sourceMessageId')::bigint
             ELSE 0
           END
         ) AS last_message_id,
         MAX(created_at) AS last_captured_at
       FROM history_entries
      WHERE user_id::text = $1
        AND type = 'session_event'
        AND COALESCE(details->>'platform', '') = 'telegram'
        AND COALESCE(details->>'sessionId', '') = $2
      GROUP BY 1
     )
     SELECT
       s.chat_id,
       c.last_message_id,
       COALESCE(
         c.last_captured_at,
         GREATEST(s.first_route_created_at, NOW() - make_interval(hours => $3::int))
       )::text AS since_at
     FROM active_sources s
     LEFT JOIN capture_state c
       ON c.chat_id = s.chat_id`,
    [userId, sessionId, TELEGRAM_BACKFILL_WINDOW_HOURS],
  );

  return rows
    .map((row) => {
      const chatId = String(row.chat_id || "").trim();
      if (!chatId) return null;
      const minMessageId = Math.max(0, Number(row.last_message_id) || 0);
      const since = String(row.since_at || "").trim() || null;
      return {
        chatId,
        minMessageId,
        since,
        limit: TELEGRAM_BACKFILL_BATCH_LIMIT,
      } satisfies TelegramBackfillTarget;
    })
    .filter((row): row is TelegramBackfillTarget => Boolean(row));
}

async function pollTelegramBackfillForSession(userId: string, sessionId: string): Promise<number> {
  const targets = await loadTelegramBackfillTargets(userId, sessionId);
  if (targets.length === 0) return 0;

  const headers = buildUserScopedHeaders(userId);
  const upstream = await proxyMicroservice(
    TELEGRAM_URL,
    "/api/telegram/pull-messages",
    "POST",
    {
      sessionId,
      limit: TELEGRAM_BACKFILL_BATCH_LIMIT,
      chats: targets.map((target) => ({
        chatId: target.chatId,
        minMessageId: target.minMessageId,
        since: target.since,
        limit: target.limit,
      })),
    },
    headers,
    TELEGRAM_BACKFILL_TIMEOUT_MS,
  );

  if (upstream.error) {
    pushChannelPollError({
      platform: "telegram",
      userId,
      sessionId,
      stage: "fetch_backfill",
      message: upstream.error.message,
      status: Number((upstream.error as { status?: number }).status) || null,
    });
    return 0;
  }

  const events = toIntegrationEvents(upstream.data);
  if (events.length === 0) return 0;

  try {
    await applyTelegramEvents(userId, sessionId, events);
  } catch (error) {
    pushChannelPollError({
      platform: "telegram",
      userId,
      sessionId,
      stage: "apply_events",
      message: error instanceof Error ? error.message : String(error),
      status: null,
    });
    throw error;
  }

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
    pushChannelPollError({
      platform: "telegram",
      userId,
      sessionId,
      stage: "fetch_events",
      message: upstream.error.message,
      status: Number((upstream.error as { status?: number }).status) || null,
    });
    if (isNotFoundSessionError(upstream.error.message)) {
      // In shared DB mode another runtime may own this session. Preserve the last known state
      // unless the owning runtime explicitly emits an offline/close event.
      return 0;
    }
    if (isTransientMicroserviceError(upstream.error)) {
      return 0;
    }
    await execute(
      "UPDATE telegram_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
      [upstream.error.message, sessionId, userId],
    );
    return 0;
  }
  const events = toIntegrationEvents(upstream.data);
  let appliedEvents = 0;
  try {
    if (events.length > 0) {
      await applyTelegramEvents(userId, sessionId, events);
      appliedEvents = events.length;
    }
  } catch (error) {
    pushChannelPollError({
      platform: "telegram",
      userId,
      sessionId,
      stage: "apply_events",
      message: error instanceof Error ? error.message : String(error),
      status: null,
    });
    throw error;
  }
  const backfilledEvents = await pollTelegramBackfillForSession(userId, sessionId);
  return appliedEvents + backfilledEvents;
}

type ChannelPollSessionRow = {
  id: string;
  user_id: string;
};

function dedupeChannelPollSessions(rows: ChannelPollSessionRow[]): ChannelPollSessionRow[] {
  const seen = new Set<string>();
  const deduped: ChannelPollSessionRow[] = [];

  for (const row of rows) {
    const sessionId = String(row.id || "").trim();
    const userId = String(row.user_id || "").trim();
    if (!sessionId || !userId) continue;
    const key = `${userId}::${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ id: sessionId, user_id: userId });
  }

  return deduped;
}

async function loadOnlineSessionsFromConnectorHealth(input: {
  platform: "whatsapp" | "telegram";
  requesterUserId: string;
  canRunGlobal: boolean;
}): Promise<ChannelPollSessionRow[]> {
  const baseUrl = input.platform === "whatsapp" ? WHATSAPP_URL : TELEGRAM_URL;
  if (!baseUrl) return [];
  const requesterUserId = String(input.requesterUserId || "").trim().toLowerCase();

  const userHeaders = input.canRunGlobal ? {} : buildUserScopedHeaders(requesterUserId || input.requesterUserId);
  // The Baileys/Telegram health endpoint returns full session details only when
  // the shared WEBHOOK_SECRET is present; without it the response contains only
  // aggregate counts and session-level filtering cannot work.
  const healthHeaders: Record<string, string> = { ...userHeaders };
  if (WEBHOOK_SECRET) healthHeaders["x-webhook-secret"] = WEBHOOK_SECRET;
  const upstream = await proxyMicroservice(baseUrl, "/health", "GET", null, healthHeaders, 6_000);
  if (upstream.error) return [];

  const payload = (upstream.data && typeof upstream.data === "object")
    ? upstream.data as Record<string, unknown>
    : {};
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const onlineRows: ChannelPollSessionRow[] = [];

  for (const raw of sessions) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;

    const sessionId = String(row.sessionId ?? row.id ?? "").trim();
    const userId = String(row.userId ?? row.user_id ?? "").trim().toLowerCase();
    if (!sessionId || !userId) continue;
    if (!input.canRunGlobal && requesterUserId && userId !== requesterUserId) continue;

    const status = String(row.status ?? "").trim().toLowerCase();
    const online = status === "online" || row.online === true;
    if (!online) continue;

    onlineRows.push({ id: sessionId, user_id: userId });
  }

  return dedupeChannelPollSessions(onlineRows);
}

async function filterSessionsByExecutionGate(rows: ChannelPollSessionRow[]): Promise<ChannelPollSessionRow[]> {
  const dedupedRows = dedupeChannelPollSessions(rows);
  if (dedupedRows.length === 0) return dedupedRows;

  const userIds = [...new Set(dedupedRows.map((row) => String(row.user_id || "").trim()).filter(Boolean))];
  if (userIds.length === 0) return [];

  const allowedRows = await query<{ user_id: string }>(
    `WITH ids AS (
       SELECT UNNEST($1::text[]) AS user_id
     )
     SELECT ids.user_id
       FROM ids
       LEFT JOIN user_roles ur ON ur.user_id::text = ids.user_id
       LEFT JOIN profiles p ON p.user_id::text = ids.user_id
      WHERE COALESCE(ur.role, 'user') = 'admin'
         OR (p.user_id IS NOT NULL AND (p.plan_expires_at IS NULL OR p.plan_expires_at > NOW()))`,
    [userIds],
  );

  const allowedUserIds = new Set(allowedRows.map((row) => String(row.user_id || "").trim()).filter(Boolean));
  return dedupedRows.filter((row) => allowedUserIds.has(String(row.user_id || "").trim()));
}

type ChannelPollRuntimeResult = {
  source: string;
  scope: "user" | "global";
  whatsappSessions: number;
  whatsappEvents: number;
  whatsappHealthFallbackAdded: number;
  telegramSessions: number;
  telegramEvents: number;
  telegramHealthFallbackAdded: number;
  failed: number;
  orphanCleanup: ChannelOrphanCleanupResult | null;
};

type ChannelPollErrorEntry = {
  at: string;
  platform: "whatsapp" | "telegram";
  userId: string;
  sessionId: string;
  stage: "fetch_events" | "fetch_backfill" | "apply_events" | "session_loop";
  message: string;
  status: number | null;
};

const CHANNEL_POLL_ERROR_BUFFER_LIMIT = 80;
const channelPollErrors: ChannelPollErrorEntry[] = [];

function pushChannelPollError(input: Omit<ChannelPollErrorEntry, "at">): void {
  const message = String(input.message || "").trim();
  if (!message) return;
  channelPollErrors.push({
    at: nowIso(),
    platform: input.platform,
    userId: String(input.userId || "").trim(),
    sessionId: String(input.sessionId || "").trim(),
    stage: input.stage,
    message,
    status: Number.isFinite(input.status) ? Number(input.status) : null,
  });
  if (channelPollErrors.length > CHANNEL_POLL_ERROR_BUFFER_LIMIT) {
    channelPollErrors.splice(0, channelPollErrors.length - CHANNEL_POLL_ERROR_BUFFER_LIMIT);
  }
}

const channelPollRuntime = {
  lastStartedAt: null as string | null,
  lastFinishedAt: null as string | null,
  lastDurationMs: null as number | null,
  successCount: 0,
  failureCount: 0,
  lastError: "",
  lastResult: null as ChannelPollRuntimeResult | null,
};

type ChannelRuntimeSessionRow = {
  sessionId: string;
  userId: string;
  status: string;
};

type ChannelOrphanCleanupResult = {
  scope: "user" | "global";
  trigger: string;
  runtime: {
    scanned: { whatsapp: number; telegram: number };
    staleDetected: { whatsapp: number; telegram: number };
    removed: { whatsapp: number; telegram: number };
    failed: { whatsapp: number; telegram: number };
  };
  db: {
    groupsScanned: number;
    remapPairs: number;
    orphanGroupsDetected: number;
    sourceRoutesRemapped: number;
    routeDestinationsRemapped: number;
    masterGroupLinksRemapped: number;
    scheduledDestinationsRemapped: number;
    sourceRoutesCleared: number;
    routeDestinationsDeleted: number;
    masterGroupLinksDeleted: number;
    scheduledDestinationsDeleted: number;
    groupsDeleted: number;
  };
  finishedAt: string;
};

const CHANNEL_ORPHAN_SWEEP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.CHANNEL_ORPHAN_SWEEP_INTERVAL_MS || "180000"),
);
const CHANNEL_ORPHAN_SWEEP_AUTO_ENABLED = !IS_PRODUCTION
  && String(process.env.CHANNEL_ORPHAN_SWEEP_AUTO || "1").trim() !== "0";
let channelOrphanSweepLastRunMs = 0;
let channelOrphanSweepInFlight: Promise<ChannelOrphanCleanupResult> | null = null;
const channelOrphanSweepRuntime = {
  lastStartedAt: null as string | null,
  lastFinishedAt: null as string | null,
  lastDurationMs: null as number | null,
  successCount: 0,
  failureCount: 0,
  lastError: "",
  lastResult: null as ChannelOrphanCleanupResult | null,
};

function parseConnectorRuntimeSessions(
  payload: unknown,
  requesterUserId: string,
  canRunGlobal: boolean,
): ChannelRuntimeSessionRow[] {
  const root = (payload && typeof payload === "object")
    ? payload as Record<string, unknown>
    : {};
  const sessionsRaw = Array.isArray(root.sessions) ? root.sessions : [];
  const rows: ChannelRuntimeSessionRow[] = [];

  for (const item of sessionsRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const sessionId = String(row.sessionId ?? row.id ?? "").trim();
    const userId = String(row.userId ?? row.user_id ?? "").trim();
    const status = String(row.status ?? "").trim().toLowerCase();
    if (!sessionId || !userId) continue;
    if (!canRunGlobal && userId !== requesterUserId) continue;
    rows.push({ sessionId, userId, status });
  }

  return rows;
}

async function loadConnectorRuntimeSessions(input: {
  platform: "whatsapp" | "telegram";
  requesterUserId: string;
  canRunGlobal: boolean;
}): Promise<ChannelRuntimeSessionRow[]> {
  const baseUrl = input.platform === "whatsapp" ? WHATSAPP_URL : TELEGRAM_URL;
  if (!baseUrl) return [];
  const headers = input.canRunGlobal ? {} : buildUserScopedHeaders(input.requesterUserId);
  const upstream = await proxyMicroservice(baseUrl, "/health", "GET", null, headers, 8_000);
  if (upstream.error) return [];
  return parseConnectorRuntimeSessions(upstream.data, input.requesterUserId, input.canRunGlobal);
}

function scoreSessionStatus(statusRaw: string): number {
  const status = String(statusRaw || "").trim().toLowerCase();
  if (status === "online") return 3;
  if (status === "connecting") return 2;
  if (status === "qr_code" || status === "pairing_code" || status === "awaiting_code" || status === "awaiting_password") return 1;
  return 0;
}

async function runChannelOrphanCleanup(input: {
  requesterUserId: string;
  canRunGlobal: boolean;
  trigger: string;
}): Promise<ChannelOrphanCleanupResult> {
  const scope: "user" | "global" = input.canRunGlobal ? "global" : "user";
  const scopeParams: unknown[] = [];
  const scopeFilter = input.canRunGlobal ? "" : "WHERE user_id = $1";
  if (!input.canRunGlobal) scopeParams.push(input.requesterUserId);

  const [waSessionsDb, tgSessionsDb] = await Promise.all([
    query<{ id: string; user_id: string; status: string }>(
      `SELECT id, user_id, COALESCE(status, '') AS status FROM whatsapp_sessions ${scopeFilter}`,
      scopeParams,
    ),
    query<{ id: string; user_id: string; status: string }>(
      `SELECT id, user_id, COALESCE(status, '') AS status FROM telegram_sessions ${scopeFilter}`,
      scopeParams,
    ),
  ]);

  const waDbSet = new Set(waSessionsDb.map((row) => `${String(row.user_id)}::${String(row.id)}`));
  const tgDbSet = new Set(tgSessionsDb.map((row) => `${String(row.user_id)}::${String(row.id)}`));
  const waStatusBySession = new Map(waSessionsDb.map((row) => [`${String(row.user_id)}::${String(row.id)}`, String(row.status || "")]));
  const tgStatusBySession = new Map(tgSessionsDb.map((row) => [`${String(row.user_id)}::${String(row.id)}`, String(row.status || "")]));

  const runtime = {
    scanned: { whatsapp: 0, telegram: 0 },
    staleDetected: { whatsapp: 0, telegram: 0 },
    removed: { whatsapp: 0, telegram: 0 },
    failed: { whatsapp: 0, telegram: 0 },
  };

  const [waRuntime, tgRuntime] = await Promise.all([
    loadConnectorRuntimeSessions({
      platform: "whatsapp",
      requesterUserId: input.requesterUserId,
      canRunGlobal: input.canRunGlobal,
    }),
    loadConnectorRuntimeSessions({
      platform: "telegram",
      requesterUserId: input.requesterUserId,
      canRunGlobal: input.canRunGlobal,
    }),
  ]);

  runtime.scanned.whatsapp = waRuntime.length;
  runtime.scanned.telegram = tgRuntime.length;

  for (const row of waRuntime) {
    const key = `${row.userId}::${row.sessionId}`;
    if (waDbSet.has(key)) continue;
    runtime.staleDetected.whatsapp += 1;
    const disconnect = await proxyMicroservice(
      WHATSAPP_URL,
      `/api/sessions/${encodeURIComponent(row.sessionId)}/disconnect`,
      "POST",
      { sessionId: row.sessionId },
      buildUserScopedHeaders(row.userId),
      10_000,
    );
    if (disconnect.error) {
      runtime.failed.whatsapp += 1;
      pushChannelPollError({
        platform: "whatsapp",
        userId: row.userId,
        sessionId: row.sessionId,
        stage: "session_loop",
        message: `orphan runtime cleanup failed: ${disconnect.error.message}`,
        status: Number((disconnect.error as { status?: number }).status) || null,
      });
      continue;
    }
    runtime.removed.whatsapp += 1;
  }

  for (const row of tgRuntime) {
    const key = `${row.userId}::${row.sessionId}`;
    if (tgDbSet.has(key)) continue;
    runtime.staleDetected.telegram += 1;
    const disconnect = await proxyMicroservice(
      TELEGRAM_URL,
      "/api/telegram/disconnect",
      "POST",
      { sessionId: row.sessionId, clearSession: true },
      buildUserScopedHeaders(row.userId),
      10_000,
    );
    if (disconnect.error) {
      runtime.failed.telegram += 1;
      pushChannelPollError({
        platform: "telegram",
        userId: row.userId,
        sessionId: row.sessionId,
        stage: "session_loop",
        message: `orphan runtime cleanup failed: ${disconnect.error.message}`,
        status: Number((disconnect.error as { status?: number }).status) || null,
      });
      continue;
    }
    runtime.removed.telegram += 1;
  }

  const groups = await query<{
    id: string;
    user_id: string;
    platform: string;
    session_id: string | null;
    external_id: string | null;
    deleted_at: string | null;
    updated_at: string | null;
    created_at: string | null;
  }>(
    `SELECT id, user_id, platform, session_id, external_id, deleted_at, updated_at, created_at
       FROM groups
       ${scopeFilter}`,
    scopeParams,
  );

  const isValidGroupSession = (row: {
    user_id: string;
    platform: string;
    session_id: string | null;
  }): boolean => {
    const sessionId = String(row.session_id || "").trim();
    if (!sessionId) return false;
    const key = `${String(row.user_id)}::${sessionId}`;
    if (String(row.platform || "") === "whatsapp") return waDbSet.has(key);
    if (String(row.platform || "") === "telegram") return tgDbSet.has(key);
    return false;
  };

  const remap = new Map<string, string>();
  const activeGroups = groups.filter((row) => !row.deleted_at);
  const duplicateBuckets = new Map<string, typeof activeGroups>();

  for (const group of activeGroups) {
    const externalId = String(group.external_id || "").trim().toLowerCase();
    if (!externalId) continue;
    const key = `${String(group.user_id)}::${String(group.platform)}::${externalId}`;
    const bucket = duplicateBuckets.get(key) || [];
    bucket.push(group);
    duplicateBuckets.set(key, bucket);
  }

  for (const rows of duplicateBuckets.values()) {
    if (rows.length <= 1) continue;
    const validRows = rows.filter((row) => isValidGroupSession(row));
    if (validRows.length === 0) continue;

    const canonical = [...validRows].sort((a, b) => {
      const aStatus = String(a.platform) === "whatsapp"
        ? waStatusBySession.get(`${String(a.user_id)}::${String(a.session_id || "")}`) || ""
        : tgStatusBySession.get(`${String(a.user_id)}::${String(a.session_id || "")}`) || "";
      const bStatus = String(b.platform) === "whatsapp"
        ? waStatusBySession.get(`${String(b.user_id)}::${String(b.session_id || "")}`) || ""
        : tgStatusBySession.get(`${String(b.user_id)}::${String(b.session_id || "")}`) || "";
      const statusDiff = scoreSessionStatus(bStatus) - scoreSessionStatus(aStatus);
      if (statusDiff !== 0) return statusDiff;
      const aUpdated = Date.parse(String(a.updated_at || a.created_at || ""));
      const bUpdated = Date.parse(String(b.updated_at || b.created_at || ""));
      if (Number.isFinite(aUpdated) && Number.isFinite(bUpdated) && bUpdated !== aUpdated) return bUpdated - aUpdated;
      return String(a.id).localeCompare(String(b.id));
    })[0];

    for (const row of rows) {
      const oldId = String(row.id);
      const newId = String(canonical.id);
      if (!oldId || !newId || oldId === newId) continue;
      remap.set(oldId, newId);
    }
  }

  const orphanGroupIds = new Set<string>();
  for (const row of activeGroups) {
    if (!isValidGroupSession(row)) {
      orphanGroupIds.add(String(row.id));
    }
  }

  for (const oldId of remap.keys()) {
    orphanGroupIds.add(oldId);
  }
  for (const newId of remap.values()) {
    orphanGroupIds.delete(newId);
  }

  const remapPairs = [...remap.entries()].filter(([oldId, newId]) => oldId !== newId);
  const removeGroupIds = [...orphanGroupIds].filter(Boolean);

  const dbStats = await transaction(async (client) => {
    let sourceRoutesRemapped = 0;
    let routeDestinationsRemapped = 0;
    let masterGroupLinksRemapped = 0;
    let scheduledDestinationsRemapped = 0;

    for (const [oldId, newId] of remapPairs) {
      if (!oldId || !newId || oldId === newId) continue;
      const sourceRes = await client.query(
        "UPDATE routes SET source_group_id = $1, updated_at = NOW() WHERE source_group_id = $2",
        [newId, oldId],
      );
      sourceRoutesRemapped += sourceRes.rowCount ?? 0;

      const routeDestInsert = await client.query(
        `INSERT INTO route_destinations (route_id, group_id)
         SELECT route_id, $1
           FROM route_destinations
          WHERE group_id = $2
         ON CONFLICT (route_id, group_id) DO NOTHING`,
        [newId, oldId],
      );
      routeDestinationsRemapped += routeDestInsert.rowCount ?? 0;
      await client.query("DELETE FROM route_destinations WHERE group_id = $1", [oldId]);

      const masterInsert = await client.query(
        `INSERT INTO master_group_links (master_group_id, group_id, is_active)
         SELECT master_group_id, $1, is_active
           FROM master_group_links
          WHERE group_id = $2
         ON CONFLICT (master_group_id, group_id)
         DO UPDATE SET is_active = (master_group_links.is_active OR EXCLUDED.is_active)`,
        [newId, oldId],
      );
      masterGroupLinksRemapped += masterInsert.rowCount ?? 0;
      await client.query("DELETE FROM master_group_links WHERE group_id = $1", [oldId]);

      const scheduledInsert = await client.query(
        `INSERT INTO scheduled_post_destinations (post_id, group_id)
         SELECT post_id, $1
           FROM scheduled_post_destinations
          WHERE group_id = $2
         ON CONFLICT (post_id, group_id) DO NOTHING`,
        [newId, oldId],
      );
      scheduledDestinationsRemapped += scheduledInsert.rowCount ?? 0;
      await client.query("DELETE FROM scheduled_post_destinations WHERE group_id = $1", [oldId]);
    }

    let sourceRoutesCleared = 0;
    let routeDestinationsDeleted = 0;
    let masterGroupLinksDeleted = 0;
    let scheduledDestinationsDeleted = 0;
    let groupsDeleted = 0;

    if (removeGroupIds.length > 0) {
      const sourceClear = await client.query(
        `UPDATE routes
            SET source_group_id = '',
                status = CASE WHEN status = 'active' THEN 'inactive' ELSE status END,
                updated_at = NOW()
          WHERE source_group_id = ANY($1::text[])`,
        [removeGroupIds],
      );
      sourceRoutesCleared = sourceClear.rowCount ?? 0;

      const routeDestDelete = await client.query(
        "DELETE FROM route_destinations WHERE group_id = ANY($1::uuid[])",
        [removeGroupIds],
      );
      routeDestinationsDeleted = routeDestDelete.rowCount ?? 0;

      const masterDelete = await client.query(
        "DELETE FROM master_group_links WHERE group_id = ANY($1::uuid[])",
        [removeGroupIds],
      );
      masterGroupLinksDeleted = masterDelete.rowCount ?? 0;

      const scheduledDelete = await client.query(
        "DELETE FROM scheduled_post_destinations WHERE group_id = ANY($1::uuid[])",
        [removeGroupIds],
      );
      scheduledDestinationsDeleted = scheduledDelete.rowCount ?? 0;

      const groupsDelete = await client.query(
        "DELETE FROM groups WHERE id = ANY($1::uuid[])",
        [removeGroupIds],
      );
      groupsDeleted = groupsDelete.rowCount ?? 0;
    }

    return {
      sourceRoutesRemapped,
      routeDestinationsRemapped,
      masterGroupLinksRemapped,
      scheduledDestinationsRemapped,
      sourceRoutesCleared,
      routeDestinationsDeleted,
      masterGroupLinksDeleted,
      scheduledDestinationsDeleted,
      groupsDeleted,
    };
  });

  return {
    scope,
    trigger: String(input.trigger || "manual"),
    runtime,
    db: {
      groupsScanned: groups.length,
      remapPairs: remapPairs.length,
      orphanGroupsDetected: orphanGroupIds.size,
      sourceRoutesRemapped: dbStats.sourceRoutesRemapped,
      routeDestinationsRemapped: dbStats.routeDestinationsRemapped,
      masterGroupLinksRemapped: dbStats.masterGroupLinksRemapped,
      scheduledDestinationsRemapped: dbStats.scheduledDestinationsRemapped,
      sourceRoutesCleared: dbStats.sourceRoutesCleared,
      routeDestinationsDeleted: dbStats.routeDestinationsDeleted,
      masterGroupLinksDeleted: dbStats.masterGroupLinksDeleted,
      scheduledDestinationsDeleted: dbStats.scheduledDestinationsDeleted,
      groupsDeleted: dbStats.groupsDeleted,
    },
    finishedAt: nowIso(),
  };
}

async function maybeRunAutoChannelOrphanCleanup(input: {
  requesterUserId: string;
  canRunGlobal: boolean;
  trigger: string;
}): Promise<ChannelOrphanCleanupResult | null> {
  if (!CHANNEL_ORPHAN_SWEEP_AUTO_ENABLED) return null;
  if (!input.canRunGlobal) return null;

  const nowMs = Date.now();
  if (channelOrphanSweepInFlight) return null;
  if (channelOrphanSweepLastRunMs > 0 && nowMs - channelOrphanSweepLastRunMs < CHANNEL_ORPHAN_SWEEP_INTERVAL_MS) {
    return null;
  }

  channelOrphanSweepLastRunMs = nowMs;
  channelOrphanSweepRuntime.lastStartedAt = nowIso();
  const startedAtMs = Date.now();

  const task = runChannelOrphanCleanup({
    requesterUserId: input.requesterUserId,
    canRunGlobal: true,
    trigger: input.trigger,
  });
  channelOrphanSweepInFlight = task;

  try {
    const report = await task;
    channelOrphanSweepRuntime.lastFinishedAt = nowIso();
    channelOrphanSweepRuntime.lastDurationMs = Math.max(0, Date.now() - startedAtMs);
    channelOrphanSweepRuntime.successCount += 1;
    channelOrphanSweepRuntime.lastError = "";
    channelOrphanSweepRuntime.lastResult = report;
    return report;
  } catch (error) {
    channelOrphanSweepRuntime.lastFinishedAt = nowIso();
    channelOrphanSweepRuntime.lastDurationMs = Math.max(0, Date.now() - startedAtMs);
    channelOrphanSweepRuntime.failureCount += 1;
    channelOrphanSweepRuntime.lastError = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    channelOrphanSweepInFlight = null;
  }
}

let _lastWaFallbackCount = -1;
let _lastTgFallbackCount = -1;

async function pollChannelEventsInScope(input: {
  requesterUserId: string;
  canRunGlobal: boolean;
}): Promise<{
  scope: "user" | "global";
  whatsappSessions: number;
  whatsappEvents: number;
  whatsappHealthFallbackAdded: number;
  telegramSessions: number;
  telegramEvents: number;
  telegramHealthFallbackAdded: number;
  failed: number;
  orphanCleanup: ChannelOrphanCleanupResult | null;
}> {
  const scope: "user" | "global" = input.canRunGlobal ? "global" : "user";
  const scopeParams: unknown[] = [];
  const scopeFilter = input.canRunGlobal ? "" : "AND user_id = $1";
  if (!input.canRunGlobal) scopeParams.push(input.requesterUserId);

  let whatsappSessions = 0;
  let whatsappEvents = 0;
  let whatsappHealthFallbackAdded = 0;
  let telegramSessions = 0;
  let telegramEvents = 0;
  let telegramHealthFallbackAdded = 0;
  let failed = 0;
  let orphanCleanup: ChannelOrphanCleanupResult | null = null;

  if (WHATSAPP_URL) {
    const dbSessions = await query<ChannelPollSessionRow>(
      `SELECT id, user_id
       FROM whatsapp_sessions
       WHERE COALESCE(status, '') <> 'offline'
       ${scopeFilter}`,
      scopeParams,
    );
    const healthSessions = await loadOnlineSessionsFromConnectorHealth({
      platform: "whatsapp",
      requesterUserId: input.requesterUserId,
      canRunGlobal: input.canRunGlobal,
    });
    const mergedSessions = dedupeChannelPollSessions([...dbSessions, ...healthSessions]);
    const sessions = await filterSessionsByExecutionGate(mergedSessions);
    const blockedByPlanCount = Math.max(0, mergedSessions.length - sessions.length);
    whatsappHealthFallbackAdded = Math.max(0, mergedSessions.length - dbSessions.length);
    whatsappSessions = sessions.length;

    if (blockedByPlanCount > 0) {
      console.info(`[poll-channel-events] whatsapp skipped ${blockedByPlanCount} session(s) with expired plan (scope=${scope})`);
    }

    if (whatsappHealthFallbackAdded !== _lastWaFallbackCount) {
      _lastWaFallbackCount = whatsappHealthFallbackAdded;
      if (whatsappHealthFallbackAdded > 0) {
        console.info(
          `[poll-channel-events] whatsapp health fallback added ${whatsappHealthFallbackAdded} session(s) (scope=${scope}, db=${dbSessions.length}, merged=${sessions.length})`,
        );
      } else {
        console.info(`[poll-channel-events] whatsapp health fallback cleared (scope=${scope})`);
      }
    }

    for (const session of sessions) {
      try {
        whatsappEvents += await pollWhatsAppEventsForSession(String(session.user_id), String(session.id));
      } catch (error) {
        pushChannelPollError({
          platform: "whatsapp",
          userId: String(session.user_id),
          sessionId: String(session.id),
          stage: "session_loop",
          message: error instanceof Error ? error.message : String(error),
          status: null,
        });
        failed += 1;
      }
    }
  }

  if (TELEGRAM_URL) {
    const dbSessions = await query<ChannelPollSessionRow>(
      `SELECT id, user_id
       FROM telegram_sessions
       WHERE COALESCE(status, '') <> 'offline'
           OR COALESCE(session_string, '') <> ''
       ${scopeFilter}`,
      scopeParams,
    );
    const healthSessions = await loadOnlineSessionsFromConnectorHealth({
      platform: "telegram",
      requesterUserId: input.requesterUserId,
      canRunGlobal: input.canRunGlobal,
    });
    const mergedSessions = dedupeChannelPollSessions([...dbSessions, ...healthSessions]);
    const sessions = await filterSessionsByExecutionGate(mergedSessions);
    const blockedByPlanCount = Math.max(0, mergedSessions.length - sessions.length);
    telegramHealthFallbackAdded = Math.max(0, mergedSessions.length - dbSessions.length);
    telegramSessions = sessions.length;

    if (blockedByPlanCount > 0) {
      console.info(`[poll-channel-events] telegram skipped ${blockedByPlanCount} session(s) with expired plan (scope=${scope})`);
    }

    if (telegramHealthFallbackAdded !== _lastTgFallbackCount) {
      _lastTgFallbackCount = telegramHealthFallbackAdded;
      if (telegramHealthFallbackAdded > 0) {
        console.info(
          `[poll-channel-events] telegram health fallback added ${telegramHealthFallbackAdded} session(s) (scope=${scope}, db=${dbSessions.length}, merged=${sessions.length})`,
        );
      } else {
        console.info(`[poll-channel-events] telegram health fallback cleared (scope=${scope})`);
      }
    }

    for (const session of sessions) {
      try {
        telegramEvents += await pollTelegramEventsForSession(String(session.user_id), String(session.id));
      } catch (error) {
        pushChannelPollError({
          platform: "telegram",
          userId: String(session.user_id),
          sessionId: String(session.id),
          stage: "session_loop",
          message: error instanceof Error ? error.message : String(error),
          status: null,
        });
        failed += 1;
      }
    }
  }

  orphanCleanup = await maybeRunAutoChannelOrphanCleanup({
    requesterUserId: input.requesterUserId,
    canRunGlobal: input.canRunGlobal,
    trigger: "poll-channel-events:auto",
  });

  return {
    scope,
    whatsappSessions,
    whatsappEvents,
    whatsappHealthFallbackAdded,
    telegramSessions,
    telegramEvents,
    telegramHealthFallbackAdded,
    failed,
    orphanCleanup,
  };
}

function spawnOpsControlLocal(targetPort: number): { ok: true; pid: number } | { ok: false; error: string } {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // services/api/src -> project root
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const entry = path.join(projectRoot, "services", "ops-control", "src", "server.mjs");

  try {
    // Pass only the minimum required environment variables (least-principle).
    // Do NOT propagate the full process.env (JWT_SECRET, SERVICE_TOKEN, etc).
    const allowedEnvVars = [
      "NODE_ENV", "PORT", "HOST", "OPS_CONTROL_TOKEN", "DATABASE_URL",
      "DB_SSL", "DB_SSL_REJECT_UNAUTHORIZED", "DB_POOL_MAX",
      "CORS_ORIGIN", "API_PUBLIC_URL", "APP_PUBLIC_URL",
      "WEBHOOK_SECRET", "PATH",
    ];
    const env: Record<string, string> = {};
    for (const k of allowedEnvVars) {
      const v = process.env[k];
      if (v !== undefined) env[k] = String(v);
    }

    // Ensure ops-control binds the expected port, and inherits security token if configured.
    env.PORT = String(targetPort);
    if (!env.HOST) env.HOST = "0.0.0.0";
    if (OPS_TOKEN && !env.OPS_CONTROL_TOKEN) {
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

async function loadControlPlane() {
  const row = await queryOne("SELECT value FROM system_settings WHERE key = 'admin_config'");
  return (row?.value ?? {}) as Record<string, unknown>;
}

// Built-in plan catalog - mirrors src/lib/plans.ts. Acts as fallback when
// admin_config has not yet been configured via the admin panel.
const BUILTIN_PLANS: Array<{ id: string; period: string; isActive: boolean }> = [
  { id: "plan-starter", period: "7 dias",  isActive: true },
  { id: "plan-start",   period: "30 dias", isActive: true },
  { id: "plan-pro",     period: "30 dias", isActive: true },
  { id: "plan-business",period: "30 dias", isActive: true },
];
const BUILTIN_PLAN_IDS = new Set(BUILTIN_PLANS.map((p) => p.id));
const ADMIN_PANEL_PLAN_ID = "admin";
const MERCADO_LIVRE_FEATURE_KEY = "mercadoLivre";
const AMAZON_FEATURE_KEY = "amazon";
const SHOPEE_AUTOMATIONS_FEATURE_KEY = "shopeeAutomations";
const MERCADO_LIVRE_FALLBACK_ENABLED_PLANS = new Set([
  "plan-starter",
  "plan-business",
]);
const AMAZON_FALLBACK_ENABLED_PLANS = new Set([
  "plan-starter",
  "plan-business",
]);
const MERCADO_LIVRE_BLOCKED_MESSAGE = "Mercado Livre não está disponível no seu plano ou nível de acesso.";
const MERCADO_LIVRE_AUTOMATION_BLOCKED_MESSAGE = "Automações Mercado Livre não estão disponíveis no seu plano ou nível de acesso.";
const AMAZON_BLOCKED_MESSAGE = "Amazon não está disponível no seu plano ou nível de acesso.";
const SHOPEE_AUTOMATION_BLOCKED_MESSAGE = "Automações Shopee não estão disponíveis no seu plano ou nível de acesso.";
const IDENTITY_ALREADY_USED_MESSAGE = "E-mail ou WhatsApp já cadastrado. Faça login ou recupere sua conta.";
const WHATSAPP_ALREADY_LINKED_MESSAGE = "Este WhatsApp já está conectado em outra conta. Use outro número ou recupere a conta original.";
const TELEGRAM_ALREADY_LINKED_MESSAGE = "Este Telegram já está conectado em outra conta. Use outro número ou recupere a conta original.";

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function sanitizePhone(raw: string): string {
  const stripped = raw.replace(/[^\d+]/g, "");
  return /^\+?\d{10,15}$/.test(stripped) ? stripped : "";
}

function isUniqueViolation(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code === "23505";
}

async function hasCrossAccountActiveWhatsAppPhone(phone: string, userId: string, sessionId = ""): Promise<boolean> {
  const normalizedPhone = sanitizePhone(phone);
  if (!normalizedPhone) return false;
  const duplicate = await queryOne<{ id: string }>(
    `SELECT id
       FROM whatsapp_sessions
      WHERE phone = $1
        AND user_id::text <> $2
        AND status IN ('online', 'connecting', 'qr_code', 'pairing_code')
        AND ($3 = '' OR id::text <> $3)
      LIMIT 1`,
    [normalizedPhone, userId, sessionId],
  );
  return Boolean(duplicate);
}

async function hasCrossAccountActiveTelegramPhone(phone: string, userId: string, sessionId = ""): Promise<boolean> {
  const normalizedPhone = sanitizePhone(phone);
  if (!normalizedPhone) return false;
  const duplicate = await queryOne<{ id: string }>(
    `SELECT id
       FROM telegram_sessions
      WHERE phone = $1
        AND user_id::text <> $2
        AND status IN ('online', 'connecting', 'awaiting_code', 'awaiting_password')
        AND ($3 = '' OR id::text <> $3)
      LIMIT 1`,
    [normalizedPhone, userId, sessionId],
  );
  return Boolean(duplicate);
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

const VALID_BILLING_PERIODS = new Set(["monthly", "quarterly", "semiannual", "annual"]);

function normalizeBillingPeriodType(raw: unknown): "monthly" | "quarterly" | "semiannual" | "annual" {
  const value = String(raw ?? "monthly").trim().toLowerCase();
  if (value === "quarterly" || value === "semiannual" || value === "annual") return value;
  return "monthly";
}

function getPlanPeriodConfig(plan: Record<string, unknown> | null, periodType: string) {
  if (!plan) return null;
  const periods = Array.isArray(plan.periods) ? plan.periods : [];
  return periods.find((item) => String((item as { type?: unknown }).type ?? "") === periodType) as Record<string, unknown> | undefined;
}

async function buildKiwifyCheckoutUrlForUser(input: {
  userId: string;
  planId: string;
  periodType: "monthly" | "quarterly" | "semiannual" | "annual";
  planFromControlPlane: Record<string, unknown> | null;
}): Promise<{ checkoutUrl: string; source: "mapping" | "control_plane" }> {
  const { userId, planId, periodType, planFromControlPlane } = input;

  const mapping = await queryOne<{
    kiwify_checkout_url: string | null;
    is_active: boolean | null;
  }>(
    `SELECT kiwify_checkout_url, is_active
       FROM kiwify_plan_mappings
      WHERE plan_id = $1
        AND period_type = $2
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
    [planId, periodType],
  );

  let rawUrl = "";
  let source: "mapping" | "control_plane" = "control_plane";

  if (mapping) {
    if (mapping.is_active === false) {
      throw new Error("Este período não está disponível para compra.");
    }
    const mappedUrl = String(mapping.kiwify_checkout_url ?? "").trim();
    if (mappedUrl) {
      rawUrl = mappedUrl;
      source = "mapping";
    }
  }

  if (!rawUrl) {
    const periodCfg = getPlanPeriodConfig(planFromControlPlane, periodType);
    if (periodCfg && periodCfg.isActive === false) {
      throw new Error("Este período não está disponível para compra.");
    }
    rawUrl = String(periodCfg?.kiwifyCheckoutUrl ?? planFromControlPlane?.kiwifyCheckoutUrl ?? "").trim();
    source = "control_plane";
  }

  if (!rawUrl) {
    throw new Error("Checkout Kiwify não configurado para este plano/período.");
  }

  const profile = await queryOne<{ email: string | null }>("SELECT email FROM profiles WHERE user_id = $1", [userId]);
  const userRow = await queryOne<{ email: string | null }>("SELECT email FROM users WHERE id = $1", [userId]);
  const email = String(profile?.email || userRow?.email || "").trim().toLowerCase();
  if (!email) {
    throw new Error("Email do usuário não encontrado.");
  }

  let checkoutUrl = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("Checkout Kiwify inválido: use URL https.");
    }
    parsed.searchParams.set("email", email);
    checkoutUrl = parsed.toString();
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Checkout Kiwify inválido.";
    throw new Error(msg || "Checkout Kiwify inválido.");
  }

  return { checkoutUrl, source };
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
  const planId = String(row?.plan_id ?? "").trim();
  if (!planId) {
    throw new Error("Plano nao configurado para este usuario.");
  }
  return planId;
}

function hasPositiveLimit(value: unknown): boolean | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n === -1 || n > 0;
}

async function resolveMarketplaceFeatureAccess(
  userId: string,
  input: {
    featureKey: string;
    fallbackEnabledPlans: Set<string>;
    blockedMessage: string;
    fallbackLimitKey?: string;
  },
): Promise<{ allowed: boolean; message: string }> {
  let planId = "";
  try {
    planId = await getUserPlanId(userId);
  } catch {
    return { allowed: false, message: "Nao foi possivel validar o plano da sua conta." };
  }

  const cp = await loadControlPlane();

  const plans = Array.isArray(cp?.plans) ? cp.plans : [];
  const accessLevels = Array.isArray(cp?.accessLevels) ? cp.accessLevels : [];

  const plan = plans.find((entry) => String(entry?.id || "").trim() === planId) || null;
  let fallbackAllowed = input.fallbackEnabledPlans.has(planId);

  if (plan && typeof plan === "object" && !Array.isArray(plan)) {
    const limits = (plan as Record<string, unknown>).limits;
    if (limits && typeof limits === "object" && !Array.isArray(limits) && input.fallbackLimitKey) {
      const byLimit = hasPositiveLimit((limits as Record<string, unknown>)[input.fallbackLimitKey]);
      if (byLimit !== null) fallbackAllowed = byLimit;
    }
  }

  let blockedMessage = input.blockedMessage;

  if (plan && typeof plan === "object" && !Array.isArray(plan)) {
    const accessLevelId = String((plan as Record<string, unknown>).accessLevelId || "").trim();
    if (accessLevelId) {
      const accessLevel = accessLevels.find((entry) => String(entry?.id || "").trim() === accessLevelId) || null;
      if (accessLevel && typeof accessLevel === "object" && !Array.isArray(accessLevel)) {
        const featureRules = (accessLevel as Record<string, unknown>).featureRules;
        if (featureRules && typeof featureRules === "object" && !Array.isArray(featureRules)) {
          const featureRuleRaw = (featureRules as Record<string, unknown>)[input.featureKey];
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

async function resolveMercadoLivreFeatureAccess(userId: string): Promise<{ allowed: boolean; message: string }> {
  return resolveMarketplaceFeatureAccess(userId, {
    featureKey: MERCADO_LIVRE_FEATURE_KEY,
    fallbackEnabledPlans: MERCADO_LIVRE_FALLBACK_ENABLED_PLANS,
    blockedMessage: MERCADO_LIVRE_BLOCKED_MESSAGE,
    fallbackLimitKey: "meliSessions",
  });
}

async function resolveMercadoLivreAutomationAccess(userId: string): Promise<{ allowed: boolean; message: string }> {
  return resolveMarketplaceFeatureAccess(userId, {
    featureKey: MERCADO_LIVRE_FEATURE_KEY,
    fallbackEnabledPlans: MERCADO_LIVRE_FALLBACK_ENABLED_PLANS,
    blockedMessage: MERCADO_LIVRE_AUTOMATION_BLOCKED_MESSAGE,
    fallbackLimitKey: "meliAutomations",
  });
}

async function resolveAmazonFeatureAccess(userId: string): Promise<{ allowed: boolean; message: string }> {
  return resolveMarketplaceFeatureAccess(userId, {
    featureKey: AMAZON_FEATURE_KEY,
    fallbackEnabledPlans: AMAZON_FALLBACK_ENABLED_PLANS,
    blockedMessage: AMAZON_BLOCKED_MESSAGE,
    fallbackLimitKey: "amazonSessions",
  });
}

async function resolveShopeeAutomationAccess(userId: string): Promise<{ allowed: boolean; message: string }> {
  return resolveMarketplaceFeatureAccess(userId, {
    featureKey: SHOPEE_AUTOMATIONS_FEATURE_KEY,
    fallbackEnabledPlans: BUILTIN_PLAN_IDS,
    blockedMessage: SHOPEE_AUTOMATION_BLOCKED_MESSAGE,
    fallbackLimitKey: "automations",
  });
}

async function listUsersWithMeta() {
  // Single JOIN instead of 3 sequential round-trips - reduces latency under load
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
           COALESCE(p.plan_sync_mode, 'auto') AS plan_sync_mode,
           COALESCE(p.plan_sync_note, '') AS plan_sync_note,
           p.plan_sync_updated_at,
           p.name AS profile_name,
           COALESCE(p.phone, '') AS phone,
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
    phone: String(u.phone ?? ""),
    plan_id: u.plan_id,
    plan_expires_at: u.plan_expires_at ?? null,
    plan_sync_mode: String(u.plan_sync_mode ?? "auto"),
    plan_sync_note: String(u.plan_sync_note ?? ""),
    plan_sync_updated_at: u.plan_sync_updated_at ?? null,
    created_at: u.created_at,
    role: u.role,
    account_status: String(u.metadata?.account_status ?? "active"),
  }));
}

type AdminLifecycleTriggerType = "plan_expiring" | "plan_expired" | "signup_welcome" | "remarketing";
type AdminLifecycleUser = Awaited<ReturnType<typeof listUsersWithMeta>>[number];

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(value: unknown): number | null {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  const d = new Date(parsed);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function utcDayDiff(target: unknown, nowMs = Date.now()): number | null {
  const targetStart = startOfUtcDay(target);
  if (targetStart === null) return null;
  const now = new Date(nowMs);
  now.setUTCHours(0, 0, 0, 0);
  const nowStart = now.getTime();
  return Math.round((targetStart - nowStart) / DAY_IN_MS);
}

function normalizeOffsetList(rawList: unknown, fallbackRaw: unknown, min: number, max: number): number[] {
  const parsed: number[] = [];
  const pushIfValid = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const normalized = Math.trunc(n);
    if (normalized < min || normalized > max) return;
    if (!parsed.includes(normalized)) parsed.push(normalized);
  };

  if (Array.isArray(rawList)) {
    for (const item of rawList) pushIfValid(item);
  } else {
    pushIfValid(rawList);
  }

  if (parsed.length === 0) {
    pushIfValid(fallbackRaw);
  }

  if (parsed.length === 0) {
    parsed.push(min);
  }

  return parsed.sort((a, b) => a - b);
}

function matchAdminLifecycleEvent(
  triggerType: AdminLifecycleTriggerType,
  triggerConfig: Record<string, unknown>,
  user: AdminLifecycleUser,
  nowMs = Date.now(),
): { matched: false } | { matched: true; eventKey: string } {
  if (triggerType === "plan_expiring") {
    const offsets = normalizeOffsetList(triggerConfig.days_before_list, triggerConfig.days_before ?? 3, 1, 365);
    const daysUntilExpiry = utcDayDiff(user.plan_expires_at, nowMs);
    if (daysUntilExpiry === null || daysUntilExpiry < 0 || !offsets.includes(daysUntilExpiry)) {
      return { matched: false };
    }
    return { matched: true, eventKey: `plan_expiring:${daysUntilExpiry}` };
  }

  if (triggerType === "plan_expired") {
    const offsets = normalizeOffsetList(triggerConfig.days_after_list, triggerConfig.days_after ?? 1, 0, 365);
    const daysUntilExpiry = utcDayDiff(user.plan_expires_at, nowMs);
    if (daysUntilExpiry === null || daysUntilExpiry > 0) {
      return { matched: false };
    }
    const daysAfterExpiry = Math.abs(daysUntilExpiry);
    if (!offsets.includes(daysAfterExpiry)) {
      return { matched: false };
    }
    return { matched: true, eventKey: `plan_expired:${daysAfterExpiry}` };
  }

  if (triggerType === "signup_welcome") {
    const offsets = normalizeOffsetList(triggerConfig.days_after_list, triggerConfig.days_after ?? 0, 0, 365);
    const daysSinceSignup = utcDayDiff(user.created_at, nowMs);
    if (daysSinceSignup === null || daysSinceSignup > 0) {
      return { matched: false };
    }
    const elapsed = Math.abs(daysSinceSignup);
    if (!offsets.includes(elapsed)) {
      return { matched: false };
    }
    return { matched: true, eventKey: `signup_welcome:${elapsed}` };
  }

  const offsets = normalizeOffsetList(triggerConfig.days_since_signup_list, triggerConfig.days_since_signup ?? 30, 1, 730);
  const daysSinceSignup = utcDayDiff(user.created_at, nowMs);
  if (daysSinceSignup === null || daysSinceSignup > 0) {
    return { matched: false };
  }
  const elapsed = Math.abs(daysSinceSignup);
  if (!offsets.includes(elapsed)) {
    return { matched: false };
  }
  return { matched: true, eventKey: `remarketing:${elapsed}` };
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
    const rateResult = await consumeRpcFunctionRateLimit(rateScopeKey, funcName);
    if (!rateResult.allowed) {
      if (rateResult.retryAfterSec > 0) {
        res.setHeader("Retry-After", String(rateResult.retryAfterSec));
      }
      // Signal to the client that this is a per-function limit, not a global server overload.
      // The client uses this header to avoid triggering the global circuit breaker.
      res.setHeader("X-Rate-Limit-Scope", "function");
      fail(res, rateResult.policy?.message || "Limite de chamadas excedido. Aguarde alguns segundos.", 429);
      return;
    }
  }

  // Plan expiry check
  if (!PLAN_EXPIRY_ALLOWED.has(funcName) && !effectiveAdmin) {
    if (await isPlanExpired(userId)) { fail(res, "Plano expirado. Renove ou troque de plano."); return; }
  }

  const requiresMercadoLivreAccess = funcName.startsWith("meli-");
  const requiresMercadoLivreAutomationAccess = funcName === "meli-automation-run";
  const requiresAmazonAccess = funcName.startsWith("amazon-");
  const requiresShopeeAutomationAccess = funcName === "shopee-automation-run";
  if ((requiresMercadoLivreAccess || requiresAmazonAccess || requiresShopeeAutomationAccess) && !effectiveAdmin) {
    try {
      const featureAccess = requiresShopeeAutomationAccess
        ? await resolveShopeeAutomationAccess(userId)
        : requiresAmazonAccess
          ? await resolveAmazonFeatureAccess(userId)
          : requiresMercadoLivreAutomationAccess
            ? await resolveMercadoLivreAutomationAccess(userId)
            : await resolveMercadoLivreFeatureAccess(userId);
      if (!featureAccess.allowed) {
        fail(
          res,
          featureAccess.message || (
            requiresShopeeAutomationAccess
              ? SHOPEE_AUTOMATION_BLOCKED_MESSAGE
              : requiresAmazonAccess
                ? AMAZON_BLOCKED_MESSAGE
                : requiresMercadoLivreAutomationAccess
                  ? MERCADO_LIVRE_AUTOMATION_BLOCKED_MESSAGE
                  : MERCADO_LIVRE_BLOCKED_MESSAGE
          ),
          403,
        );
        return;
      }
    } catch {
      fail(
        res,
        requiresShopeeAutomationAccess
          ? "Nao foi possivel validar o acesso as automacoes Shopee."
          : requiresAmazonAccess
            ? "Nao foi possivel validar o acesso ao modulo Amazon."
            : requiresMercadoLivreAutomationAccess
              ? "Nao foi possivel validar o acesso as automacoes Mercado Livre."
              : "Nao foi possivel validar o acesso ao modulo Mercado Livre.",
        503,
      );
      return;
    }
  }

  try {
    // â”€â”€ poll-channel-events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "poll-channel-events") {
      const source = String(params.source ?? "frontend");
      const canRunGlobalChannelPolling = isService || (effectiveAdmin && !userIsAdmin);
      const startedAtMs = Date.now();
      channelPollRuntime.lastStartedAt = new Date(startedAtMs).toISOString();
      try {
        const polled = await pollChannelEventsInScope({
          requesterUserId: userId,
          canRunGlobal: canRunGlobalChannelPolling,
        });
        channelPollRuntime.lastFinishedAt = nowIso();
        channelPollRuntime.lastDurationMs = Math.max(0, Date.now() - startedAtMs);
        channelPollRuntime.successCount += 1;
        channelPollRuntime.lastError = "";
        channelPollRuntime.lastResult = {
          source,
          scope: polled.scope,
          whatsappSessions: polled.whatsappSessions,
          whatsappEvents: polled.whatsappEvents,
          whatsappHealthFallbackAdded: polled.whatsappHealthFallbackAdded,
          telegramSessions: polled.telegramSessions,
          telegramEvents: polled.telegramEvents,
          telegramHealthFallbackAdded: polled.telegramHealthFallbackAdded,
          failed: polled.failed,
          orphanCleanup: polled.orphanCleanup,
        };
        ok(res, { ok: true, source, ...polled }); return;
      } catch (error) {
        channelPollRuntime.lastFinishedAt = nowIso();
        channelPollRuntime.lastDurationMs = Math.max(0, Date.now() - startedAtMs);
        channelPollRuntime.failureCount += 1;
        channelPollRuntime.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }

    // —— admin-sanitize-channel-orphans ———————————————————————————————
    if (funcName === "admin-sanitize-channel-orphans") {
      if (!effectiveAdmin) { fail(res, "Acesso negado", 403); return; }
      const requestedScope = String(params.scope ?? "global").trim().toLowerCase();
      const canRunGlobal = requestedScope !== "user";

      const startedAtMs = Date.now();
      channelOrphanSweepRuntime.lastStartedAt = nowIso();
      try {
        const report = await runChannelOrphanCleanup({
          requesterUserId: userId,
          canRunGlobal,
          trigger: String(params.trigger ?? "admin-manual"),
        });
        channelOrphanSweepRuntime.lastFinishedAt = nowIso();
        channelOrphanSweepRuntime.lastDurationMs = Math.max(0, Date.now() - startedAtMs);
        channelOrphanSweepRuntime.successCount += 1;
        channelOrphanSweepRuntime.lastError = "";
        channelOrphanSweepRuntime.lastResult = report;
        channelOrphanSweepLastRunMs = Date.now();
        ok(res, { ok: true, ...report });
        return;
      } catch (error) {
        channelOrphanSweepRuntime.lastFinishedAt = nowIso();
        channelOrphanSweepRuntime.lastDurationMs = Math.max(0, Date.now() - startedAtMs);
        channelOrphanSweepRuntime.failureCount += 1;
        channelOrphanSweepRuntime.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }

    // â”€â”€ whatsapp-connect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    
    // -- purge-history-entries ------------------------------------------------
    // Removes history_entries rows older than max_age_days (default: 90).
    // Only callable by the scheduler (SERVICE_TOKEN) or a platform admin.
    if (funcName === "purge-history-entries") {
      if (!isService && !effectiveAdmin) { fail(res, "Acesso negado", 403); return; }
      const maxAgeDays = Math.max(30, Math.min(3650, toInt(params.maxAgeDays, 90)));
      const batchSize  = Math.max(100, Math.min(50_000, toInt(params.batchSize, 5_000)));
      const startedAtMs = Date.now();
      try {
        const rows = await query(
          "SELECT deleted_total, batches FROM purge_old_history_entries($1, $2)",
          [maxAgeDays, batchSize],
        );
        const row = rows[0] ?? { deleted_total: "0", batches: "0" };
        const deletedTotal = Number(row.deleted_total || 0);
        const batchCount   = Number(row.batches || 0);
        console.info(JSON.stringify({
          ts: nowIso(), svc: "api", event: "history_purge",
          maxAgeDays, batchSize, deletedTotal, batchCount,
          durationMs: Date.now() - startedAtMs,
          triggeredBy: isService ? "scheduler" : userId,
        }));
        ok(res, { ok: true, deletedTotal, batchCount, maxAgeDays, durationMs: Date.now() - startedAtMs });
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const pgCode = typeof error === "object" && error && "code" in error
          ? String((error as { code?: unknown }).code || "")
          : "";
        const missingPurgeFn = pgCode === "42883" || /purge_old_history_entries/i.test(msg) && /does not exist/i.test(msg);
        if (missingPurgeFn) {
          console.warn("[rpc] purge-history-entries skipped: SQL function purge_old_history_entries is not available in this database.");
          ok(res, {
            ok: true,
            skipped: true,
            reason: "purge_function_missing",
            maxAgeDays,
            batchSize,
            deletedTotal: 0,
            batchCount: 0,
            durationMs: Date.now() - startedAtMs,
          });
          return;
        }
        console.error(`[rpc] purge-history-entries failed: ${msg}`);
        fail(res, `Falha ao purgar historico: ${msg}`, 500); return;
      }
    }
    // ── analytics-sync-all-groups: sync groups from all online WA sessions ──
    if (funcName === "analytics-sync-all-groups") {
      await reconcileWhatsAppSessionsFromHealth(userId).catch(() => ({ reconciled: 0, online: false }));

      const dbSessions = await query<{ id: string; name: string; status: string | null }>(
        `SELECT id, name, status FROM whatsapp_sessions WHERE user_id = $1`,
        [userId],
      );
      const dbById = new Map<string, { id: string; name: string; status: string | null }>();
      for (const session of dbSessions) {
        const sessionId = String(session?.id || "").trim();
        if (!sessionId) continue;
        dbById.set(sessionId, session);
      }

      let runtimeHealthSucceeded = false;
      const runtimeOnlineRows = await loadOnlineSessionsFromConnectorHealth({
        platform: "whatsapp",
        requesterUserId: userId,
        canRunGlobal: false,
      }).then((rows) => { runtimeHealthSucceeded = true; return rows; }).catch(() => []);

      const onlineSessionsMap = new Map<string, { id: string; name: string; source: "runtime" | "db" | "probe" }>();
      for (const runtimeRow of runtimeOnlineRows) {
        const sessionId = String(runtimeRow?.id || "").trim();
        if (!sessionId) continue;
        const dbSession = dbById.get(sessionId);
        if (!dbSession) continue;
        onlineSessionsMap.set(sessionId, {
          id: sessionId,
          name: String(dbSession.name || sessionId),
          source: "runtime",
        });
      }

      // DB-status fallback: only use when the runtime health check itself failed
      // (Baileys unreachable). If Baileys responded but reported no online sessions
      // for this user, honour that — don't try sessions that are genuinely offline.
      if (onlineSessionsMap.size === 0 && !runtimeHealthSucceeded) {
        for (const dbSession of dbSessions) {
          const sessionId = String(dbSession?.id || "").trim();
          if (!sessionId) continue;
          if (normalizeWhatsAppStatus(dbSession.status) !== "online") continue;
          onlineSessionsMap.set(sessionId, {
            id: sessionId,
            name: String(dbSession?.name || sessionId),
            source: "db",
          });
        }
      }

      let sessionsToSync = Array.from(onlineSessionsMap.values());
      let discoveryMode: "runtime_or_db" | "probe_all" = "runtime_or_db";
      if (sessionsToSync.length === 0) {
        const probeMap = new Map<string, { id: string; name: string; source: "probe" }>();
        for (const dbSession of dbSessions) {
          const sessionId = String(dbSession?.id || "").trim();
          if (!sessionId) continue;
          probeMap.set(sessionId, {
            id: sessionId,
            name: String(dbSession?.name || sessionId),
            source: "probe",
          });
        }
        sessionsToSync = Array.from(probeMap.values());
        discoveryMode = "probe_all";
      }

      if (sessionsToSync.length === 0) {
        ok(res, {
          success: false,
          sessionsSynced: 0,
          totalGroups: 0,
          errors: ["Nenhuma sessao WhatsApp cadastrada para sincronizacao."],
          sessionsEvaluated: 0,
          runtimeOnline: 0,
          sessionDiscoveryMode: discoveryMode,
        });
        return;
      }

      const settled = await Promise.allSettled(
        sessionsToSync.map((session) =>
          syncWhatsAppSessionGroups({
            userId,
            sessionId: session.id,
            includeEventPoll: true,
            timeoutMs: 45_000,
          }).then((r) => ({ session, result: r })),
        ),
      );

      let totalGroups = 0;
      let sessionsSynced = 0;
      const errors: string[] = [];

      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        const session = sessionsToSync[index];
        if (outcome.status === "fulfilled") {
          totalGroups += outcome.value.result.count;
          sessionsSynced += 1;
        } else {
          errors.push(`${session?.name || session?.id || "??"}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
        }
      }

      ok(res, {
        success: sessionsSynced > 0,
        sessionsSynced,
        totalGroups,
        errors,
        sessionsEvaluated: sessionsToSync.length,
        runtimeOnline: runtimeOnlineRows.length,
        sessionDiscoveryMode: discoveryMode,
      });
      return;
    }

    // ── analytics-admin-groups: fetch WA groups where user is admin ──
    // Reads directly from DB — no synchronous WhatsApp probe.
    // Strict mode: only admin groups are returned.
    if (funcName === "analytics-admin-groups") {
      const hasAdminColumns = await hasGroupsAdminColumns();
      const baseGroups = await query<{
        id: string;
        name: string;
        external_id: string;
        member_count: number;
        session_id: string | null;
        is_admin: boolean;
        owner_jid: string;
        invite_code: string;
        invite_link: string;
      }>(
        `SELECT
           g.id,
           g.name,
           COALESCE(g.external_id, '') AS external_id,
           COALESCE(g.member_count, 0)::int AS member_count,
           g.session_id,
           COALESCE((to_jsonb(g)->>'is_admin')::boolean, FALSE) AS is_admin,
           COALESCE(to_jsonb(g)->>'owner_jid', '') AS owner_jid,
           COALESCE(to_jsonb(g)->>'invite_code', '') AS invite_code,
           COALESCE(NULLIF(to_jsonb(g)->>'invite_link', ''), '') AS invite_link
           FROM groups g
          WHERE g.user_id = $1
            AND g.platform = 'whatsapp'
            AND g.deleted_at IS NULL
          ORDER BY g.name`,
        [userId],
      );

      const displayGroups = hasAdminColumns
        ? baseGroups.filter((g) => Boolean(g.is_admin))
        : [];
      const adminFilterMode = hasAdminColumns ? "strict" : "schema_missing_admin_columns";

      ok(res, {
        groups: displayGroups.map(g => ({
          id: g.id,
          name: g.name,
          externalId: g.external_id,
          memberCount: g.member_count,
          sessionId: g.session_id || "",
          isAdmin: Boolean(g.is_admin),
          ownerJid: g.owner_jid,
          inviteCode: g.invite_code,
          inviteLink: g.invite_link || null,
        })),
        adminGroupsCount: displayGroups.length,
        adminFilterMode,
      });
      return;
    }

    if (funcName === "analytics-members-evolution") {
      const rawScope    = String(params.scope || "all").trim();
      const rawDays     = Math.max(1, Math.min(365, toInt(params.days, 30)));
      const rawGroupIds = Array.isArray(params.scopeGroupIds)
        ? params.scopeGroupIds.map((id: unknown) => String(id).trim()).filter(isUuid)
        : [];

      const result = await loadWhatsAppMembersEvolution({
        userId,
        scope: rawScope,
        days: rawDays,
        scopeGroupIds: rawGroupIds,
      });

      ok(res, result);
      return;
    }

    // ── analytics-store-movement ──────────────────────────────────────────────
    // Called exclusively by the WhatsApp Baileys service (service-secret auth).
    // Inserts a member event and auto-correlates permanence time when a matching
    // entry is found for a leaving member.
    if (funcName === "analytics-store-movement") {
      if (!isService && !effectiveAdmin) {
        fail(res, "Não autorizado", 403);
        return;
      }

      const groupExternalId = String(params.groupExternalId || "").trim();
      const eventType       = String(params.eventType || "").trim();
      const memberPhone     = String(params.memberPhone || "").trim();
      const authorPhone     = String(params.authorPhone || "").trim();
      const eventTimestamp  = String(params.eventTimestamp || new Date().toISOString()).trim();
      const sessionId       = params.sessionId ? String(params.sessionId).trim() : null;

      const validTypes = ["member_joined", "member_left", "member_removed"];
      if (!groupExternalId || !validTypes.includes(eventType) || !memberPhone) {
        fail(res, "Parâmetros inválidos para analytics-store-movement", 400);
        return;
      }

      // Resolve group UUID from external_id (WhatsApp JID)
      // We don't know the userId here — it's a service call — so we find the group
      // by external_id without scoping to a single user (service is trusted).
      const groupRow = await queryOne<{ id: string; user_id: string; session_id: string | null }>(
        `SELECT id, user_id, session_id FROM groups
          WHERE external_id = $1 AND platform = 'whatsapp' AND deleted_at IS NULL
          LIMIT 1`,
        [groupExternalId],
      );
      if (!groupRow) {
        // Group not yet synced — silently ignore
        ok(res, { stored: false, reason: "group_not_found" });
        return;
      }

      const groupUUID = groupRow.id;
      const ownerUserId = groupRow.user_id;

      // Insert the movement row
      const inserted = await queryOne<{ id: string }>(
        `INSERT INTO group_member_movements
           (user_id, group_id, event_type, member_phone, author_phone, event_timestamp, session_id)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)
         RETURNING id`,
        [ownerUserId, groupUUID, eventType, memberPhone, authorPhone, eventTimestamp, sessionId],
      );
      if (!inserted) {
        fail(res, "Falha ao inserir movimento");
        return;
      }
      const newId = inserted.id;

      // For departures, try to find and correlate the last entry from same member
      if (eventType === "member_left" || eventType === "member_removed") {
        const entryRow = await queryOne<{ id: string; event_timestamp: string }>(
          `SELECT id, event_timestamp
             FROM group_member_movements
            WHERE group_id = $1
              AND member_phone = $2
              AND event_type = 'member_joined'
              AND entry_event_id IS NULL
            ORDER BY event_timestamp DESC
            LIMIT 1`,
          [groupUUID, memberPhone],
        );
        if (entryRow) {
          const entryTime  = new Date(entryRow.event_timestamp).getTime();
          const exitTime   = new Date(eventTimestamp).getTime();
          const diffMinutes = Math.max(0, Math.round((exitTime - entryTime) / 60000));

          // Update exit row with permanence and link to entry
          await execute(
            `UPDATE group_member_movements
                SET time_permanence_minutes = $1, entry_event_id = $2
              WHERE id = $3`,
            [diffMinutes, entryRow.id, newId],
          );
          // Also back-link the entry row so it knows about exit
          await execute(
            `UPDATE group_member_movements SET entry_event_id = $1 WHERE id = $2 AND entry_event_id IS NULL`,
            [newId, entryRow.id],
          );
        }

        // If an active recapture rule exists, enqueue the message
        const rule = await queryOne<{ id: string; delay_hours: number; message_template: string }>(
          `SELECT id, delay_hours, message_template
             FROM group_recapture_rules
            WHERE group_id = $1 AND active = true
            LIMIT 1`,
          [groupUUID],
        );
        if (rule && rule.message_template.trim()) {
          const scheduledAt = new Date(
            new Date(eventTimestamp).getTime() + rule.delay_hours * 3_600_000,
          ).toISOString();
          await execute(
            `INSERT INTO group_recapture_queue
               (user_id, group_id, movement_id, rule_id, member_phone, scheduled_at)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
            [ownerUserId, groupUUID, newId, rule.id, memberPhone, scheduledAt],
          );
        }
      }

      ok(res, { stored: true, movementId: newId });
      return;
    }

    // ── analytics-cross-group-overlap ──────────────────────────────────────────
    // Counts phones currently present in more than one of the scoped groups.
    // "Currently present" = last event for that (phone, group) pair is member_joined.
    if (funcName === "analytics-cross-group-overlap") {
      const rawGroupIds = Array.isArray(params.scopeGroupIds)
        ? (params.scopeGroupIds as unknown[]).map((id) => String(id).trim()).filter(isUuid)
        : [];
      const overlapDays = Math.max(1, Math.min(365, toInt(params.days, 30)));

      // Resolve scope: requested IDs or all user groups
      let scopeIds: string[] = rawGroupIds;
      if (scopeIds.length === 0) {
        const allRows = await query<{ id: string }>(
          `SELECT id FROM groups WHERE user_id = $1 AND platform = 'whatsapp' AND deleted_at IS NULL`,
          [userId],
        );
        scopeIds = allRows.map((r) => r.id);
      }

      if (scopeIds.length < 2) {
        ok(res, {
          overlapCount: 0,
          maxGroupsPerMember: 0,
          avgGroupsPerMember: 0,
          analyzedGroups: scopeIds.length,
          hasData: false,
        });
        return;
      }

      const row = await queryOne<{
        overlap_count: number;
        max_count: number;
        avg_count: number;
        total_phones: number;
      }>(
        `WITH current_membership AS (
           SELECT DISTINCT ON (member_phone, group_id)
             member_phone,
             group_id,
             event_type
           FROM group_member_movements
           WHERE user_id = $1
             AND group_id = ANY($2::uuid[])
             AND event_timestamp >= NOW() - ($3 * INTERVAL '1 day')
           ORDER BY member_phone, group_id, event_timestamp DESC
         ),
         active AS (
           SELECT member_phone, group_id
           FROM current_membership
           WHERE event_type = 'member_joined'
         ),
         phone_totals AS (
           SELECT member_phone, COUNT(DISTINCT group_id)::int AS cnt
           FROM active
           GROUP BY member_phone
         ),
         overlap AS (
           SELECT member_phone, cnt
           FROM phone_totals
           WHERE cnt > 1
         )
         SELECT
           COUNT(*)::int                            AS overlap_count,
           COALESCE(MAX(cnt), 0)::int               AS max_count,
           COALESCE(ROUND(AVG(cnt)::numeric, 1), 0) AS avg_count,
           (SELECT COUNT(DISTINCT member_phone)::int FROM phone_totals) AS total_phones
         FROM overlap`,
        [userId, scopeIds, overlapDays],
      );

      ok(res, {
        overlapCount:        row?.overlap_count      ?? 0,
        maxGroupsPerMember:  row?.max_count          ?? 0,
        avgGroupsPerMember:  Number(row?.avg_count   ?? 0),
        totalPhonesAnalyzed: row?.total_phones       ?? 0,
        analyzedGroups:      scopeIds.length,
        hasData:             (row?.overlap_count     ?? 0) > 0,
      });
      return;
    }

    // ── analytics-movement-history ────────────────────────────────────────────
    // Returns a paginated feed of member movement events for a group.
    if (funcName === "analytics-movement-history") {
      const groupUuid  = String(params.groupId    || "").trim();
      const days       = Math.min(365, Math.max(1, Number(params.days)  || 30));
      const eventType  = String(params.eventType  || "all").trim();  // all | joined | left
      const page       = Math.max(0, Number(params.page)  || 0);
      const limit      = Math.min(100, Math.max(1, Number(params.limit) || 50));
      const offset     = page * limit;

      if (!groupUuid) { fail(res, "groupId obrigatório", 400); return; }

      // Ownership check (404 not 403 — don't reveal existence)
      const groupOwned = await queryOne<{ id: string }>(
        `SELECT id FROM groups WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [groupUuid, userId],
      );
      if (!groupOwned) { fail(res, "Grupo não encontrado", 404); return; }

      const validTypes = ["member_joined", "member_left", "member_removed"];
      const typeFilter = validTypes.includes(eventType)
        ? `AND event_type = '${eventType}'`
        : eventType === "left"
          ? `AND event_type IN ('member_left', 'member_removed')`
          : "";

      const items = await query<{
        id: string;
        event_type: string;
        member_phone: string;
        author_phone: string;
        event_timestamp: string;
        time_permanence_minutes: number | null;
        entry_event_id: string | null;
        session_id: string | null;
      }>(
        `SELECT id, event_type, member_phone, author_phone, event_timestamp,
                time_permanence_minutes, entry_event_id, session_id
           FROM group_member_movements
          WHERE group_id = $1
            AND user_id  = $2
            AND event_timestamp >= NOW() - ($3 || ' days')::interval
            ${typeFilter}
          ORDER BY event_timestamp DESC
          LIMIT $4 OFFSET $5`,
        [groupUuid, userId, String(days), limit, offset],
      );

      const countRow = await queryOne<{ total: string }>(
        `SELECT COUNT(*) AS total
           FROM group_member_movements
          WHERE group_id = $1
            AND user_id  = $2
            AND event_timestamp >= NOW() - ($3 || ' days')::interval
            ${typeFilter}`,
        [groupUuid, userId, String(days)],
      );

      ok(res, {
        items: items.map((row) => ({
          id: row.id,
          groupId: groupUuid,
          eventType: row.event_type,
          memberPhone: row.member_phone,
          authorPhone: row.author_phone || null,
          eventTimestamp: row.event_timestamp,
          timePermanenceMinutes: row.time_permanence_minutes ?? null,
          entryEventId: row.entry_event_id ?? null,
          sessionId: row.session_id ?? null,
        })),
        total: Number(countRow?.total ?? 0),
        page,
        limit,
      });
      return;
    }

    // ── analytics-movement-kpis ───────────────────────────────────────────────
    // Aggregate KPIs for the history tab header cards.
    if (funcName === "analytics-movement-kpis") {
      const groupUuid = String(params.groupId || "").trim();
      const days      = Math.min(365, Math.max(1, Number(params.days) || 30));

      if (!groupUuid) { fail(res, "groupId obrigatório", 400); return; }

      const groupOwned = await queryOne<{ id: string }>(
        `SELECT id FROM groups WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [groupUuid, userId],
      );
      if (!groupOwned) { fail(res, "Grupo não encontrado", 404); return; }

      const kpiRow = await queryOne<{
        total_joins: string;
        total_leaves: string;
        avg_perm: string | null;
        median_perm: string | null;
        max_perm: string | null;
        exits_under_24h: string;
        exits_under_7d: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE event_type = 'member_joined') AS total_joins,
           COUNT(*) FILTER (WHERE event_type IN ('member_left', 'member_removed')) AS total_leaves,
           AVG(time_permanence_minutes) FILTER (WHERE time_permanence_minutes IS NOT NULL) AS avg_perm,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_permanence_minutes)
             FILTER (WHERE time_permanence_minutes IS NOT NULL) AS median_perm,
           MAX(time_permanence_minutes) FILTER (WHERE time_permanence_minutes IS NOT NULL) AS max_perm,
           COUNT(*) FILTER (
             WHERE event_type IN ('member_left', 'member_removed')
               AND time_permanence_minutes IS NOT NULL
               AND time_permanence_minutes < 1440
           ) AS exits_under_24h,
           COUNT(*) FILTER (
             WHERE event_type IN ('member_left', 'member_removed')
               AND time_permanence_minutes IS NOT NULL
               AND time_permanence_minutes < 10080
           ) AS exits_under_7d
         FROM group_member_movements
        WHERE group_id = $1
          AND user_id  = $2
          AND event_timestamp >= NOW() - ($3 || ' days')::interval`,
        [groupUuid, userId, String(days)],
      );

      const avgMin = kpiRow?.avg_perm != null ? Math.round(Number(kpiRow.avg_perm)) : null;

      ok(res, {
        totalJoins:              Number(kpiRow?.total_joins ?? 0),
        totalLeaves:             Number(kpiRow?.total_leaves ?? 0),
        avgPermanenceMinutes:    avgMin,
        avgPermanenceFormatted:  avgMin != null ? formatPermanenceMinutes(avgMin) : null,
        medianPermanenceMinutes: kpiRow?.median_perm != null ? Math.round(Number(kpiRow.median_perm)) : null,
        maxPermanenceMinutes:    kpiRow?.max_perm    != null ? Math.round(Number(kpiRow.max_perm))    : null,
        exitsUnder24h:           Number(kpiRow?.exits_under_24h ?? 0),
        exitsUnder7d:            Number(kpiRow?.exits_under_7d  ?? 0),
      });
      return;
    }

    // ── analytics-recapture-rule-save ─────────────────────────────────────────
    // Upsert a recapture rule for a group (one per group).
    if (funcName === "analytics-recapture-rule-save") {
      const groupUuid      = String(params.groupId         || "").trim();
      const delayHours     = Math.max(0, Number(params.delayHours) || 0);
      const messageTemplate = String(params.messageTemplate || "").trim();
      const active         = params.active !== false; // default true
      const sessionWaId    = params.sessionWaId ? String(params.sessionWaId).trim() : null;

      if (!groupUuid) { fail(res, "groupId obrigatório", 400); return; }

      const groupOwned = await queryOne<{ id: string }>(
        `SELECT id FROM groups WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [groupUuid, userId],
      );
      if (!groupOwned) { fail(res, "Grupo não encontrado", 404); return; }

      // Validate the chosen session belongs to this user
      if (sessionWaId) {
        const sessionOwned = await queryOne<{ id: string }>(
          `SELECT id FROM whatsapp_sessions WHERE id = $1 AND user_id = $2`,
          [sessionWaId, userId],
        );
        if (!sessionOwned) { fail(res, "Sessão não encontrada", 404); return; }
      }

      const saved = await queryOne<{
        id: string; delay_hours: number; message_template: string;
        active: boolean; session_wa_id: string | null; created_at: string; updated_at: string;
      }>(
        `INSERT INTO group_recapture_rules (user_id, group_id, delay_hours, message_template, active, session_wa_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (group_id) DO UPDATE
           SET delay_hours      = EXCLUDED.delay_hours,
               message_template = EXCLUDED.message_template,
               active           = EXCLUDED.active,
               session_wa_id    = EXCLUDED.session_wa_id,
               updated_at       = NOW()
         RETURNING id, delay_hours, message_template, active, session_wa_id, created_at, updated_at`,
        [userId, groupUuid, delayHours, messageTemplate, active, sessionWaId],
      );

      ok(res, {
        id: saved?.id,
        groupId: groupUuid,
        delayHours: saved?.delay_hours ?? delayHours,
        messageTemplate: saved?.message_template ?? messageTemplate,
        active: saved?.active ?? active,
        sessionWaId: saved?.session_wa_id ?? null,
        createdAt: saved?.created_at,
        updatedAt: saved?.updated_at,
      });
      return;
    }

    // ── analytics-recapture-queue ─────────────────────────────────────────────
    // Returns the rule config + pending and recently processed queue items.
    if (funcName === "analytics-recapture-queue") {
      const groupUuid = String(params.groupId || "").trim();
      if (!groupUuid) { fail(res, "groupId obrigatório", 400); return; }

      const groupOwned = await queryOne<{ id: string }>(
        `SELECT id FROM groups WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [groupUuid, userId],
      );
      if (!groupOwned) { fail(res, "Grupo não encontrado", 404); return; }

      const rule = await queryOne<{
        id: string; delay_hours: number; message_template: string;
        active: boolean; session_wa_id: string | null; created_at: string; updated_at: string;
      }>(
        `SELECT id, delay_hours, message_template, active, session_wa_id, created_at, updated_at
           FROM group_recapture_rules WHERE group_id = $1 AND user_id = $2`,
        [groupUuid, userId],
      );

      const pending = await query<{
        id: string; member_phone: string; scheduled_at: string;
        status: string; sent_at: string | null; error_message: string;
        movement_id: string;
      }>(
        `SELECT id, member_phone, scheduled_at, status, sent_at, error_message, movement_id
           FROM group_recapture_queue
          WHERE group_id = $1 AND user_id = $2 AND status = 'pending'
          ORDER BY scheduled_at ASC LIMIT 100`,
        [groupUuid, userId],
      );

      const recent = await query<{
        id: string; member_phone: string; scheduled_at: string;
        status: string; sent_at: string | null; error_message: string;
        movement_id: string;
      }>(
        `SELECT id, member_phone, scheduled_at, status, sent_at, error_message, movement_id
           FROM group_recapture_queue
          WHERE group_id = $1 AND user_id = $2 AND status IN ('sent', 'failed')
          ORDER BY COALESCE(sent_at, scheduled_at) DESC LIMIT 50`,
        [groupUuid, userId],
      );

      const mapItem = (row: typeof pending[0]) => ({
        id: row.id,
        groupId: groupUuid,
        movementId: row.movement_id,
        memberPhone: row.member_phone,
        scheduledAt: row.scheduled_at,
        sentAt: row.sent_at ?? null,
        status: row.status,
        errorMessage: row.error_message || "",
      });

      ok(res, {
        rule: rule
          ? {
              id: rule.id,
              groupId: groupUuid,
              delayHours: rule.delay_hours,
              messageTemplate: rule.message_template,
              active: rule.active,
              sessionWaId: rule.session_wa_id ?? null,
              createdAt: rule.created_at,
              updatedAt: rule.updated_at,
            }
          : null,
        pending: pending.map(mapItem),
        recent: recent.map(mapItem),
      });
      return;
    }

    // ── analytics-recapture-process-batch ────────────────────────────────────
    // Called by the Baileys recapture-dispatcher to get the next batch of items
    // to send. Only service / trusted backend callers.
    if (funcName === "analytics-recapture-process-batch") {
      if (!isService && !effectiveAdmin) {
        fail(res, "Não autorizado", 403);
        return;
      }

      const batch = await query<{
        id: string;
        member_phone: string;
        message_template: string;
        external_id: string;
        session_id: string | null;
        time_permanence_minutes: number | null;
      }>(
        `SELECT q.id, q.member_phone, r.message_template,
                g.external_id, COALESCE(r.session_wa_id, g.session_id) AS session_id,
                m.time_permanence_minutes
           FROM group_recapture_queue q
           JOIN group_recapture_rules r ON r.id = q.rule_id
           JOIN groups                g ON g.id = q.group_id AND g.deleted_at IS NULL
           JOIN group_member_movements m ON m.id = q.movement_id
          WHERE q.status = 'pending'
            AND q.scheduled_at <= NOW()
          ORDER BY q.scheduled_at ASC
          LIMIT 20`,
        [],
      );

      ok(res, batch.map((row) => ({
        queueId:                row.id,
        memberPhone:            row.member_phone,
        messageTemplate:        row.message_template,
        groupExternalId:        row.external_id,
        sessionId:              row.session_id ?? null,
        timePermanenceMinutes:  row.time_permanence_minutes ?? null,
      })));
      return;
    }

    // ── analytics-recapture-mark-sent ─────────────────────────────────────────
    // Called by the Baileys recapture-dispatcher after each send attempt.
    if (funcName === "analytics-recapture-mark-sent") {
      if (!isService && !effectiveAdmin) {
        fail(res, "Não autorizado", 403);
        return;
      }

      const queueId     = String(params.queueId      || "").trim();
      const status      = String(params.status        || "").trim();
      const errorMessage = String(params.errorMessage || "").trim().slice(0, 500);

      if (!queueId || !["sent", "failed"].includes(status)) {
        fail(res, "Parâmetros inválidos para analytics-recapture-mark-sent", 400);
        return;
      }

      await execute(
        `UPDATE group_recapture_queue
            SET status = $1, sent_at = NOW(), error_message = $2
          WHERE id = $3`,
        [status, errorMessage, queueId],
      );

      ok(res, { updated: true });
      return;
    }

    // ── Analytics RPC proxy functions ──────────────────────────────────────────
    // These proxy calls go through the Baileys service with proper auth headers
    const analyticsRpcActions: string[] = [
      "analytics-composition",
      "analytics-geography",
      "analytics-churn-daily",
      "analytics-churn-trends",
      "analytics-churn-retention",
      "analytics-health-score",
      "analytics-group-summary",
    ];

    if (analyticsRpcActions.includes(funcName)) {
      if (!WHATSAPP_URL) {
        fail(res, "WHATSAPP_MICROSERVICE_URL não definido");
        return;
      }

      const groupUuid = String(params.groupId || "").trim();
      const days = Number(params.days) || 30;

      if (!groupUuid) {
        fail(res, "groupId obrigatório", 400);
        return;
      }

      // Resolve external_id (WhatsApp JID) e session_id para o grupo
      const groupRow = await queryOne<{ external_id: string; session_id: string }>(
        `SELECT external_id, session_id FROM groups
         WHERE id = $1 AND user_id = $2 AND platform = 'whatsapp' AND deleted_at IS NULL`,
        [groupUuid, userId],
      );

      if (!groupRow) {
        fail(res, "Grupo não encontrado", 404);
        return;
      }

      const externalId = String(groupRow.external_id || "").trim();
      const sessionId  = String(groupRow.session_id  || "").trim();

      if (!externalId) {
        fail(res, "Grupo sem external_id — sincronize novamente", 422);
        return;
      }

      const sessionQuery = sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : "";

      // Mapeia função → endpoint Baileys usando o WhatsApp JID correto
      const endpointMap: Record<string, string> = {
        "analytics-composition":    `/api/analytics/groups/${encodeURIComponent(externalId)}/composition${sessionQuery ? `?${sessionQuery}` : ""}`,
        "analytics-geography":      `/api/analytics/groups/${encodeURIComponent(externalId)}/geography${sessionQuery ? `?${sessionQuery}` : ""}`,
        "analytics-churn-daily":    `/api/analytics/groups/${encodeURIComponent(externalId)}/churn/daily?days=${days}${sessionQuery ? `&${sessionQuery}` : ""}`,
        "analytics-churn-trends":   `/api/analytics/groups/${encodeURIComponent(externalId)}/churn/trends${sessionQuery ? `?${sessionQuery}` : ""}`,
        "analytics-churn-retention":`/api/analytics/groups/${encodeURIComponent(externalId)}/churn/retention${sessionQuery ? `?${sessionQuery}` : ""}`,
        "analytics-health-score":   `/api/analytics/groups/${encodeURIComponent(externalId)}/health?days=${days}${sessionQuery ? `&${sessionQuery}` : ""}`,
        "analytics-group-summary":  `/api/analytics/groups/${encodeURIComponent(externalId)}/summary?days=${days}${sessionQuery ? `&${sessionQuery}` : ""}`,
      };

      const endpoint = endpointMap[funcName];
      if (!endpoint) {
        fail(res, `Função de analytics não mapeada: ${funcName}`);
        return;
      }

      const r = await proxyMicroservice(
        WHATSAPP_URL,
        endpoint,
        "GET",
        null,
        buildUserScopedHeaders(userId),
      );

      let resolved = r;
      if (
        resolved.error
        && sessionId
        && resolved.error.status === 404
      ) {
        const normalizedError = String(resolved.error.message || "").toLowerCase();
        const canRetryWithoutSession = (
          normalizedError.includes("grupo nao encontrado")
          || normalizedError.includes("grupo não encontrado")
          || normalizedError.includes("group not found")
        );

        if (canRetryWithoutSession) {
          const retryEndpoint = stripSessionIdQueryParam(endpoint);
          if (retryEndpoint !== endpoint) {
            resolved = await proxyMicroservice(
              WHATSAPP_URL,
              retryEndpoint,
              "GET",
              null,
              buildUserScopedHeaders(userId),
            );
          }
        }
      }

      if (resolved.error) {
        fail(res, resolved.error.message || "Falha ao buscar métricas", 502);
        return;
      }

      ok(res, unwrapAnalyticsPayload(resolved.data));
      return;
    }

if (funcName === "whatsapp-connect") {
      const action = String(params.action ?? "");
      const sessionId = String(params.sessionId ?? "");
      // Ownership guard: verify session belongs to this user before any session-specific action
      if (sessionId && action !== "health" && action !== "poll_events_all") {
        const ownedWa = await queryOne("SELECT id FROM whatsapp_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        if (!ownedWa) { fail(res, "Sessão não encontrada"); return; }
      }
      if (!WHATSAPP_URL) {
        if (action === "health") { ok(res, { online: false, url: "", uptimeSec: null, sessions: [], error: "WHATSAPP_MICROSERVICE_URL não definido" }); return; }
        if (action === "poll_events_all" || action === "poll_events") { ok(res, { success: true, sessions: 0, events: 0 }); return; }
        if (action === "delete") {
          await execute(
            "DELETE FROM whatsapp_sessions WHERE id = $1 AND user_id = $2",
            [sessionId, userId],
          );
          ok(res, { success: true, status: "deleted", runtimeCleanup: "skipped", runtimeError: "WHATSAPP_MICROSERVICE_URL não definido" });
          return;
        }
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
        const dbSessions = await query<{ id: string }>("SELECT id FROM whatsapp_sessions WHERE user_id = $1", [userId]);
        const dbRows = dedupeChannelPollSessions(
          dbSessions.map((row) => ({ id: String(row?.id || ""), user_id: userId })),
        );
        const healthRows = await loadOnlineSessionsFromConnectorHealth({
          platform: "whatsapp",
          requesterUserId: userId,
          canRunGlobal: false,
        }).catch(() => []);
        const sessions = dedupeChannelPollSessions([...dbRows, ...healthRows]);
        let totalEvents = 0;
        for (const row of sessions) {
          if (!row?.id) continue;
          try {
            totalEvents += await pollWhatsAppEventsForSession(userId, String(row.id));
          } catch {
            // best effort polling
          }
        }
        ok(res, {
          success: true,
          sessions: sessions.length,
          events: totalEvents,
          healthFallbackAdded: Math.max(0, sessions.length - dbRows.length),
        }); return;
      }
      if (action === "poll_events") {
        const events = await pollWhatsAppEventsForSession(userId, sessionId);
        ok(res, { success: true, events }); return;
      }
      if (action === "connect") {
        const sess = await queryOne("SELECT auth_method, phone, name FROM whatsapp_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
        if (!sess) { fail(res, "Sessão não encontrada"); return; }
        const authMethod = "qr";
        const phone = sanitizePhone(String(sess.phone ?? ""));
        if (phone && await hasCrossAccountActiveWhatsAppPhone(phone, userId, sessionId)) {
          fail(res, WHATSAPP_ALREADY_LINKED_MESSAGE, 409); return;
        }
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
        let polledEvents = await pollWhatsAppEventsForSession(userId, sessionId).catch(() => 0);
        for (let attempt = 0; attempt < 2 && polledEvents <= 0; attempt += 1) {
          await sleep(700);
          const extraEvents = await pollWhatsAppEventsForSession(userId, sessionId).catch(() => 0);
          polledEvents += extraEvents;
          if (extraEvents > 0) break;
        }

        const dbState = await queryOne<{ status: string | null }>(
          "SELECT status FROM whatsapp_sessions WHERE id = $1 AND user_id = $2",
          [sessionId, userId],
        );
        const upstreamStatus = (r.data && typeof r.data === "object" && typeof (r.data as Record<string, unknown>).status === "string")
          ? String((r.data as Record<string, unknown>).status)
          : "";
        const status = normalizeWhatsAppStatus(dbState?.status ?? upstreamStatus ?? "connecting");
        const waitingWebhook = polledEvents <= 0 && (status === "connecting" || status === "offline");
        ok(res, { success: true, status, waiting_webhook: waitingWebhook }); return;
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
      if (action === "delete") {
        const waHeaders = buildUserScopedHeaders(userId);
        const disconnect = await proxyMicroservice(
          WHATSAPP_URL,
          `/api/sessions/${encodeURIComponent(sessionId)}/disconnect`,
          "POST",
          { sessionId },
          waHeaders,
        );

        await execute(
          "DELETE FROM whatsapp_sessions WHERE id = $1 AND user_id = $2",
          [sessionId, userId],
        );

        if (disconnect.error) {
          ok(res, {
            success: true,
            status: "deleted",
            runtimeCleanup: "failed",
            runtimeError: disconnect.error.message || "Falha ao encerrar runtime do WhatsApp",
          });
          return;
        }

        ok(res, { success: true, status: "deleted", runtimeCleanup: "ok" });
        return;
      }
      if (action === "sync_groups") {
        let syncResult: Awaited<ReturnType<typeof syncWhatsAppSessionGroups>>;
        try {
          syncResult = await syncWhatsAppSessionGroups({
            userId,
            sessionId,
            includeEventPoll: true,
          });
        } catch (error) {
          fail(res, error instanceof Error ? error.message : String(error));
          return;
        }
        ok(res, {
          success: true,
          count: syncResult.count,
          events: syncResult.events,
          masterGroupInviteSync: syncResult.inviteSync,
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
        const touched = await refreshTelegramHealthState(userId).catch(() => 0);
        const dbSessions = await query<{ id: string }>("SELECT id FROM telegram_sessions WHERE user_id = $1", [userId]);
        const dbRows = dedupeChannelPollSessions(
          dbSessions.map((row) => ({ id: String(row?.id || ""), user_id: userId })),
        );
        const healthRows = await loadOnlineSessionsFromConnectorHealth({
          platform: "telegram",
          requesterUserId: userId,
          canRunGlobal: false,
        }).catch(() => []);
        const sessions = dedupeChannelPollSessions([...dbRows, ...healthRows]);
        let totalEvents = 0;
        for (const row of sessions) {
          if (!row?.id) continue;
          try {
            totalEvents += await pollTelegramEventsForSession(userId, String(row.id));
          } catch {
            // best effort polling
          }
        }
        ok(res, {
          success: true,
          sessions: sessions.length,
          events: totalEvents,
          touched,
          healthFallbackAdded: Math.max(0, sessions.length - dbRows.length),
        }); return;
      }
      if (action === "refresh_status") {
        const touched = await refreshTelegramHealthState(userId).catch(() => 0);
        const dbSessions = await query<{ id: string }>("SELECT id FROM telegram_sessions WHERE user_id = $1", [userId]);
        const dbRows = dedupeChannelPollSessions(
          dbSessions.map((row) => ({ id: String(row?.id || ""), user_id: userId })),
        );
        const healthRows = await loadOnlineSessionsFromConnectorHealth({
          platform: "telegram",
          requesterUserId: userId,
          canRunGlobal: false,
        }).catch(() => []);
        const sessions = dedupeChannelPollSessions([...dbRows, ...healthRows]);
        let totalEvents = 0;
        for (const row of sessions) {
          if (!row?.id) continue;
          try {
            totalEvents += await pollTelegramEventsForSession(userId, String(row.id));
          } catch {
            // best effort polling
          }
        }
        ok(res, {
          success: true,
          sessions: sessions.length,
          events: totalEvents,
          touched,
          healthFallbackAdded: Math.max(0, sessions.length - dbRows.length),
        }); return;
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
        const phone = sanitizePhone(String(params.phone ?? sess.phone ?? ""));
        if (!phone) { fail(res, "Telefone inválido. Use formato com DDD, ex: +5511912345678", 400); return; }
        if (await hasCrossAccountActiveTelegramPhone(phone, userId, sessionId)) {
          fail(res, TELEGRAM_ALREADY_LINKED_MESSAGE, 409); return;
        }
        await execute("UPDATE telegram_sessions SET status='connecting', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2", [sessionId, userId]);
        const tgHeaders = buildUserScopedHeaders(userId);
        // Decrypt session_string before passing to Telegram microservice (handles legacy plaintext transparently)
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/send_code", "POST", {
          sessionId,
          userId,
          phone,
          webhookUrl: "",
          sessionString: decryptCredential(String(sess.session_string ?? "")),
        }, tgHeaders);
        if (r.error) {
          await execute(
            "UPDATE telegram_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
            [String(r.error.message || "Erro ao iniciar autenticação Telegram"), sessionId, userId],
          ).catch(() => undefined);
          const upstreamStatus = Number((r.error as { status?: unknown }).status);
          const statusCode = Number.isFinite(upstreamStatus) && upstreamStatus >= 400 ? upstreamStatus : 502;
          fail(res, r.error.message, statusCode);
          return;
        }
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
        if (r.error) {
          await execute(
            "UPDATE telegram_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
            [String(r.error.message || "Erro ao validar código Telegram"), sessionId, userId],
          ).catch(() => undefined);
          const upstreamStatus = Number((r.error as { status?: unknown }).status);
          const statusCode = Number.isFinite(upstreamStatus) && upstreamStatus >= 400 ? upstreamStatus : 502;
          fail(res, r.error.message, statusCode);
          return;
        }
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, r.data ?? { status: "connecting" }); return;
      }
      if (action === "verify_password") {
        await execute("UPDATE telegram_sessions SET status='connecting', error_message='', updated_at=NOW() WHERE id=$1 AND user_id=$2", [sessionId, userId]);
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/verify_password", "POST", { sessionId, password: params.password }, tgHeaders);
        if (r.error) {
          await execute(
            "UPDATE telegram_sessions SET status='warning', error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
            [String(r.error.message || "Erro ao validar senha 2FA Telegram"), sessionId, userId],
          ).catch(() => undefined);
          const upstreamStatus = Number((r.error as { status?: unknown }).status);
          const statusCode = Number.isFinite(upstreamStatus) && upstreamStatus >= 400 ? upstreamStatus : 502;
          fail(res, r.error.message, statusCode);
          return;
        }
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, r.data ?? { status: "connecting" }); return;
      }
      if (action === "disconnect") {
        const clearSession = params.clearSession === true || String(params.clearSession ?? "").trim().toLowerCase() === "true";
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(
          TELEGRAM_URL,
          "/api/telegram/disconnect",
          "POST",
          { sessionId, clearSession },
          tgHeaders,
        );
        if (r.error) { fail(res, r.error.message); return; }
        await execute(
          `UPDATE telegram_sessions
              SET status = 'offline',
                  connected_at = NULL,
                  phone_code_hash = '',
                  session_string = CASE WHEN $3 THEN '' ELSE session_string END,
                  error_message = '',
                  updated_at = NOW()
            WHERE id = $1 AND user_id = $2`,
          [sessionId, userId, clearSession],
        );
        await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, { status: "offline", clear_session: clearSession }); return;
      }
      if (action === "sync_groups") {
        const tgHeaders = buildUserScopedHeaders(userId);
        const r = await proxyMicroservice(TELEGRAM_URL, "/api/telegram/sync_groups", "POST", { sessionId }, tgHeaders);
        if (r.error) { fail(res, r.error.message); return; }
        const payload = (r.data && typeof r.data === "object") ? r.data as Record<string, unknown> : {};
        const remoteGroups = Array.isArray(payload.groupsData)
          ? payload.groupsData as Array<Record<string, unknown>>
          : [];
        let groupsSyncedDirect = 0;
        for (const row of remoteGroups) {
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
          groupsSyncedDirect += 1;
        }
        const events = await pollTelegramEventsForSession(userId, sessionId).catch(() => 0);
        ok(res, { ...payload, groupsSyncedDirect, events }); return;
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
      // Atomic claim: UPDATE status -> 'processing' using FOR UPDATE SKIP LOCKED so that
      // concurrent calls from the frontend and the scheduler never process the same post.
      // Only rows still 'pending' at the moment of the UPDATE are claimed, preventing
      // double-dispatch (SQL-5).
      const canRunGlobalDispatch = isService || (effectiveAdmin && !userIsAdmin);
      const claimedRows = canRunGlobalDispatch
        ? await query(
            `UPDATE scheduled_posts SET status = 'processing', updated_at = NOW()
             WHERE id IN (
               SELECT id FROM scheduled_posts
               WHERE status = 'pending'
                 AND scheduled_at <= NOW()
                 AND EXISTS (
                   SELECT 1
                     FROM profiles p
                    WHERE p.user_id = scheduled_posts.user_id
                      AND (p.plan_expires_at IS NULL OR p.plan_expires_at > NOW())
                 )
               ORDER BY scheduled_at LIMIT $1
               FOR UPDATE SKIP LOCKED
             ) RETURNING *`,
            [limit]
          )
        : await query(
            `UPDATE scheduled_posts SET status = 'processing', updated_at = NOW()
             WHERE id IN (
               SELECT id FROM scheduled_posts
               WHERE status = 'pending'
                 AND scheduled_at <= NOW()
                 AND user_id = $2
                 AND EXISTS (
                   SELECT 1
                     FROM profiles p
                    WHERE p.user_id = scheduled_posts.user_id
                      AND (p.plan_expires_at IS NULL OR p.plan_expires_at > NOW())
                 )
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
      const scheduleTemplateCache = new Map<string, { content: string; scope: TemplateScope } | null>();
      const insertScheduleFailedHistory = async (input: {
        userId: string;
        destination: string;
        message: string;
        reason: string;
        errorStep: string;
        platform?: string;
        error?: string;
        messageType?: "text" | "image" | "video";
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
        const isRouteQuietHoursQueue = String(meta.scheduleSource || "").trim().toLowerCase() === ROUTE_QUIET_HOURS_SCHEDULE_SOURCE;
        const routeQueueRouteId = typeof meta.routeId === "string" ? meta.routeId.trim() : "";
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
          let cachedTemplate = scheduleTemplateCache.get(cacheKey);
          if (cachedTemplate === undefined) {
            const templateRow = await queryOne<{ content: string; scope: string | null; tags: unknown }>(
              "SELECT content, scope, tags FROM templates WHERE user_id = $1 AND id = $2",
              [post.user_id, rawTemplateId],
            );
            cachedTemplate = templateRow && typeof templateRow.content === "string"
              ? {
                content: templateRow.content,
                scope: inferTemplateScopeFromTemplateRow(templateRow as unknown as Record<string, unknown>),
              }
              : null;
            scheduleTemplateCache.set(cacheKey, cachedTemplate);
          }
          const templateData = parseScheduleTemplateData(meta);
          if (cachedTemplate && Object.keys(templateData).length > 0) {
            const scopeHint = inferTemplateScopeFromScheduleSource(meta.scheduleSource);
            message = applyScopedTemplatePlaceholders(
              scopeHint || cachedTemplate.scope,
              cachedTemplate.content,
              templateData,
            );
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
            messageType: scheduleMedia ? scheduleMedia.kind : "text",
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
              messageType: scheduleMedia ? scheduleMedia.kind : "text",
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
              errorStep: "destination_validation",
              error: "Sessão do destino offline ou grupo sem identificador externo.",
              messageType: scheduleMedia ? scheduleMedia.kind : "text",
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
              messageType: mediaForDestination ? mediaForDestination.kind : "text",
            });
            break;
          }

          await execute("INSERT INTO history_entries (id, user_id, type, source, destination, status, details, direction, message_type, processing_status, block_reason, error_step) VALUES ($1,$2,'schedule_sent','Agendamento',$3,'success',$4,'outbound',$5,'sent','','')",
            [uuid(), post.user_id, g.name, JSON.stringify({ message, platform: g.platform, hasMedia: !!mediaForDestination }), mediaForDestination ? mediaForDestination.kind : "text"]);
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

        if (postSentCount > 0 && isRouteQuietHoursQueue && isUuid(routeQueueRouteId)) {
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
            [postSentCount, routeQueueRouteId, post.user_id],
          );
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
      if (cred.secret_key) cred.secret_key = decryptCredential(cred.secret_key);
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
    if (funcName === "marketplace-convert-link") {
      const sourceInput = String(params.url ?? params.link ?? "").trim();
      if (!sourceInput) { fail(res, "URL obrigatoria"); return; }
      if (sourceInput.length > MAX_URL_LENGTH) { fail(res, "URL excede o tamanho maximo permitido"); return; }

      const sourceUrl = /^https?:\/\//i.test(sourceInput) ? sourceInput : `https://${sourceInput}`;
      if (!parseHttpUrl(sourceUrl)) { fail(res, "URL invalida"); return; }

      const resolvedUrl = await resolveRouteLinkWithRedirect(sourceUrl);
      const marketplace = detectAffiliateMarketplace(resolvedUrl) ?? detectAffiliateMarketplace(sourceUrl);
      if (!marketplace) {
        fail(res, "Marketplace nao suportado. Use links da Shopee, Mercado Livre ou Amazon.");
        return;
      }

      if ((marketplace === "mercadolivre" || marketplace === "amazon") && !effectiveAdmin) {
        try {
          const featureAccess = marketplace === "amazon"
            ? await resolveAmazonFeatureAccess(userId)
            : await resolveMercadoLivreFeatureAccess(userId);
          if (!featureAccess.allowed) {
            fail(
              res,
              featureAccess.message || (marketplace === "amazon" ? AMAZON_BLOCKED_MESSAGE : MERCADO_LIVRE_BLOCKED_MESSAGE),
              403,
            );
            return;
          }
        } catch {
          fail(
            res,
            marketplace === "amazon"
              ? "Nao foi possivel validar o acesso ao modulo Amazon."
              : "Nao foi possivel validar o acesso ao modulo Mercado Livre.",
            503,
          );
          return;
        }
      }

      if (marketplace === "amazon") {
        const amazonUrl = isAmazonProductUrlLike(resolvedUrl) ? resolvedUrl : sourceUrl;
        if (!isAmazonProductUrlLike(amazonUrl)) { fail(res, "URL informada nao parece ser da Amazon (amazon.com.br)"); return; }
        let conversion: AmazonAffiliateConversionResult;
        try {
          conversion = await buildAmazonAffiliateConversionForUser(userId, amazonUrl);
        } catch (error) {
          fail(res, error instanceof Error ? error.message : "Falha ao converter link Amazon");
          return;
        }

        ok(res, {
          marketplace: "amazon",
          originalLink: sourceUrl,
          resolvedLink: conversion.resolvedUrl,
          affiliateLink: conversion.affiliateLink,
          asin: conversion.asin,
          usedService: true,
        });
        return;
      }

      if (marketplace === "mercadolivre") {
        if (!MELI_URL) { fail(res, "MeLi RPA nao configurado."); return; }

        const productUrl = isMercadoLivreProductUrlLike(resolvedUrl) ? resolvedUrl : sourceUrl;
        if (!isMercadoLivreProductUrlLike(productUrl)) { fail(res, "URL informada nao parece ser do Mercado Livre"); return; }
        const requestedSessionId = String(params.sessionId ?? "").trim();
        const sessionId = await resolveRouteMeliSessionId(userId, requestedSessionId);
        if (!sessionId) { fail(res, "Nenhuma sessao Mercado Livre disponivel para conversao."); return; }

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
          marketplace: "mercadolivre",
          success: true,
          originalLink: String(payload.originalUrl || sourceUrl),
          resolvedLink: String(payload.resolvedUrl || payload.originalUrl || productUrl),
          affiliateLink: String(payload.affiliateLink || productUrl),
          cached: payload.cached === true,
          conversionTimeMs: Number.isFinite(Number(payload.conversionTimeMs))
            ? Number(payload.conversionTimeMs)
            : undefined,
        });
        return;
      }

      if (!SHOPEE_URL) { fail(res, "Shopee microservice nao configurado."); return; }
      const cred = await queryOne("SELECT app_id, secret_key, region FROM api_credentials WHERE user_id=$1 AND provider='shopee'", [userId]);
      if (!cred) { fail(res, "Credenciais Shopee nao configuradas."); return; }
      if (cred.secret_key) cred.secret_key = decryptCredential(cred.secret_key);

      const shopeeUrl = isShopeeProductUrlLike(resolvedUrl) ? resolvedUrl : sourceUrl;
      if (!isShopeeProductUrlLike(shopeeUrl)) { fail(res, "URL informada nao parece ser da Shopee"); return; }

      const shopeeHeaders = buildUserScopedHeaders(userId);
      const r = await proxyMicroservice(SHOPEE_URL, "/api/shopee/convert-link", "POST", {
        url: shopeeUrl,
        appId: cred.app_id,
        secret: cred.secret_key,
        region: cred.region,
      }, shopeeHeaders, 30_000);
      if (r.error) { fail(res, r.error.message); return; }

      const payload: Record<string, unknown> = (r.data && typeof r.data === "object")
        ? (r.data as Record<string, unknown>)
        : {};
      ok(res, {
        marketplace: "shopee",
        originalLink: String(payload.originalLink || sourceUrl),
        resolvedLink: String(payload.resolvedLink || payload.resolvedUrl || shopeeUrl),
        affiliateLink: String(payload.affiliateLink || shopeeUrl),
        cached: payload.cached === true,
        conversionTimeMs: Number.isFinite(Number(payload.conversionTimeMs))
          ? Number(payload.conversionTimeMs)
          : undefined,
        status: payload.status ? String(payload.status) : undefined,
      });
      return;
    }
    if (funcName === "amazon-convert-link") {
      const sourceUrl = String(params.url ?? params.link ?? "").trim();
      try {
        const conversion = await buildAmazonAffiliateConversionForUser(userId, sourceUrl);
        ok(res, {
          affiliateLink: conversion.affiliateLink,
          asin: conversion.asin,
          resolvedUrl: conversion.resolvedUrl,
          usedService: true,
        });
      } catch (error) {
        fail(res, error instanceof Error ? error.message : "Falha ao converter link Amazon");
        return;
      }
      return;
    }

    if (funcName === "amazon-convert-links") {
      const urlsRaw = Array.isArray(params.urls) ? params.urls : (Array.isArray(params.links) ? params.links : []);
      const urls = urlsRaw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      const dedupedUrls: string[] = [...new Set<string>(urls)];
      if (dedupedUrls.length === 0) { fail(res, "Lista de URLs Amazon obrigatoria"); return; }
      if (dedupedUrls.length > 50) { fail(res, "Limite de 50 URLs por lote Amazon"); return; }
      if (dedupedUrls.some((item) => item.length > MAX_URL_LENGTH)) { fail(res, "Uma ou mais URLs excedem o tamanho maximo permitido"); return; }
      if (dedupedUrls.some((item) => !isAmazonProductUrlLike(item))) { fail(res, "Uma ou mais URLs não parecem ser da Amazon"); return; }
      
      const conversions = [];
      for (const originalLink of dedupedUrls) {
        try {
          const conversion = await buildAmazonAffiliateConversionForUser(userId, originalLink);
          conversions.push({
            originalLink,
            affiliateLink: conversion.affiliateLink,
            asin: conversion.asin,
            resolvedUrl: conversion.resolvedUrl,
            usedService: true,
            error: null,
          });
        } catch (error) {
          conversions.push({
            originalLink,
            affiliateLink: originalLink,
            asin: null,
            usedService: false,
            error: error instanceof Error ? error.message : "Falha ao converter link Amazon",
          });
        }
      }
      ok(res, { conversions });
      return;
    }

    if (funcName === "amazon-product-snapshot") {
      const sourceUrl = String(params.productUrl ?? params.url ?? "").trim();
      const asinHint = String(params.asin ?? "").trim().toUpperCase();
      if (!sourceUrl && !asinHint) { fail(res, "URL ou ASIN Amazon obrigatorio"); return; }
      if (sourceUrl && sourceUrl.length > MAX_URL_LENGTH) { fail(res, "URL Amazon excede o tamanho maximo permitido"); return; }

      const canonicalUrl = sourceUrl ? (canonicalizeAmazonProductUrl(sourceUrl) || "") : "";
      if (sourceUrl && !canonicalUrl) { fail(res, "URL informada não parece ser da Amazon (deve ser amazon.com.br)"); return; }

      const asin = asinHint || (canonicalUrl ? String(extractAmazonAsin(canonicalUrl) || "").trim().toUpperCase() : "");
      const targetUrl = canonicalUrl || (asin ? `https://www.amazon.com.br/dp/${asin}` : "");
      if (!targetUrl) { fail(res, "Nao foi possivel identificar o produto Amazon"); return; }

      try {
        const snapshot = await getAmazonProductSnapshot(targetUrl);
        ok(res, {
          ...snapshot,
          asin: String(snapshot.asin || asin || "").trim() || undefined,
        });
      } catch (error) {
        fail(res, error instanceof Error ? error.message : "Falha ao extrair dados do produto Amazon");
      }
      return;
    }

    if (funcName === "shopee-convert-link") {
      if (!SHOPEE_URL) { fail(res, "Shopee microservice não configurado."); return; }
      const cred = await queryOne("SELECT app_id, secret_key, region FROM api_credentials WHERE user_id=$1 AND provider='shopee'", [userId]);
      if (!cred) { fail(res, "Credenciais Shopee não configuradas."); return; }
      if (cred.secret_key) cred.secret_key = decryptCredential(cred.secret_key);
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
      if (cred.secret_key) cred.secret_key = decryptCredential(cred.secret_key);
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
      if (cred.secret_key) cred.secret_key = decryptCredential(cred.secret_key);
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
      for (const row of credRows) { if (row.secret_key) row.secret_key = decryptCredential(row.secret_key); }
      const credsByUser = new Map(credRows.map((row) => [String(row.user_id), row]));

      let processed = 0;
      let sent = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];
      const shopeeAccessByUser = new Map<string, boolean>();
      const activePlanByUser = new Map<string, boolean>();

      for (const auto of automations) {
        const ownerUserId = String(auto.user_id || "").trim();
        const automationName = String(auto.name || auto.id || "Automação Shopee");
        const automationId = String(auto.id || "").trim();
        if (!ownerUserId || !automationId) {
          skipped += 1;
          errors.push(`${automationName}: dados da automação inválidos`);
          continue;
        }

        if (runAllUsers) {
          let ownerHasActivePlan = activePlanByUser.get(ownerUserId);
          if (ownerHasActivePlan === undefined) {
            try {
              ownerHasActivePlan = !(await isPlanExpired(ownerUserId));
            } catch {
              ownerHasActivePlan = false;
            }
            activePlanByUser.set(ownerUserId, ownerHasActivePlan);
          }
          if (!ownerHasActivePlan) {
            skipped += 1;
            continue;
          }

          let ownerHasAccess = shopeeAccessByUser.get(ownerUserId);
          if (ownerHasAccess === undefined) {
            try {
              const access = await resolveShopeeAutomationAccess(ownerUserId);
              ownerHasAccess = access.allowed;
            } catch {
              ownerHasAccess = false;
            }
            shopeeAccessByUser.set(ownerUserId, ownerHasAccess);
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
        const template = await resolveAutomationTemplateForScope({
          userId: ownerUserId,
          templateId,
          scope: "shopee",
        });

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
            errorStep: "offer_validate",
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
        const automationSessionId = readAutomationDeliverySessionId(claimed);
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
              errorStep: "destination_validate",
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
              const access = await resolveMercadoLivreAutomationAccess(ownerUserId);
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
        const template = await resolveAutomationTemplateForScope({
          userId: ownerUserId,
          templateId,
          scope: "meli",
        });

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
        const automationSessionId = readAutomationDeliverySessionId(claimed);
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
              errorStep: "destination_validate",
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

    if (funcName === "amazon-automation-run") {
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
        AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'amazon'
        AND (
          last_run_at IS NULL
          OR last_run_at <= NOW() - (GREATEST(COALESCE(interval_minutes, 1), 1) * INTERVAL '1 minute')
        )
      `;

      const automations = requestedAutomationId
        ? (runAllUsers
            ? await query(
                "SELECT * FROM shopee_automations WHERE id = $1 AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'amazon' LIMIT 1",
                [requestedAutomationId],
              )
            : await query(
                "SELECT * FROM shopee_automations WHERE id = $1 AND user_id = $2 AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'amazon' LIMIT 1",
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
          message: "Nenhuma automação Amazon elegível para execução neste ciclo.",
        });
        return;
      }

      let processed = 0;
      let sent = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];
      const amazonAccessByUser = new Map<string, boolean>();

      for (const auto of automations) {
        const ownerUserId = String(auto.user_id || "").trim();
        const automationName = String(auto.name || auto.id || "Automação Amazon");
        const automationId = String(auto.id || "").trim();
        if (!ownerUserId || !automationId) {
          skipped += 1;
          errors.push(`${automationName}: dados da automação inválidos`);
          continue;
        }

        if (runAllUsers) {
          let ownerHasAccess = amazonAccessByUser.get(ownerUserId);
          if (ownerHasAccess === undefined) {
            try {
              const access = await resolveAmazonFeatureAccess(ownerUserId);
              ownerHasAccess = access.allowed;
            } catch {
              ownerHasAccess = false;
            }
            amazonAccessByUser.set(ownerUserId, ownerHasAccess);
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
             AND COALESCE(NULLIF(TRIM(config->>'marketplace'), ''), 'shopee') = 'amazon'
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
        const template = await resolveAutomationTemplateForScope({
          userId: ownerUserId,
          templateId,
          scope: "amazon",
        });

        const products = await query<{
          id: string;
          tab_key: string;
          asin: string | null;
          title: string;
          product_url: string;
          image_url: string;
          price_cents: string | number;
          old_price_cents: string | number | null;
          discount_text: string;
          seller: string;
          rating: string | number | null;
          reviews_count: string | number | null;
          badge_text: string;
        }>(
          `SELECT id, tab_key, asin, title, product_url, image_url, price_cents, old_price_cents, discount_text, seller, rating, reviews_count, badge_text
             FROM amazon_vitrine_products
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
            asin: String(row.asin || "").trim(),
            title,
            productUrl,
            imageUrl,
            price,
            oldPrice: oldPrice > 0 ? oldPrice : null,
            discountText: String(row.discount_text || "").trim(),
            seller,
            rating: toNumber(row.rating, 0),
            reviewsCount: Math.max(0, Math.floor(toNumber(row.reviews_count, 0))),
            installmentsText: "",
            badgeText: String(row.badge_text || "").trim(),
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

        let conversion: AmazonAffiliateConversionResult;
        try {
          conversion = await buildAmazonAffiliateConversionForUser(
            ownerUserId,
            String(selectedProduct.productUrl || "").trim(),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Falha ao converter link Amazon";
          const blockReason = reason.includes("/amazon/configuracoes")
            ? "missing_amazon_tag"
            : "amazon_conversion_failed";
          const historyStatus = blockReason === "missing_amazon_tag" ? "warning" : "error";
          const processingStatus = blockReason === "missing_amazon_tag" ? "blocked" : "failed";
          if (blockReason === "missing_amazon_tag") {
            skipped += 1;
          } else {
            failed += 1;
            errors.push(`${automationName}: ${reason}`);
          }
          await insertAutomationHistoryEntry({
            userId: ownerUserId,
            automationName,
            destination: "automation:diagnostic",
            status: historyStatus,
            processingStatus,
            message: reason,
            details: { automationId, source, reason: blockReason },
            blockReason,
            errorStep: "link_conversion",
          });
          continue;
        }

        const affiliateLink = String(conversion.affiliateLink || "").trim();
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
        const fallbackTitle = String(selectedProduct.title || "Oferta Amazon");
        const message = templateContent
          ? buildAmazonAutomationMessage(templateContent, selectedProduct, affiliateLink)
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
        const automationSessionId = readAutomationDeliverySessionId(claimed);
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
              errorStep: "destination_validate",
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

          if (mediaForDestination.kind !== "image") {
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

    if (funcName === "amazon-vitrine-sync") {
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
      const onlyIfStale = isPrivilegedSync ? params.onlyIfStale !== false : true;

      const result = await syncAmazonVitrine({ source, force, onlyIfStale });
      if (!result.success) { fail(res, result.message); return; }
      ok(res, result);
      return;
    }

    if (funcName === "amazon-vitrine-list") {
      const payload = await listAmazonVitrine({
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
          serviceOnline: false,
          url: "",
          uptimeSec: null,
          error: "MeLi RPA não configurado.",
          service: "mercadolivre-rpa",
          stats: null,
          sessionStatus: "not_found",
          sessionId: "",
          sessionName: "",
          sessionLastCheckedAt: null as string | null,
        });
        return;
      }
      const meliHeaders = { "x-autolinks-user-id": userId };
      const r = await proxyMicroservice(MELI_URL, "/api/meli/health", "GET", null, meliHeaders);
      if (r.error) {
        ok(res, {
          online: false,
          serviceOnline: false,
          url: MELI_URL,
          uptimeSec: null,
          error: r.error.message,
          service: "mercadolivre-rpa",
          stats: null,
          sessionStatus: "error",
          sessionId: "",
          sessionName: "",
          sessionLastCheckedAt: null as string | null,
        });
        return;
      }
      const payload: Record<string, unknown> = (r.data && typeof r.data === "object")
        ? (r.data as Record<string, unknown>)
        : {};

      const latestSession = await queryOne<{
        id: string;
        name: string;
        status: string;
        last_checked_at: string | null;
        error_message: string | null;
      }>(
        `SELECT id, name, status, last_checked_at, error_message
           FROM meli_sessions
          WHERE user_id = $1
          ORDER BY updated_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [userId],
      );

      const sessionId = latestSession?.id ? String(latestSession.id) : "";
      const sessionName = latestSession?.name ? String(latestSession.name) : "";
      let sessionStatus = normalizeMeliSessionHealthStatus(latestSession?.status || "not_found");
      let sessionLastCheckedAt = latestSession?.last_checked_at ? String(latestSession.last_checked_at) : null;
      let sessionError = latestSession?.error_message ? String(latestSession.error_message) : "";
      let sessionCheckedByHealth = false;

      if (sessionId && (sessionStatus === "active" || sessionStatus === "untested")) {
        const lastCheckedMs = sessionLastCheckedAt ? Date.parse(sessionLastCheckedAt) : NaN;
        const shouldRecheck = !Number.isFinite(lastCheckedMs) || (Date.now() - lastCheckedMs) >= MELI_HEALTH_SESSION_RECHECK_MS;
        if (shouldRecheck) {
          const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);
          const sessionCheck = await proxyMicroservice(
            MELI_URL,
            `/api/meli/sessions/${encodeURIComponent(scopedSessionId)}/test`,
            "POST",
            {},
            meliHeaders,
            25_000,
          );

          if (!sessionCheck.error) {
            let sessionPayload = (sessionCheck.data && typeof sessionCheck.data === "object")
              ? sessionCheck.data as Record<string, unknown>
              : {};
            let checkStatus = normalizeMeliSessionHealthStatus(sessionPayload.status);
            let checkLogs = Array.isArray(sessionPayload.logs) ? sessionPayload.logs : [];

            if (isMeliSessionNotFoundStatus(checkStatus)) {
              const restored = await rehydrateMeliSessionFileFromDatabase(userId, sessionId);
              if (restored.restored) {
                const retryCheck = await proxyMicroservice(
                  MELI_URL,
                  `/api/meli/sessions/${encodeURIComponent(scopedSessionId)}/test`,
                  "POST",
                  {},
                  meliHeaders,
                  25_000,
                );
                if (!retryCheck.error) {
                  sessionPayload = (retryCheck.data && typeof retryCheck.data === "object")
                    ? retryCheck.data as Record<string, unknown>
                    : {};
                  checkStatus = normalizeMeliSessionHealthStatus(sessionPayload.status);
                  checkLogs = Array.isArray(sessionPayload.logs) ? sessionPayload.logs : [];
                }
              }
            }

            const firstErrorLog = checkLogs.find((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return false;
              const lvl = String((item as { level?: unknown }).level || "").toLowerCase();
              return lvl === "error";
            });
            const checkError = checkStatus === "active"
              ? ""
              : String(
                sessionPayload.error
                || ((firstErrorLog && typeof firstErrorLog === "object")
                  ? (firstErrorLog as { message?: unknown }).message
                  : "")
                || meliSessionHealthStatusMessage(checkStatus),
              );
            const transientValidationFailure = isTransientMeliSessionValidationResult({
              status: checkStatus,
              errorMessage: checkError,
              logs: checkLogs,
            });

            if (!transientValidationFailure) {
              await execute(
                "UPDATE meli_sessions SET status=$1, last_checked_at=NOW(), error_message=$2, updated_at=NOW() WHERE id=$3 AND user_id=$4",
                [checkStatus, checkError, sessionId, userId],
              );
              sessionStatus = checkStatus;
              sessionLastCheckedAt = nowIso();
              sessionError = checkError;
              sessionCheckedByHealth = true;
            }
          } else if (!isTransientMicroserviceError(sessionCheck.error)) {
            const hardError = String(sessionCheck.error.message || "Falha ao validar sessao Mercado Livre");
            await execute(
              "UPDATE meli_sessions SET status='error', last_checked_at=NOW(), error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
              [hardError, sessionId, userId],
            );
            sessionStatus = "error";
            sessionLastCheckedAt = nowIso();
            sessionError = hardError;
            sessionCheckedByHealth = true;
          }
        }
      }

      const unhealthySessionStatuses = new Set(["expired", "error", "not_found", "no_affiliate"]);
      const hasSession = !!sessionId;
      const sessionHealthy = !hasSession || !unhealthySessionStatuses.has(sessionStatus);
      const serviceOnline = payload.ok === true || payload.online === true;
      const healthError = !serviceOnline
        ? (payload.error ? String(payload.error) : "Servico Mercado Livre indisponivel")
        : (sessionHealthy ? null : (sessionError || meliSessionHealthStatusMessage(sessionStatus)));

      ok(res, {
        online: serviceOnline && sessionHealthy,
        serviceOnline,
        url: MELI_URL,
        uptimeSec: null,
        error: healthError,
        service: String(payload.service || "mercadolivre-rpa"),
        stats: (payload.stats && typeof payload.stats === "object") ? payload.stats : null,
        sessionStatus,
        sessionId,
        sessionName,
        sessionLastCheckedAt,
        sessionCheckedByHealth,
      });
      return;
    }
    if (funcName === "amazon-service-health") {
      const tagRow = await queryOne<{ affiliate_tag: string }>(
        "SELECT affiliate_tag FROM amazon_affiliate_tags WHERE user_id = $1 LIMIT 1",
        [userId],
      );
      const tag = String(tagRow?.affiliate_tag ?? "").trim();
      const tagConfigured = Boolean(tag);

      if (!AMAZON_URL) {
        ok(res, {
          online: false,
          serviceOnline: false,
          tagConfigured,
          url: "",
          uptimeSec: null,
          error: "AMAZON_MICROSERVICE_URL não configurado.",
          service: "amazon-affiliate",
          stats: null,
        });
        return;
      }

      const upstream = await proxyMicroservice(AMAZON_URL, "/health", "GET", null, buildUserScopedHeaders(userId), 10_000);
      if (upstream.error) {
        ok(res, {
          online: false,
          serviceOnline: false,
          tagConfigured,
          url: AMAZON_URL,
          uptimeSec: null,
          error: upstream.error.message,
          service: "amazon-affiliate",
          stats: null,
        });
        return;
      }

      const payload = (upstream.data && typeof upstream.data === "object")
        ? upstream.data as Record<string, unknown>
        : {};
      const uptimeRaw = Number(payload.uptimeSec ?? payload.uptime);
      const serviceOnline = payload.ok === true || payload.online === true || payload.success === true;
      const healthError = !serviceOnline
        ? (payload.error ? String(payload.error) : "Servico Amazon indisponivel")
        : (tagConfigured ? null : "Tag de afiliado Amazon não configurada.");

      ok(res, {
        online: serviceOnline && tagConfigured,
        serviceOnline,
        tagConfigured,
        url: AMAZON_URL,
        uptimeSec: Number.isFinite(uptimeRaw) ? uptimeRaw : null,
        error: healthError,
        service: String(payload.service || "amazon-affiliate"),
        stats: (payload.stats && typeof payload.stats === "object") ? payload.stats : null,
      });
      return;
    }
    if (funcName === "meli-save-session") {
      if (!MELI_URL) { fail(res, "MeLi RPA não configurado."); return; }

      const sessionId = String(params.sessionId ?? "").trim();
      if (!sessionId) { fail(res, "sessionId é obrigatório"); return; }
      if (!isUuid(sessionId)) { fail(res, "sessionId inválido"); return; }
      if (params.cookies == null) { fail(res, "cookies é obrigatório"); return; }
      const cookiesPayload = normalizeMeliCookiesPayload(params.cookies);
      if (!cookiesPayload) { fail(res, "cookies inválido. Envie JSON válido."); return; }

      meliDiag(`[meli:save-session] ENTRY user=${userId} sessionId=${sessionId} cookiesPayloadType=${typeof cookiesPayload} cookiesPayloadKeys=${cookiesPayload && typeof cookiesPayload === "object" ? Object.keys(cookiesPayload as object).join(",") : "N/A"} rawCookiesType=${typeof params.cookies} rawCookiesLen=${String(params.cookies || "").length}`);

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

      meliDiag(`[meli:save-session] canonical=${canonicalSessionId} existingSessions=${userSessions.map(r => r.id).join(",")} stale=${staleSessionIds.join(",")}`);

      // Accept both "sessionName" (new clients/extension) and legacy "name" field.
      // "name" is used as the RPC selector and is stripped from params before this
      // handler runs, so clients that still send "name" as the session display name
      // will seamlessly fall through to "sessionName" here.
      const inputName = String(params.sessionName ?? params.name ?? "").trim();
      const previousName = String(canonicalSessionName || existingSession?.name || "").trim();
      const initialFallbackName = buildFriendlyMeliSessionName(canonicalSessionId, "");
      const initialName = inputName
        || (previousName && !isLegacyMeliAutoSessionName(previousName) ? previousName : "")
        || initialFallbackName;

      // Persist session metadata + cookies first so transient upstream failures do not
      // discard valid cookies and cause false "cookies not found" on the next test.
      await execute(
        `INSERT INTO meli_sessions (id, user_id, name, account_name, ml_user_id, status, last_checked_at, error_message)
         VALUES ($1,$2,$3,$4,$5,'untested',NOW(),'')
         ON CONFLICT (id) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             name = EXCLUDED.name,
             last_checked_at = EXCLUDED.last_checked_at,
             updated_at = NOW()`,
        [canonicalSessionId, userId, initialName, "", ""],
      );

      // Persist cookies to DB (dual-write: JSONB + encrypted backup).
      // Wrap in try/catch so that a transient DB failure does NOT prevent the RPA
      // proxy below from receiving and saving the cookies to its local disk.
      // The RPA diskfile is the primary runtime storage; the DB layers are
      // authoritative backups used only for rehydration when the RPA file is lost.
      let dbPersistOk = false;
      try {
        meliDiag(`[meli:save-session] BEFORE persistMeliSessionCookiesPayload canonical=${canonicalSessionId} user=${userId}`);
        await persistMeliSessionCookiesPayload(userId, canonicalSessionId, cookiesPayload);
        dbPersistOk = true;
        meliDiag(`[meli:save-session] AFTER persistMeliSessionCookiesPayload — persisted successfully`);
      } catch (persistError) {
        // Log but do NOT abort — the RPA must still receive the cookies.
        meliDiag(`[meli:save-session] persistMeliSessionCookiesPayload FAILED (non-fatal): ${String(persistError)}`);
      }

      const scopedSessionId = buildScopedMeliSessionId(userId, canonicalSessionId);
      const meliHeaders = { "x-autolinks-user-id": userId };
      const upstream = await proxyMicroservice(
        MELI_URL,
        "/api/meli/sessions",
        "POST",
        { sessionId: scopedSessionId, cookies: cookiesPayload },
        meliHeaders,
        45_000,
      );
      if (upstream.error) {
        await execute(
          "UPDATE meli_sessions SET status='error', last_checked_at=NOW(), error_message=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
          [upstream.error.message, canonicalSessionId, userId],
        );
        fail(res, upstream.error.message);
        return;
      }

      const upstreamData: Record<string, unknown> = (upstream.data && typeof upstream.data === "object")
        ? (upstream.data as Record<string, unknown>)
        : {};
      const rawStatus = String(upstreamData.status || "untested").trim().toLowerCase();
      const allowedStatuses = new Set(["active", "expired", "error", "untested", "not_found", "no_affiliate"]);
      const status = allowedStatuses.has(rawStatus) ? rawStatus : "error";
      const accountName = String(upstreamData.accountName || "");
      const mlUserId = String(upstreamData.mlUserId || "");
      const logs = Array.isArray(upstreamData.logs) ? upstreamData.logs : [];
      const fallbackName = buildFriendlyMeliSessionName(canonicalSessionId, accountName);
      const finalName = inputName
        || (previousName && !isLegacyMeliAutoSessionName(previousName) ? previousName : "")
        || fallbackName;
      const unknownStatusMessage = rawStatus && !allowedStatuses.has(rawStatus)
        ? `Status inválido retornado pelo servico Mercado Livre (${rawStatus})`
        : "";
      const errorMessage = status === "error"
        ? String((upstreamData as { error?: unknown }).error || unknownStatusMessage || "Falha ao salvar cookies")
        : "";

      await execute(
        "UPDATE meli_sessions SET name=$1, account_name=$2, ml_user_id=$3, status=$4, last_checked_at=NOW(), error_message=$5, updated_at=NOW() WHERE id=$6 AND user_id=$7",
        [finalName, accountName, mlUserId, status, errorMessage, canonicalSessionId, userId],
      );

      // Deferred retry: if the DB persist above failed but the RPA saved cookies
      // successfully, attempt DB persist again now that the network may have recovered.
      if (!dbPersistOk) {
        try {
          await persistMeliSessionCookiesPayload(userId, canonicalSessionId, cookiesPayload);
          console.info(`[meli:save-session] deferred DB persist SUCCEEDED for session=${canonicalSessionId}`);
        } catch (retryError) {
          console.error(`[meli:save-session] deferred DB persist also FAILED: ${String(retryError)}`);
        }
      }

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
      if (!sessionId) { fail(res, "sessionId é obrigatório"); return; }
      if (!isUuid(sessionId)) { fail(res, "sessionId inválido"); return; }

      const owned = await queryOne<{ id: string; name: string }>(
        "SELECT id, name FROM meli_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, userId],
      );
      if (!owned) { fail(res, "Sessão não encontrada"); return; }

      const scopedSessionId = buildScopedMeliSessionId(userId, sessionId);
      const meliHeaders = { "x-autolinks-user-id": userId };
      let upstream = await proxyMicroservice(
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

      let upstreamData: Record<string, unknown> = (upstream.data && typeof upstream.data === "object")
        ? (upstream.data as Record<string, unknown>)
        : {};
      let status = String(upstreamData.status || "error");
      let accountName = String(upstreamData.accountName || "");
      let mlUserId = String(upstreamData.mlUserId || "");
      let logs = Array.isArray(upstreamData.logs) ? upstreamData.logs : [];

      if (isMeliSessionNotFoundStatus(status)) {
        const restored = await rehydrateMeliSessionFileFromDatabase(userId, sessionId);
        if (restored.restored) {
          upstream = await proxyMicroservice(
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

          upstreamData = (upstream.data && typeof upstream.data === "object")
            ? (upstream.data as Record<string, unknown>)
            : {};
          status = String(upstreamData.status || "error");
          accountName = String(upstreamData.accountName || "");
          mlUserId = String(upstreamData.mlUserId || "");
          logs = Array.isArray(upstreamData.logs) ? upstreamData.logs : [];
        } else if (restored.reason && !String(upstreamData.error || "").trim()) {
          upstreamData.error = restored.reason;
        }
      }

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

      const currentName = String(owned.name || "").trim();
      const nextName = currentName && !isLegacyMeliAutoSessionName(currentName)
        ? currentName
        : buildFriendlyMeliSessionName(sessionId, accountName);

      await execute(
        "UPDATE meli_sessions SET status=$1, account_name=$2, ml_user_id=$3, last_checked_at=NOW(), error_message=$4, name=$7 WHERE id=$5 AND user_id=$6",
        [status, accountName, mlUserId, errorMessage, sessionId, userId, nextName],
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
      const canonicalSessionId = canonical?.id ? String(canonical.id).trim() : "";
      if (canonical && canonicalSessionId) {
        const canonicalName = String(canonical.name || "").trim();
        const canonicalAccountName = String(canonical.account_name || "").trim();
        if (!canonicalName || isLegacyMeliAutoSessionName(canonicalName)) {
          const upgradedName = buildFriendlyMeliSessionName(canonicalSessionId, canonicalAccountName);
          canonical.name = upgradedName;
          try {
            await execute(
              "UPDATE meli_sessions SET name = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3",
              [upgradedName, canonicalSessionId, userId],
            );
          } catch {
            // Non-fatal: use upgraded name in-memory for this response.
          }
        }
      }
      if (canonicalSessionId) {
        try {
          await maybeAlignMeliCookiesBackupOwner(userId, canonicalSessionId);
        } catch (error) {
          console.warn(`[meli] failed to realign backup pointer for user=${userId} session=${canonicalSessionId}: ${String(error)}`);
        }
      }
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
      if (!sessionId) { fail(res, "sessionId é obrigatório"); return; }
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
      await execute(
        "DELETE FROM api_credentials WHERE user_id = $1 AND provider = $2",
        [userId, MELI_SESSION_COOKIES_PROVIDER],
      );
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
      let upstream = await proxyMicroservice(
        MELI_URL,
        "/api/meli/convert",
        "POST",
        { productUrl, sessionId: scopedSessionId },
        meliHeaders,
        90_000,
      );
      if (upstream.error) { fail(res, upstream.error.message); return; }

      let payload: Record<string, unknown> = (upstream.data && typeof upstream.data === "object")
        ? (upstream.data as Record<string, unknown>)
        : {};
      if (payload.success !== true && isMeliSessionFileMissingSignal(payload.error)) {
        const restored = await rehydrateMeliSessionFileFromDatabase(userId, sessionId);
        if (restored.restored) {
          upstream = await proxyMicroservice(
            MELI_URL,
            "/api/meli/convert",
            "POST",
            { productUrl, sessionId: scopedSessionId },
            meliHeaders,
            90_000,
          );
          if (upstream.error) { fail(res, upstream.error.message); return; }
          payload = (upstream.data && typeof upstream.data === "object")
            ? (upstream.data as Record<string, unknown>)
            : {};
        } else if (restored.reason && !String(payload.error || "").trim()) {
          payload.error = restored.reason;
        }
      }

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
      let upstream = await proxyMicroservice(
        MELI_URL,
        "/api/meli/convert/batch",
        "POST",
        { urls: dedupedUrls, sessionId: scopedSessionId },
        meliHeaders,
        120_000,
      );
      if (upstream.error) { fail(res, upstream.error.message); return; }

      let payload: Record<string, unknown> = (upstream.data && typeof upstream.data === "object")
        ? (upstream.data as Record<string, unknown>)
        : {};
      let rawResults = Array.isArray(payload.results) ? payload.results : [];

      const shouldRetryAfterRestore = rawResults.length > 0
        && rawResults.every((item) => {
          const row = (item && typeof item === "object") ? item as Record<string, unknown> : {};
          if (row.success === true) return false;
          return isMeliSessionFileMissingSignal(row.error);
        });

      if (shouldRetryAfterRestore) {
        const restored = await rehydrateMeliSessionFileFromDatabase(userId, sessionId);
        if (restored.restored) {
          upstream = await proxyMicroservice(
            MELI_URL,
            "/api/meli/convert/batch",
            "POST",
            { urls: dedupedUrls, sessionId: scopedSessionId },
            meliHeaders,
            120_000,
          );
          if (upstream.error) { fail(res, upstream.error.message); return; }
          payload = (upstream.data && typeof upstream.data === "object")
            ? (upstream.data as Record<string, unknown>)
            : {};
          rawResults = Array.isArray(payload.results) ? payload.results : [];
        }
      }

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
      if (!effectiveAdmin) { fail(res, "Acesso negado", 403); return; }
      const queues = await collectProcessQueueSnapshot();
      ok(res, { queues, timestamp: nowIso() }); return;
    }
    if (funcName === "ops-service-health") {
      if (!effectiveAdmin) { fail(res, "Acesso negado", 403); return; }
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
      if (!svc || !["whatsapp","telegram","shopee","meli","amazon","all"].includes(svc)) { fail(res, "Serviço inválido"); return; }
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
      if (!svc || !["whatsapp","telegram","shopee","meli","amazon"].includes(svc)) { fail(res, "Serviço inválido"); return; }
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
          runtime: {
            channelPolling: {
              lastStartedAt: channelPollRuntime.lastStartedAt,
              lastFinishedAt: channelPollRuntime.lastFinishedAt,
              lastDurationMs: channelPollRuntime.lastDurationMs,
              successCount: channelPollRuntime.successCount,
              failureCount: channelPollRuntime.failureCount,
              lastError: channelPollRuntime.lastError,
              lastResult: channelPollRuntime.lastResult ? { ...channelPollRuntime.lastResult } : null,
              errorsRecent: channelPollErrors.slice(-50).map((item) => ({ ...item })),
            },
            channelOrphanCleanup: {
              autoEnabled: CHANNEL_ORPHAN_SWEEP_AUTO_ENABLED,
              intervalMs: CHANNEL_ORPHAN_SWEEP_INTERVAL_MS,
              inFlight: Boolean(channelOrphanSweepInFlight),
              lastStartedAt: channelOrphanSweepRuntime.lastStartedAt,
              lastFinishedAt: channelOrphanSweepRuntime.lastFinishedAt,
              lastDurationMs: channelOrphanSweepRuntime.lastDurationMs,
              successCount: channelOrphanSweepRuntime.successCount,
              failureCount: channelOrphanSweepRuntime.failureCount,
              lastError: channelOrphanSweepRuntime.lastError,
              lastResult: channelOrphanSweepRuntime.lastResult ? { ...channelOrphanSweepRuntime.lastResult } : null,
            },
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
        // Bust cached app_runtime_flags for ALL users so maintenance state propagates immediately.
        bustGlobalTableCache("app_runtime_flags");
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
        const rows = await query("SELECT * FROM system_announcements ORDER BY created_at DESC LIMIT 100");
        // Scope metrics aggregation to only the fetched announcement IDs — avoids a full table
        // scan of user_notifications which grows unboundedly as announcements are delivered.
        const announcementIds = rows.map((r) => r.id);
        const metricsRows = announcementIds.length > 0
          ? await query(
            `SELECT announcement_id,
              COUNT(*) AS delivered,
              COUNT(*) FILTER (WHERE status='read') AS read_count,
              COUNT(*) FILTER (WHERE status='dismissed') AS dismissed_count
             FROM user_notifications WHERE announcement_id = ANY($1::uuid[]) GROUP BY announcement_id`,
            [announcementIds],
          )
          : [];
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
          // Double-quote identifiers - keys are hardcoded strings above, quoting prevents future injection
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

    // ── admin-wa-broadcast ───────────────────────────────────────────────────
    if (funcName === "admin-wa-broadcast") {
      if (!effectiveAdmin) { fail(res, "Acesso negado", 403); return; }
      const action = String(params.action ?? "");

      // ACTION: preview — list recipients matching filters
      if (action === "preview") {
        const filterPlan: string[] = Array.isArray(params.filterPlan) ? params.filterPlan.filter((p: unknown) => typeof p === "string") : [];
        const filterStatus = String(params.filterStatus ?? "all");
        const filterUserIds: string[] = Array.isArray(params.filterUserIds) ? params.filterUserIds.filter((u: unknown) => typeof u === "string") : [];

        const users = await listUsersWithMeta();
        const filtered = users.filter((u) => {
          if (["inactive", "blocked", "archived"].includes(u.account_status)) return false;
          if (u.role === "admin") return false;
          if (!u.phone) return false;
          if (filterUserIds.length > 0 && !filterUserIds.includes(u.user_id)) return false;
          if (filterPlan.length > 0 && !filterPlan.includes(u.plan_id)) return false;
          if (filterStatus === "active_plan") {
            if (u.plan_expires_at && Date.parse(u.plan_expires_at) <= Date.now()) return false;
          } else if (filterStatus === "expired_plan") {
            if (!u.plan_expires_at || Date.parse(u.plan_expires_at) > Date.now()) return false;
          }
          return true;
        });

        ok(res, {
          count: filtered.length,
          users: filtered.slice(0, 300).map((u) => ({
            user_id: u.user_id,
            name: u.name,
            email: u.email,
            phone: u.phone,
            plan_id: u.plan_id,
          })),
        });
        return;
      }

      // ACTION: send — send broadcast immediately
      if (action === "send") {
        const message = String(params.message ?? "").trim();
        const mediaParam = params.media as { base64?: string; mimeType?: string; fileName?: string } | null | undefined;
        const hasMedia = mediaParam && typeof mediaParam.base64 === "string" && mediaParam.base64.length > 0;
        if (!message && !hasMedia) { fail(res, "Mensagem ou mídia é obrigatória"); return; }

        const filterPlan: string[] = Array.isArray(params.filterPlan) ? params.filterPlan.filter((p: unknown) => typeof p === "string") : [];
        const filterStatus = String(params.filterStatus ?? "all");
        const filterUserIds: string[] = Array.isArray(params.filterUserIds) ? params.filterUserIds.filter((u: unknown) => typeof u === "string") : [];

        // Get admin's WA session
        const adminSession = await queryOne<{ id: string; status: string }>(
          "SELECT id, status FROM whatsapp_sessions WHERE user_id = $1 ORDER BY created_at LIMIT 1",
          [userId],
        );
        if (!adminSession) { fail(res, "Nenhuma sessão WhatsApp do admin encontrada"); return; }
        if (adminSession.status !== "online") { fail(res, "WhatsApp do admin não está online"); return; }

        // Resolve recipients
        const allUsers = await listUsersWithMeta();
        const recipients = allUsers.filter((u) => {
          if (["inactive", "blocked", "archived"].includes(u.account_status)) return false;
          if (u.role === "admin") return false;
          if (!u.phone) return false;
          if (filterUserIds.length > 0 && !filterUserIds.includes(u.user_id)) return false;
          if (filterPlan.length > 0 && !filterPlan.includes(u.plan_id)) return false;
          if (filterStatus === "active_plan") {
            if (u.plan_expires_at && Date.parse(u.plan_expires_at) <= Date.now()) return false;
          } else if (filterStatus === "expired_plan") {
            if (!u.plan_expires_at || Date.parse(u.plan_expires_at) > Date.now()) return false;
          }
          return true;
        });

        if (recipients.length === 0) { fail(res, "Nenhum destinatário encontrado com os filtros informados"); return; }

        // Create broadcast record
        const broadcastId = uuid();
        await execute(
          `INSERT INTO admin_wa_broadcasts (id, admin_user_id, message, filter_plan, filter_status, filter_user_ids, total_recipients, status, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', NOW())`,
          [broadcastId, userId, message, filterPlan, filterStatus, filterUserIds.length > 0 ? filterUserIds : [], recipients.length],
        );

        // Send messages with delay between each to avoid WhatsApp rate limits
        const outbound = message ? formatMessageForPlatform(message, "whatsapp") : "";
        const waHeaders = buildUserScopedHeaders(userId);
        let sentCount = 0;
        let failedCount = 0;
        const errors: Array<{ phone: string; error: string }> = [];

        for (let i = 0; i < recipients.length; i++) {
          const recipient = recipients[i];
          const phone = String(recipient.phone).replace(/\D/g, "");
          if (!phone) { failedCount++; errors.push({ phone: recipient.phone, error: "Telefone inválido" }); continue; }

          const jid = `${phone}@s.whatsapp.net`;
          const waBody: Record<string, unknown> = {
            sessionId: adminSession.id,
            jid,
            content: outbound,
          };
          if (hasMedia) {
            waBody.media = {
              kind: "image",
              base64: mediaParam!.base64,
              mimeType: normalizeSafeMediaMime(mediaParam!.mimeType),
              fileName: String(mediaParam!.fileName || "imagem.jpg"),
            };
          }
          try {
            const r = await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", waBody, waHeaders, 15_000);

            if (r.error) {
              failedCount++;
              errors.push({ phone, error: String(r.error.message || "Falha no envio") });
            } else {
              sentCount++;
            }
          } catch (e: unknown) {
            failedCount++;
            errors.push({ phone, error: e instanceof Error ? e.message : String(e) });
          }

          // Delay 1.5s between messages to avoid rate limiting
          if (i < recipients.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }

        const finalStatus = failedCount === 0 ? "sent" : sentCount === 0 ? "failed" : "partial";
        await execute(
          `UPDATE admin_wa_broadcasts SET status=$1, sent_count=$2, failed_count=$3, error_details=$4::jsonb, completed_at=NOW() WHERE id=$5`,
          [finalStatus, sentCount, failedCount, JSON.stringify(errors.slice(0, 50)), broadcastId],
        );

        await appendAudit("admin_wa_broadcast", userId, null, {
          broadcast_id: broadcastId,
          total: recipients.length,
          sent: sentCount,
          failed: failedCount,
        });

        ok(res, {
          broadcast_id: broadcastId,
          total: recipients.length,
          sent: sentCount,
          failed: failedCount,
          status: finalStatus,
        });
        return;
      }

      // ACTION: schedule — schedule broadcast for later
      if (action === "schedule") {
        const message = String(params.message ?? "").trim();
        if (!message) { fail(res, "Mensagem é obrigatória"); return; }
        const scheduledAt = String(params.scheduledAt ?? "").trim();
        if (!scheduledAt || !Date.parse(scheduledAt)) { fail(res, "Data de agendamento inválida"); return; }
        if (Date.parse(scheduledAt) <= Date.now()) { fail(res, "Data de agendamento deve ser no futuro"); return; }

        const filterPlan: string[] = Array.isArray(params.filterPlan) ? params.filterPlan.filter((p: unknown) => typeof p === "string") : [];
        const filterStatus = String(params.filterStatus ?? "all");
        const filterUserIds: string[] = Array.isArray(params.filterUserIds) ? params.filterUserIds.filter((u: unknown) => typeof u === "string") : [];

        // Preview count
        const allUsers2 = await listUsersWithMeta();
        const recipientCount = allUsers2.filter((u) => {
          if (["inactive", "blocked", "archived"].includes(u.account_status)) return false;
          if (u.role === "admin") return false;
          if (!u.phone) return false;
          if (filterUserIds.length > 0 && !filterUserIds.includes(u.user_id)) return false;
          if (filterPlan.length > 0 && !filterPlan.includes(u.plan_id)) return false;
          if (filterStatus === "active_plan") {
            if (u.plan_expires_at && Date.parse(u.plan_expires_at) <= Date.now()) return false;
          } else if (filterStatus === "expired_plan") {
            if (!u.plan_expires_at || Date.parse(u.plan_expires_at) > Date.now()) return false;
          }
          return true;
        }).length;

        const broadcastId = uuid();
        await execute(
          `INSERT INTO admin_wa_broadcasts (id, admin_user_id, message, filter_plan, filter_status, filter_user_ids, total_recipients, status, scheduled_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8)`,
          [broadcastId, userId, message, filterPlan, filterStatus, filterUserIds.length > 0 ? filterUserIds : [], recipientCount, scheduledAt],
        );

        await appendAudit("admin_wa_broadcast_scheduled", userId, null, { broadcast_id: broadcastId, scheduled_at: scheduledAt, recipients: recipientCount });

        ok(res, { broadcast_id: broadcastId, scheduled_at: scheduledAt, recipients: recipientCount });
        return;
      }

      // ACTION: cancel — cancel a scheduled broadcast
      if (action === "cancel") {
        const broadcastId = String(params.broadcastId ?? "").trim();
        if (!broadcastId) { fail(res, "ID do broadcast é obrigatório"); return; }
        const row = await queryOne<{ status: string }>("SELECT status FROM admin_wa_broadcasts WHERE id=$1 AND admin_user_id=$2", [broadcastId, userId]);
        if (!row) { fail(res, "Broadcast não encontrado"); return; }
        if (row.status !== "scheduled") { fail(res, "Apenas broadcasts agendados podem ser cancelados"); return; }
        await execute("UPDATE admin_wa_broadcasts SET status='cancelled', updated_at=NOW() WHERE id=$1", [broadcastId]);
        ok(res, { success: true });
        return;
      }

      // ACTION: list — list broadcast history
      if (action === "list") {
        const rows = await query(
          "SELECT * FROM admin_wa_broadcasts WHERE admin_user_id=$1 ORDER BY created_at DESC LIMIT 50",
          [userId],
        );
        ok(res, { broadcasts: rows });
        return;
      }

      // ACTION: dispatch_scheduled — process scheduled broadcasts (called by scheduler)
      if (action === "dispatch_scheduled") {
        const due = await query(
          `UPDATE admin_wa_broadcasts SET status='processing', started_at=NOW(), updated_at=NOW()
           WHERE id IN (
             SELECT id FROM admin_wa_broadcasts
             WHERE status='scheduled' AND scheduled_at <= NOW()
             ORDER BY scheduled_at LIMIT 5
             FOR UPDATE SKIP LOCKED
           ) RETURNING *`,
        );

        let dispatched = 0;
        for (const broadcast of due) {
          const bcastSession = await queryOne<{ id: string; status: string }>(
            "SELECT id, status FROM whatsapp_sessions WHERE user_id = $1 ORDER BY created_at LIMIT 1",
            [broadcast.admin_user_id],
          );
          if (!bcastSession || bcastSession.status !== "online") {
            await execute("UPDATE admin_wa_broadcasts SET status='failed', error_details=$1::jsonb, completed_at=NOW() WHERE id=$2", [JSON.stringify([{ phone: "", error: "WhatsApp do admin não está online" }]), broadcast.id]);
            continue;
          }

          const bcastUsers = await listUsersWithMeta();
          const bFilterPlan: string[] = Array.isArray(broadcast.filter_plan) ? broadcast.filter_plan : [];
          const bFilterStatus = String(broadcast.filter_status ?? "all");
          const bFilterUserIds: string[] = Array.isArray(broadcast.filter_user_ids) ? broadcast.filter_user_ids : [];

          const bRecipients = bcastUsers.filter((u) => {
            if (["inactive", "blocked", "archived"].includes(u.account_status)) return false;
            if (u.role === "admin") return false;
            if (!u.phone) return false;
            if (bFilterUserIds.length > 0 && !bFilterUserIds.includes(u.user_id)) return false;
            if (bFilterPlan.length > 0 && !bFilterPlan.includes(u.plan_id)) return false;
            if (bFilterStatus === "active_plan") {
              if (u.plan_expires_at && Date.parse(u.plan_expires_at) <= Date.now()) return false;
            } else if (bFilterStatus === "expired_plan") {
              if (!u.plan_expires_at || Date.parse(u.plan_expires_at) > Date.now()) return false;
            }
            return true;
          });

          const bOutbound = formatMessageForPlatform(String(broadcast.message), "whatsapp");
          const bWaHeaders = buildUserScopedHeaders(String(broadcast.admin_user_id));
          let bSentCount = 0;
          let bFailedCount = 0;
          const bErrors: Array<{ phone: string; error: string }> = [];

          for (let j = 0; j < bRecipients.length; j++) {
            const bRecipient = bRecipients[j];
            const bPhone = String(bRecipient.phone).replace(/\D/g, "");
            if (!bPhone) { bFailedCount++; bErrors.push({ phone: bRecipient.phone, error: "Telefone inválido" }); continue; }
            const bJid = `${bPhone}@s.whatsapp.net`;
            try {
              const br = await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", {
                sessionId: bcastSession.id,
                jid: bJid,
                content: bOutbound,
              }, bWaHeaders, 15_000);
              if (br.error) { bFailedCount++; bErrors.push({ phone: bPhone, error: String(br.error.message || "Falha") }); }
              else { bSentCount++; }
            } catch (e: unknown) {
              bFailedCount++;
              bErrors.push({ phone: bPhone, error: e instanceof Error ? e.message : String(e) });
            }
            // Delay between messages
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }

          const bFinalStatus = bFailedCount === 0 ? "sent" : bSentCount === 0 ? "failed" : "partial";
          await execute(
            `UPDATE admin_wa_broadcasts SET status=$1, sent_count=$2, failed_count=$3, total_recipients=$4, error_details=$5::jsonb, completed_at=NOW() WHERE id=$6`,
            [bFinalStatus, bSentCount, bFailedCount, bRecipients.length, JSON.stringify(bErrors.slice(0, 50)), broadcast.id],
          );
          dispatched++;
        }

        ok(res, { dispatched, checked: due.length });
        return;
      }

      fail(res, "Ação de broadcast inválida");
      return;
    }

    // â”€â”€ admin-users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    
    // ── admin-message-automations ────────────────────────────────────────────
    if (funcName === "admin-message-automations") {
      if (!effectiveAdmin) { fail(res, "Acesso negado", 403); return; }
      const action = String(params.action ?? "");

      if (action === "list") {
        const rows = await query(
          "SELECT * FROM admin_message_automations WHERE admin_user_id=$1 ORDER BY created_at DESC LIMIT 200",
          [userId],
        );
        ok(res, { automations: rows });
        return;
      }

      if (action === "create") {
        const name = String(params.name ?? "").trim();
        const description = String(params.description ?? "").trim();
        const triggerType = String(params.trigger_type ?? "").trim();
        const validTriggers = ["plan_expiring","plan_expired","signup_welcome","remarketing"];
        if (!name) { fail(res, "Nome é obrigatório"); return; }
        if (triggerType === "cron") { fail(res, "Gatilho cron ainda não está disponível"); return; }
        if (!validTriggers.includes(triggerType)) { fail(res, "Tipo de gatilho inválido"); return; }
        const messageTemplate = String(params.message_template ?? "").trim();
        if (!messageTemplate) { fail(res, "Mensagem é obrigatória"); return; }
        const triggerConfig = (params.trigger_config && typeof params.trigger_config === "object" && !Array.isArray(params.trigger_config))
          ? params.trigger_config as Record<string, unknown> : {};
        const filterPlan: string[] = Array.isArray(params.filter_plan) ? params.filter_plan.filter((p: unknown) => typeof p === "string") : [];
        const autoId = uuid();
        await execute(
          `INSERT INTO admin_message_automations (id, admin_user_id, name, description, trigger_type, trigger_config, message_template, filter_plan)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
          [autoId, userId, name, description, triggerType, JSON.stringify(triggerConfig), messageTemplate, filterPlan],
        );
        await appendAudit("create_message_automation", userId, null, { automation_id: autoId, trigger_type: triggerType });
        ok(res, { automation_id: autoId });
        return;
      }

      if (action === "update") {
        const autoId = String(params.automation_id ?? "").trim();
        if (!autoId) { fail(res, "ID da automação é obrigatório"); return; }
        const existing = await queryOne("SELECT id FROM admin_message_automations WHERE id=$1 AND admin_user_id=$2", [autoId, userId]);
        if (!existing) { fail(res, "Automação não encontrada"); return; }
        const name = String(params.name ?? "").trim();
        const description = String(params.description ?? "").trim();
        const triggerType = String(params.trigger_type ?? "").trim();
        const validTriggers2 = ["plan_expiring","plan_expired","signup_welcome","remarketing"];
        if (!name) { fail(res, "Nome é obrigatório"); return; }
        if (triggerType === "cron") { fail(res, "Gatilho cron ainda não está disponível"); return; }
        if (!validTriggers2.includes(triggerType)) { fail(res, "Tipo de gatilho inválido"); return; }
        const messageTemplate = String(params.message_template ?? "").trim();
        if (!messageTemplate) { fail(res, "Mensagem é obrigatória"); return; }
        const triggerConfig = (params.trigger_config && typeof params.trigger_config === "object" && !Array.isArray(params.trigger_config))
          ? params.trigger_config as Record<string, unknown> : {};
        const filterPlan: string[] = Array.isArray(params.filter_plan) ? params.filter_plan.filter((p: unknown) => typeof p === "string") : [];
        await execute(
          `UPDATE admin_message_automations SET name=$1, description=$2, trigger_type=$3, trigger_config=$4::jsonb, message_template=$5, filter_plan=$6, updated_at=NOW() WHERE id=$7`,
          [name, description, triggerType, JSON.stringify(triggerConfig), messageTemplate, filterPlan, autoId],
        );
        await appendAudit("update_message_automation", userId, null, { automation_id: autoId });
        ok(res, { success: true });
        return;
      }

      if (action === "toggle") {
        const autoId = String(params.automation_id ?? "").trim();
        if (!autoId) { fail(res, "ID da automação é obrigatório"); return; }
        const row = await queryOne<{ is_active: boolean }>("SELECT is_active FROM admin_message_automations WHERE id=$1 AND admin_user_id=$2", [autoId, userId]);
        if (!row) { fail(res, "Automação não encontrada"); return; }
        const newActive = !row.is_active;
        await execute("UPDATE admin_message_automations SET is_active=$1, updated_at=NOW() WHERE id=$2", [newActive, autoId]);
        ok(res, { is_active: newActive });
        return;
      }

      if (action === "delete") {
        const autoId = String(params.automation_id ?? "").trim();
        if (!autoId) { fail(res, "ID da automação é obrigatório"); return; }
        const rowDel = await queryOne("SELECT id FROM admin_message_automations WHERE id=$1 AND admin_user_id=$2", [autoId, userId]);
        if (!rowDel) { fail(res, "Automação não encontrada"); return; }
        await execute("DELETE FROM admin_message_automations WHERE id=$1", [autoId]);
        await appendAudit("delete_message_automation", userId, null, { automation_id: autoId });
        ok(res, { success: true });
        return;
      }

      if (action === "preview") {
        const triggerType = String(params.trigger_type ?? "").trim();
        if (triggerType === "cron") { fail(res, "Gatilho cron ainda não está disponível"); return; }
        const allowedPreviewTriggers = new Set(["plan_expiring", "plan_expired", "signup_welcome", "remarketing"]);
        if (!allowedPreviewTriggers.has(triggerType)) { fail(res, "Tipo de gatilho inválido"); return; }
        const triggerConfig = (params.trigger_config && typeof params.trigger_config === "object" && !Array.isArray(params.trigger_config))
          ? params.trigger_config as Record<string, unknown> : {};
        const filterPlan: string[] = Array.isArray(params.filter_plan) ? params.filter_plan.filter((p: unknown) => typeof p === "string") : [];
        const allUsers = await listUsersWithMeta();
        const nowMs = Date.now();
        const matched = allUsers.filter((u) => {
          if (["inactive","blocked","archived"].includes(u.account_status)) return false;
          if (u.role === "admin") return false;
          if (!u.phone) return false;
          if (filterPlan.length > 0 && !filterPlan.includes(u.plan_id)) return false;
          const evaluation = matchAdminLifecycleEvent(triggerType as AdminLifecycleTriggerType, triggerConfig, u, nowMs);
          return evaluation.matched;
        });
        ok(res, { count: matched.length });
        return;
      }

      if (action === "run_now") {
        const autoId = String(params.automation_id ?? "").trim();
        if (!autoId) { fail(res, "ID da automação é obrigatório"); return; }
        const auto = await queryOne<{
          id: string; name: string; trigger_type: string; trigger_config: Record<string, unknown>;
          message_template: string; filter_plan: string[]; admin_user_id: string;
        }>("SELECT * FROM admin_message_automations WHERE id=$1 AND admin_user_id=$2", [autoId, userId]);
        if (!auto) { fail(res, "Automação não encontrada"); return; }
        if (auto.trigger_type === "cron") { fail(res, "Gatilho cron ainda não está disponível"); return; }

        const adminSession2 = await queryOne<{ id: string; status: string }>(
          "SELECT id, status FROM whatsapp_sessions WHERE user_id = $1 ORDER BY created_at LIMIT 1",
          [userId],
        );
        if (!adminSession2) { fail(res, "Nenhuma sessão WhatsApp do admin encontrada"); return; }
        if (adminSession2.status !== "online") { fail(res, "WhatsApp do admin não está online"); return; }

        const allUsersRun = await listUsersWithMeta();
        const runFilterPlan: string[] = Array.isArray(auto.filter_plan) ? auto.filter_plan : [];
        const runTriggerConfig = typeof auto.trigger_config === "object" && auto.trigger_config ? auto.trigger_config as Record<string, unknown> : {};
        const runNowMs = Date.now();
        const runTriggerType = String(auto.trigger_type) as AdminLifecycleTriggerType;

        const recipientsRun = allUsersRun.filter((u) => {
          if (["inactive","blocked","archived"].includes(u.account_status)) return false;
          if (u.role === "admin") return false;
          if (!u.phone) return false;
          if (runFilterPlan.length > 0 && !runFilterPlan.includes(u.plan_id)) return false;
          const evaluation = matchAdminLifecycleEvent(runTriggerType, runTriggerConfig, u, runNowMs);
          return evaluation.matched;
        });

        if (recipientsRun.length === 0) { ok(res, { sent: 0, failed: 0, total: 0 }); return; }

        const outbound2 = formatMessageForPlatform(auto.message_template, "whatsapp");
        const waHeaders2 = buildUserScopedHeaders(userId);
        let sentCount2 = 0; let failedCount2 = 0;

        for (let i = 0; i < recipientsRun.length; i++) {
          const r = recipientsRun[i];
          const phone = String(r.phone).replace(/\D/g, "");
          if (!phone) { failedCount2++; continue; }
          try {
            const result2 = await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", {
              sessionId: adminSession2.id, jid: `${phone}@s.whatsapp.net`, content: outbound2,
            }, waHeaders2, 15_000);
            if (result2.error) failedCount2++; else sentCount2++;
          } catch { failedCount2++; }
          if (i < recipientsRun.length - 1) await new Promise((resolve) => setTimeout(resolve, 1500));
        }

        await execute(
          `UPDATE admin_message_automations SET last_run_at=NOW(), run_count=run_count+1, last_run_sent=$1, last_run_failed=$2, updated_at=NOW() WHERE id=$3`,
          [sentCount2, failedCount2, autoId],
        );
        await appendAudit("run_message_automation", userId, null, { automation_id: autoId, sent: sentCount2, failed: failedCount2 });
        ok(res, { sent: sentCount2, failed: failedCount2, total: recipientsRun.length });
        return;
      }

      if (action === "dispatch_automations") {
        if (!isService) { fail(res, "Ação reservada ao agendador", 403); return; }
        const allAutos = await query("SELECT * FROM admin_message_automations WHERE is_active=TRUE");
        const allUsers = await listUsersWithMeta();
        const allowedDispatchTriggers = new Set<AdminLifecycleTriggerType>(["plan_expiring", "plan_expired", "signup_welcome", "remarketing"]);
        const scheduleDateIso = new Date().toISOString().slice(0, 10);
        let totalDispatched = 0;
        let totalSent = 0;
        let totalFailed = 0;
        let totalSkipped = 0;

        for (const autoItem of allAutos) {
          if (String(autoItem.trigger_type) === "cron") continue;

          const autoId = String(autoItem.id || "").trim();
          const adminUserId = String(autoItem.admin_user_id || "").trim();
          const triggerTypeRaw = String(autoItem.trigger_type || "").trim();
          if (!autoId || !adminUserId || !allowedDispatchTriggers.has(triggerTypeRaw as AdminLifecycleTriggerType)) {
            continue;
          }

          const aSession = await queryOne<{ id: string; status: string }>(
            "SELECT id, status FROM whatsapp_sessions WHERE user_id = $1 ORDER BY created_at LIMIT 1",
            [adminUserId],
          );
          if (!aSession || aSession.status !== "online") continue;

          const aFilterPlan: string[] = Array.isArray(autoItem.filter_plan) ? autoItem.filter_plan : [];
          const aTriggerConfig = typeof autoItem.trigger_config === "object" && autoItem.trigger_config
            ? autoItem.trigger_config as Record<string, unknown>
            : {};
          const dispNowMs = Date.now();
          const aTriggerType = triggerTypeRaw as AdminLifecycleTriggerType;

          const aRecipients = allUsers.flatMap((u) => {
            if (["inactive", "blocked", "archived"].includes(u.account_status)) return [];
            if (u.role === "admin") return [];
            if (!u.phone) return [];
            if (aFilterPlan.length > 0 && !aFilterPlan.includes(u.plan_id)) return [];
            const evaluation = matchAdminLifecycleEvent(aTriggerType, aTriggerConfig, u, dispNowMs);
            if (!evaluation.matched) return [];
            return [{ user: u, eventKey: evaluation.eventKey }];
          });

          if (aRecipients.length === 0) continue;

          const aOutbound = formatMessageForPlatform(String(autoItem.message_template), "whatsapp");
          const aHeaders = buildUserScopedHeaders(adminUserId);
          let aSent = 0;
          let aFailed = 0;
          let aSkipped = 0;

          for (let i = 0; i < aRecipients.length; i++) {
            const recipient = aRecipients[i];
            const phone = String(recipient.user.phone).replace(/\D/g, "");
            if (!phone) { aFailed++; continue; }

            const dispatchId = uuid();
            const reserve = await execute(
              `INSERT INTO admin_message_event_dispatches
                 (id, automation_id, admin_user_id, recipient_user_id, event_key, schedule_date, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'reserved')
               ON CONFLICT (automation_id, recipient_user_id, event_key, schedule_date) DO NOTHING`,
              [dispatchId, autoId, adminUserId, String(recipient.user.id), recipient.eventKey, scheduleDateIso],
            );
            if ((reserve.rowCount || 0) <= 0) {
              aSkipped++;
              continue;
            }

            try {
              const r2 = await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", {
                sessionId: aSession.id,
                jid: `${phone}@s.whatsapp.net`,
                content: aOutbound,
              }, aHeaders, 15_000);

              if (r2.error) {
                aFailed++;
                await execute(
                  "UPDATE admin_message_event_dispatches SET status='failed', error_message=$1, updated_at=NOW() WHERE id=$2",
                  [String(r2.error.message || "Falha no envio"), dispatchId],
                );
              } else {
                aSent++;
                await execute(
                  "UPDATE admin_message_event_dispatches SET status='sent', sent_at=NOW(), error_message='', updated_at=NOW() WHERE id=$1",
                  [dispatchId],
                );
              }
            } catch (error: unknown) {
              aFailed++;
              await execute(
                "UPDATE admin_message_event_dispatches SET status='failed', error_message=$1, updated_at=NOW() WHERE id=$2",
                [error instanceof Error ? error.message : String(error), dispatchId],
              );
            }

            if (i < aRecipients.length - 1) await new Promise((resolve) => setTimeout(resolve, 1500));
          }

          await execute(
            `UPDATE admin_message_automations SET last_run_at=NOW(), run_count=run_count+1, last_run_sent=$1, last_run_failed=$2, updated_at=NOW() WHERE id=$3`,
            [aSent, aFailed, autoId],
          );

          if (aSent > 0 || aFailed > 0 || aSkipped > 0) {
            totalDispatched++;
          }
          totalSent += aSent;
          totalFailed += aFailed;
          totalSkipped += aSkipped;
        }

        ok(res, { dispatched: totalDispatched, sent: totalSent, failed: totalFailed, skipped: totalSkipped });
        return;
      }

      fail(res, "Ação de automação inválida");
      return;
    }
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
        await setManualPlanOverride(tid, "admin_update_plan");
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
        // Wrap role change + token invalidation in a transaction - DELETE without INSERT leaves user roleless
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
          // Invalidate all active tokens for the target user - JWT embeds role, so old tokens
          // would otherwise remain valid with the previous role until natural expiry.
          await client.query("UPDATE users SET token_invalidated_before = NOW() WHERE id = $1", [tid]);
        });
        await setAutoPlanSync(tid, role === "admin" ? "role_promoted_to_admin" : "role_demoted_to_user");
        await appendAudit("set_role", userId, tid, {
          role,
          plan_id: role === "admin" ? ADMIN_PANEL_PLAN_ID : nextUserPlan,
        });
        ok(res, { success: true }); return;
      }
      if (action === "set_name") {
        const tid = String(params.user_id ?? ""); const name = String(params.name ?? "").trim();
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; } if (!name) { fail(res, "Nomé obrigatório"); return; }
        await execute("UPDATE users SET metadata = metadata || $1::jsonb, updated_at=NOW() WHERE id=$2", [JSON.stringify({ name }), tid]);
        await execute("UPDATE profiles SET name=$1, updated_at=NOW() WHERE user_id=$2", [name, tid]);
        await appendAudit("set_name", userId, tid, { name });
        ok(res, { success: true }); return;
      }
      if (action === "set_status") {
        const tid = String(params.user_id ?? ""); const status = String(params.account_status ?? "active");
        if (!["active","inactive","blocked","archived"].includes(status)) { fail(res, "Status inválido"); return; }
        if (tid === userId && status !== "active") { fail(res, "Não é permitido alterar o próprio status"); return; }
        const setInv = status !== "active" ? ", token_invalidated_before = NOW()" : "";
        await execute(`UPDATE users SET metadata = metadata || $1::jsonb${setInv}, updated_at=NOW() WHERE id=$2`, [JSON.stringify({ account_status: status, status_updated_at: nowIso() }), tid]);
        await appendAudit("set_status", userId, tid, { account_status: status });
        ok(res, { success: true }); return;
      }
      if (action === "archive_user") {
        const tid = String(params.user_id ?? ""); if (tid === userId) { fail(res, "Não é permitido arquivar o próprio usuário"); return; }
        await execute("UPDATE users SET metadata = metadata || $1::jsonb, token_invalidated_before = NOW(), updated_at=NOW() WHERE id=$2", [JSON.stringify({ account_status: "archived", archived_at: nowIso(), status_updated_at: nowIso() }), tid]);
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
        const target = await queryOne("SELECT u.email, COALESCE(r.role, 'user') AS role FROM users u LEFT JOIN user_roles r ON r.user_id=u.id WHERE u.id=$1", [tid]);
        if (!target) { fail(res, "Usuário não encontrado"); return; }
        if (String(target.role ?? "user") === "admin") {
          const adminCountRow = await queryOne<{ total: string | number }>(
            "SELECT COUNT(*)::int AS total FROM user_roles WHERE role='admin'",
          );
          const adminCount = Number(adminCountRow?.total ?? 0);
          if (adminCount <= 1) { fail(res, "Não é permitido remover o último administrador do sistema"); return; }
        }
        const deletedEmail = `deleted+${tid}@autolinks.local`;
        await transaction(async (client) => {
          await client.query(
            "UPDATE users SET email=$1, metadata = metadata || $2::jsonb, token_invalidated_before=NOW(), updated_at=NOW() WHERE id=$3",
            [
              deletedEmail,
              JSON.stringify({
                account_status: "archived",
                deleted_at: nowIso(),
                deleted_by: userId,
                status_updated_at: nowIso(),
              }),
              tid,
            ],
          );
          await client.query(
            "UPDATE profiles SET email=$1, phone='', name='Usuário removido', updated_at=NOW() WHERE user_id=$2",
            [deletedEmail, tid],
          );
          await client.query("DELETE FROM user_roles WHERE user_id=$1", [tid]);
        });
        await appendAudit("delete_user", userId, tid, {
          deleted_user_id: tid,
          email: target.email ?? null,
          mode: "soft_delete",
        });
        ok(res, { success: true }); return;
      }
      if (action === "create_user") {
        const email = normalizeEmail(params.email); const password = String(params.password ?? "");
        const name = String(params.name ?? "Usuário").trim() || "Usuário"; const role = String(params.role ?? "user") === "admin" ? "admin" : "user";
        const phone = sanitizePhone(String(params.phone ?? ""));
        const requestedPlanId = String(params.plan_id ?? "").trim();
        const planId = role === "admin"
          ? ADMIN_PANEL_PLAN_ID
          : (requestedPlanId && validPlanIds.has(requestedPlanId) ? requestedPlanId : fallbackPlan);
        const createPasswordError = getPasswordPolicyError(password);
        const disposableEmailError = getDisposableEmailError(email);
        if (!email || !isValidEmail(email) || createPasswordError) { fail(res, createPasswordError ? `Senha inválida: ${createPasswordError}` : "Informe email válido"); return; }
        if (disposableEmailError) { fail(res, disposableEmailError, 400); return; }
        const exists = await queryOne("SELECT id FROM users WHERE email=$1", [email]);
        if (exists) { fail(res, "Email já cadastrado"); return; }
        if (phone) {
          const duplicatedPhone = await queryOne("SELECT user_id FROM profiles WHERE phone=$1 LIMIT 1", [phone]);
          if (duplicatedPhone) { fail(res, IDENTITY_ALREADY_USED_MESSAGE, 409); return; }
        }
        const hash = await bcrypt.hash(password, BCRYPT_COST);
        const newId = uuid();
        // Wrap 3 INSERTs in a transaction - if any fails, roll back to avoid orphan user/role/profile
        try {
          await transaction(async (client) => {
            await client.query("INSERT INTO users (id, email, password_hash, metadata, email_confirmed_at) VALUES ($1,$2,$3,$4,NOW())", [newId, email, hash, JSON.stringify({ name, account_status: "active", status_updated_at: nowIso() })]);
            await client.query("INSERT INTO user_roles (id, user_id, role) VALUES ($1,$2,$3)", [uuid(), newId, role]);
            await client.query(
              "INSERT INTO profiles (id, user_id, name, email, plan_id, plan_expires_at, phone) VALUES ($1,$2,$3,$4,$5,$6,$7)",
              [uuid(), newId, name, email, planId, role === "admin" ? null : planExpiresAt(cp, planId), phone],
            );
          });
        } catch (createUserError) {
          if (isUniqueViolation(createUserError)) { fail(res, IDENTITY_ALREADY_USED_MESSAGE, 409); return; }
          throw createUserError;
        }
        await appendAudit("create_user", userId, newId, { email, role, plan_id: planId });
        ok(res, {
          success: true,
          created_user: {
            id: newId,
            user_id: newId,
            name,
            email,
            phone,
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
        const phoneProvided = params.phone !== undefined;
        const phone = phoneProvided ? sanitizePhone(String(params.phone ?? "")) : "";
        if (phoneProvided) {
          const rawPhone = String(params.phone ?? "").trim();
          if (rawPhone && !phone) { fail(res, "Telefone inválido. Use formato com DDD, ex: +5511912345678"); return; }
          if (phone) {
            const duplicatePhone = await queryOne("SELECT user_id FROM profiles WHERE phone=$1 AND user_id<>$2 LIMIT 1", [phone, tid]);
            if (duplicatePhone) { fail(res, IDENTITY_ALREADY_USED_MESSAGE, 409); return; }
          }
        }
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

        try {
          await transaction(async (client) => {
            if (emailProvided) {
              await client.query("UPDATE users SET email=$1, updated_at=NOW() WHERE id=$2", [email, tid]);
              await client.query("UPDATE profiles SET email=$1, updated_at=NOW() WHERE user_id=$2", [email, tid]);
            }
            if (phoneProvided) {
              await client.query("UPDATE profiles SET phone=$1, updated_at=NOW() WHERE user_id=$2", [phone, tid]);
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
            await client.query("UPDATE users SET token_invalidated_before = NOW(), updated_at=NOW() WHERE id=$1", [tid]);
          });
        } catch (updateUserError) {
          if (isUniqueViolation(updateUserError)) { fail(res, IDENTITY_ALREADY_USED_MESSAGE, 409); return; }
          throw updateUserError;
        }
        if (role !== "admin") {
          await setManualPlanOverride(tid, "admin_update_user");
        } else {
          await setAutoPlanSync(tid, "admin_role_without_plan");
        }
        await appendAudit("update_user", userId, tid, {
          name: name || undefined,
          email: emailProvided ? email : undefined,
          phone: phoneProvided ? phone : undefined,
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
        await setManualPlanOverride(tid, "admin_extend_plan");
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
        await setManualPlanOverride(tid, "admin_set_plan_expiry");
        await appendAudit("set_plan_expiry", userId, tid, { plan_expires_at: expiresAt });
        ok(res, { success: true, plan_expires_at: expiresAt }); return;
      }
      if (action === "set_plan_sync_mode") {
        const tid = String(params.user_id ?? "").trim();
        const mode = String(params.mode ?? "auto").trim() === "manual_override" ? "manual_override" : "auto";
        const reason = String(params.reason ?? "").trim();
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; }
        const roleRow = await queryOne("SELECT role FROM user_roles WHERE user_id=$1", [tid]);
        if (String(roleRow?.role ?? "user") === "admin") { fail(res, "Admins não usam sincronização de plano."); return; }
        if (mode === "manual_override") {
          await setManualPlanOverride(tid, reason || "admin_set_plan_sync_mode_manual");
        } else {
          await setAutoPlanSync(tid, reason || "admin_set_plan_sync_mode_auto");
        }
        await appendAudit("set_plan_sync_mode", userId, tid, { mode, reason: reason || undefined });
        ok(res, { success: true, plan_sync_mode: mode }); return;
      }
      if (action === "impersonate_user") {
        const tid = String(params.user_id ?? "").trim();
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; }
        if (tid === userId) { fail(res, "Não é permitido entrar como o próprio usuário"); return; }

        const target = await queryOne<{
          id: string;
          email: string | null;
          role: string;
          account_status: string | null;
        }>(
          `SELECT u.id,
                  u.email,
                  COALESCE(r.role, 'user') AS role,
                  COALESCE(NULLIF(u.metadata->>'account_status', ''), 'active') AS account_status
             FROM users u
             LEFT JOIN user_roles r ON r.user_id = u.id
            WHERE u.id = $1`,
          [tid],
        );
        if (!target) { fail(res, "Usuário alvo não encontrado"); return; }

        const targetRole = String(target.role ?? "user") === "admin" ? "admin" : "user";
        if (targetRole === "admin") { fail(res, "Não é permitido entrar como outra conta admin"); return; }

        const targetStatus = String(target.account_status ?? "active").trim().toLowerCase();
        if (targetStatus === "blocked" || targetStatus === "archived") {
          fail(res, "Não é permitido entrar como usuário bloqueado ou arquivado");
          return;
        }

        const targetEmail = String(target.email ?? "").trim().toLowerCase();
        if (!targetEmail) { fail(res, "Email do usuário alvo não encontrado"); return; }

        const impersonationToken = signToken({ sub: target.id, email: targetEmail, role: targetRole });
        setSessionCookie(res, impersonationToken);

        await appendAudit("impersonate_user", userId, tid, {
          target_user_id: tid,
          target_role: targetRole,
          target_status: targetStatus || "active",
          initiated_via: "admin_users",
        });

        ok(res, {
          ok: true,
          redirect_url: "/dashboard",
        });
        return;
      }
      if (action === "reset_password") {
        const tid = String(params.user_id ?? ""); const pwd = String(params.password ?? "").trim();
        const resetPasswordError = getPasswordPolicyError(pwd);
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; } if (resetPasswordError) { fail(res, resetPasswordError); return; }
        const hash = await bcrypt.hash(pwd, BCRYPT_COST);
        // Invalidate all existing tokens immediately - the account must be secured after password reset
        await execute("UPDATE users SET password_hash=$1, token_invalidated_before=NOW(), updated_at=NOW() WHERE id=$2", [hash, tid]);
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
      if (action === "send_whatsapp_contact") {
        const tid = String(params.user_id ?? "");
        const phone = String(params.phone ?? "").trim();
        const message = String(params.message ?? "").trim();
        const mediaParam = params.media as { base64?: string; mimeType?: string; fileName?: string } | null | undefined;
        const hasMedia = mediaParam && typeof mediaParam.base64 === "string" && mediaParam.base64.length > 0;
        if (!tid) { fail(res, "Usuário alvo obrigatório"); return; }
        if (!phone) { fail(res, "Telefone do usuário obrigatório"); return; }
        if (!message && !hasMedia) { fail(res, "Mensagem ou mídia é obrigatória"); return; }

        // Get admin WA session
        const adminWaSession = await queryOne<{ id: string; status: string }>(
          "SELECT id, status FROM whatsapp_sessions WHERE user_id = $1 ORDER BY created_at LIMIT 1",
          [userId],
        );
        if (!adminWaSession) { fail(res, "Nenhuma sessão WhatsApp do admin encontrada. Configure seu WhatsApp na aba de Conexão."); return; }
        if (adminWaSession.status !== "online") { fail(res, "WhatsApp do admin não está online. Conecte-se primeiro na aba de Conexão."); return; }

        const cleanPhone = phone.replace(/\D/g, "");
        if (!cleanPhone) { fail(res, "Número de telefone inválido"); return; }
        const jid = `${cleanPhone}@s.whatsapp.net`;
        const outbound = message ? formatMessageForPlatform(message, "whatsapp") : "";
        const waHeaders = buildUserScopedHeaders(userId);

        const waBody: Record<string, unknown> = {
          sessionId: adminWaSession.id,
          jid,
          content: outbound,
        };
        if (hasMedia) {
          waBody.media = {
            kind: "image",
            base64: mediaParam!.base64,
            mimeType: normalizeSafeMediaMime(mediaParam!.mimeType),
            fileName: String(mediaParam!.fileName || "imagem.jpg"),
          };
        }

        const phoneLast4 = cleanPhone.slice(-4);
        console.log(`[rpc] admin send_whatsapp_contact user=${tid} phone_last4=${phoneLast4} hasMedia=${hasMedia} messageLength=${message.length}`);
        const waResult = await proxyMicroservice(WHATSAPP_URL, "/api/send-message", "POST", waBody, waHeaders, 15_000);

        if (waResult.error) {
          fail(res, `Falha ao enviar mensagem: ${String(waResult.error.message || waResult.error)}`); return;
        }

        await appendAudit("send_whatsapp_contact", userId, tid, {
          phone_last4: phoneLast4,
          message_length: message.length,
          hasMedia,
        });
        ok(res, { success: true }); return;
      }
      fail(res, "Ação administrativa inválida"); return;
    }

    // â”€â”€ account-plan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (funcName === "account-plan") {
      const action = String(params.action ?? "");
      if (userIsAdmin) { fail(res, "Conta admin não possui plano de assinatura."); return; }

      if (action === "change_plan") {
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

      if (action === "create_kiwify_checkout") {
        const targetPlanId = String(params.plan_id ?? "").trim();
        const periodType = normalizeBillingPeriodType(params.period_type);
        if (!targetPlanId) { fail(res, "plan_id obrigatório"); return; }
        if (!VALID_BILLING_PERIODS.has(periodType)) { fail(res, "period_type inválido"); return; }

        const cp = await loadControlPlane();
        const plans = Array.isArray(cp.plans) ? cp.plans : [];
        const targetPlan = plans.find((p) => String((p as { id?: unknown }).id) === targetPlanId) as Record<string, unknown> | undefined;
        if (!targetPlan || targetPlan.isActive !== true || targetPlan.visibleInAccount !== true) {
          fail(res, "Plano indisponível para assinatura."); return;
        }

        try {
          const checkout = await buildKiwifyCheckoutUrlForUser({
            userId,
            planId: targetPlanId,
            periodType,
            planFromControlPlane: targetPlan,
          });
          ok(res, {
            provider: "kiwify",
            period_type: periodType,
            source: checkout.source,
            checkout_url: checkout.checkoutUrl,
          });
          return;
        } catch (error) {
          fail(res, error instanceof Error ? error.message : "Checkout Kiwify inválido.");
          return;
        }
      }

      fail(res, "Ação de conta inválida"); return;
    }

    // ── admin-kiwify ──────────────────────────────────────────────────────────
    if (funcName === "admin-kiwify") {
      if (!effectiveAdmin) { fail(res, "Acesso negado"); return; }
      const action = String(params.action ?? "");

      // ── Config ────────────────────────────────────────────────────────────
      if (action === "get_config") {
        const cfg = await loadKiwifyConfig();
        if (!cfg) { ok(res, { config: null }); return; }
        // Never send secrets to frontend — mask them
        ok(res, {
          config: {
            account_id: cfg.account_id,
            client_id_set: !!cfg.client_id,
            client_secret_set: !!cfg.client_secret,
            webhook_secret_set: !!cfg.webhook_secret,
            affiliate_enabled: cfg.affiliate_enabled,
            grace_period_days: cfg.grace_period_days,
          },
        });
        return;
      }

      if (action === "save_config") {
        const clientId = String(params.client_id ?? "").trim();
        const clientSecret = String(params.client_secret ?? "").trim();
        const accountId = String(params.account_id ?? "").trim();
        const webhookSecret = String(params.webhook_secret ?? "").trim();
        const affiliateEnabled = params.affiliate_enabled === true;
        const gracePeriodDays = Math.max(0, Math.min(30, Number(params.grace_period_days) || 3));

        // Blank credential fields = "keep existing value" (UI shows placeholder hint)
        // At minimum, account_id must be provided (not secret, just identifier)
        if (!accountId) {
          fail(res, "account_id é obrigatório"); return;
        }

        // Load existing config to preserve credentials when fields are left blank
        const existingCfg = await loadKiwifyConfig();
        if (!existingCfg && (!clientId || !clientSecret)) {
          fail(res, "Na primeira configuração, client_id e client_secret são obrigatórios"); return;
        }
        const effectiveWebhookSecret = webhookSecret || (existingCfg?.webhook_secret ?? "");
        if (!effectiveWebhookSecret) {
          fail(res, "webhook_secret é obrigatório para processar eventos da Kiwify"); return;
        }

        await saveKiwifyConfig({
          client_id: clientId || (existingCfg?.client_id ?? ""),
          client_secret: clientSecret || (existingCfg?.client_secret ?? ""),
          account_id: accountId,
          webhook_secret: effectiveWebhookSecret,
          affiliate_enabled: affiliateEnabled,
          grace_period_days: gracePeriodDays,
        });
        await appendAudit("kiwify_config_save", userId, null, { account_id: accountId });
        ok(res, { success: true }); return;
      }

      if (action === "test_connection") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        try {
          const details = await kiwifyGetAccountDetails(cfg);
          ok(res, { success: true, account: details }); return;
        } catch (e) {
          fail(res, `Falha na conexão: ${e instanceof Error ? e.message : e}`); return;
        }
      }

      // ── Products (from Kiwify API) ────────────────────────────────────────
      if (action === "list_products") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const page = Math.max(1, Number(params.page) || 1);
        const result = await kiwifyListProducts(cfg, page);
        ok(res, result); return;
      }

      // ── Plan mappings ─────────────────────────────────────────────────────
      if (action === "list_mappings") {
        const mappings = await loadPlanMappings();
        ok(res, { mappings }); return;
      }

      if (action === "save_mapping") {
        const planId = String(params.plan_id ?? "").trim();
        if (!planId) { fail(res, "plan_id obrigatório"); return; }
        const periodType = String(params.period_type ?? "monthly").trim();
        const validPeriods = ["monthly", "quarterly", "semiannual", "annual"];
        if (!validPeriods.includes(periodType)) { fail(res, "period_type inválido"); return; }
        await savePlanMapping({
          plan_id: planId,
          period_type: periodType,
          kiwify_product_id: String(params.kiwify_product_id ?? "").trim(),
          kiwify_product_name: String(params.kiwify_product_name ?? "").trim(),
          kiwify_checkout_url: String(params.kiwify_checkout_url ?? "").trim(),
          affiliate_enabled: params.affiliate_enabled === true,
          affiliate_commission_percent: Math.max(0, Math.min(100, Number(params.affiliate_commission_percent) || 0)),
          is_active: params.is_active !== false,
        });
        await appendAudit("kiwify_mapping_save", userId, null, { plan_id: planId, period_type: periodType });
        ok(res, { success: true }); return;
      }

      if (action === "delete_mapping") {
        const planId = String(params.plan_id ?? "").trim();
        if (!planId) { fail(res, "plan_id obrigatório"); return; }
        const periodType = params.period_type ? String(params.period_type).trim() : undefined;
        await deletePlanMapping(planId, periodType);
        await appendAudit("kiwify_mapping_delete", userId, null, { plan_id: planId, period_type: periodType ?? "all" });
        ok(res, { success: true }); return;
      }

      // ── Transactions ──────────────────────────────────────────────────────
      if (action === "list_transactions") {
        const result = await listKiwifyTransactions(params);
        ok(res, result); return;
      }

      if (action === "link_transaction") {
        const txId = String(params.transaction_id ?? "").trim();
        const targetUserId = String(params.user_id ?? "").trim();
        if (!txId || !targetUserId) { fail(res, "transaction_id e user_id obrigatórios"); return; }
        const linked = await linkKiwifyTransactionToUser({ transactionId: txId, targetUserId });
        await appendAudit("kiwify_link_transaction", userId, targetUserId, { transaction_id: txId, plan_id: linked.planId });
        ok(res, { success: true }); return;
      }

      if (action === "list_manual_overrides") {
        const result = await listManualOverrideUsers({
          page: params.page,
          limit: params.limit,
          search: params.search,
        });
        ok(res, result); return;
      }

      if (action === "resume_auto_sync_bulk") {
        const userIds = Array.isArray(params.user_ids) ? params.user_ids : [];
        if (userIds.length === 0) { fail(res, "user_ids obrigatório"); return; }
        const reason = String(params.reason ?? "").trim();
        const resumed = await resumeAutoSyncForUsers({ userIds, reason });
        await appendAudit("kiwify_resume_auto_sync_bulk", userId, null, {
          requested_count: userIds.length,
          updated_count: resumed.updated,
          reason: reason || undefined,
        });
        ok(res, { success: true, updated: resumed.updated }); return;
      }

      // ── Sales (from Kiwify API) ───────────────────────────────────────────
      if (action === "list_sales") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const startDate = String(params.start_date ?? "");
        const endDate = String(params.end_date ?? "");
        if (!startDate || !endDate) { fail(res, "start_date e end_date obrigatórios"); return; }
        const result = await kiwifyListSales(cfg, {
          start_date: startDate,
          end_date: endDate,
          status: params.status ? String(params.status) : undefined,
          product_id: params.product_id ? String(params.product_id) : undefined,
          affiliate_id: params.affiliate_id ? String(params.affiliate_id) : undefined,
          page_number: params.page ? Number(params.page) : undefined,
          page_size: params.page_size ? Number(params.page_size) : undefined,
          view_full_sale_details: params.view_full_sale_details === true,
        });
        ok(res, result); return;
      }

      if (action === "refund_sale") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const saleId = String(params.sale_id ?? "").trim();
        if (!saleId) { fail(res, "sale_id obrigatório"); return; }
        const pixKey = params.pix_key ? String(params.pix_key).trim() : undefined;
        const result = await kiwifyRefundSale(cfg, saleId, pixKey);
        await appendAudit("kiwify_refund", userId, null, { sale_id: saleId });
        ok(res, result); return;
      }

      // ── Affiliates (from Kiwify API) ──────────────────────────────────────
      if (action === "list_affiliates") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const result = await kiwifyListAffiliates(cfg, {
          status: params.status ? String(params.status) : undefined,
          product_id: params.product_id ? String(params.product_id) : undefined,
          search: params.search ? String(params.search) : undefined,
          page_number: params.page ? Number(params.page) : undefined,
        });
        const normalized = (Array.isArray(result?.data) ? result.data : []).map((row) => {
          return {
            id: String(row.affiliate_id ?? ""),
            name: String(row.name ?? ""),
            email: String(row.email ?? ""),
            status: String(row.status ?? ""),
            commission_percent: Number(row.commission ?? 0),
            sales_count: 0,
            total_earned_cents: 0,
          };
        });
        ok(res, { data: normalized, pagination: result?.pagination ?? null }); return;
      }

      if (action === "get_affiliate") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const affId = String(params.affiliate_id ?? "").trim();
        if (!affId) { fail(res, "affiliate_id obrigatório"); return; }
        const result = await kiwifyGetAffiliate(cfg, affId);
        ok(res, result); return;
      }

      if (action === "edit_affiliate") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const affId = String(params.affiliate_id ?? "").trim();
        if (!affId) { fail(res, "affiliate_id obrigatório"); return; }
        const data: { commission?: number; status?: "active" | "blocked" | "refused" } = {};
        if (params.commission != null) data.commission = Number(params.commission);
        if (params.status) data.status = String(params.status) as "active" | "blocked" | "refused";
        const result = await kiwifyEditAffiliate(cfg, affId, data);
        await appendAudit("kiwify_edit_affiliate", userId, null, { affiliate_id: affId, ...data });
        ok(res, result); return;
      }

      // ── Stats & Balance ───────────────────────────────────────────────────
      if (action === "get_stats") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const stats = await kiwifyGetStats(cfg, {
          product_id: params.product_id ? String(params.product_id) : undefined,
          start_date: params.start_date ? String(params.start_date) : undefined,
          end_date: params.end_date ? String(params.end_date) : undefined,
        });
        ok(res, { stats }); return;
      }

      if (action === "get_balance") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const balance = await kiwifyGetBalance(cfg);
        ok(res, { balance }); return;
      }

      // ── Webhook management ────────────────────────────────────────────────
      if (action === "list_webhooks") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const result = await kiwifyListWebhooks(cfg);
        ok(res, result); return;
      }

      if (action === "setup_webhook") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const webhookUrl = String(params.webhook_url ?? "").trim();
        if (!webhookUrl) { fail(res, "webhook_url obrigatório"); return; }
        const webhookName = String(params.webhook_name || "AutoLinks Webhook").trim();
        const result = await kiwifyCreateWebhook(cfg, {
          name: webhookName,
          url: webhookUrl,
          products: "all",
          triggers: [...KIWIFY_WEBHOOK_TRIGGERS],
          token: cfg.webhook_secret,
        });
        await appendAudit("kiwify_webhook_setup", userId, null, { webhook_url: webhookUrl });
        ok(res, result); return;
      }

      if (action === "delete_webhook") {
        const cfg = await loadKiwifyConfig();
        if (!cfg || !cfg.client_id) { fail(res, "Kiwify não configurado"); return; }
        const whId = String(params.webhook_id ?? "").trim();
        if (!whId) { fail(res, "webhook_id obrigatório"); return; }
        await kiwifyDeleteWebhook(cfg, whId);
        await appendAudit("kiwify_webhook_delete", userId, null, { webhook_id: whId });
        ok(res, { success: true }); return;
      }

      // ── Webhook logs ──────────────────────────────────────────────────────
      if (action === "list_webhook_logs") {
        const page = Math.max(1, Number(params.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(params.limit) || 50));
        const offset = (page - 1) * limit;
        const rows = await query(
          `SELECT
             id,
             event_type,
             NULLIF(kiwify_order_id, '') AS order_id,
             processing_result AS status,
             NULLIF(error_message, '') AS error_message,
             created_at
           FROM kiwify_webhooks_log
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        const countRow = await queryOne("SELECT COUNT(*)::int AS total FROM kiwify_webhooks_log");
        ok(res, { logs: rows, total: countRow?.total ?? 0, page, limit }); return;
      }

      fail(res, "Ação Kiwify inválida"); return;
    }

    // ── kiwify-checkout-url (authenticated user fetches checkout URL for a plan) ─
    if (funcName === "kiwify-checkout-url") {
      const planId = String(params.plan_id ?? "").trim();
      const periodType = normalizeBillingPeriodType(params.period_type);
      if (!planId) { fail(res, "plan_id obrigatório"); return; }
      if (!VALID_BILLING_PERIODS.has(periodType)) { fail(res, "period_type inválido"); return; }

      const cp = await loadControlPlane();
      const plans = Array.isArray(cp.plans) ? cp.plans : [];
      const targetPlan = plans.find((p) => String((p as { id?: unknown }).id) === planId) as Record<string, unknown> | undefined;

      if (targetPlan && (targetPlan.isActive !== true || targetPlan.visibleInAccount !== true)) {
        fail(res, "Plano indisponível para assinatura.");
        return;
      }

      try {
        const checkout = await buildKiwifyCheckoutUrlForUser({
          userId,
          planId,
          periodType,
          planFromControlPlane: targetPlan ?? null,
        });
        ok(res, {
          period_type: periodType,
          source: checkout.source,
          checkout_url: checkout.checkoutUrl,
        });
      } catch (error) {
        fail(res, error instanceof Error ? error.message : "Checkout não disponível para este plano");
      }
      return;
    }

    fail(res, `Função não implementada: ${funcName}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[rpc] ${funcName} error:`, msg);
    res.status(500).json({ data: null, error: { message: msg } });
  }
});

// ── analytics RPC proxy ──────────────────────────────────────────────────
async function proxyAnalytics(
  req: Request,
  res: Response,
  path: string,
  method: string = "GET",
  body: unknown = null
): Promise<void> {
  if (!WHATSAPP_URL) {
    fail(res, "WHATSAPP_MICROSERVICE_URL não definido");
    return;
  }
  try {
    const headers: Record<string, string> = {
      "x-webhook-secret": WEBHOOK_SECRET,
    };
    const url = `${WHATSAPP_URL}${path}`;
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) {
      fail(res, data?.error || "Falha no serviço de analytics", response.status);
      return;
    }
    ok(res, data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(res, `Erro ao comunicar com serviço WhatsApp: ${msg}`, 502);
  }
}
