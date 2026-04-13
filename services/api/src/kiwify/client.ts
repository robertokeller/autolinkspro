/**
 * Kiwify API Client — OAuth2 + all endpoints
 * Base URL: https://public-api.kiwify.com/v1
 * Auth: Bearer token via OAuth2 (expires_in 86400s = 24h per API response)
 * Rate limit: 100 req/min
 */
import { createHash } from "node:crypto";
import { query, queryOne, execute } from "../db.js";
import { encryptCredential, decryptCredential } from "../credential-cipher.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KiwifyConfig {
  id: string;
  client_id: string;
  client_secret: string;
  account_id: string;
  webhook_secret: string;
  oauth_token_cache: string;
  affiliate_enabled: boolean;
  grace_period_days: number;
}

interface OAuthTokenCache {
  access_token: string;
  expires_at: number; // epoch ms
}

export interface KiwifyProduct {
  id: string;
  name: string;
  type: string;
  created_at: string;
  currency: string;
  price: number | null;
  affiliate_enabled: boolean;
  status: string;
  payment_type: string;
  links?: Array<{ id: string; custom_name: string | null; status: string; is_sales_page: boolean }>;
  offers?: unknown[];
  subscriptions?: unknown[];
  revenue_partners?: unknown[];
}

export interface KiwifyCustomer {
  id: string;
  name: string;
  email: string;
  cpf?: string;
  mobile?: string;
  instagram?: string;
  country?: string;
  address?: {
    street: string;
    number: string;
    complement: string;
    neighborhood: string;
    city: string;
    state: string;
    zipcode: string;
  };
}

export interface KiwifySale {
  id: string;
  reference: string;
  type: string;
  created_at: string;
  updated_at: string;
  product: { id: string; name: string };
  status: string;
  payment_method: string;
  net_amount: number;
  currency: string;
  customer: KiwifyCustomer;
  approved_date: string | null;
  boleto_url: string | null;
  card_last_digits: string | null;
  card_type: string | null;
  installments: number | null;
  payment: {
    charge_amount: number;
    charge_currency: string;
    net_amount: number;
    product_base_price: number;
    product_base_currency: string;
    fee: number;
    fee_currency: string;
  };
  refunded_at: string | null;
  sale_type: string;
  tracking: {
    sck: string | null;
    src: string | null;
    utm_campaign: string | null;
    utm_content: string | null;
    utm_medium: string | null;
    utm_source: string | null;
    utm_term: string | null;
    s1: string | null;
    s2: string | null;
    s3: string | null;
  };
  affiliate_commission: {
    name: string;
    document: string;
    email: string;
    amount: number;
  } | null;
  revenue_partners: unknown[];
}

export interface KiwifyAffiliate {
  affiliate_id: string;
  name: string;
  email: string;
  company_name: string;
  director_cpf: string;
  company_cnpj: string;
  product: { id: string; name: string };
  commission: number;
  status: string;
  created_at: string;
}

export interface KiwifyStats {
  credit_card_approval_rate: number;
  total_sales: number;
  total_net_amount: number;
  refund_rate: number;
  chargeback_rate: number;
  total_boleto_generated: number;
  total_boleto_paid: number;
  boleto_rate: number;
}

export interface KiwifyBalance {
  available: number;
  pending: number;
  legal_entity_id: string;
}

export interface KiwifyWebhook {
  id: string;
  name: string;
  url: string;
  products: string;
  triggers: string[];
  token: string;
  created_at: string;
  updated_at: string;
}

export interface KiwifyPaginated<T> {
  pagination: { count: number; page_number: number; page_size: number };
  data: T[];
}

// ─── Webhook event types ────────────────────────────────────────────────────

export const KIWIFY_WEBHOOK_TRIGGERS = [
  "boleto_gerado",
  "pix_gerado",
  "carrinho_abandonado",
  "compra_recusada",
  "compra_aprovada",
  "compra_reembolsada",
  "chargeback",
  "subscription_canceled",
  "subscription_late",
  "subscription_renewed",
] as const;

export type KiwifyWebhookTrigger = (typeof KIWIFY_WEBHOOK_TRIGGERS)[number];

// ─── Config helpers ─────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS = 60_000;
let configCache: { config: KiwifyConfig; fetchedAt: number } | null = null;

export async function loadKiwifyConfig(): Promise<KiwifyConfig | null> {
  if (configCache && Date.now() - configCache.fetchedAt < CONFIG_CACHE_TTL_MS) {
    return configCache.config;
  }
  const row = await queryOne("SELECT * FROM kiwify_config LIMIT 1");
  if (!row) return null;
  const config: KiwifyConfig = {
    id: row.id,
    client_id: decryptCredential(row.client_id),
    client_secret: decryptCredential(row.client_secret),
    account_id: row.account_id,
    webhook_secret: decryptCredential(row.webhook_secret),
    oauth_token_cache: row.oauth_token_cache,
    affiliate_enabled: row.affiliate_enabled,
    grace_period_days: row.grace_period_days ?? 3,
  };
  configCache = { config, fetchedAt: Date.now() };
  return config;
}

export function clearKiwifyConfigCache() {
  configCache = null;
}

export async function saveKiwifyConfig(data: {
  client_id: string;
  client_secret: string;
  account_id: string;
  webhook_secret: string;
  affiliate_enabled: boolean;
  grace_period_days: number;
}): Promise<void> {
  const existing = await queryOne("SELECT id FROM kiwify_config LIMIT 1");
  const encClientId = encryptCredential(data.client_id);
  const encClientSecret = encryptCredential(data.client_secret);
  const encWebhookSecret = encryptCredential(data.webhook_secret);

  if (existing) {
    await execute(
      `UPDATE kiwify_config SET client_id=$1, client_secret=$2, account_id=$3, webhook_secret=$4,
       affiliate_enabled=$5, grace_period_days=$6 WHERE id=$7`,
      [encClientId, encClientSecret, data.account_id, encWebhookSecret, data.affiliate_enabled, data.grace_period_days, existing.id]
    );
  } else {
    await execute(
      `INSERT INTO kiwify_config (client_id, client_secret, account_id, webhook_secret, affiliate_enabled, grace_period_days)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [encClientId, encClientSecret, data.account_id, encWebhookSecret, data.affiliate_enabled, data.grace_period_days]
    );
  }
  clearKiwifyConfigCache();
}

// ─── OAuth token management ────────────────────────────────────────────────

const BASE_URL = "https://public-api.kiwify.com/v1";
const TOKEN_REFRESH_MARGIN_MS = 3_600_000; // refresh 1h before expiry

async function getCachedToken(config: KiwifyConfig): Promise<string | null> {
  if (!config.oauth_token_cache) return null;
  try {
    const cache: OAuthTokenCache = JSON.parse(decryptCredential(config.oauth_token_cache));
    if (cache.access_token && cache.expires_at > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      return cache.access_token;
    }
  } catch { /* expired or corrupted */ }
  return null;
}

async function requestNewToken(config: KiwifyConfig): Promise<string> {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kiwify OAuth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const token = data.access_token as string;
  const expiresInMs = (Number(data.expires_in) || 86400) * 1000;
  const cache: OAuthTokenCache = { access_token: token, expires_at: Date.now() + expiresInMs };

  // Persist token cache (encrypted)
  const encCache = encryptCredential(JSON.stringify(cache));
  await execute("UPDATE kiwify_config SET oauth_token_cache=$1 WHERE id=$2", [encCache, config.id]);
  clearKiwifyConfigCache();

  return token;
}

async function getAccessToken(config: KiwifyConfig): Promise<string> {
  const cached = await getCachedToken(config);
  if (cached) return cached;
  return requestNewToken(config);
}

// ─── Rate limiter (100 req/min) ────────────────────────────────────────────

const requestTimestamps: number[] = [];
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 95; // conservative margin

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0]! < now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT_MAX) {
    const waitMs = requestTimestamps[0]! + RATE_LIMIT_WINDOW_MS - now + 100;
    await new Promise<void>((r) => setTimeout(r, waitMs));
  }
  requestTimestamps.push(Date.now());
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

async function kiwifyFetch(
  config: KiwifyConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  await waitForRateLimit();
  const token = await getAccessToken(config);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "x-kiwify-account-id": config.account_id,
    };
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      continue;
    }
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      continue;
    }

    if (res.status === 204) return {};

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Kiwify API ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    }
    return data;
  }
  throw new Error(`Kiwify API ${method} ${path}: max retries exceeded`);
}

// ─── Public API methods ─────────────────────────────────────────────────────

export async function kiwifyGetAccountDetails(config: KiwifyConfig) {
  return kiwifyFetch(config, "GET", "/account-details") as Promise<Record<string, unknown>>;
}

export async function kiwifyListProducts(
  config: KiwifyConfig,
  pageNumber = 1,
  pageSize = 50,
): Promise<KiwifyPaginated<KiwifyProduct>> {
  return kiwifyFetch(config, "GET", `/products?page_number=${pageNumber}&page_size=${pageSize}`) as Promise<KiwifyPaginated<KiwifyProduct>>;
}

export async function kiwifyGetProduct(config: KiwifyConfig, id: string): Promise<KiwifyProduct> {
  return kiwifyFetch(config, "GET", `/products/${encodeURIComponent(id)}`) as Promise<KiwifyProduct>;
}

export async function kiwifyListSales(
  config: KiwifyConfig,
  filters: {
    start_date: string;
    end_date: string;
    status?: string;
    product_id?: string;
    affiliate_id?: string;
    payment_method?: string;
    page_number?: number;
    page_size?: number;
    view_full_sale_details?: boolean;
  },
): Promise<KiwifyPaginated<KiwifySale>> {
  const params = new URLSearchParams();
  params.set("start_date", filters.start_date);
  params.set("end_date", filters.end_date);
  if (filters.status) params.set("status", filters.status);
  if (filters.product_id) params.set("product_id", filters.product_id);
  if (filters.affiliate_id) params.set("affiliate_id", filters.affiliate_id);
  if (filters.payment_method) params.set("payment_method", filters.payment_method);
  if (filters.page_number) params.set("page_number", String(filters.page_number));
  if (filters.page_size) params.set("page_size", String(filters.page_size));
  if (filters.view_full_sale_details) params.set("view_full_sale_details", "true");
  return kiwifyFetch(config, "GET", `/sales?${params.toString()}`) as Promise<KiwifyPaginated<KiwifySale>>;
}

export async function kiwifyGetSale(config: KiwifyConfig, id: string): Promise<KiwifySale> {
  return kiwifyFetch(config, "GET", `/sales/${encodeURIComponent(id)}`) as Promise<KiwifySale>;
}

export async function kiwifyRefundSale(config: KiwifyConfig, id: string, pixKey?: string) {
  const body = pixKey ? { pixKey } : {};
  return kiwifyFetch(config, "POST", `/sales/${encodeURIComponent(id)}/refund`, body);
}

export async function kiwifyGetStats(
  config: KiwifyConfig,
  filters?: { product_id?: string; start_date?: string; end_date?: string },
): Promise<KiwifyStats> {
  const params = new URLSearchParams();
  if (filters?.product_id) params.set("product_id", filters.product_id);
  if (filters?.start_date) params.set("start_date", filters.start_date);
  if (filters?.end_date) params.set("end_date", filters.end_date);
  const qs = params.toString();
  return kiwifyFetch(config, "GET", `/stats${qs ? `?${qs}` : ""}`) as Promise<KiwifyStats>;
}

export async function kiwifyGetBalance(config: KiwifyConfig): Promise<KiwifyBalance> {
  return kiwifyFetch(config, "GET", "/balance") as Promise<KiwifyBalance>;
}

export async function kiwifyListAffiliates(
  config: KiwifyConfig,
  filters?: { status?: string; product_id?: string; search?: string; page_number?: number; page_size?: number },
): Promise<KiwifyPaginated<KiwifyAffiliate>> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.product_id) params.set("product_id", filters.product_id);
  if (filters?.search) params.set("search", filters.search);
  if (filters?.page_number) params.set("page_number", String(filters.page_number));
  if (filters?.page_size) params.set("page_size", String(filters.page_size));
  const qs = params.toString();
  return kiwifyFetch(config, "GET", `/affiliates${qs ? `?${qs}` : ""}`) as Promise<KiwifyPaginated<KiwifyAffiliate>>;
}

export async function kiwifyGetAffiliate(config: KiwifyConfig, id: string): Promise<KiwifyAffiliate> {
  return kiwifyFetch(config, "GET", `/affiliates/${encodeURIComponent(id)}`) as Promise<KiwifyAffiliate>;
}

export async function kiwifyEditAffiliate(
  config: KiwifyConfig,
  id: string,
  data: { commission?: number; status?: "active" | "blocked" | "refused" },
): Promise<KiwifyAffiliate> {
  return kiwifyFetch(config, "PUT", `/affiliates/${encodeURIComponent(id)}`, data) as Promise<KiwifyAffiliate>;
}

export async function kiwifyListWebhooks(
  config: KiwifyConfig,
  filters?: { product_id?: string; search?: string; page_number?: number; page_size?: number },
): Promise<KiwifyPaginated<KiwifyWebhook>> {
  const params = new URLSearchParams();
  if (filters?.product_id) params.set("product_id", filters.product_id);
  if (filters?.search) params.set("search", filters.search);
  if (filters?.page_number) params.set("page_number", String(filters.page_number));
  if (filters?.page_size) params.set("page_size", String(filters.page_size));
  const qs = params.toString();
  return kiwifyFetch(config, "GET", `/webhooks${qs ? `?${qs}` : ""}`) as Promise<KiwifyPaginated<KiwifyWebhook>>;
}

export async function kiwifyCreateWebhook(
  config: KiwifyConfig,
  data: { name: string; url: string; products: string; triggers: string[]; token: string },
): Promise<KiwifyWebhook> {
  return kiwifyFetch(config, "POST", "/webhooks", data) as Promise<KiwifyWebhook>;
}

export async function kiwifyDeleteWebhook(config: KiwifyConfig, id: string): Promise<void> {
  await kiwifyFetch(config, "DELETE", `/webhooks/${encodeURIComponent(id)}`);
}

// ─── Utility: payload hash for idempotency ──────────────────────────────────

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ─── Plan mapping helpers ───────────────────────────────────────────────────

export interface KiwifyPlanMapping {
  id: string;
  plan_id: string;
  period_type: string;
  kiwify_product_id: string;
  kiwify_product_name: string;
  kiwify_checkout_url: string;
  affiliate_enabled: boolean;
  affiliate_commission_percent: number;
  is_active: boolean;
}

export type KiwifyPeriodType = "monthly" | "quarterly" | "semiannual" | "annual";

function normalizePeriodToken(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function normalizeKiwifyPeriodType(raw: unknown): KiwifyPeriodType | null {
  const value = normalizePeriodToken(String(raw ?? ""));
  if (!value) return null;

  if (value === "monthly" || value === "mensal") return "monthly";
  if (value === "quarterly" || value === "trimestral") return "quarterly";
  if (value === "semiannual" || value === "semi-annual" || value === "semestral") return "semiannual";
  if (value === "annual" || value === "anual" || value === "yearly" || value === "year") return "annual";

  if (value.includes("semes")) return "semiannual";
  if (value.includes("semi") && value.includes("an")) return "semiannual";
  if (value.includes("quarter") || value.includes("trimes")) return "quarterly";
  if (value.includes("annual") || value.includes("anual") || value.includes("year")) return "annual";
  if (value.includes("month") || value.includes("mens")) return "monthly";

  if (/^3\s*(m|mes|meses|month|months)$/.test(value)) return "quarterly";
  if (/^6\s*(m|mes|meses|month|months)$/.test(value)) return "semiannual";
  if (/^12\s*(m|mes|meses|month|months)$/.test(value)) return "annual";
  if (/^1\s*(m|mes|month)$/.test(value)) return "monthly";

  return null;
}

function readPath(input: unknown, path: string[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function extractKiwifyPeriodTypeHint(payload: unknown): KiwifyPeriodType | null {
  const direct = normalizeKiwifyPeriodType(payload);
  if (direct) return direct;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const candidates: unknown[] = [
    readPath(payload, ["period_type"]),
    readPath(payload, ["periodType"]),
    readPath(payload, ["billing_period"]),
    readPath(payload, ["billingPeriod"]),
    readPath(payload, ["subscription_period"]),
    readPath(payload, ["subscriptionPeriod"]),
    readPath(payload, ["cycle"]),
    readPath(payload, ["recurrence"]),
    readPath(payload, ["frequency"]),
    readPath(payload, ["sale_type"]),
    readPath(payload, ["type"]),
    readPath(payload, ["Subscription", "plan", "id"]),
    readPath(payload, ["Subscription", "plan", "name"]),
    readPath(payload, ["subscription", "plan", "id"]),
    readPath(payload, ["subscription", "plan", "name"]),
    readPath(payload, ["Product", "name"]),
    readPath(payload, ["product", "name"]),
    readPath(payload, ["product_name"]),
    readPath(payload, ["plan_name"]),
    readPath(payload, ["offer_name"]),
    readPath(payload, ["offer", "name"]),
    readPath(payload, ["title"]),
    readPath(payload, ["name"]),
  ];

  for (const candidate of candidates) {
    const parsed = normalizeKiwifyPeriodType(candidate);
    if (parsed) return parsed;
  }

  return null;
}

export async function loadPlanMappings(): Promise<KiwifyPlanMapping[]> {
  // Returns ALL mappings (active and inactive) for admin use.
  // Runtime lookup uses findPlanByKiwifyProduct() which filters active mappings
  // and disambiguates by period hint when available.
  const rows = await query("SELECT * FROM kiwify_plan_mappings ORDER BY plan_id");
  return rows as KiwifyPlanMapping[];
}

export async function findPlanByKiwifyProduct(
  kiwifyProductId: string,
  periodHint?: unknown,
): Promise<KiwifyPlanMapping | null> {
  const rows = await query(
    `SELECT *
       FROM kiwify_plan_mappings
      WHERE kiwify_product_id = $1
        AND is_active = TRUE
      ORDER BY updated_at DESC, created_at DESC, period_type ASC`,
    [kiwifyProductId],
  ) as KiwifyPlanMapping[];

  if (!rows.length) return null;

  const normalizedHint = normalizeKiwifyPeriodType(periodHint);
  if (normalizedHint) {
    const exact = rows.find((row) => normalizeKiwifyPeriodType(row.period_type) === normalizedHint);
    if (exact) return exact;
  }

  if (rows.length === 1) return rows[0];
  return null;
}

export async function savePlanMapping(data: {
  plan_id: string;
  period_type: string;
  kiwify_product_id: string;
  kiwify_product_name: string;
  kiwify_checkout_url: string;
  affiliate_enabled: boolean;
  affiliate_commission_percent: number;
  is_active: boolean;
}): Promise<void> {
  await execute(
    `INSERT INTO kiwify_plan_mappings
      (plan_id, period_type, kiwify_product_id, kiwify_product_name, kiwify_checkout_url,
       affiliate_enabled, affiliate_commission_percent, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (plan_id, period_type) DO UPDATE SET
       kiwify_product_id = EXCLUDED.kiwify_product_id,
       kiwify_product_name = EXCLUDED.kiwify_product_name,
       kiwify_checkout_url = EXCLUDED.kiwify_checkout_url,
       affiliate_enabled = EXCLUDED.affiliate_enabled,
       affiliate_commission_percent = EXCLUDED.affiliate_commission_percent,
       is_active = EXCLUDED.is_active`,
    [data.plan_id, data.period_type, data.kiwify_product_id, data.kiwify_product_name,
     data.kiwify_checkout_url, data.affiliate_enabled, data.affiliate_commission_percent, data.is_active]
  );
}

export async function deletePlanMapping(planId: string, periodType?: string): Promise<void> {
  if (periodType) {
    await execute("DELETE FROM kiwify_plan_mappings WHERE plan_id = $1 AND period_type = $2", [planId, periodType]);
  } else {
    await execute("DELETE FROM kiwify_plan_mappings WHERE plan_id = $1", [planId]);
  }
}
