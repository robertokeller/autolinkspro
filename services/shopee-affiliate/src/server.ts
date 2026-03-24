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

// ââ€â‚¬ââ€â‚¬ââ€â‚¬ Rate limiting (in-memory, per IP) ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬ââ€â‚¬
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_REQUESTS = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_SHOPEE_BATCH_QUERIES = 20;
const MAX_URL_LENGTH = 2048;

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

