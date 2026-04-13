import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { load } from "cheerio";
import { execute, query, queryOne, transaction } from "./db.js";

export type AmazonVitrineTabKey = "destaques" | "top_performance" | "mais_vendidos" | "ofertas_quentes" | "melhor_avaliados";

export type AmazonVitrineTabConfig = {
  key: AmazonVitrineTabKey;
  label: string;
};

const AMAZON_VITRINE_SYNC_INTERVAL_MS = Number.parseInt(
  process.env.AMAZON_VITRINE_SYNC_INTERVAL_MS || "86400000",
  10
); // 24 horas
const AMAZON_VITRINE_FETCH_TIMEOUT_MS = Number.parseInt(
  process.env.AMAZON_VITRINE_FETCH_TIMEOUT_MS || "20000",
  10
);
const AMAZON_VITRINE_FETCH_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.AMAZON_VITRINE_FETCH_MAX_ATTEMPTS || "5", 10)
);
const AMAZON_VITRINE_FETCH_RETRY_BASE_MS = Math.max(
  150,
  Number.parseInt(process.env.AMAZON_VITRINE_FETCH_RETRY_BASE_MS || "700", 10)
);
const AMAZON_VITRINE_IMAGE_FETCH_DELAY_MS = 1000; // 1 segundo entre fetches de imagem
const AMAZON_VITRINE_IMAGE_FETCH_TIMEOUT_MS = 5000; // 5 segundos timeout para fetch de imagem
const AMAZON_VITRINE_EMPTY_AUTO_SYNC_COOLDOWN_MS = Math.max(
  60_000,
  Number.parseInt(process.env.AMAZON_VITRINE_EMPTY_AUTO_SYNC_COOLDOWN_MS || "600000", 10)
);
const AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE = Math.max(
  20,
  Number.parseInt(process.env.AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE || "120", 10)
);
const AMAZON_VITRINE_TARGET_ACTIVE_PER_TAB = Math.max(
  20,
  Number.parseInt(process.env.AMAZON_VITRINE_TARGET_ACTIVE_PER_TAB || "200", 10)
);
const AMAZON_VITRINE_SYNC_RUNS_RETENTION_DAYS = Math.max(
  7,
  Number.parseInt(process.env.AMAZON_VITRINE_SYNC_RUNS_RETENTION_DAYS || "30", 10)
);
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const AMAZON_BASE_URL = "https://www.amazon.com.br";
const DEFAULT_TAB_KEY: AmazonVitrineTabKey = "destaques";
const BLOCKED_HTML_MARKERS = [
  "captcha",
  "verifique que voce e humano",
  "acesso denegado",
  "access denied",
  "too many requests",
  "request blocked",
  "solicitacao bloqueada",
  "algo deu errado",
  "something went wrong",
];

const AMAZON_VITRINE_TAB_ALIAS_MAP: Record<string, AmazonVitrineTabKey> = {
  all: "destaques",
  destaques: "destaques",
  melhor_avaliados: "melhor_avaliados",
  top_performance: "top_performance",
  mais_vendidos: "mais_vendidos",
  ofertas_quentes: "ofertas_quentes",
};

export const AMAZON_VITRINE_TABS: AmazonVitrineTabConfig[] = [
  {
    key: "destaques",
    label: "Destaques",
  },
  {
    key: "top_performance",
    label: "Top Performance",
  },
  {
    key: "mais_vendidos",
    label: "Mais Vendidos",
  },
  {
    key: "ofertas_quentes",
    label: "Ofertas Quentes",
  },
  {
    key: "melhor_avaliados",
    label: "Melhor Avaliados",
  },
];

const AMAZON_VITRINE_SOURCE_POOL = [
  "https://www.amazon.com.br/events/ofertasmensais",
  "https://www.amazon.com.br/gp/movers-and-shakers/kitchen/ref=zg_bsms_kitchen_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/hpc/ref=zg_bsms_hpc_sm",
  "https://www.amazon.com.br/events/ofertasmensais?bubble-id=discounts-collection-for-you",
  "https://www.amazon.com.br/gp/movers-and-shakers/sports/ref=zg_bsms_sports_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/fashion/ref=zg_bsms_fashion_sm",
  "https://www.amazon.com.br/events/ofertasmensais?bubble-id=deals-collection-pix",
  "https://www.amazon.com.br/gp/movers-and-shakers/home/ref=zg_bsms_home_sm",
  "https://www.amazon.com.br/events/ofertasmensais?bubble-id=deals-todasofertas",
  "https://www.amazon.com.br/gp/movers-and-shakers/furniture/ref=zg_bsms_furniture_sm",
  "https://www.amazon.com.br/events/ofertasmensais?bubble-id=deals-maisamadas",
] as const;

const AMAZON_VITRINE_SUPPLEMENTAL_SOURCE_POOL = [
  "https://www.amazon.com.br/gp/movers-and-shakers/electronics/ref=zg_bsms_electronics_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/computers/ref=zg_bsms_computers_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/toys/ref=zg_bsms_toys_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/beauty/ref=zg_bsms_beauty_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/books/ref=zg_bsms_books_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/video-games/ref=zg_bsms_videogames_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/sporting-goods/ref=zg_bsms_sportinggoods_sm",
  "https://www.amazon.com.br/gp/movers-and-shakers/automotive/ref=zg_bsms_automotive_sm",
] as const;

type ExtractedProduct = {
  id: string;
  tab: AmazonVitrineTabKey;
  sourceUrl: string;
  asin: string;
  productUrl: string;
  title: string;
  imageUrl: string;
  priceCents: number;
  oldPriceCents: number | null;
  discountText: string;
  seller: string;
  badgeText: string;
  payloadHash: string;
};

type ExistingRow = {
  product_url: string;
  payload_hash: string;
  is_active: boolean;
};

type LastSyncRow = {
  created_at: string;
  finished_at: string | null;
};

export type AmazonVitrineSyncResult = {
  success: boolean;
  skipped: boolean;
  source: string;
  scannedTabs: number;
  fetchedCards: number;
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  unchangedCount: number;
  lastSyncAt: string | null;
  message: string;
};

export type AmazonVitrineListResult = {
  tab: AmazonVitrineTabKey;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  items: Array<{
    id: string;
    tab: AmazonVitrineTabKey;
    sourceUrl: string;
    asin: string;
    title: string;
    productUrl: string;
    imageUrl: string;
    price: number;
    oldPrice: number | null;
    discountText: string;
    seller: string;
    badgeText: string;
    collectedAt: string;
  }>;
  tabs: Array<{ key: AmazonVitrineTabKey; label: string; activeCount: number }>;
  lastSyncAt: string | null;
  stale: boolean;
};

export type AmazonProductSnapshot = {
  productUrl: string;
  title: string;
  imageUrl: string;
  price: number | null;
  oldPrice: number | null;
  discountText: string;
  installmentsText: string;
  seller: string;
  rating: number | null;
  reviewsCount: number | null;
  badgeText: string;
  asin?: string;
};

// Utility functions
function normalizeText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeSearchableText(value: string): string {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function parseIntegerDigits(value: string): number {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return 0;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseAmountCentsFromCurrencyText(value: string): number {
  const normalized = normalizeText(value);
  if (!normalized) return 0;
  const match = normalized.match(/R\$\s*([\d.]+)(?:,(\d{1,2}))?/i);
  if (!match) return 0;
  const integerPart = Number.parseInt(String(match[1] || "").replace(/\./g, ""), 10);
  if (!Number.isFinite(integerPart) || integerPart <= 0) return 0;
  const centsRaw = String(match[2] || "").trim();
  const centsParsed = Number.parseInt(centsRaw.padEnd(2, "0").slice(0, 2), 10);
  const cents = Number.isFinite(centsParsed) ? Math.max(0, Math.min(99, centsParsed)) : 0;
  return integerPart * 100 + cents;
}

function parseStringifiedNumber(value: unknown): number | null {
  const raw = normalizeText(String(value || ""));
  if (!raw) return null;

  let normalized = raw.replace(/[R$\s]/gi, "").replace(/[^0-9.,-]/g, "");

  if (!normalized) return null;

  // 1.234,56 -> 1234.56
  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
    // 1,234.56 -> 1234.56
  } else if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/,/g, "");
    // 1234,56 -> 1234.56
  } else if (/^-?\d+,\d+$/.test(normalized)) {
    normalized = normalized.replace(",", ".");
    // 7.706 (reviews count) -> 7706
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function priceFromCents(value: number | null | undefined): number | null {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  return Number((Number(value) / 100).toFixed(2));
}

function pickFirstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeText(String(value || ""));
    if (normalized) return normalized;
  }
  return "";
}

function pickFirstPositiveNumber(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (Number.isFinite(Number(value)) && Number(value) > 0) {
      return Number(Number(value).toFixed(2));
    }
  }
  return null;
}

function extractRegexString(input: string, pattern: RegExp): string {
  const match = input.match(pattern);
  return match?.[1] ? normalizeText(String(match[1])) : "";
}

function extractRegexNumber(input: string, pattern: RegExp): number | null {
  const match = input.match(pattern);
  if (!match?.[1]) return null;
  return parseStringifiedNumber(match[1]);
}

function parseRatingValue(value: string): number | null {
  const normalized = normalizeText(value).replace(",", ".");
  if (!normalized) return null;
  const match = normalized.match(/([0-5](?:\.[0-9])?)/);
  if (!match?.[1]) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function parseReviewsCount(value: string): number | null {
  const parsed = parseIntegerDigits(value);
  return parsed > 0 ? parsed : null;
}

function normalizeInstallmentsText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  const match = normalized.match(/(\d{1,2})x\s*(?:de\s*)?R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) return normalized;
  const suffix = /sem juros/i.test(normalized) ? " sem juros" : "";
  return `${match[1]}x de R$${match[2]}${suffix}`.trim();
}

function sanitizeDiscountText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (!normalized.toLowerCase().includes("off") && /\d+\s*%/.test(normalized)) {
    return `${normalized} off`;
  }
  return normalized;
}

function sanitizeBadgeText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  return normalized;
}

function normalizeSeller(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";

  const soldByMatch = normalized.match(/vendido\s+por\s+([^.,|]+)(?:\s+e\s+entregue\s+por.*)?/i);
  if (soldByMatch?.[1]) return normalizeText(soldByMatch[1]);

  const cleaned = normalized
    .replace(/^marca\s*[:\-]\s*/i, "")
    .replace(/^visite\s+a\s+loja\s*/i, "")
    .replace(/^por\s+/i, "")
    .trim();

  return cleaned;
}

function deriveTitleFromAmazonUrl(productUrl: string): string {
  try {
    const parsed = new URL(productUrl);
    const chunks = parsed.pathname.split("/").filter(Boolean);
    if (chunks.length === 0) return "";

    const dpIndex = chunks.findIndex((chunk) => chunk.toLowerCase() === "dp");
    const slugCandidate = dpIndex > 0
      ? chunks[dpIndex - 1]
      : chunks[0];
    const decoded = decodeURIComponent(String(slugCandidate || ""));
    return normalizeText(decoded.replace(/[-_+]+/g, " "));
  } catch {
    return "";
  }
}

function extractPriceFromSelectors($: ReturnType<typeof load>, selectors: string[]): number | null {
  for (const selector of selectors) {
    const value = normalizeText($(selector).first().text());
    const cents = parseAmountCentsFromCurrencyText(value);
    if (cents > 0) return priceFromCents(cents);
  }
  return null;
}

function hasSnapshotCoreFields(snapshot: AmazonProductSnapshot | null | undefined): snapshot is AmazonProductSnapshot {
  if (!snapshot) return false;
  const hasPrice = Number.isFinite(Number(snapshot.price)) && Number(snapshot.price) > 0;
  return String(snapshot.title || "").trim().length > 0 && (hasPrice || !!snapshot.discountText || !!snapshot.imageUrl);
}

function scoreSnapshotCompleteness(snapshot: AmazonProductSnapshot | null | undefined): number {
  if (!snapshot) return 0;
  let score = 0;

  if (normalizeText(snapshot.title)) score += 2;
  if (Number.isFinite(Number(snapshot.price)) && Number(snapshot.price) > 0) score += 3;
  if (Number.isFinite(Number(snapshot.oldPrice)) && Number(snapshot.oldPrice) > 0) score += 1;
  if (normalizeText(snapshot.discountText)) score += 1;
  if (normalizeText(snapshot.installmentsText)) score += 1;
  if (normalizeText(snapshot.seller)) score += 1;
  if (normalizeText(snapshot.imageUrl)) score += 2;
  if (Number.isFinite(Number(snapshot.rating)) && Number(snapshot.rating) > 0) score += 1;
  if (Number.isFinite(Number(snapshot.reviewsCount)) && Number(snapshot.reviewsCount) > 0) score += 1;
  if (normalizeText(snapshot.asin)) score += 1;

  return score;
}

function buildSnapshotFetchCandidates(canonicalUrl: string, asinHint: string): string[] {
  const out = new Set<string>();
  if (asinHint) {
    out.add(`https://www.amazon.com.br/dp/${asinHint}`);
    out.add(`https://www.amazon.com.br/gp/product/${asinHint}`);
  }
  out.add(canonicalUrl);
  return [...out].filter(Boolean);
}

async function extractSnapshotFromLivePage(canonicalUrl: string, asinHint: string): Promise<AmazonProductSnapshot> {
  const html = await fetchHtml(canonicalUrl, { expectContent: false });
  const $ = load(html);

  const productUrl = canonicalizeProductUrl(pickFirstNonEmptyString(
    $("link[rel='canonical']").attr("href"),
    $("meta[property='og:url']").attr("content"),
    canonicalUrl,
  )) || canonicalUrl;

  const title = pickFirstNonEmptyString(
    $("meta[property='og:title']").attr("content"),
    $("#productTitle").first().text(),
    $("h1").first().text(),
    deriveTitleFromAmazonUrl(productUrl),
  );

  const imageUrl = upgradeAmazonThumbnailUrl(pickFirstNonEmptyString(
    $("meta[property='og:image']").attr("content"),
    $("#landingImage").attr("data-old-hires"),
    $("#landingImage").attr("src"),
    $("#imgTagWrapperId img").first().attr("data-old-hires"),
    $("#imgTagWrapperId img").first().attr("src"),
  ));

  const price = pickFirstPositiveNumber(
    extractPriceFromSelectors($, [
      "#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen",
      "#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen",
      "#corePrice_desktop .a-price:not(.a-text-price) .a-offscreen",
      "#priceblock_dealprice",
      "#priceblock_ourprice",
      "#price_inside_buybox",
    ]),
    extractRegexNumber(html, /\"priceAmount\"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i),
    extractRegexNumber(html, /\"price\"\s*:\s*\"?([0-9]+(?:\.[0-9]+)?)\"?/i),
  );

  const oldPrice = pickFirstPositiveNumber(
    extractPriceFromSelectors($, [
      "#corePriceDisplay_desktop_feature_div .a-price.a-text-price .a-offscreen",
      "#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen",
      "#corePrice_feature_div .a-price.a-text-price .a-offscreen",
      ".a-price[data-a-strike='true'] .a-offscreen",
      ".priceBlockStrikePriceString",
    ]),
    extractRegexNumber(html, /\"basisPrice\"[^}]*\"priceAmount\"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i),
    extractRegexNumber(html, /\"listPrice\"[^}]*\"amount\"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i),
  );

  let discountText = sanitizeDiscountText(pickFirstNonEmptyString(
    $("#corePriceDisplay_desktop_feature_div .savingsPercentage").first().text(),
    $("#corePrice_feature_div .savingsPercentage").first().text(),
    $(".reinventPriceSavingsPercentageMargin").first().text(),
    extractRegexString(html, /\"savingsPercentage\"\s*:\s*\"([^\"]+)\"/i),
  ));
  if (!discountText && Number.isFinite(Number(oldPrice)) && Number.isFinite(Number(price)) && Number(oldPrice) > Number(price) && Number(price) > 0) {
    const pct = Math.round((1 - Number(price) / Number(oldPrice)) * 100);
    if (pct > 0) discountText = `${pct}% off`;
  }

  const installmentsText = normalizeInstallmentsText(pickFirstNonEmptyString(
    $("#installmentCalculator_feature_div").first().text(),
    $("#financeOffers").first().text(),
    extractRegexString(html, /(\d{1,2}x\s*(?:de\s*)?R\$\s*[\d.]+(?:,\d{1,2})?(?:\s*sem\s*juros)?)/i),
  ));

  const seller = normalizeSeller(pickFirstNonEmptyString(
    $("#sellerProfileTriggerId").first().text(),
    $("#bylineInfo").first().text(),
    $("#merchant-info").first().text(),
    "Amazon",
  ));

  const rating = pickFirstPositiveNumber(
    parseRatingValue(String($("#acrPopover").attr("title") || "")),
    parseRatingValue($("#acrPopover").first().text()),
    extractRegexNumber(html, /\"averageRating\"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i),
  );

  const reviewsCount = pickFirstPositiveNumber(
    parseReviewsCount($("#acrCustomerReviewText").first().text()),
    extractRegexNumber(html, /\"totalReviewCount\"\s*:\s*([0-9.]+)/i),
  );

  const badgeText = sanitizeBadgeText(pickFirstNonEmptyString(
    $("#dealBadgeText").first().text(),
    $("#dealBadgeSupportingText").first().text(),
    $(".a-badge-text").first().text(),
  ));

  const asin = pickFirstNonEmptyString(
    $("#ASIN").attr("value"),
    extractRegexString(html, /\"asin\"\s*:\s*\"([A-Z0-9]{10})\"/i),
    asinHint,
    extractAsinFromUrl(productUrl),
  ).toUpperCase();

  return {
    productUrl,
    title,
    imageUrl,
    price,
    oldPrice: Number.isFinite(Number(oldPrice)) && Number(oldPrice) > Number(price || 0)
      ? oldPrice
      : oldPrice,
    discountText,
    installmentsText,
    seller,
    rating,
    reviewsCount,
    badgeText,
    asin: asin || undefined,
  };
}

export async function getAmazonProductSnapshot(rawUrl: string): Promise<AmazonProductSnapshot> {
  const canonicalUrl = canonicalizeProductUrl(rawUrl);
  if (!canonicalUrl) {
    throw new Error("URL do produto invalida para extracao.");
  }

  const asinHint = normalizeText(extractAsinFromUrl(canonicalUrl)).toUpperCase();
  const fetchCandidates = buildSnapshotFetchCandidates(canonicalUrl, asinHint);
  let bestSnapshot: AmazonProductSnapshot | null = null;

  for (const targetUrl of fetchCandidates) {
    try {
      const snapshot = await extractSnapshotFromLivePage(targetUrl, asinHint);
      if (hasSnapshotCoreFields(snapshot)) {
        return snapshot;
      }

      if (scoreSnapshotCompleteness(snapshot) > scoreSnapshotCompleteness(bestSnapshot)) {
        bestSnapshot = snapshot;
      }
    } catch {
      // Try next candidate URL.
    }
  }

  if (bestSnapshot) {
    return bestSnapshot;
  }

  const fallbackProductUrl = asinHint ? `https://www.amazon.com.br/dp/${asinHint}` : canonicalUrl;
  const fallbackTitle = deriveTitleFromAmazonUrl(canonicalUrl) || deriveTitleFromAmazonUrl(fallbackProductUrl);

  return {
    productUrl: fallbackProductUrl,
    title: fallbackTitle || "Produto Amazon",
    imageUrl: "",
    price: null,
    oldPrice: null,
    discountText: "",
    installmentsText: "",
    seller: "Amazon",
    rating: null,
    reviewsCount: null,
    badgeText: "",
    asin: asinHint || undefined,
  };
}

function extractAsinFromUrl(url: string): string {
  const match = String(url || "").match(/\/dp\/([A-Z0-9]{10})/i);
  return match?.[1] || "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toCents(value: number | null): number {
  if (!Number.isFinite(value) || value === null || value <= 0) return 0;
  return Math.round(value * 100);
}

function readNested(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function extractContentFragmentsText(content: unknown): string {
  if (!isRecord(content)) return "";
  const fragments = content.fragments;
  if (!Array.isArray(fragments)) return "";
  const text = fragments
    .map((fragment) => (isRecord(fragment) ? normalizeText(String(fragment.text || "")) : ""))
    .filter(Boolean)
    .join(" ");
  return normalizeText(text);
}

function buildImageUrlFromAsset(asset: unknown): string {
  if (!isRecord(asset)) return "";

  const directCandidates = [
    normalizeText(String(asset.url || "")),
    normalizeText(String(asset.src || "")),
    normalizeText(String(asset.sourceUrl || "")),
  ];
  const direct = directCandidates.find(Boolean) || "";
  if (direct) return direct;

  const baseUrl = normalizeText(String(asset.baseUrl || ""));
  const extension = normalizeText(String(asset.extension || "")).replace(/^\./, "");
  if (baseUrl && extension) return `${baseUrl}.${extension}`;
  return baseUrl;
}

function extractBalancedJsonObject(input: string, startIndex: number): string | null {
  let index = startIndex;
  while (index < input.length && input[index] !== "{") {
    index += 1;
  }
  if (index >= input.length) return null;

  const begin = index;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(begin, index + 1);
      }
    }
  }

  return null;
}

function extractMountedWidgetConfigs(html: string): Record<string, unknown>[] {
  const configs: Record<string, unknown>[] = [];
  const mountWidgetPattern = /mountWidget\(\s*['"][^'"]+['"]\s*,/g;

  for (const match of html.matchAll(mountWidgetPattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const jsonObject = extractBalancedJsonObject(html, start);
    if (!jsonObject) continue;
    try {
      const parsed = JSON.parse(jsonObject);
      if (isRecord(parsed)) {
        configs.push(parsed);
      }
    } catch {
      // Ignore malformed payloads from unrelated widgets.
    }
  }

  return configs;
}

function extractProductsFromDiscountWidget(
  html: string,
  tabKey: AmazonVitrineTabKey,
  sourceUrl: string
): ExtractedProduct[] {
  const configs = extractMountedWidgetConfigs(html);
  if (configs.length === 0) return [];

  for (const config of configs) {
    const widgetType = normalizeSearchableText(String(config.widgetType || ""));
    const productSearchResponse = isRecord(config.productSearchResponse) ? config.productSearchResponse : null;
    const rawProducts = Array.isArray(productSearchResponse?.products) ? productSearchResponse.products : [];

    if (rawProducts.length === 0) continue;
    if (widgetType && widgetType !== "discount-asin-grid") continue;

    const products: ExtractedProduct[] = [];
    const seenUrls = new Set<string>();

    for (const rawProduct of rawProducts) {
      if (products.length >= AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE) break;
      if (!isRecord(rawProduct)) continue;

      const href = normalizeText(String(rawProduct.link || rawProduct.productUrl || ""));
      const asin = normalizeText(String(rawProduct.asin || extractAsinFromUrl(href)));
      if (!asin) continue;

      const productUrl = canonicalizeProductUrl(href || `/dp/${asin}`);
      if (!productUrl || seenUrls.has(productUrl)) continue;

      const title = normalizeText(
        String(
          rawProduct.title ||
          readNested(rawProduct, ["image", "altText"]) ||
          readNested(rawProduct, ["name"]) ||
          ""
        )
      );
      if (!title || title.length < 5) continue;

      const image = isRecord(rawProduct.image) ? rawProduct.image : null;
      const rawImageUrl =
        buildImageUrlFromAsset(image?.hiRes) ||
        buildImageUrlFromAsset(image?.lowRes) ||
        buildImageUrlFromAsset(image);
      const imageUrl = upgradeAmazonThumbnailUrl(rawImageUrl);
      if (!imageUrl) continue;

      const price = isRecord(rawProduct.price) ? rawProduct.price : null;
      const priceToPay = isRecord(price?.priceToPay) ? price.priceToPay : null;
      const basisPrice = isRecord(price?.basisPrice) ? price.basisPrice : null;

      const currentPrice = parseStringifiedNumber(priceToPay?.price || rawProduct.priceToPay || "");
      const priceCents = toCents(currentPrice);
      if (priceCents <= 0) continue;

      const oldPrice = parseStringifiedNumber(basisPrice?.price || rawProduct.basisPrice || "");
      const oldPriceCents = toCents(oldPrice);

      let discountText = normalizeText(
        extractContentFragmentsText(readNested(rawProduct, ["dealBadge", "label", "content"]))
      );
      if (discountText && !discountText.toLowerCase().includes("off") && /\d+\s*%/.test(discountText)) {
        discountText = `${discountText} off`;
      }
      if (!discountText && oldPriceCents > priceCents) {
        const pct = Math.round((1 - priceCents / oldPriceCents) * 100);
        if (pct > 0) discountText = `${pct}% off`;
      }

      const badgeText = normalizeText(
        extractContentFragmentsText(readNested(rawProduct, ["dealBadge", "messaging", "content"]))
      );

      const seller = normalizeText(
        String(
          readNested(rawProduct, ["brandLogo", "altText"]) ||
          readNested(rawProduct, ["brand", "name"]) ||
          "Amazon"
        )
      );

      const base: Omit<ExtractedProduct, "payloadHash"> = {
        id: buildProductId(tabKey, productUrl),
        tab: tabKey,
        sourceUrl,
        asin,
        productUrl,
        title,
        imageUrl,
        priceCents,
        oldPriceCents: oldPriceCents > priceCents ? oldPriceCents : null,
        discountText,
        seller: seller || "Amazon",
        badgeText,
      };

      seenUrls.add(productUrl);
      products.push({ ...base, payloadHash: buildPayloadHash(base) });
    }

    if (products.length > 0) {
      return products.slice(0, AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE);
    }
  }

  return [];
}

function extractProductsFromDclGrid(
  $: ReturnType<typeof load>,
  tabKey: AmazonVitrineTabKey,
  sourceUrl: string
): ExtractedProduct[] {
  const wrappers = $(".dcl-product-wrapper").toArray();
  const fallbackNodes = wrappers.length > 0 ? wrappers : $(".a-cardui.dcl-product").toArray();

  const products: ExtractedProduct[] = [];
  const seenUrls = new Set<string>();

  for (const node of fallbackNodes) {
    if (products.length >= AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE) break;

    const root = $(node).hasClass("dcl-product-wrapper")
      ? ($(node).find(".a-cardui.dcl-product").first().length ? $(node).find(".a-cardui.dcl-product").first() : $(node))
      : $(node);

    const href = normalizeText(root.find("a[href*='/dp/']").first().attr("href") || "");
    const asin = extractAsinFromUrl(href);
    if (!asin) continue;

    const productUrl = canonicalizeProductUrl(href);
    if (!productUrl || seenUrls.has(productUrl)) continue;

    const rawImgUrl = normalizeText(
      root.find("img").first().attr("src") ||
      root.find("img").first().attr("data-src") ||
      ""
    );
    const imageUrl = upgradeAmazonThumbnailUrl(rawImgUrl);
    if (!imageUrl) continue;

    const title = normalizeText(
      root.find("img").first().attr("alt") ||
      root.find("a[href*='/dp/']").first().attr("title") ||
      root.find("[class*='title']").first().text() ||
      ""
    );
    if (!title || title.length < 5) continue;

    const priceCents = parseAmountCentsFromCurrencyText(
      root.find(".dcl-product-price-new .a-offscreen, .a-price:not(.a-text-price) .a-offscreen").first().text()
    );
    if (priceCents <= 0) continue;

    const oldPriceCents = parseAmountCentsFromCurrencyText(
      root.find(".dcl-product-price-old .a-offscreen, .a-text-price .a-offscreen").first().text()
    );

    let discountText = normalizeText(root.find("[class*='badgeLabel']").first().text()).replace(/^-/, "").trim();
    if (discountText && !discountText.toLowerCase().includes("off") && /\d+\s*%/.test(discountText)) {
      discountText = `${discountText} off`;
    }
    if (!discountText && oldPriceCents > priceCents) {
      const pct = Math.round((1 - priceCents / oldPriceCents) * 100);
      if (pct > 0) discountText = `${pct}% off`;
    }

    const badgeText = normalizeText(root.find("[class*='badgeMessage']").first().text());

    const base: Omit<ExtractedProduct, "payloadHash"> = {
      id: buildProductId(tabKey, productUrl),
      tab: tabKey,
      sourceUrl,
      asin,
      productUrl,
      title,
      imageUrl,
      priceCents,
      oldPriceCents: oldPriceCents > priceCents ? oldPriceCents : null,
      discountText,
      seller: "Amazon",
      badgeText,
    };

    seenUrls.add(productUrl);
    products.push({ ...base, payloadHash: buildPayloadHash(base) });
  }

  return products.slice(0, AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE);
}

function extractProductsFromMoversGrid(
  $: ReturnType<typeof load>,
  tabKey: AmazonVitrineTabKey,
  sourceUrl: string
): ExtractedProduct[] {
  const cards = $(
    ".zg-grid-general-faceout, .p13n-sc-uncoverable-faceout, .zg-item"
  ).toArray();

  const products: ExtractedProduct[] = [];
  const seenUrls = new Set<string>();

  for (const node of cards) {
    if (products.length >= AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE) break;
    const root = $(node);

    const linkEl = root.find("a.a-link-normal.aok-block[href*='/dp/']").first().length > 0
      ? root.find("a.a-link-normal.aok-block[href*='/dp/']").first()
      : root.find("a[href*='/dp/']").first();
    const href = normalizeText(linkEl.attr("href") || "");
    const asin = extractAsinFromUrl(href);
    if (!asin) continue;

    const productUrl = canonicalizeProductUrl(href);
    if (!productUrl || seenUrls.has(productUrl)) continue;

    const rawImgUrl = normalizeText(
      root.find("img").first().attr("src")
      || root.find("img").first().attr("data-src")
      || ""
    );
    const imageUrl = upgradeAmazonThumbnailUrl(rawImgUrl);
    if (!imageUrl) continue;

    const title = normalizeText(
      root.find("[class*='p13n-sc-css-line-clamp']").first().text()
      || root.find("img").first().attr("alt")
      || linkEl.text()
      || ""
    );
    if (!title || title.length < 5) continue;

    const priceText = normalizeText(
      root.find("[class*='p13n-sc-price']").first().text()
      || root.find(".a-size-base.a-color-price").first().text()
      || root.find(".a-color-price").first().text()
    );
    const priceCents = parseAmountCentsFromCurrencyText(priceText);
    if (priceCents <= 0) continue;

    const oldPriceCents = parseAmountCentsFromCurrencyText(
      root.find(".a-text-strike, .a-color-secondary .a-text-normal").first().text()
    );

    const badgeText = normalizeText(root.find(".zg-bdg-text").first().text());
    let discountText = "";
    if (oldPriceCents > priceCents) {
      const pct = Math.round((1 - priceCents / oldPriceCents) * 100);
      if (pct > 0) discountText = `${pct}% off`;
    }

    const base: Omit<ExtractedProduct, "payloadHash"> = {
      id: buildProductId(tabKey, productUrl),
      tab: tabKey,
      sourceUrl,
      asin,
      productUrl,
      title,
      imageUrl,
      priceCents,
      oldPriceCents: oldPriceCents > priceCents ? oldPriceCents : null,
      discountText,
      seller: "Amazon",
      badgeText,
    };

    seenUrls.add(productUrl);
    products.push({ ...base, payloadHash: buildPayloadHash(base) });
  }

  return products.slice(0, AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE);
}

function normalizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  return normalizeText(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function toAbsoluteUrl(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value, AMAZON_BASE_URL).toString();
  } catch {
    return "";
  }
}

// Upgrade Amazon CDN thumbnail URLs to larger version by removing size restrictions.
// e.g. ._AC_UL320_.jpg -> .jpg  (Amazon CDN serves original if no directive)
function upgradeAmazonThumbnailUrl(raw: string): string {
  const absolute = toAbsoluteUrl(raw);
  if (!absolute) return "";
  // Remove inline sizing directives like ._AC_UL320_. ._SX300_. ._AC_SR400,300_.
  return absolute.replace(/\._[A-Z0-9_,]+_(?=\.(jpg|jpeg|png|gif|webp)(\?|$))/i, "");
}

function canonicalizeProductUrl(raw: string): string {
  const absolute = toAbsoluteUrl(raw);
  if (!absolute) return "";

  try {
    const parsed = new URL(absolute);
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return absolute;
  }
}

function isBlockedHtml(value: string): boolean {
  const head = normalizeSearchableText(String(value || "").slice(0, 80_000));
  if (!head) return false;
  return BLOCKED_HTML_MARKERS.some((marker) => head.includes(marker));
}

function buildProductId(tab: AmazonVitrineTabKey, productUrl: string): string {
  return createHash("sha1").update(`${tab}::${productUrl}`).digest("hex");
}

function buildPayloadHash(input: Omit<ExtractedProduct, "payloadHash">): string {
  const payload = JSON.stringify({
    title: input.title,
    imageUrl: input.imageUrl,
    priceCents: input.priceCents,
    oldPriceCents: input.oldPriceCents,
    discountText: input.discountText,
    seller: input.seller,
    badgeText: input.badgeText,
  });
  return createHash("sha1").update(payload).digest("hex");
}

// HTTP fetch with retry logic
async function fetchHtml(url: string, options: { expectContent?: boolean } = {}): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= AMAZON_VITRINE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": BROWSER_UA,
          "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
          accept: "text/html,application/xhtml+xml",
          referer: AMAZON_BASE_URL,
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
        signal: AbortSignal.timeout(Math.max(5000, AMAZON_VITRINE_FETCH_TIMEOUT_MS)),
      });

      const html = await response.text();
      if (!response.ok) {
        const suffix = normalizeText(html.slice(0, 180));
        throw new Error(`HTTP ${response.status}${suffix ? ` - ${suffix}` : ""}`);
      }

      if (isBlockedHtml(html)) {
        throw new Error("página bloqueada por anti-bot/captcha");
      }

      return html;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || "erro desconhecido"));
      if (attempt >= AMAZON_VITRINE_FETCH_MAX_ATTEMPTS) break;
      const retryDelayMs = AMAZON_VITRINE_FETCH_RETRY_BASE_MS * attempt + Math.floor(Math.random() * 250);
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`Falha ao buscar ${url}: ${normalizeErrorMessage(lastError) || "erro desconhecido"}`);
}

// Extract products from HTML list page.
// Supports two Amazon page types:
//   Strategy 1 — Search result pages (/s?...): [data-component-type="s-search-result"]
//   Strategy 2 — Bestseller pages (/gp/bestsellers/...): .zg-item-immersion / [id^=gridItemRoot_]
// Images are extracted directly from the list page (no secondary fetch needed).
function extractProductsFromHtml(html: string, tabKey: AmazonVitrineTabKey, sourceUrl: string): ExtractedProduct[] {
  const $ = load(html);

  const widgetProducts = extractProductsFromDiscountWidget(html, tabKey, sourceUrl);
  if (widgetProducts.length > 0) {
    return widgetProducts;
  }

  const dclProducts = extractProductsFromDclGrid($, tabKey, sourceUrl);
  if (dclProducts.length > 0) {
    return dclProducts;
  }

  const moversProducts = extractProductsFromMoversGrid($, tabKey, sourceUrl);
  if (moversProducts.length > 0) {
    return moversProducts;
  }

  const products: ExtractedProduct[] = [];
  const seenUrls = new Set<string>();

  // ── Strategy 1: Amazon search result page ─────────────────────────────────
  const searchItems = $('[data-component-type="s-search-result"][data-asin]').toArray();

  for (const el of searchItems) {
    if (products.length >= AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE) break;

    const asin = normalizeText($(el).attr("data-asin") ?? "");
    if (!asin || !/^[A-Z0-9]{8,12}$/i.test(asin)) continue;

    // Image — mandatory; skip if absent
    const rawImgUrl =
      $(el).find("img.s-image").first().attr("src") ??
      $(el).find("img[data-src*='media-amazon']").first().attr("data-src") ??
      "";
    const imageUrl = upgradeAmazonThumbnailUrl(rawImgUrl);
    if (!imageUrl) continue;

    // Product URL
    const href =
      $(el).find("h2 a[href*='/dp/']").first().attr("href") ??
      $(el).find("a[href*='/dp/']").first().attr("href") ??
      "";
    const productUrl = canonicalizeProductUrl(href);
    if (!productUrl || seenUrls.has(productUrl)) continue;

    // Title
    const title = normalizeText(
      $(el).find("h2 a span.a-text-normal, h2 a span, h2 a").first().text() ||
      $(el).find("[data-cy='title-recipe'] a span").first().text()
    );
    if (!title || title.length < 5) continue;

    // Current price (.a-price without struck-through / a-text-price)
    const priceCents = parseAmountCentsFromCurrencyText(
      $(el).find(".a-price:not(.a-text-price) .a-offscreen").first().text()
    );
    if (priceCents <= 0) continue;

    // Old price (struck-through)
    const oldPriceCents = parseAmountCentsFromCurrencyText(
      $(el).find(".a-text-price .a-offscreen, .a-price[data-a-strike='true'] .a-offscreen").first().text()
    );

    // Discount text
    let discountText = normalizeText($(el).find(".savingsPercentage").first().text())
      .replace(/^-/, "").trim();
    if (discountText && !discountText.toLowerCase().includes("off")) discountText += " off";
    if (!discountText && oldPriceCents > priceCents) {
      const pct = Math.round((1 - priceCents / oldPriceCents) * 100);
      if (pct > 0) discountText = `${pct}% off`;
    }

    // Badge
    const badgeText = normalizeText($(el).find(".a-badge-text").first().text());

    seenUrls.add(productUrl);
    const base: Omit<ExtractedProduct, "payloadHash"> = {
      id: buildProductId(tabKey, productUrl),
      tab: tabKey,
      sourceUrl,
      asin,
      productUrl,
      title,
      imageUrl,
      priceCents,
      oldPriceCents: oldPriceCents > priceCents ? oldPriceCents : null,
      discountText,
      seller: "Amazon",
      badgeText,
    };
    products.push({ ...base, payloadHash: buildPayloadHash(base) });
  }

  // ── Strategy 2: Bestseller page fallback ──────────────────────────────────
  if (products.length === 0) {
    const bsItems = $(
      "[id^='gridItemRoot_'], .zg-item-immersion, li.a-carousel-card"
    ).toArray();

    for (const el of bsItems) {
      if (products.length >= AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE) break;

      const asinLink = $(el).find("a[href*='/dp/']").first();
      const href = asinLink.attr("href") ?? "";
      const asin = extractAsinFromUrl(href);
      if (!asin) continue;

      const productUrl = canonicalizeProductUrl(href);
      if (!productUrl || seenUrls.has(productUrl)) continue;

      const rawImgUrl = $(el).find("img[src*='media-amazon']").first().attr("src") ?? "";
      const imageUrl = upgradeAmazonThumbnailUrl(rawImgUrl);
      if (!imageUrl) continue;

      const title = normalizeText(
        $(el).find("[class*='line-clamp'] a, .p13n-sc-truncated").first().text() ||
        (asinLink.attr("title") ?? "")
      );
      if (!title || title.length < 5) continue;

      const priceCents = parseAmountCentsFromCurrencyText(
        $(el).find(".p13n-sc-price, [data-a-color='base'] .a-offscreen").first().text()
      );
      if (priceCents <= 0) continue;

      seenUrls.add(productUrl);
      const base: Omit<ExtractedProduct, "payloadHash"> = {
        id: buildProductId(tabKey, productUrl),
        tab: tabKey,
        sourceUrl,
        asin,
        productUrl,
        title,
        imageUrl,
        priceCents,
        oldPriceCents: null,
        discountText: "",
        seller: "Amazon",
        badgeText: "",
      };
      products.push({ ...base, payloadHash: buildPayloadHash(base) });
    }
  }

  return products.slice(0, AMAZON_VITRINE_MAX_PRODUCTS_PER_SOURCE);
}

function shuffleArray<T>(input: T[]): T[] {
  const out = [...input];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [out[index], out[randomIndex]] = [out[randomIndex], out[index]];
  }
  return out;
}

function assignProductToTab(product: ExtractedProduct, tabKey: AmazonVitrineTabKey): ExtractedProduct {
  const base: Omit<ExtractedProduct, "id" | "tab" | "payloadHash"> = {
    sourceUrl: product.sourceUrl,
    asin: product.asin,
    productUrl: product.productUrl,
    title: product.title,
    imageUrl: product.imageUrl,
    priceCents: product.priceCents,
    oldPriceCents: product.oldPriceCents,
    discountText: product.discountText,
    seller: product.seller,
    badgeText: product.badgeText,
  };

  return {
    ...base,
    id: buildProductId(tabKey, base.productUrl),
    tab: tabKey,
    payloadHash: buildPayloadHash({
      id: "",
      tab: tabKey,
      ...base,
    }),
  };
}

function distributeProductsAcrossTabs(products: ExtractedProduct[]): Map<AmazonVitrineTabKey, ExtractedProduct[]> {
  const distributed = new Map<AmazonVitrineTabKey, ExtractedProduct[]>();
  for (const tab of AMAZON_VITRINE_TABS) {
    distributed.set(tab.key, []);
  }

  if (products.length === 0) {
    return distributed;
  }

  for (let index = 0; index < AMAZON_VITRINE_TABS.length; index += 1) {
    const tab = AMAZON_VITRINE_TABS[index];
    const shuffled = shuffleArray(products);
    const startOffset = shuffled.length > 0
      ? (index * Math.floor(shuffled.length / Math.max(1, AMAZON_VITRINE_TABS.length))) % shuffled.length
      : 0;
    const rotated = [...shuffled.slice(startOffset), ...shuffled.slice(0, startOffset)];

    const selected: ExtractedProduct[] = [];
    const seenInTab = new Set<string>();

    for (const product of rotated) {
      if (selected.length >= AMAZON_VITRINE_TARGET_ACTIVE_PER_TAB) break;
      if (seenInTab.has(product.productUrl)) continue;
      seenInTab.add(product.productUrl);
      selected.push(assignProductToTab(product, tab.key));
    }

    distributed.set(tab.key, selected);
  }

  return distributed;
}

function normalizeTabKey(value: unknown): AmazonVitrineTabKey {
  const raw = String(value || "").trim().toLowerCase();
  const mapped = AMAZON_VITRINE_TAB_ALIAS_MAP[raw];
  if (mapped) return mapped;
  const found = AMAZON_VITRINE_TABS.find((tab) => tab.key === raw);
  return found ? found.key : DEFAULT_TAB_KEY;
}

function getSafePage(value: unknown): number {
  const parsed = Number.parseInt(String(value || "1"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

function getSafeLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || "50"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.max(1, Math.min(parsed, 50));
}

async function getLastSuccessfulSync(): Promise<LastSyncRow | null> {
  return await queryOne<LastSyncRow>(
    `SELECT created_at, finished_at
       FROM amazon_vitrine_sync_runs
      WHERE status = 'success'
      ORDER BY created_at DESC
      LIMIT 1`
  );
}

export async function isAmazonVitrineStale(): Promise<boolean> {
  const lastSync = await getLastSuccessfulSync();
  if (!lastSync?.created_at) return true;
  const lastMs = Date.parse(String(lastSync.finished_at || lastSync.created_at));
  if (!Number.isFinite(lastMs)) return true;
  return Date.now() - lastMs >= AMAZON_VITRINE_SYNC_INTERVAL_MS;
}

async function persistSyncError(input: { source: string; startedAt: string; message: string }) {
  await execute(
    `INSERT INTO amazon_vitrine_sync_runs
      (source, status, message, scanned_tabs, fetched_cards, added_count, updated_count, removed_count, unchanged_count, started_at, finished_at)
     VALUES ($1, 'error', $2, 0, 0, 0, 0, 0, 0, $3, NOW())`,
    [input.source, input.message, input.startedAt]
  );
}

async function purgeOldSyncRuns(client: PoolClient): Promise<number> {
  const result = await client.query(
    `DELETE FROM amazon_vitrine_sync_runs
      WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [AMAZON_VITRINE_SYNC_RUNS_RETENTION_DAYS]
  );
  return Math.max(0, result.rowCount || 0);
}

// Upsert products to database
async function upsertTabProducts(
  client: PoolClient,
  tab: AmazonVitrineTabConfig,
  products: ExtractedProduct[]
): Promise<{ added: number; updated: number; removed: number; unchanged: number }> {
  const existingRows = await client.query<ExistingRow>(
    `SELECT product_url, payload_hash, is_active
       FROM amazon_vitrine_products
      WHERE tab_key = $1`,
    [tab.key]
  );

  const existingByUrl = new Map<string, ExistingRow>();
  for (const row of existingRows.rows) {
    existingByUrl.set(String(row.product_url), row);
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const seen = new Set<string>();

  for (const product of products) {
    const existing = existingByUrl.get(product.productUrl);
    if (!existing) added += 1;
    else if (String(existing.payload_hash) !== product.payloadHash || !existing.is_active) updated += 1;
    else unchanged += 1;

    seen.add(product.productUrl);

    await client.query(
      `INSERT INTO amazon_vitrine_products
        (id, tab_key, source_url, asin, product_url, title, image_url, price_cents, old_price_cents, discount_text, seller, badge_text, payload_hash, is_active, first_seen_at, last_seen_at, collected_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,NOW(),NOW(),NOW())
       ON CONFLICT (tab_key, product_url) DO UPDATE
       SET id = EXCLUDED.id,
           source_url = EXCLUDED.source_url,
           asin = EXCLUDED.asin,
           title = EXCLUDED.title,
           image_url = EXCLUDED.image_url,
           price_cents = EXCLUDED.price_cents,
           old_price_cents = EXCLUDED.old_price_cents,
           discount_text = EXCLUDED.discount_text,
           seller = EXCLUDED.seller,
           badge_text = EXCLUDED.badge_text,
           payload_hash = EXCLUDED.payload_hash,
           is_active = TRUE,
           last_seen_at = NOW(),
           collected_at = NOW(),
           updated_at = NOW()`,
      [
        product.id,
        product.tab,
        product.sourceUrl,
        product.asin,
        product.productUrl,
        product.title,
        product.imageUrl,
        product.priceCents,
        product.oldPriceCents,
        product.discountText,
        product.seller,
        product.badgeText,
        product.payloadHash,
      ]
    );
  }

  const removedUrls = existingRows.rows
    .filter((row) => !seen.has(String(row.product_url)))
    .map((row) => String(row.product_url));

  let removed = 0;
  if (removedUrls.length > 0) {
    const result = await client.query(
      `DELETE FROM amazon_vitrine_products
        WHERE tab_key = $1
          AND product_url = ANY($2::text[])`,
      [tab.key, removedUrls]
    );
    removed = Math.max(0, result.rowCount || 0);
  }

  return { added, updated, removed, unchanged };
}

// Main sync function
async function syncAmazonVitrineInternal(
  input: {
    source?: string;
    force?: boolean;
    onlyIfStale?: boolean;
  } = {}
): Promise<AmazonVitrineSyncResult> {
  const source = normalizeText(String(input.source || "manual")) || "manual";
  const startedAt = new Date().toISOString();
  const onlyIfStale = input.onlyIfStale !== false;

  try {
    if (!input.force && onlyIfStale) {
      const stale = await isAmazonVitrineStale();
      if (!stale) {
        const lastSync = await getLastSuccessfulSync();
        return {
          success: true,
          skipped: true,
          source,
          scannedTabs: 0,
          fetchedCards: 0,
          addedCount: 0,
          updatedCount: 0,
          removedCount: 0,
          unchangedCount: 0,
          lastSyncAt: lastSync?.finished_at || lastSync?.created_at || null,
          message: "Sync ignorado porque a vitrine ainda está dentro da janela de 24h.",
        };
      }
    }

    const extractedByTab = new Map<AmazonVitrineTabKey, ExtractedProduct[]>();
    const extractionWarnings: string[] = [];
    let fetchedCards = 0;
    const uniqueProductsByUrl = new Map<string, ExtractedProduct>();
    const shuffledSources = shuffleArray<string>([...AMAZON_VITRINE_SOURCE_POOL]);
    const supplementalSources = shuffleArray<string>([...AMAZON_VITRINE_SUPPLEMENTAL_SOURCE_POOL])
      .filter((url) => !shuffledSources.includes(url));

    const ingestSource = async (sourceUrl: string) => {
      try {
        const html = await fetchHtml(sourceUrl);
        const extracted = extractProductsFromHtml(html, DEFAULT_TAB_KEY, sourceUrl);
        fetchedCards += extracted.length;

        if (extracted.length === 0) {
          extractionWarnings.push(`[source] sem produtos válidos em ${sourceUrl}`);
          return;
        }

        for (const product of extracted) {
          if (uniqueProductsByUrl.has(product.productUrl)) continue;
          uniqueProductsByUrl.set(product.productUrl, product);
        }
      } catch (sourceError) {
        extractionWarnings.push(`[source] ${sourceUrl}: ${normalizeErrorMessage(sourceError)}`);
      }
    };

    for (const sourceUrl of shuffledSources) {
      await ingestSource(sourceUrl);
    }

    if (uniqueProductsByUrl.size < AMAZON_VITRINE_TARGET_ACTIVE_PER_TAB) {
      for (const sourceUrl of supplementalSources) {
        await ingestSource(sourceUrl);
        if (uniqueProductsByUrl.size >= AMAZON_VITRINE_TARGET_ACTIVE_PER_TAB) {
          break;
        }
      }
    }

    if (uniqueProductsByUrl.size === 0) {
      const details = extractionWarnings
        .map((warning) => normalizeText(warning))
        .filter(Boolean)
        .slice(0, 5)
        .join(" | ");
      throw new Error(details ? `Nenhum produto válido encontrado. ${details}` : "Nenhum produto válido encontrado.");
    }

    const distributedByTab = distributeProductsAcrossTabs([...uniqueProductsByUrl.values()]);
    for (const tab of AMAZON_VITRINE_TABS) {
      const products = distributedByTab.get(tab.key) ?? [];
      if (products.length === 0) {
        extractionWarnings.push(`[${tab.key}] sem produtos após distribuição aleatória`);
      } else if (products.length < AMAZON_VITRINE_TARGET_ACTIVE_PER_TAB) {
        extractionWarnings.push(
          `[${tab.key}] abaixo da meta (${products.length}/${AMAZON_VITRINE_TARGET_ACTIVE_PER_TAB}) para a sessão atual`
        );
      }
      extractedByTab.set(tab.key, products);
    }

    const syncWarningMessage = extractionWarnings.length > 0
      ? normalizeText(extractionWarnings.slice(0, 10).join(" | ")).slice(0, 1900)
      : "";

    const counters = await transaction(async (client) => {
      let added = 0;
      let updated = 0;
      let removed = 0;
      let unchanged = 0;

      for (const tab of AMAZON_VITRINE_TABS) {
        const products = extractedByTab.get(tab.key) ?? [];

        const result = await upsertTabProducts(client, tab, products);
        added += result.added;
        updated += result.updated;
        removed += result.removed;
        unchanged += result.unchanged;
      }

      const purgedSyncRuns = await purgeOldSyncRuns(client);

      await client.query(
        `INSERT INTO amazon_vitrine_sync_runs
          (source, status, message, scanned_tabs, fetched_cards, added_count, updated_count, removed_count, unchanged_count, started_at, finished_at)
         VALUES ($1, 'success', $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [source, syncWarningMessage, extractedByTab.size, fetchedCards, added, updated, removed, unchanged, startedAt]
      );

      return { added, updated, removed, unchanged, purgedSyncRuns };
    });

    const lastSync = await getLastSuccessfulSync();
    return {
      success: true,
      skipped: false,
      source,
      scannedTabs: extractedByTab.size,
      fetchedCards,
      addedCount: counters.added,
      updatedCount: counters.updated,
      removedCount: counters.removed,
      unchangedCount: counters.unchanged,
      lastSyncAt: lastSync?.finished_at || lastSync?.created_at || null,
      message: extractionWarnings.length > 0
        ? `Sync da vitrine Amazon concluido com avisos (${extractedByTab.size}/${AMAZON_VITRINE_TABS.length} abas atualizadas).`
        : `Sync da vitrine Amazon concluido com sucesso.${counters.purgedSyncRuns > 0 ? ` Limpeza de ${counters.purgedSyncRuns} logs antigos.` : ""}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistSyncError({ source, startedAt, message }).catch(() => undefined);
    return {
      success: false,
      skipped: false,
      source,
      scannedTabs: 0,
      fetchedCards: 0,
      addedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      lastSyncAt: null,
      message,
    };
  }
}

let syncInFlight: Promise<AmazonVitrineSyncResult> | null = null;
let lastEmptyAutoSyncAtMs = 0;

export async function syncAmazonVitrine(
  input: {
    source?: string;
    force?: boolean;
    onlyIfStale?: boolean;
  } = {}
): Promise<AmazonVitrineSyncResult> {
  if (syncInFlight) {
    return await syncInFlight;
  }

  syncInFlight = syncAmazonVitrineInternal(input).finally(() => {
    syncInFlight = null;
  });

  return await syncInFlight;
}

// Fetch products from database
async function fetchAmazonVitrineListSnapshot(
  tab: AmazonVitrineTabKey,
  limit: number,
  offset: number
): Promise<{
  countRow: { total: string } | null;
  rows: Array<{
    id: string;
    tab_key: AmazonVitrineTabKey;
    source_url: string;
    asin: string;
    title: string;
    product_url: string;
    image_url: string;
    price_cents: number;
    old_price_cents: number | null;
    discount_text: string;
    seller: string;
    badge_text: string;
    collected_at: string;
  }>;
  tabRows: Array<{ tab_key: AmazonVitrineTabKey; active_count: string }>;
  lastSync: LastSyncRow | null;
}> {
  const [countRow, rows, tabRows, lastSync] = await Promise.all([
    queryOne<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM amazon_vitrine_products WHERE tab_key = $1 AND is_active = TRUE",
      [tab]
    ),
    query<{
      id: string;
      tab_key: AmazonVitrineTabKey;
      source_url: string;
      asin: string;
      title: string;
      product_url: string;
      image_url: string;
      price_cents: number;
      old_price_cents: number | null;
      discount_text: string;
      seller: string;
      badge_text: string;
      collected_at: string;
    }>(
      `SELECT id, tab_key, source_url, asin, title, product_url, image_url, price_cents, old_price_cents, discount_text, seller, badge_text, collected_at
         FROM amazon_vitrine_products
        WHERE tab_key = $1
          AND is_active = TRUE
        ORDER BY updated_at DESC, collected_at DESC
        LIMIT $2 OFFSET $3`,
      [tab, limit, offset]
    ),
    query<{ tab_key: AmazonVitrineTabKey; active_count: string }>(
      `SELECT tab_key, COUNT(*)::text AS active_count
         FROM amazon_vitrine_products
        WHERE is_active = TRUE
        GROUP BY tab_key`
    ),
    getLastSuccessfulSync(),
  ]);

  return { countRow, rows, tabRows, lastSync };
}

async function maybeAutoRecoverEmptyVitrine() {
  if (syncInFlight) {
    await syncInFlight.catch(() => undefined);
    return;
  }

  const now = Date.now();
  if (now - lastEmptyAutoSyncAtMs < AMAZON_VITRINE_EMPTY_AUTO_SYNC_COOLDOWN_MS) {
    return;
  }

  lastEmptyAutoSyncAtMs = now;
  await syncAmazonVitrine({
    source: "auto-empty-list",
    force: true,
    onlyIfStale: false,
  }).catch(() => undefined);
}

export async function listAmazonVitrine(input: {
  tab?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<AmazonVitrineListResult> {
  const tab = normalizeTabKey(input.tab);
  const page = getSafePage(input.page);
  const limit = getSafeLimit(input.limit);
  const offset = (page - 1) * limit;

  let snapshot = await fetchAmazonVitrineListSnapshot(tab, limit, offset);
  let total = Number.parseInt(String(snapshot.countRow?.total || "0"), 10) || 0;
  if (total <= 0) {
    await maybeAutoRecoverEmptyVitrine();
    snapshot = await fetchAmazonVitrineListSnapshot(tab, limit, offset);
    total = Number.parseInt(String(snapshot.countRow?.total || "0"), 10) || 0;
  }

  const { rows, tabRows, lastSync } = snapshot;
  const tabCountMap = new Map<AmazonVitrineTabKey, number>();
  for (const row of tabRows) {
    tabCountMap.set(row.tab_key, Number.parseInt(String(row.active_count || "0"), 10) || 0);
  }

  const tabs = AMAZON_VITRINE_TABS.map((item) => ({
    key: item.key,
    label: item.label,
    activeCount: tabCountMap.get(item.key) || 0,
  }));

  const lastSyncAt = lastSync?.finished_at || lastSync?.created_at || null;
  const stale = await isAmazonVitrineStale();

  return {
    tab,
    page,
    limit,
    total,
    hasMore: offset + rows.length < total,
    items: rows.map((row) => ({
      id: String(row.id),
      tab: row.tab_key,
      sourceUrl: String(row.source_url || ""),
      asin: String(row.asin || ""),
      title: String(row.title || ""),
      productUrl: String(row.product_url || ""),
      imageUrl: String(row.image_url || ""),
      price: Number((Number(row.price_cents || 0) / 100).toFixed(2)),
      oldPrice:
        row.old_price_cents === null || row.old_price_cents === undefined
          ? null
          : Number((Number(row.old_price_cents) / 100).toFixed(2)),
      discountText: String(row.discount_text || ""),
      seller: String(row.seller || ""),
      badgeText: String(row.badge_text || ""),
      collectedAt: String(row.collected_at || ""),
    })),
    tabs,
    lastSyncAt,
    stale,
  };
}
