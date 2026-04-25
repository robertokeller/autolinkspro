import "dotenv/config";
import crypto from "node:crypto";
import process from "node:process";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import pino from "pino";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "3113");
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOW_INSECURE_NO_SECRET = process.env.ALLOW_INSECURE_NO_SECRET === "true";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const logger = pino({ level: LOG_LEVEL });
const app = express();

const rawCorsOrigin = process.env.CORS_ORIGIN ?? "";
const corsOriginList = rawCorsOrigin.split(",").map((s) => s.trim()).filter(Boolean);

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server / non-browser requests (no Origin header).
    if (!origin) { callback(null, true); return; }
    // When an explicit allowlist is configured, enforce it.
    if (corsOriginList.length > 0) {
      callback(null, corsOriginList.includes(origin));
      return;
    }
    // Fail-closed by default: only allow localhost origins when no CORS_ORIGIN is set.
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    callback(null, isLocalhost);
  },
}));
app.use(express.json({ limit: "2mb" }));

// ─── Security headers ────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  next();
});

// Rate limiting (in-memory, per IP)
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_REQUESTS = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_SHOPEE_BATCH_QUERIES = 20;
const MAX_URL_LENGTH = 2048;
const REPORT_MAX_PAGES = Math.max(
  1,
  Math.min(50, Number.parseInt(String(process.env.SHOPEE_REPORT_MAX_PAGES || "5"), 10) || 5),
);
const REPORT_PAGE_LIMIT = Math.max(
  1,
  Math.min(200, Number.parseInt(String(process.env.SHOPEE_REPORT_PAGE_LIMIT || "50"), 10) || 50),
);
const REPORT_GRAPHQL_MAX_RANGE_DAYS = Math.max(
  1,
  Math.min(180, Number.parseInt(String(process.env.SHOPEE_REPORT_GRAPHQL_MAX_RANGE_DAYS || "93"), 10) || 93),
);
const REPORT_MAX_ROWS = Math.max(
  50,
  Math.min(5000, Number.parseInt(String(process.env.SHOPEE_REPORT_MAX_ROWS || "1500"), 10) || 1500),
);
const REPORT_CONVERSION_PATH = String(
  process.env.SHOPEE_REPORT_CONVERSION_PATH || "/open_api/list?type=conversion_report",
).trim();
const REPORT_VALIDATION_PATH = String(
  process.env.SHOPEE_REPORT_VALIDATION_PATH || "/open_api/list?type=validation_report",
).trim();
const REPORT_VALUE_FIELDS = String(
  process.env.SHOPEE_REPORT_VALUE_FIELDS
    || "commission,total_commission,commission_value,estimated_commission,valid_commission,settled_commission,commission_amount",
)
  .split(",")
  .map((field) => field.trim())
  .filter(Boolean);
const REPORT_TOTAL_FIELDS = String(
  process.env.SHOPEE_REPORT_TOTAL_FIELDS
    || "total_commission,commission_total,totalCommission,estimated_commission,settled_commission,valid_commission,total_valid_commission,total_estimated_commission,total_settled_commission,overall_commission,sum_commission",
)
  .split(",")
  .map((field) => field.trim())
  .filter(Boolean);

function normalizeFieldKey(input: unknown): string {
  return String(input || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const REPORT_VALUE_FIELD_KEYS = new Set(REPORT_VALUE_FIELDS.map((field) => normalizeFieldKey(field)));
const REPORT_ROW_HINT_KEYS = new Set([
  ...REPORT_VALUE_FIELD_KEYS,
  "orderid",
  "conversionid",
  "itemid",
  "productid",
  "shopid",
  "orderno",
  "itemname",
  "productname",
]);

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function rateLimitScopeKey(req: Request): string {
  const userId = String(req.header("x-autolinks-user-id") || "").trim().toLowerCase();
  if (userId && isUuid(userId)) return `user:${userId}`;
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  return `ip:${ip}`;
}

function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") {
    next();
    return;
  }
  const key = rateLimitScopeKey(req);
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_REQUESTS) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "Too Many Requests" });
    return;
  }
  next();
}

app.use(rateLimit);

// Evict expired entries every 5 minutes to prevent unbounded Map growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}, 5 * 60_000).unref();

const REGION_HOSTS: Record<string, string> = {
  my: "https://open-api.affiliate.shopee.com.my",
  sg: "https://open-api.affiliate.shopee.sg",
  ph: "https://open-api.affiliate.shopee.ph",
  th: "https://open-api.affiliate.shopee.co.th",
  vn: "https://open-api.affiliate.shopee.vn",
  id: "https://open-api.affiliate.shopee.co.id",
  tw: "https://open-api.affiliate.shopee.tw",
  br: "https://open-api.affiliate.shopee.com.br",
  mx: "https://open-api.affiliate.shopee.com.mx",
  pl: "https://open-api.affiliate.shopee.pl",
};

type ShopeeCredentials = {
  appId: string;
  secret: string;
  region: string;
};

type CommissionReportType = "conversion_report" | "validation_report";

type CommissionReportSummary = {
  success: true;
  type: CommissionReportType;
  startDate: string;
  endDate: string;
  totalCommission: number;
  currency: string;
  recordsCount: number;
  pagesScanned: number;
};

type ShopeeReportSource = "conversion" | "validated";

type ShopeeReportRow = {
  source: ShopeeReportSource;
  purchaseTime: number;
  clickTime: number;
  conversionId: string;
  orderId: string;
  orderStatus: string;
  buyerType: string;
  device: string;
  referrer: string;
  campaignType: string;
  campaignPartnerName: string;
  utmContent: string;
  shopId: string;
  shopName: string;
  itemId: string;
  itemName: string;
  qty: number;
  actualAmount: number;
  itemPrice: number;
  totalCommission: number;
  sellerCommission: number;
  shopeeCommission: number;
  netCommission: number;
  fraudStatus: string;
  displayItemStatus: string;
  itemNotes: string;
};

type ShopeeReportStatusPoint = {
  status: string;
  count: number;
};

type ShopeeReportShopPoint = {
  shopId: string;
  shopName: string;
  sales: number;
  totalCommission: number;
  items: number;
  orders: number;
};

type ShopeeReportDailyPoint = {
  date: string;
  sales: number;
  totalCommission: number;
  netCommission: number;
  orders: number;
  items: number;
};

type ShopeeReportSummary = {
  conversions: number;
  orders: number;
  items: number;
  totalSales: number;
  totalCommission: number;
  netCommission: number;
  sellerCommission: number;
  shopeeCommission: number;
  averageTicket: number;
  cancelledOrders: number;
  pendingOrders: number;
  completedOrders: number;
  unpaidOrders: number;
  fraudItems: number;
};

type ShopeeReportBlock = {
  summary: ShopeeReportSummary;
  rows: ShopeeReportRow[];
  daily: ShopeeReportDailyPoint[];
  statusBreakdown: ShopeeReportStatusPoint[];
  topShops: ShopeeReportShopPoint[];
  pagesScanned: number;
  rawConversions: number;
};

type ShopeeReportsResponse = {
  success: true;
  currency: string;
  period: {
    startDate: string;
    endDate: string;
    startTimestamp: number;
    endTimestamp: number;
  };
  conversion: ShopeeReportBlock;
  validated: ShopeeReportBlock;
};

type ShopeeReportFilters = {
  shopId?: number;
  orderStatus?: string;
  buyerType?: string;
  campaignType?: string;
  campaignPartnerName?: string;
};

type BatchQuery = {
  id?: string;
  params?: Record<string, unknown>;
};

type BatchQueryResult = {
  products: ReturnType<typeof mapNodeToProduct>[];
  hasMore: boolean;
  error?: string;
};

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeRegion(region: unknown): string {
  const parsed = String(region || "br").trim().toLowerCase();
  return REGION_HOSTS[parsed] ? parsed : "br";
}

function safeCompare(a: string, b: string): boolean {
  const key = Buffer.alloc(32);
  const ha = crypto.createHmac("sha256", key).update(a).digest();
  const hb = crypto.createHmac("sha256", key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const insecureSecretBypass = !WEBHOOK_SECRET && NODE_ENV !== "production" && ALLOW_INSECURE_NO_SECRET;

if (!WEBHOOK_SECRET && !insecureSecretBypass) {
  throw new Error("WEBHOOK_SECRET is required. To bypass only in development, set ALLOW_INSECURE_NO_SECRET=true.");
}

if (insecureSecretBypass) {
  console.warn("[shopee] WEBHOOK_SECRET not set - insecure development bypass is enabled via ALLOW_INSECURE_NO_SECRET=true.");
}
if (WEBHOOK_SECRET && WEBHOOK_SECRET.toLowerCase() === "change-me" && NODE_ENV === "production") {
  throw new Error("WEBHOOK_SECRET is set to the default placeholder 'change-me'. Set a strong secret before running in production.");
}
if (WEBHOOK_SECRET && WEBHOOK_SECRET.toLowerCase() === "change-me") {
  console.warn("[shopee] WEBHOOK_SECRET is set to the default placeholder 'change-me' \u2014 replace it with a strong secret.");
}
function requireWebhookSecret(req: Request, res: Response, next: NextFunction) {
  if (!WEBHOOK_SECRET) {
    if (insecureSecretBypass) {
      next();
      return;
    }
    res.status(403).json({ error: "Forbidden: WEBHOOK_SECRET not configured" });
    return;
  }

  const received = req.header("x-webhook-secret") || "";
  if (!safeCompare(received, WEBHOOK_SECRET)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}

function requireCredentials(payload: unknown): { ok: true; credentials: ShopeeCredentials } | { ok: false; error: string } {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const appId = String(body.appId || "").trim();
  const secret = String(body.secret || "").trim();
  const region = normalizeRegion(body.region);

  if (!appId || !secret) {
    return { ok: false, error: "Credenciais Shopee inválidas (appId/secret)." };
  }

  return {
    ok: true,
    credentials: {
      appId,
      secret,
      region,
    },
  };
}

function toNumber(input: unknown): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : 0;
}

function toStringValue(input: unknown): string {
  return typeof input === "string" ? input : String(input || "");
}

function toInt(input: unknown, fallback: number): number {
  const value = Number.parseInt(String(input), 10);
  return Number.isFinite(value) ? value : fallback;
}

function toShopeeSortType(sortBy: string): number {
  switch (sortBy) {
    case "relevancy":
      return 1;
    case "commission":
      return 2;
    case "discount":
      return 3;
    case "rating":
      return 4;
    case "sales":
      return 5;
    case "price_asc":
      return 6;
    case "price_desc":
      return 6;
    default:
      return 5;
  }
}

function buildBaseUrl(region: string): string {
  const host = REGION_HOSTS[region] || REGION_HOSTS.br;
  return `${host}/graphql`;
}

type ShopeeAuthHeaderMode = "spaced" | "compact" | "signatureFirst";

const SHOPEE_AUTH_HEADER_FALLBACK_MODES: ShopeeAuthHeaderMode[] = [
  "spaced",
  "compact",
  "signatureFirst",
];

function signAuthorization(
  appId: string,
  secret: string,
  payload: string,
  mode: ShopeeAuthHeaderMode = "spaced",
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const factor = `${appId}${timestamp}${payload}${secret}`;
  const signature = crypto.createHash("sha256").update(factor).digest("hex");
  if (mode === "compact") {
    return `SHA256 Credential=${appId},Timestamp=${timestamp},Signature=${signature}`;
  }
  if (mode === "signatureFirst") {
    return `SHA256 Credential=${appId}, Signature=${signature}, Timestamp=${timestamp}`;
  }
  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeCurrency(value: unknown): string {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (!/^[A-Z]{3,6}$/.test(raw)) return "";
  return raw;
}

function parseDecimalLike(input: unknown): number {
  if (typeof input === "number") return Number.isFinite(input) ? input : Number.NaN;

  const raw = String(input || "").trim();
  if (!raw) return Number.NaN;

  let normalized = raw
    .replace(/[R$\s]/gi, "")
    .replace(/[^0-9.,-]/g, "");
  if (!normalized) return Number.NaN;

  const commaPos = normalized.lastIndexOf(",");
  const dotPos = normalized.lastIndexOf(".");

  if (commaPos >= 0 && dotPos >= 0) {
    if (commaPos > dotPos) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (commaPos >= 0) {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeReportType(input: unknown): CommissionReportType | null {
  const value = String(input || "").trim().toLowerCase();
  if (value === "conversion_report") return "conversion_report";
  if (value === "validation_report") return "validation_report";
  return null;
}

function normalizeDateYmd(input: unknown): string | null {
  const value = String(input || "").trim();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return normalized;
}

function dateYmdDaysAgo(days: number): string {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  now.setUTCDate(now.getUTCDate() - Math.max(0, Math.trunc(days)));
  return now.toISOString().slice(0, 10);
}

const REPORT_ORDER_STATUS_VALUES = new Set(["UNPAID", "PENDING", "COMPLETED", "CANCELLED"]);
const REPORT_BUYER_TYPE_VALUES = new Set(["NEW", "EXISTING"]);
const REPORT_FILTER_TEXT_MAX_LENGTH = 120;

function normalizeReportTextFilter(input: unknown): string | undefined {
  const value = String(input || "").trim();
  if (!value) return undefined;
  if (value.length > REPORT_FILTER_TEXT_MAX_LENGTH) return value.slice(0, REPORT_FILTER_TEXT_MAX_LENGTH);
  return value;
}

function normalizeReportEnumFilter(
  input: unknown,
  allowed: Set<string>,
): string | undefined {
  const value = String(input || "").trim().toUpperCase();
  if (!value || value === "ALL") return undefined;
  return allowed.has(value) ? value : undefined;
}

function normalizeReportNumericFilter(input: unknown): number | undefined {
  const value = Number.parseInt(String(input || "").trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function normalizeReportFilters(input: unknown): ShopeeReportFilters {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const campaignTypeRaw = String(source.campaignType || "").trim();
  const campaignType = campaignTypeRaw && campaignTypeRaw.toUpperCase() !== "ALL"
    ? campaignTypeRaw.toUpperCase()
    : undefined;

  return {
    shopId: normalizeReportNumericFilter(source.shopId),
    orderStatus: normalizeReportEnumFilter(source.orderStatus, REPORT_ORDER_STATUS_VALUES),
    buyerType: normalizeReportEnumFilter(source.buyerType, REPORT_BUYER_TYPE_VALUES),
    campaignType,
    campaignPartnerName: normalizeReportTextFilter(source.campaignPartnerName),
  };
}

function resolveReportPath(type: CommissionReportType): string {
  return type === "validation_report" ? REPORT_VALIDATION_PATH : REPORT_CONVERSION_PATH;
}

function buildReportUrl(
  credentials: ShopeeCredentials,
  type: CommissionReportType,
  startDate: string,
  endDate: string,
  page: number,
  limit: number,
): string {
  const host = REGION_HOSTS[credentials.region] || REGION_HOSTS.br;
  const template = resolveReportPath(type);
  const rawUrl = /^https?:\/\//i.test(template)
    ? template
    : `${host}${template.startsWith("/") ? "" : "/"}${template}`;

  const resolved = rawUrl
    .replace(/\{type\}/g, encodeURIComponent(type))
    .replace(/\{startDate\}/g, encodeURIComponent(startDate))
    .replace(/\{endDate\}/g, encodeURIComponent(endDate))
    .replace(/\{page\}/g, encodeURIComponent(String(page)))
    .replace(/\{limit\}/g, encodeURIComponent(String(limit)));

  const parsed = new URL(resolved);
  if (!parsed.searchParams.has("type")) parsed.searchParams.set("type", type);
  if (!parsed.searchParams.has("start_date")) parsed.searchParams.set("start_date", startDate);
  if (!parsed.searchParams.has("end_date")) parsed.searchParams.set("end_date", endDate);
  if (!parsed.searchParams.has("page")) parsed.searchParams.set("page", String(page));
  if (!parsed.searchParams.has("limit")) parsed.searchParams.set("limit", String(limit));
  return parsed.toString();
}

function buildReportSignaturePayload(input: {
  type: CommissionReportType;
  startDate: string;
  endDate: string;
  page: number;
  limit: number;
}): string {
  return JSON.stringify({
    type: input.type,
    start_date: input.startDate,
    end_date: input.endDate,
    page: input.page,
    limit: input.limit,
  });
}

function findFirstObjectArray(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5 || value == null) return [];

  if (Array.isArray(value)) {
    const objectRows = value
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
    if (objectRows.length > 0) {
      const likelyRows = objectRows.filter((row) => isLikelyCommissionReportRow(row));
      if (likelyRows.length > 0) return likelyRows;
    }
    for (const row of value) {
      const nested = findFirstObjectArray(row, depth + 1);
      if (nested.length > 0) return nested;
    }
    return [];
  }

  const record = asRecord(value);
  if (!record) return [];

  const prioritizedKeys = ["items", "rows", "records", "list", "result", "data"];
  for (const key of prioritizedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const nested = findFirstObjectArray(record[key], depth + 1);
    if (nested.length > 0) return nested;
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findFirstObjectArray(nestedValue, depth + 1);
    if (nested.length > 0) return nested;
  }

  return [];
}

function isLikelyCommissionReportRow(row: Record<string, unknown>): boolean {
  const keys = Object.keys(row);
  if (keys.length === 0) return false;

  for (const key of keys) {
    const normalized = normalizeFieldKey(key);
    if (REPORT_ROW_HINT_KEYS.has(normalized)) return true;
    if (normalized.includes("commission") && !normalized.includes("rate")) return true;
  }

  return false;
}

function findNumberByKeys(value: unknown, keys: string[], depth = 0): number | null {
  if (depth > 5 || value == null) return null;
  const record = asRecord(value);
  if (!record) return null;

  const normalizedLookup = new Set(keys.map((key) => normalizeFieldKey(key)));
  let best: number | null = null;

  for (const [rawKey, rawValue] of Object.entries(record)) {
    if (!normalizedLookup.has(normalizeFieldKey(rawKey))) continue;
    const parsed = parseDecimalLike(rawValue);
    if (!Number.isFinite(parsed)) continue;
    const safeValue = Math.max(0, parsed);
    best = best === null ? safeValue : Math.max(best, safeValue);
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findNumberByKeys(nestedValue, keys, depth + 1);
    if (nested === null) continue;
    best = best === null ? nested : Math.max(best, nested);
  }

  return best;
}

function findCurrency(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return "";
  const record = asRecord(value);
  if (!record) return "";

  const direct = normalizeCurrency(record.currency)
    || normalizeCurrency(record.currency_code)
    || normalizeCurrency(record.currencyCode);
  if (direct) return direct;

  for (const nestedValue of Object.values(record)) {
    const nested = findCurrency(nestedValue, depth + 1);
    if (nested) return nested;
  }

  return "";
}

function extractRowCommissionValue(row: Record<string, unknown>, depth = 0): number {
  if (depth > 5) return 0;

  let directCommission = 0;
  for (const [rawKey, rawValue] of Object.entries(row)) {
    const normalizedKey = normalizeFieldKey(rawKey);
    const isValueField = REPORT_VALUE_FIELD_KEYS.has(normalizedKey)
      || (normalizedKey.includes("commission") && !normalizedKey.includes("rate"));
    if (!isValueField) continue;

    const parsed = parseDecimalLike(rawValue);
    if (!Number.isFinite(parsed)) continue;
    directCommission = Math.max(directCommission, Math.max(0, parsed));
  }
  if (directCommission > 0) return directCommission;

  let nestedCommission = 0;
  for (const nestedValue of Object.values(row)) {
    if (Array.isArray(nestedValue)) {
      for (const item of nestedValue) {
        const itemRecord = asRecord(item);
        if (!itemRecord) continue;
        nestedCommission += extractRowCommissionValue(itemRecord, depth + 1);
      }
      continue;
    }

    const nestedRecord = asRecord(nestedValue);
    if (!nestedRecord) continue;
    nestedCommission += extractRowCommissionValue(nestedRecord, depth + 1);
  }

  return nestedCommission;
}

function hasNextReportPage(
  payload: Record<string, unknown>,
  page: number,
  rowsCount: number,
  limit: number,
): boolean {
  const nextPage = toInt(payload.next_page ?? payload.nextPage, 0);
  if (nextPage > page) return true;

  const totalPages = toInt(payload.total_pages ?? payload.totalPages, 0);
  const currentPage = toInt(payload.current_page ?? payload.page, page);
  if (totalPages > 0 && currentPage < totalPages) return true;

  if (payload.has_more === true || payload.hasMore === true || payload.has_next === true || payload.hasNextPage === true) {
    return true;
  }

  const totalCount = toInt(payload.total_count ?? payload.totalCount, 0);
  if (totalCount > 0 && (page * limit) < totalCount) return true;

  return rowsCount >= limit;
}

async function callShopeeSignedGet(
  credentials: ShopeeCredentials,
  url: string,
  signaturePayload: string,
): Promise<Record<string, unknown>> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      let lastAuthError: unknown = null;
      for (let authModeIndex = 0; authModeIndex < SHOPEE_AUTH_HEADER_FALLBACK_MODES.length; authModeIndex += 1) {
        const authMode = SHOPEE_AUTH_HEADER_FALLBACK_MODES[authModeIndex];
        try {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: signAuthorization(credentials.appId, credentials.secret, signaturePayload, authMode),
            },
          });

          const text = await response.text().catch(() => "");
          if (/buyer\/login/i.test(response.url || "") || /buyer\/login/i.test(text)) {
            throw new Error("Shopee report endpoint returned login page. Configure valid report path and access.");
          }

          let parsed: Record<string, unknown> = {};
          if (text) {
            try {
              parsed = JSON.parse(text) as Record<string, unknown>;
            } catch {
              const compactSnippet = text
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 180);
              throw new Error(`Shopee report endpoint returned non-JSON response: ${compactSnippet}`);
            }
          }

          if (!response.ok) {
            const errText = parsed.error || parsed.message || parsed.msg
              || (parsed.code != null ? `error [${parsed.code}]` : null)
              || `Shopee report HTTP ${response.status}`;
            throw new Error(String(errText));
          }

          const rawCode = parsed.code ?? parsed.error_code ?? parsed.errcode;
          if (rawCode !== undefined && rawCode !== null && String(rawCode).trim() !== "") {
            const code = Number.parseInt(String(rawCode), 10);
            const hasNumericCode = Number.isFinite(code);
            const isSuccessCode = !hasNumericCode || code === 0 || code === 200;
            if (!isSuccessCode) {
              const businessMessage = String(
                parsed.message
                || parsed.msg
                || parsed.error
                || parsed.reason
                || `Shopee report error code ${code}`,
              ).trim();
              throw new Error(businessMessage || `Shopee report error code ${code}`);
            }
          }

          if (parsed.success === false) {
            const businessMessage = String(
              parsed.message
              || parsed.msg
              || parsed.error
              || parsed.reason
              || "Shopee report request failed",
            ).trim();
            throw new Error(businessMessage || "Shopee report request failed");
          }

          return parsed;
        } catch (error) {
          const shouldTryNextAuthHeader = (
            looksLikeShopeeAuthSignatureError(error)
            && authModeIndex < (SHOPEE_AUTH_HEADER_FALLBACK_MODES.length - 1)
          );
          if (!shouldTryNextAuthHeader) {
            throw error;
          }
          lastAuthError = error;
          logger.warn({
            authMode,
            nextAuthMode: SHOPEE_AUTH_HEADER_FALLBACK_MODES[authModeIndex + 1],
            error: sanitizeError(error),
          }, "retrying shopee signed GET with alternate auth header");
        }
      }

      if (lastAuthError) {
        throw lastAuthError;
      }
    } catch (error) {
      const canRetry = attempt < maxAttempts && isRetryableShopeeError(error);
      if (!canRetry) throw error;

      const backoffMs = 300 * attempt;
      logger.warn({ attempt, backoffMs, error: sanitizeError(error) }, "retrying shopee report request");
      await wait(backoffMs);
    }
  }

  throw new Error("Failed to fetch Shopee report.");
}

async function fetchCommissionReport(
  credentials: ShopeeCredentials,
  input: { type: CommissionReportType; startDate: string; endDate: string },
): Promise<CommissionReportSummary> {
  let page = 1;
  let pagesScanned = 0;
  let recordsCount = 0;
  let rowsTotalCommission = 0;
  let directTotalCommission: number | null = null;
  let currency = "BRL";

  while (page <= REPORT_MAX_PAGES) {
    const targetUrl = buildReportUrl(
      credentials,
      input.type,
      input.startDate,
      input.endDate,
      page,
      REPORT_PAGE_LIMIT,
    );

    const signaturePayload = buildReportSignaturePayload({
      type: input.type,
      startDate: input.startDate,
      endDate: input.endDate,
      page,
      limit: REPORT_PAGE_LIMIT,
    });

    const payload = await callShopeeSignedGet(credentials, targetUrl, signaturePayload);
    const innerPayload = asRecord(payload.data) ?? payload;

    const parsedCurrency = findCurrency(innerPayload) || findCurrency(payload);
    if (parsedCurrency) currency = parsedCurrency;

    const topLevelTotal = findNumberByKeys(innerPayload, REPORT_TOTAL_FIELDS)
      ?? findNumberByKeys(payload, REPORT_TOTAL_FIELDS);
    if (topLevelTotal !== null) {
      directTotalCommission = directTotalCommission === null
        ? topLevelTotal
        : Math.max(directTotalCommission, topLevelTotal);
    }

    const rows = findFirstObjectArray(innerPayload);
    if (rows.length > 0) {
      recordsCount += rows.length;
      for (const row of rows) {
        rowsTotalCommission += extractRowCommissionValue(row);
      }
    }

    pagesScanned += 1;
    const nextFromInner = hasNextReportPage(innerPayload, page, rows.length, REPORT_PAGE_LIMIT);
    const nextFromOuter = innerPayload === payload
      ? false
      : hasNextReportPage(payload, page, rows.length, REPORT_PAGE_LIMIT);
    if (!nextFromInner && !nextFromOuter) break;
    page += 1;
  }

  const totalCommission = Number(Math.max(0, directTotalCommission ?? 0, rowsTotalCommission).toFixed(2));

  return {
    success: true,
    type: input.type,
    startDate: input.startDate,
    endDate: input.endDate,
    totalCommission,
    currency,
    recordsCount,
    pagesScanned,
  };
}

const REGION_DEFAULT_CURRENCY: Record<string, string> = {
  br: "BRL",
  mx: "MXN",
  sg: "SGD",
  my: "MYR",
  ph: "PHP",
  th: "THB",
  vn: "VND",
  id: "IDR",
  tw: "TWD",
  pl: "PLN",
};

const CONVERSION_REPORT_GRAPHQL_QUERY = `
  query ConversionReport(
    $purchaseTimeStart: Int64
    $purchaseTimeEnd: Int64
    $shopId: Int64
    $campaignPartnerName: String
    $limit: Int
  ) {
    conversionReport(
      purchaseTimeStart: $purchaseTimeStart
      purchaseTimeEnd: $purchaseTimeEnd
      shopId: $shopId
      campaignPartnerName: $campaignPartnerName
      limit: $limit
    ) {
      nodes {
        purchaseTime
        clickTime
        conversionId
        conversionStatus
        buyerType
        device
        referrer
        totalCommission
        sellerCommission
        shopeeCommissionCapped
        netCommission
        utmContent
        orders {
          orderId
          orderStatus
          items {
            shopId
            shopName
            itemId
            itemName
            qty
            itemPrice
            actualAmount
            itemTotalCommission
            itemSellerCommission
            itemShopeeCommissionCapped
            campaignPartnerName
            campaignType
            fraudStatus
            displayItemStatus
            itemNotes
          }
        }
      }
      pageInfo {
        limit
        hasNextPage
        scrollId
      }
    }
  }
`;

const CONVERSION_REPORT_GRAPHQL_QUERY_PAGED = `
  query ConversionReportPaged(
    $purchaseTimeStart: Int64
    $purchaseTimeEnd: Int64
    $shopId: Int64
    $campaignPartnerName: String
    $limit: Int
    $scrollId: String
  ) {
    conversionReport(
      purchaseTimeStart: $purchaseTimeStart
      purchaseTimeEnd: $purchaseTimeEnd
      shopId: $shopId
      campaignPartnerName: $campaignPartnerName
      limit: $limit
      scrollId: $scrollId
    ) {
      nodes {
        purchaseTime
        clickTime
        conversionId
        conversionStatus
        buyerType
        device
        referrer
        totalCommission
        sellerCommission
        shopeeCommissionCapped
        netCommission
        utmContent
        orders {
          orderId
          orderStatus
          items {
            shopId
            shopName
            itemId
            itemName
            qty
            itemPrice
            actualAmount
            itemTotalCommission
            itemSellerCommission
            itemShopeeCommissionCapped
            campaignPartnerName
            campaignType
            fraudStatus
            displayItemStatus
            itemNotes
          }
        }
      }
      pageInfo {
        limit
        hasNextPage
        scrollId
      }
    }
  }
`;

const VALIDATED_REPORT_GRAPHQL_QUERY = `
  query ValidatedReport(
    $limit: Int
    $scrollId: String
  ) {
    validatedReport(
      limit: $limit
      scrollId: $scrollId
    ) {
      nodes {
        purchaseTime
        conversionId
        totalCommission
        orders {
          orderId
          orderStatus
          items {
            shopId
            shopName
            itemId
            itemName
            qty
            itemPrice
            actualAmount
            itemTotalCommission
            fraudStatus
            displayItemStatus
          }
        }
      }
      pageInfo {
        limit
        hasNextPage
        scrollId
      }
    }
  }
`;

function defaultCurrencyForRegion(region: string): string {
  return REGION_DEFAULT_CURRENCY[normalizeRegion(region)] || "BRL";
}

function toCurrencyAmount(input: unknown): number {
  const parsed = parseDecimalLike(input);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

function toUnixDayRange(startDate: string, endDate: string): { startTimestamp: number; endTimestamp: number } {
  const startTimestamp = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
  const endTimestamp = Math.floor(Date.parse(`${endDate}T23:59:59Z`) / 1000);
  return { startTimestamp, endTimestamp };
}

function inTimestampRange(value: number, startTimestamp: number, endTimestamp: number): boolean {
  return value >= startTimestamp && value <= endTimestamp;
}

function toReportId(input: unknown): string {
  const value = String(input || "").trim();
  return value;
}

function toReportTimestamp(input: unknown): number {
  const value = toInt(input, 0);
  return value > 0 ? value : 0;
}

function toReportDateKey(timestampSec: number): string {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return "unknown";
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function daysInRange(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function normalizeOrderStatus(status: unknown): string {
  const value = String(status || "").trim().toUpperCase();
  return value || "UNKNOWN";
}

function includesNormalizedText(target: string, search: string): boolean {
  const normalizedTarget = String(target || "").trim().toLowerCase();
  const normalizedSearch = String(search || "").trim().toLowerCase();
  if (!normalizedSearch) return true;
  return normalizedTarget.includes(normalizedSearch);
}

function matchesShopeeReportFilters(row: ShopeeReportRow, filters: ShopeeReportFilters): boolean {
  if (filters.orderStatus && row.orderStatus !== filters.orderStatus) return false;
  if (filters.buyerType && row.buyerType !== filters.buyerType) return false;
  if (filters.shopId && toReportId(filters.shopId) !== row.shopId) return false;
  if (filters.campaignType && row.campaignType !== filters.campaignType) return false;
  if (filters.campaignPartnerName && !includesNormalizedText(row.campaignPartnerName, filters.campaignPartnerName)) return false;
  return true;
}

async function fetchGraphqlReportNodes(
  credentials: ShopeeCredentials,
  source: ShopeeReportSource,
  period: { startTimestamp: number; endTimestamp: number },
  filters: ShopeeReportFilters,
): Promise<{ nodes: Record<string, unknown>[]; pagesScanned: number }> {
  let scrollId: string | null = null;
  let pagesScanned = 0;
  const nodes: Record<string, unknown>[] = [];

  while (pagesScanned < REPORT_MAX_PAGES) {
    const variables: Record<string, unknown> = {
      limit: REPORT_PAGE_LIMIT,
    };
    if (scrollId) {
      variables.scrollId = scrollId;
    }
    if (source === "conversion") {
      variables.purchaseTimeStart = String(period.startTimestamp);
      variables.purchaseTimeEnd = String(period.endTimestamp);
      if (filters.shopId) variables.shopId = String(filters.shopId);
      if (filters.campaignPartnerName) variables.campaignPartnerName = filters.campaignPartnerName;
    }

    const query = source === "conversion"
      ? (scrollId ? CONVERSION_REPORT_GRAPHQL_QUERY_PAGED : CONVERSION_REPORT_GRAPHQL_QUERY)
      : VALIDATED_REPORT_GRAPHQL_QUERY;
    const data = await callShopeeGraphql(credentials, query, variables);

    const reportConnection = asRecord(source === "conversion" ? data.conversionReport : data.validatedReport);
    const nodeListRaw = Array.isArray(reportConnection?.nodes) ? reportConnection?.nodes : [];
    const nodeList = nodeListRaw
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
    nodes.push(...nodeList);

    pagesScanned += 1;

    const pageInfo = asRecord(reportConnection?.pageInfo);
    const nextScrollId = String(pageInfo?.scrollId || "").trim();
    const hasNextPage = pageInfo?.hasNextPage === true && !!nextScrollId;
    if (!hasNextPage) break;

    if (source === "validated" && nodeList.length > 0) {
      // Validated report query does not expose purchaseTime filter.
      // Stop early when all current rows are older than selected start date.
      let maxTimestamp = 0;
      for (const node of nodeList) {
        const ts = toReportTimestamp(node.purchaseTime);
        if (ts > maxTimestamp) maxTimestamp = ts;
      }
      if (maxTimestamp > 0 && maxTimestamp < period.startTimestamp) break;
    }

    scrollId = nextScrollId;
  }

  return { nodes, pagesScanned };
}

function buildShopeeReportBlock(
  source: ShopeeReportSource,
  nodes: Record<string, unknown>[],
  pagesScanned: number,
  period: { startTimestamp: number; endTimestamp: number },
  filters: ShopeeReportFilters,
): ShopeeReportBlock {
  const rows: ShopeeReportRow[] = [];
  const uniqueConversions = new Set<string>();
  const uniqueOrders = new Set<string>();
  const statusBreakdownMap = new Map<string, number>();
  const shopMap = new Map<string, {
    shopId: string;
    shopName: string;
    sales: number;
    totalCommission: number;
    items: number;
    orderIds: Set<string>;
  }>();
  const dailyMap = new Map<string, {
    sales: number;
    totalCommission: number;
    netCommission: number;
    items: number;
    orderIds: Set<string>;
  }>();

  let totalSales = 0;
  let totalCommission = 0;
  let totalNetCommission = 0;
  let totalSellerCommission = 0;
  let totalShopeeCommission = 0;
  let totalItems = 0;
  let fraudItems = 0;

  for (const node of nodes) {
    const purchaseTime = toReportTimestamp(node.purchaseTime);
    if (!inTimestampRange(purchaseTime, period.startTimestamp, period.endTimestamp)) continue;

    const clickTime = toReportTimestamp(node.clickTime);
    const conversionId = toReportId(node.conversionId) || `fallback-${source}-${purchaseTime}-${rows.length}`;
    const conversionKey = `${source}:${conversionId}`;
    const conversionStatus = normalizeOrderStatus(node.conversionStatus || node.orderStatus);
    const conversionTotalCommission = toCurrencyAmount(node.totalCommission);
    const conversionSellerCommission = toCurrencyAmount(node.sellerCommission);
    const conversionShopeeCommission = toCurrencyAmount(node.shopeeCommissionCapped);
    const conversionNetCommission = toCurrencyAmount(node.netCommission);
    const buyerType = String(node.buyerType || "").trim().toUpperCase();
    const device = String(node.device || "").trim().toUpperCase();
    const referrer = String(node.referrer || "").trim();
    const campaignType = String(node.campaignType || "").trim().toUpperCase();
    const utmContent = String(node.utmContent || "").trim();
    const conversionDateKey = toReportDateKey(purchaseTime);
    let conversionHasIncludedRows = false;

    const ordersRaw = Array.isArray(node.orders) ? node.orders : [];
    const orders = ordersRaw
      .filter((order): order is Record<string, unknown> => !!order && typeof order === "object" && !Array.isArray(order));

    if (orders.length === 0) {
      const syntheticOrderId = "";
      const syntheticOrderStatus = conversionStatus;
      const syntheticRow: ShopeeReportRow = {
        source,
        purchaseTime,
        clickTime,
        conversionId,
        orderId: syntheticOrderId,
        orderStatus: syntheticOrderStatus,
        buyerType,
        device,
        referrer,
        campaignType,
        campaignPartnerName: String(node.campaignPartnerName || "").trim(),
        utmContent,
        shopId: "",
        shopName: "",
        itemId: "",
        itemName: `Conversao ${conversionId}`,
        qty: 1,
        actualAmount: 0,
        itemPrice: 0,
        totalCommission: conversionTotalCommission,
        sellerCommission: conversionSellerCommission,
        shopeeCommission: conversionShopeeCommission,
        netCommission: conversionNetCommission > 0 ? conversionNetCommission : conversionTotalCommission,
        fraudStatus: "",
        displayItemStatus: syntheticOrderStatus,
        itemNotes: "Resumo de conversao (sem itens detalhados na resposta da Shopee)",
      };

      if (matchesShopeeReportFilters(syntheticRow, filters)) {
        conversionHasIncludedRows = true;

        totalCommission += syntheticRow.totalCommission;
        totalNetCommission += syntheticRow.netCommission;
        totalSellerCommission += syntheticRow.sellerCommission;
        totalShopeeCommission += syntheticRow.shopeeCommission;
        totalItems += 1;
        rows.push(syntheticRow);

        const syntheticOrderKey = `${source}:${conversionId}:summary`;
        if (!uniqueOrders.has(syntheticOrderKey)) {
          uniqueOrders.add(syntheticOrderKey);
          statusBreakdownMap.set(syntheticOrderStatus, (statusBreakdownMap.get(syntheticOrderStatus) || 0) + 1);
        }

        const daily = dailyMap.get(conversionDateKey) || {
          sales: 0,
          totalCommission: 0,
          netCommission: 0,
          items: 0,
          orderIds: new Set<string>(),
        };
        daily.totalCommission += syntheticRow.totalCommission;
        daily.netCommission += syntheticRow.netCommission;
        daily.items += 1;
        daily.orderIds.add(syntheticOrderKey);
        dailyMap.set(conversionDateKey, daily);
      }
    }

    for (const order of orders) {
      const orderId = toReportId(order.orderId);
      const orderStatus = normalizeOrderStatus(order.orderStatus);
      const orderUniqueKey = `${source}:${conversionId}:${orderId || "unknown"}`;
      let orderHasIncludedItems = false;

      const itemsRaw = Array.isArray(order.items) ? order.items : [];
      const items = itemsRaw
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));

      for (const item of items) {
        const actualAmount = toCurrencyAmount(item.actualAmount);
        const itemPrice = toCurrencyAmount(item.itemPrice);
        const rowTotalCommission = toCurrencyAmount(item.itemTotalCommission);
        const rowSellerCommission = toCurrencyAmount(item.itemSellerCommission);
        const rowShopeeCommission = toCurrencyAmount(item.itemShopeeCommissionCapped);
        const rowNetCommission = rowTotalCommission > 0 ? rowTotalCommission : 0;
        const shopId = toReportId(item.shopId);
        const shopName = String(item.shopName || "").trim() || "Loja sem nome";
        const qty = Math.max(0, toInt(item.qty, 0));
        const fraudStatus = String(item.fraudStatus || "").trim().toUpperCase();
        const campaignPartnerName = String(item.campaignPartnerName || "").trim();
        const displayItemStatus = String(item.displayItemStatus || "").trim();
        const itemNotes = String(item.itemNotes || "").trim();
        const resolvedCampaignType = String(item.campaignType || campaignType || "").trim().toUpperCase();

        const row: ShopeeReportRow = {
          source,
          purchaseTime,
          clickTime,
          conversionId,
          orderId,
          orderStatus,
          buyerType,
          device,
          referrer,
          campaignType: resolvedCampaignType,
          campaignPartnerName,
          utmContent,
          shopId,
          shopName,
          itemId: toReportId(item.itemId),
          itemName: String(item.itemName || "").trim() || "Item sem nome",
          qty,
          actualAmount,
          itemPrice,
          totalCommission: rowTotalCommission,
          sellerCommission: rowSellerCommission,
          shopeeCommission: rowShopeeCommission,
          netCommission: rowNetCommission,
          fraudStatus,
          displayItemStatus,
          itemNotes,
        };

        if (!matchesShopeeReportFilters(row, filters)) continue;

        orderHasIncludedItems = true;
        conversionHasIncludedRows = true;

        totalSales += actualAmount;
        totalCommission += rowTotalCommission;
        totalNetCommission += rowNetCommission;
        totalSellerCommission += rowSellerCommission;
        totalShopeeCommission += rowShopeeCommission;
        totalItems += 1;
        if (fraudStatus === "FRAUD") fraudItems += 1;
        rows.push(row);

        const shopKey = `${shopId || "unknown"}:${shopName.toLowerCase()}`;
        const currentShop = shopMap.get(shopKey) || {
          shopId,
          shopName,
          sales: 0,
          totalCommission: 0,
          items: 0,
          orderIds: new Set<string>(),
        };
        currentShop.sales += actualAmount;
        currentShop.totalCommission += rowTotalCommission;
        currentShop.items += 1;
        if (orderId) currentShop.orderIds.add(orderUniqueKey);
        shopMap.set(shopKey, currentShop);

        const daily = dailyMap.get(conversionDateKey) || {
          sales: 0,
          totalCommission: 0,
          netCommission: 0,
          items: 0,
          orderIds: new Set<string>(),
        };
        daily.sales += actualAmount;
        daily.totalCommission += rowTotalCommission;
        daily.netCommission += rowNetCommission;
        daily.items += 1;
        if (orderId) daily.orderIds.add(orderUniqueKey);
        dailyMap.set(conversionDateKey, daily);
      }

      if (orderHasIncludedItems && orderId && !uniqueOrders.has(orderUniqueKey)) {
        uniqueOrders.add(orderUniqueKey);
        statusBreakdownMap.set(orderStatus, (statusBreakdownMap.get(orderStatus) || 0) + 1);
      }
    }

    if (conversionHasIncludedRows) {
      uniqueConversions.add(conversionKey);
    }
  }

  const statusBreakdown = Array.from(statusBreakdownMap.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const topShops = Array.from(shopMap.values())
    .map((entry) => ({
      shopId: entry.shopId,
      shopName: entry.shopName,
      sales: round2(entry.sales),
      totalCommission: round2(entry.totalCommission),
      items: entry.items,
      orders: entry.orderIds.size,
    }))
    .sort((a, b) => (
      b.totalCommission - a.totalCommission
      || b.sales - a.sales
      || b.items - a.items
    ))
    .slice(0, 10);

  const daily = Array.from(dailyMap.entries())
    .map(([date, point]) => ({
      date,
      sales: round2(point.sales),
      totalCommission: round2(point.totalCommission),
      netCommission: round2(point.netCommission),
      orders: point.orderIds.size,
      items: point.items,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sortedRows = rows
    .sort((a, b) => (
      b.purchaseTime - a.purchaseTime
      || b.actualAmount - a.actualAmount
      || b.totalCommission - a.totalCommission
    ))
    .slice(0, REPORT_MAX_ROWS);

  const totalOrders = uniqueOrders.size;
  const cancelledOrders = statusBreakdownMap.get("CANCELLED") || 0;
  const pendingOrders = statusBreakdownMap.get("PENDING") || 0;
  const completedOrders = statusBreakdownMap.get("COMPLETED") || 0;
  const unpaidOrders = statusBreakdownMap.get("UNPAID") || 0;
  const averageTicket = totalOrders > 0 ? totalSales / totalOrders : 0;

  return {
    summary: {
      conversions: uniqueConversions.size,
      orders: totalOrders,
      items: totalItems,
      totalSales: round2(totalSales),
      totalCommission: round2(totalCommission),
      netCommission: round2(totalNetCommission),
      sellerCommission: round2(totalSellerCommission),
      shopeeCommission: round2(totalShopeeCommission),
      averageTicket: round2(averageTicket),
      cancelledOrders,
      pendingOrders,
      completedOrders,
      unpaidOrders,
      fraudItems,
    },
    rows: sortedRows,
    daily,
    statusBreakdown,
    topShops,
    pagesScanned,
    rawConversions: nodes.length,
  };
}

function buildLegacyReportBlock(summary: CommissionReportSummary): ShopeeReportBlock {
  const conversions = Math.max(0, toInt(summary.recordsCount, 0));
  const totalCommission = round2(summary.totalCommission);

  return {
    summary: {
      conversions,
      orders: conversions,
      items: conversions,
      totalSales: 0,
      totalCommission,
      netCommission: totalCommission,
      sellerCommission: 0,
      shopeeCommission: 0,
      averageTicket: 0,
      cancelledOrders: 0,
      pendingOrders: 0,
      completedOrders: 0,
      unpaidOrders: 0,
      fraudItems: 0,
    },
    rows: [],
    daily: [],
    statusBreakdown: [],
    topShops: [],
    pagesScanned: Math.max(0, toInt(summary.pagesScanned, 0)),
    rawConversions: conversions,
  };
}

async function fetchShopeeReportsLegacy(
  credentials: ShopeeCredentials,
  input: { startDate: string; endDate: string },
  period: { startTimestamp: number; endTimestamp: number },
): Promise<ShopeeReportsResponse> {
  const [conversionLegacy, validatedLegacy] = await Promise.all([
    fetchCommissionReport(credentials, {
      type: "conversion_report",
      startDate: input.startDate,
      endDate: input.endDate,
    }),
    fetchCommissionReport(credentials, {
      type: "validation_report",
      startDate: input.startDate,
      endDate: input.endDate,
    }),
  ]);

  return {
    success: true,
    currency: conversionLegacy.currency || validatedLegacy.currency || defaultCurrencyForRegion(credentials.region),
    period: {
      startDate: input.startDate,
      endDate: input.endDate,
      startTimestamp: period.startTimestamp,
      endTimestamp: period.endTimestamp,
    },
    conversion: buildLegacyReportBlock(conversionLegacy),
    validated: buildLegacyReportBlock(validatedLegacy),
  };
}

async function fetchShopeeReports(
  credentials: ShopeeCredentials,
  input: { startDate: string; endDate: string; filters?: ShopeeReportFilters },
): Promise<ShopeeReportsResponse> {
  const period = toUnixDayRange(input.startDate, input.endDate);
  const filters = normalizeReportFilters(input.filters);
  let conversionRaw: { nodes: Record<string, unknown>[]; pagesScanned: number };
  try {
    conversionRaw = await fetchGraphqlReportNodes(credentials, "conversion", period, filters);
  } catch (error) {
    if (!shouldFallbackGraphqlReports(error)) {
      throw error;
    }
    logger.warn({ error: sanitizeError(error) }, "conversionReport GraphQL incompatible; using legacy signed reports fallback");
    return await fetchShopeeReportsLegacy(credentials, input, period);
  }

  const conversion = buildShopeeReportBlock(
    "conversion",
    conversionRaw.nodes,
    conversionRaw.pagesScanned,
    period,
    filters,
  );

  // Shopee now requires validationId for validatedReport, which is not provided by
  // conversionReport query args. Build a "validated" view from completed conversion
  // rows by default, while preserving user filters when explicitly set.
  const validatedFilters: ShopeeReportFilters = {
    ...filters,
    orderStatus: filters.orderStatus || "COMPLETED",
  };
  const validated = buildShopeeReportBlock(
    "validated",
    conversionRaw.nodes,
    conversionRaw.pagesScanned,
    period,
    validatedFilters,
  );

  return {
    success: true,
    currency: defaultCurrencyForRegion(credentials.region),
    period: {
      startDate: input.startDate,
      endDate: input.endDate,
      startTimestamp: period.startTimestamp,
      endTimestamp: period.endTimestamp,
    },
    conversion,
    validated,
  };
}

function isRetryableShopeeError(error: unknown): boolean {
  const message = sanitizeError(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("system error") ||
    message.includes("econnreset") ||
    message.includes("enotfound")
  );
}

function shouldFallbackGraphqlReports(error: unknown): boolean {
  const message = sanitizeError(error)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return (
    message.includes("wrong type")
    || message.includes("got null for non-null")
    || message.includes("cannot query field")
    || message.includes("validationid")
  );
}

function shouldFallbackValidatedReport(error: unknown): boolean {
  const message = sanitizeError(error)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return (
    message.includes("validatedreport")
    && message.includes("validationid")
    && message.includes("required")
  );
}

function looksLikeShopeeAuthSignatureError(error: unknown): boolean {
  const message = sanitizeError(error).toLowerCase();
  return (
    message.includes("invalid signature")
    || message.includes("invalid authorization header")
    || message.includes("invalid credential")
    || message.includes("request expired")
    || message.includes("invalid timestamp")
    || message.includes("10020")
  );
}

function compactGraphqlQuery(query: string): string {
  return query
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function buildGraphqlPayload(
  query: string,
  variables: Record<string, unknown>,
  mode: "legacy" | "canonical",
): string {
  if (mode === "legacy") {
    return JSON.stringify({ query, variables }).replace(/\n/g, "");
  }
  return JSON.stringify({
    query: compactGraphqlQuery(query),
    operationName: null,
    variables,
  });
}

async function callShopeeGraphqlWithPayload(
  credentials: ShopeeCredentials,
  payload: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let lastAuthError: unknown = null;
  for (let authModeIndex = 0; authModeIndex < SHOPEE_AUTH_HEADER_FALLBACK_MODES.length; authModeIndex += 1) {
    const authMode = SHOPEE_AUTH_HEADER_FALLBACK_MODES[authModeIndex];
    try {
      const response = await fetch(buildBaseUrl(credentials.region), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: signAuthorization(credentials.appId, credentials.secret, payload, authMode),
        },
        body: payload,
      });

      const text = await response.text().catch(() => "");
      let parsed: Record<string, unknown> = {};
      if (text) {
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = { error: text };
        }
      }

      if (!response.ok) {
        const errText = parsed.error || parsed.message || parsed.msg
          || (parsed.code != null ? `error [${parsed.code}]` : null)
          || `Shopee API HTTP ${response.status}`;
        throw new Error(String(errText));
      }

      const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
      if (errors.length > 0) {
        const first = errors[0] as Record<string, unknown>;
        const errMsg = String(first.message || first.msg || "Erro GraphQL da Shopee");
        logger.error({
          graphqlErrors: errors,
          variables,
          httpStatus: response.status,
        }, `shopee graphql error: ${errMsg}`);
        throw new Error(errMsg);
      }

      const data = parsed.data;
      if (!data || typeof data !== "object") {
        throw new Error("Resposta inválida da Shopee API");
      }

      return data as Record<string, unknown>;
    } catch (error) {
      const shouldTryNextAuthHeader = (
        looksLikeShopeeAuthSignatureError(error)
        && authModeIndex < (SHOPEE_AUTH_HEADER_FALLBACK_MODES.length - 1)
      );
      if (!shouldTryNextAuthHeader) {
        throw error;
      }
      lastAuthError = error;
      logger.warn({
        authMode,
        nextAuthMode: SHOPEE_AUTH_HEADER_FALLBACK_MODES[authModeIndex + 1],
        error: sanitizeError(error),
      }, "retrying shopee graphql with alternate auth header");
    }
  }

  if (lastAuthError) {
    throw lastAuthError;
  }
  throw new Error("Falha ao autenticar chamada GraphQL Shopee");
}

async function callShopeeGraphql(
  credentials: ShopeeCredentials,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const legacyPayload = buildGraphqlPayload(query, variables, "legacy");
      try {
        return await callShopeeGraphqlWithPayload(credentials, legacyPayload, variables);
      } catch (error) {
        if (!looksLikeShopeeAuthSignatureError(error)) throw error;
        logger.warn({
          error: sanitizeError(error),
          attempt,
        }, "retrying shopee graphql with canonical payload");
        const canonicalPayload = buildGraphqlPayload(query, variables, "canonical");
        return await callShopeeGraphqlWithPayload(credentials, canonicalPayload, variables);
      }
    } catch (error) {
      const canRetry = attempt < maxAttempts && isRetryableShopeeError(error);
      if (!canRetry) throw error;

      const backoffMs = 300 * attempt;
      logger.warn({ attempt, backoffMs, error: sanitizeError(error) }, "retrying shopee graphql call");
      await wait(backoffMs);
    }
  }

  throw new Error("Falha ao consultar Shopee API");
}

function normalizeCommissionRate(input: unknown): number {
  const value = toNumber(input);
  if (value <= 0) return 0;
  return value > 1 ? value / 100 : value;
}

// priceDiscountRate can come as decimal (0.30 = 30%) or integer (30 = 30%)
function normalizeDiscountRate(input: unknown): number {
  const value = toNumber(input);
  if (value <= 0) return 0;
  const pct = value > 1 ? value : value * 100;
  return Math.max(0, Math.min(99, Math.round(pct)));
}

function toPositivePrice(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Number(value.toFixed(2));
}

/** Strip Shopee's `lp=aff` query param that sometimes leaks into affiliate links. */
function stripLpAff(url: string): string {
  const v = String(url || "").trim();
  if (!v) return "";
  try {
    const parsed = new URL(v);
    if (!parsed.searchParams.has("lp")) return v;
    const lp = parsed.searchParams.getAll("lp");
    if (!lp.some((x) => x.trim().toLowerCase() === "aff")) return v;
    const next = new URLSearchParams();
    for (const [k, val] of parsed.searchParams.entries()) {
      if (k === "lp" && val.trim().toLowerCase() === "aff") continue;
      next.append(k, val);
    }
    const qs = next.toString();
    return `${parsed.origin}${parsed.pathname}${qs ? `?${qs}` : ""}${parsed.hash}`;
  } catch {
    return v.replace(/[?&]lp=aff(?=(&|#|$))/gi, (m, s) =>
      m.startsWith("?") ? (s === "&" ? "?" : "") : (s === "&" ? "&" : ""),
    ).replace(/[?&]$/, "");
  }
}

function mapNodeToProduct(node: Record<string, unknown>, category = "ofertas") {
  const salePrice = toPositivePrice(toNumber(node.price));
  const discount = normalizeDiscountRate(node.priceDiscountRate);
  const originalPrice = discount > 0
    ? toPositivePrice(salePrice / (1 - discount / 100))
    : salePrice;
  const commission = normalizeCommissionRate(node.commissionRate);
  const commissionValueRaw = toNumber(node.commission);
  const commissionValue = commissionValueRaw > 0
    ? toPositivePrice(commissionValueRaw)
    : toPositivePrice(salePrice * commission);
  const sales = Math.max(0, Math.round(toNumber(node.sales)));

  const link = String(node.productLink || "");
  const offerLink = stripLpAff(String(node.offerLink || ""));
  const affiliateLink = stripLpAff(String(node.offerLink || link));

  const shopId = toStringValue(node.shopId || node.shopid || "").trim();
  const itemId = toStringValue(node.itemId || node.itemid || "").trim();
  const idSeed = `${shopId}_${itemId}_${link}`;
  const id = shopId && itemId
    ? `${shopId}_${itemId}`
    : crypto.createHash("md5").update(idSeed).digest("hex").slice(0, 16);

  return {
    id,
    title: String(node.productName || "Produto Shopee"),
    imageUrl: String(node.imageUrl || ""),
    originalPrice,
    salePrice,
    discount,
    commission,
    commissionValue,
    sales,
    link,
    offerLink,
    affiliateLink,
    category,
    shopName: String(node.shopName || node.shopname || ""),
    shopId: shopId || undefined,
    itemId: itemId || undefined,
    rating: toPositivePrice(toNumber(node.ratingStar)),
  };
}

function isAffiliateOfferWithCommission(product: ReturnType<typeof mapNodeToProduct>): boolean {
  const offerLink = String(product.offerLink || "").trim();
  const affiliateLink = String(product.affiliateLink || "").trim();
  const hasAffiliateLink = /^https?:\/\//i.test(offerLink) && /^https?:\/\//i.test(affiliateLink);
  if (!hasAffiliateLink) return false;

  const commissionRate = Number(product.commission || 0);
  const commissionValue = Number(product.commissionValue || 0);
  return commissionRate > 0 || commissionValue > 0;
}

function extractProductIdentifiers(url: string): { shopId: string; itemId: string } | null {
  const normalized = String(url || "");
  if (!normalized) return null;

  const productMatch = normalized.match(/-i\.(\d+)\.(\d+)/i);
  if (productMatch?.[1] && productMatch?.[2]) {
    return { shopId: productMatch[1], itemId: productMatch[2] };
  }

  const pathMatch = normalized.match(/\/(\d+)\/(\d+)(?:\?|#|$)/);
  if (pathMatch?.[1] && pathMatch?.[2]) {
    return { shopId: pathMatch[1], itemId: pathMatch[2] };
  }

  return null;
}

function looksLikeShopeeUrl(url: string): boolean {
  const input = String(url || "").trim();
  if (!input) return false;
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host.includes("shopee.")
      || host.endsWith("shope.ee")
    );
  } catch {
    return false;
  }
}

async function runBatchQuery(
  credentials: ShopeeCredentials,
  queryId: string,
  params: Record<string, unknown>,
): Promise<BatchQueryResult> {
  const pageFromClient = Math.max(1, toInt(params.page, 1));
  const apiPage = pageFromClient - 1;
  const limit = Math.max(1, Math.min(50, toInt(params.limit, 20)));
  const sortBy = String(params.sortBy || "sales").trim().toLowerCase();
  const sortType = toShopeeSortType(sortBy);
  const keyword = String(params.keyword || "").trim();
  const matchId = toInt(params.matchId, 0);
  const category = matchId > 0 ? `cat_${matchId}` : (keyword || sortBy || "ofertas");
  const listType = toInt(params.listType, 0);

  const offerQuery = `
    query ProductOffer(
      $keyword: String
      $matchId: Int64
      $listType: Int
      $sortType: Int
      $page: Int
      $limit: Int
    ) {
      productOfferV2(
        keyword: $keyword
        matchId: $matchId
        listType: $listType
        sortType: $sortType
        page: $page
        limit: $limit
      ) {
        nodes {
          productName
          imageUrl
          commissionRate
          commission
          price
          priceDiscountRate
          ratingStar
          productLink
          offerLink
          sales
          shopId
          itemId
          shopName
        }
        pageInfo {
          hasNextPage
          page
          limit
        }
      }
    }
  `;

  const response = await callShopeeGraphql(credentials, offerQuery, {
    keyword: matchId > 0 ? null : (keyword || null),
    matchId: matchId > 0 ? matchId : null,
    listType,
    sortType,
    page: apiPage,
    limit,
  });

  const offer = response.productOfferV2 as Record<string, unknown> | undefined;
  const nodesRaw = offer?.nodes;
  const nodes = Array.isArray(nodesRaw) ? nodesRaw : [];
  const mapped = nodes
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => mapNodeToProduct(item, category))
    .filter((item) => isAffiliateOfferWithCommission(item));

  if (sortBy === "price_desc") {
    mapped.sort((a, b) => b.salePrice - a.salePrice);
  } else if (sortBy === "price_asc") {
    mapped.sort((a, b) => a.salePrice - b.salePrice);
  } else if (sortBy === "commission") {
    mapped.sort((a, b) => b.commission - a.commission);
  } else if (sortBy === "sales") {
    mapped.sort((a, b) => b.sales - a.sales);
  }

  const pageInfo = offer?.pageInfo as Record<string, unknown> | undefined;
  const hasMore = pageInfo?.hasNextPage === true ? true : mapped.length >= limit;

  logger.debug({
    queryId,
    keyword: matchId > 0 ? null : keyword,
    matchId: matchId > 0 ? matchId : null,
    sortBy,
    page: pageFromClient,
    count: mapped.length,
    hasMore,
  }, "shopee batch query ok");

  return {
    products: mapped,
    hasMore,
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
  });
});

app.use("/api", requireWebhookSecret);

app.post("/api/shopee/test-connection", async (req, res) => {
  const parsed = requireCredentials(req.body);
  if (!parsed.ok) {
    res.json({ success: false, error: parsed.error, region: "br" });
    return;
  }

  const { credentials } = parsed;
  try {
    const query = `
      query PingConnection {
        productOfferV2(listType: 0, page: 0, limit: 1) {
          nodes {
            productName
          }
        }
      }
    `;
    await callShopeeGraphql(credentials, query, {});
    res.json({ success: true, region: credentials.region.toUpperCase() });
  } catch (error) {
    res.json({
      success: false,
      region: credentials.region.toUpperCase(),
      error: sanitizeError(error),
    });
  }
});

app.post("/api/shopee/commission-report", async (req, res) => {
  const parsed = requireCredentials(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const reportType = normalizeReportType(req.body?.reportType ?? req.body?.type ?? "conversion_report");
  if (!reportType) {
    res.status(400).json({ error: "Tipo de relatorio invalido. Use conversion_report ou validation_report." });
    return;
  }

  const startInput = String(req.body?.startDate ?? req.body?.start_date ?? "").trim();
  const endInput = String(req.body?.endDate ?? req.body?.end_date ?? "").trim();

  const normalizedStart = startInput ? normalizeDateYmd(startInput) : null;
  const normalizedEnd = endInput ? normalizeDateYmd(endInput) : null;

  if (startInput && !normalizedStart) {
    res.status(400).json({ error: "startDate invalido. Use formato YYYY-MM-DD." });
    return;
  }
  if (endInput && !normalizedEnd) {
    res.status(400).json({ error: "endDate invalido. Use formato YYYY-MM-DD." });
    return;
  }

  const startDate = normalizedStart || dateYmdDaysAgo(29);
  const endDate = normalizedEnd || dateYmdDaysAgo(0);

  if (startDate > endDate) {
    res.status(400).json({ error: "Periodo invalido: startDate deve ser menor ou igual a endDate." });
    return;
  }

  try {
    const result = await fetchCommissionReport(parsed.credentials, {
      type: reportType,
      startDate,
      endDate,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({
      error: sanitizeError(error),
      type: reportType,
      startDate,
      endDate,
    });
  }
});

app.post("/api/shopee/reports", async (req, res) => {
  const parsed = requireCredentials(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const startInput = String(req.body?.startDate ?? req.body?.start_date ?? "").trim();
  const endInput = String(req.body?.endDate ?? req.body?.end_date ?? "").trim();
  const normalizedStart = startInput ? normalizeDateYmd(startInput) : null;
  const normalizedEnd = endInput ? normalizeDateYmd(endInput) : null;

  if (startInput && !normalizedStart) {
    res.status(400).json({ error: "startDate invalido. Use formato YYYY-MM-DD." });
    return;
  }
  if (endInput && !normalizedEnd) {
    res.status(400).json({ error: "endDate invalido. Use formato YYYY-MM-DD." });
    return;
  }

  const startDate = normalizedStart || dateYmdDaysAgo(29);
  const endDate = normalizedEnd || dateYmdDaysAgo(0);
  const filters = normalizeReportFilters(req.body?.filters);
  if (startDate > endDate) {
    res.status(400).json({ error: "Periodo invalido: startDate deve ser menor ou igual a endDate." });
    return;
  }

  const daysRequested = daysInRange(startDate, endDate);
  if (daysRequested > REPORT_GRAPHQL_MAX_RANGE_DAYS) {
    res.status(400).json({
      error: `Periodo maximo permitido: ${REPORT_GRAPHQL_MAX_RANGE_DAYS} dias.`,
      maxDays: REPORT_GRAPHQL_MAX_RANGE_DAYS,
    });
    return;
  }

  try {
    const report = await fetchShopeeReports(parsed.credentials, {
      startDate,
      endDate,
      filters,
    });
    res.json(report);
  } catch (error) {
    res.status(400).json({
      error: sanitizeError(error),
      startDate,
      endDate,
      filters,
    });
  }
});

app.post("/api/shopee/convert-link", async (req, res) => {
  const parsed = requireCredentials(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const sourceUrl = String(req.body?.url || "").trim();
  if (!sourceUrl) {
    res.status(400).json({ error: "URL do produto e obrigatoria" });
    return;
  }
  if (sourceUrl.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: "URL do produto excede o tamanho maximo permitido" });
    return;
  }
  if (!looksLikeShopeeUrl(sourceUrl)) {
    res.status(400).json({ error: "URL informada não parece ser da Shopee" });
    return;
  }

  const { credentials } = parsed;

  try {
    const targetUrl = sourceUrl;

    const mutation = `
      mutation GenerateShortLink($input: ShortLinkInput!) {
        generateShortLink(input: $input) {
          shortLink
        }
      }
    `;

    const converted = await callShopeeGraphql(credentials, mutation, {
      input: { originUrl: targetUrl },
    });

    const linkNode = converted.generateShortLink as Record<string, unknown> | undefined;
    const rawAffiliateLink = String(linkNode?.shortLink || "").trim();
    if (!rawAffiliateLink) {
      throw new Error("Shopee não retornou link de afiliado");
    }

    const affiliateLink = stripLpAff(rawAffiliateLink);
    const ids = extractProductIdentifiers(targetUrl);

    let product: Record<string, unknown> | null = null;

    if (ids) {
      const detailQuery = `
        query ProductDetail($shopId: Int64!, $itemId: Int64!) {
          productOfferV2(shopId: $shopId, itemId: $itemId) {
            nodes {
              productName
              imageUrl
              commissionRate
              commission
              price
              priceDiscountRate
              ratingStar
              productLink
              offerLink
              sales
              shopId
              itemId
              shopName
            }
          }
        }
      `;

      try {
        const detail = await callShopeeGraphql(credentials, detailQuery, {
          shopId: ids.shopId,
          itemId: ids.itemId,
        });

        const detailNode = (detail.productOfferV2 as Record<string, unknown> | undefined)?.nodes;
        const nodes = Array.isArray(detailNode) ? detailNode : [];
        if (nodes.length > 0 && nodes[0] && typeof nodes[0] === "object") {
          const mapped = mapNodeToProduct(nodes[0] as Record<string, unknown>, "conversão");
          product = {
            ...mapped,
            affiliateLink,
          };
        }
      } catch (error) {
        logger.warn({
          sourceUrl,
          shopId: ids.shopId,
          itemId: ids.itemId,
          error: sanitizeError(error),
        }, "shopee detail query failed, returning affiliate link without product details");
      }
    }

    res.json({
      affiliateLink,
      product,
      resolvedUrl: targetUrl,
    });
  } catch (error) {
    res.status(400).json({ error: sanitizeError(error) });
  }
});

app.post("/api/shopee/batch", async (req, res) => {
  const parsed = requireCredentials(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const queries = Array.isArray(req.body?.queries) ? (req.body.queries as BatchQuery[]) : [];
  if (queries.length > MAX_SHOPEE_BATCH_QUERIES) {
    res.status(400).json({ error: `Maximo de ${MAX_SHOPEE_BATCH_QUERIES} consultas por lote` });
    return;
  }
  const { credentials } = parsed;
  const results: Record<string, unknown> = {};

  for (const query of queries) {
    const id = String(query.id || crypto.randomUUID());
    const params = query.params && typeof query.params === "object" ? query.params : {};
    try {
      results[id] = await runBatchQuery(credentials, id, params);
    } catch (error) {
      logger.warn({ queryId: id, error: sanitizeError(error) }, "shopee batch query failed");
      results[id] = {
        products: [],
        hasMore: false,
        error: sanitizeError(error),
      };
    }
  }

  res.json({ results });
});

const httpServer = app.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT }, "shopee affiliate service online");
});

httpServer.on("error", (error) => {
  logger.error({ error: sanitizeError(error), host: HOST, port: PORT }, "failed to bind shopee service");
  process.exit(1);
});
