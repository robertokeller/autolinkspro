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
const REPORT_TOTAL_FIELDS = [
  "total_commission",
  "commission_total",
  "totalCommission",
  "estimated_commission",
  "settled_commission",
  "valid_commission",
  ...REPORT_VALUE_FIELDS,
];

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

function signAuthorization(appId: string, secret: string, payload: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const factor = `${appId}${timestamp}${payload}${secret}`;
  const signature = crypto.createHash("sha256").update(factor).digest("hex");
  return `SHA256 Credential=${appId},Timestamp=${timestamp},Signature=${signature}`;
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
    if (objectRows.length > 0) return objectRows;
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

function findNumberByKeys(value: unknown, keys: string[], depth = 0): number | null {
  if (depth > 5 || value == null) return null;
  const record = asRecord(value);
  if (!record) return null;

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const parsed = parseDecimalLike(record[key]);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findNumberByKeys(nestedValue, keys, depth + 1);
    if (nested !== null) return nested;
  }

  return null;
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

function extractRowCommissionValue(row: Record<string, unknown>): number {
  for (const field of REPORT_VALUE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const parsed = parseDecimalLike(row[field]);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
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
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: signAuthorization(credentials.appId, credentials.secret, signaturePayload),
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
          throw new Error("Shopee report endpoint returned non-JSON response.");
        }
      }

      if (!response.ok) {
        throw new Error(String(parsed.error || parsed.message || `Shopee report HTTP ${response.status}`));
      }

      return parsed;
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
      directTotalCommission = topLevelTotal;
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

  const totalCommission = Number(Math.max(0, directTotalCommission ?? rowsTotalCommission).toFixed(2));

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
    $purchaseTimeStart: Int
    $purchaseTimeEnd: Int
    $limit: Int
    $scrollId: String
  ) {
    conversionReport(
      purchaseTimeStart: $purchaseTimeStart
      purchaseTimeEnd: $purchaseTimeEnd
      limit: $limit
      scrollId: $scrollId
    ) {
      nodes {
        purchaseTime
        clickTime
        conversionId
        buyerType
        device
        referrer
        totalCommission
        sellerCommission
        shopeeCommissionCapped
        netCommission
        utmContent
        campaignType
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
            campaignType
            campaignPartnerName
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
        clickTime
        conversionId
        buyerType
        device
        referrer
        totalCommission
        sellerCommission
        shopeeCommissionCapped
        netCommission
        utmContent
        campaignType
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
            campaignType
            campaignPartnerName
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

async function fetchGraphqlReportNodes(
  credentials: ShopeeCredentials,
  source: ShopeeReportSource,
  period: { startTimestamp: number; endTimestamp: number },
): Promise<{ nodes: Record<string, unknown>[]; pagesScanned: number }> {
  let scrollId: string | null = null;
  let pagesScanned = 0;
  const nodes: Record<string, unknown>[] = [];

  while (pagesScanned < REPORT_MAX_PAGES) {
    const variables: Record<string, unknown> = {
      limit: REPORT_PAGE_LIMIT,
      scrollId: scrollId || null,
    };
    if (source === "conversion") {
      variables.purchaseTimeStart = period.startTimestamp;
      variables.purchaseTimeEnd = period.endTimestamp;
    }

    const data = await callShopeeGraphql(
      credentials,
      source === "conversion" ? CONVERSION_REPORT_GRAPHQL_QUERY : VALIDATED_REPORT_GRAPHQL_QUERY,
      variables,
    );

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
): ShopeeReportBlock {
  const rows: ShopeeReportRow[] = [];
  const uniqueConversions = new Set<string>();
  const uniqueOrders = new Set<string>();
  const statusByOrder = new Map<string, string>();
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
    const buyerType = String(node.buyerType || "").trim().toUpperCase();
    const device = String(node.device || "").trim().toUpperCase();
    const referrer = String(node.referrer || "").trim();
    const campaignType = String(node.campaignType || "").trim();
    const utmContent = String(node.utmContent || "").trim();
    const conversionNetCommission = toCurrencyAmount(node.netCommission || node.totalCommission);
    const conversionDateKey = toReportDateKey(purchaseTime);

    if (!uniqueConversions.has(conversionKey)) {
      uniqueConversions.add(conversionKey);
      totalNetCommission += conversionNetCommission;
      const daily = dailyMap.get(conversionDateKey) || {
        sales: 0,
        totalCommission: 0,
        netCommission: 0,
        items: 0,
        orderIds: new Set<string>(),
      };
      daily.netCommission += conversionNetCommission;
      dailyMap.set(conversionDateKey, daily);
    }

    const ordersRaw = Array.isArray(node.orders) ? node.orders : [];
    const orders = ordersRaw
      .filter((order): order is Record<string, unknown> => !!order && typeof order === "object" && !Array.isArray(order));

    for (const order of orders) {
      const orderId = toReportId(order.orderId);
      const orderStatus = normalizeOrderStatus(order.orderStatus);
      const orderUniqueKey = `${source}:${conversionId}:${orderId || "unknown"}`;
      if (orderId && !uniqueOrders.has(orderUniqueKey)) {
        uniqueOrders.add(orderUniqueKey);
        statusByOrder.set(orderUniqueKey, orderStatus);
        statusBreakdownMap.set(orderStatus, (statusBreakdownMap.get(orderStatus) || 0) + 1);
      }

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

        totalSales += actualAmount;
        totalCommission += rowTotalCommission;
        totalSellerCommission += rowSellerCommission;
        totalShopeeCommission += rowShopeeCommission;
        totalItems += 1;
        if (fraudStatus === "FRAUD") fraudItems += 1;

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
          campaignType: String(item.campaignType || campaignType || "").trim(),
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
        daily.items += 1;
        if (orderId) daily.orderIds.add(orderUniqueKey);
        dailyMap.set(conversionDateKey, daily);
      }
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

async function fetchShopeeReports(
  credentials: ShopeeCredentials,
  input: { startDate: string; endDate: string },
): Promise<ShopeeReportsResponse> {
  const period = toUnixDayRange(input.startDate, input.endDate);
  const [conversionRaw, validatedRaw] = await Promise.all([
    fetchGraphqlReportNodes(credentials, "conversion", period),
    fetchGraphqlReportNodes(credentials, "validated", period),
  ]);

  const conversion = buildShopeeReportBlock(
    "conversion",
    conversionRaw.nodes,
    conversionRaw.pagesScanned,
    period,
  );
  const validated = buildShopeeReportBlock(
    "validated",
    validatedRaw.nodes,
    validatedRaw.pagesScanned,
    period,
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

async function callShopeeGraphql(
  credentials: ShopeeCredentials,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payloadObj = { query, variables };
      const payload = JSON.stringify(payloadObj).replace(/\n/g, "");
      const response = await fetch(buildBaseUrl(credentials.region), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: signAuthorization(credentials.appId, credentials.secret, payload),
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
        throw new Error(String(parsed.error || parsed.message || `Shopee API HTTP ${response.status}`));
      }

      const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
      if (errors.length > 0) {
        const first = errors[0] as Record<string, unknown>;
        const errMsg = String(first.message || "Erro GraphQL da Shopee");
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
    });
    res.json(report);
  } catch (error) {
    res.status(400).json({
      error: sanitizeError(error),
      startDate,
      endDate,
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
