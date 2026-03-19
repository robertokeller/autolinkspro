import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { load } from "cheerio";
import { execute, query, queryOne, transaction } from "./db.js";

export type MeliVitrineTabKey =
  | "top_performance"
  | "mais_vendidos"
  | "ofertas_quentes"
  | "melhor_avaliados";

export type MeliVitrineTabConfig = {
  key: MeliVitrineTabKey;
  label: string;
  sourceUrls: string[];
};

const MELI_VITRINE_SYNC_INTERVAL_MS = Number.parseInt(process.env.MELI_VITRINE_SYNC_INTERVAL_MS || "7200000", 10);
const MELI_VITRINE_FETCH_TIMEOUT_MS = Number.parseInt(process.env.MELI_VITRINE_FETCH_TIMEOUT_MS || "20000", 10);
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const MELI_BASE_URL = "https://www.mercadolivre.com.br";
const DEFAULT_TAB_KEY: MeliVitrineTabKey = "top_performance";
const PAUSED_AD_MARKERS = ["anuncio pausado", "publicacao pausada"];

const MELI_VITRINE_TAB_ALIAS_MAP: Record<string, MeliVitrineTabKey> = {
  all: "top_performance",
  top_performance: "top_performance",
  mais_vendidos: "mais_vendidos",
  ofertas_quentes: "ofertas_quentes",
  melhor_avaliados: "melhor_avaliados",
  beleza_cuidados: "top_performance",
  calcados_roupas_bolsas: "top_performance",
  casa_moveis_decoracao: "top_performance",
  celulares_telefones: "top_performance",
  construcao: "top_performance",
  eletrodomesticos: "top_performance",
  esportes_fitness: "top_performance",
  ferramentas: "top_performance",
  informatica: "top_performance",
  saude: "top_performance",
};

export const MELI_VITRINE_TABS: MeliVitrineTabConfig[] = [
  {
    key: "top_performance",
    label: "Top Performance",
    sourceUrls: [
      "https://www.mercadolivre.com.br/social/promozonevip/lists/bf623a1c-2a1f-43af-ab51-b5155a677a9e",
      "https://www.mercadolivre.com.br/social/tudonapromo/lists/b07d147c-7750-43cd-bb5a-852967804a73",
    ],
  },
  {
    key: "mais_vendidos",
    label: "Mais vendidos",
    sourceUrls: [
      "https://www.mercadolivre.com.br/social/ofertasgamer/lists/ffc82d3a-cf5e-436e-a2a8-f92f5ba79379?page=1",
      "https://www.mercadolivre.com.br/social/ta20250821221208/lists/cf0accd5-df65-4ad9-99be-ddd038ffad54",
    ],
  },
  {
    key: "ofertas_quentes",
    label: "Ofertas quentes",
    sourceUrls: [
      "https://www.mercadolivre.com.br/social/nn20251114221751/lists/b07d72f6-57d9-4170-9443-f6b07f340e82",
      "https://www.mercadolivre.com.br/social/fadadoscupons/lists/32815423-27cb-4651-8bb6-985183a5e0d8?page=3",
    ],
  },
  {
    key: "melhor_avaliados",
    label: "Melhor Avaliados",
    sourceUrls: [
      "https://www.mercadolivre.com.br/social/nn20251114221751/lists/b07d72f6-57d9-4170-9443-f6b07f340e82",
      "https://www.mercadolivre.com.br/social/rogenevinicius/lists/d62a0a62-343e-4c4a-994e-b92693de660f",
    ],
  },
];

type ExtractedProduct = {
  id: string;
  tab: MeliVitrineTabKey;
  sourceUrl: string;
  productUrl: string;
  title: string;
  imageUrl: string;
  priceCents: number;
  oldPriceCents: number | null;
  discountText: string;
  seller: string;
  rating: number | null;
  reviewsCount: number | null;
  shippingText: string;
  installmentsText: string;
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

export type MeliVitrineSyncResult = {
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

export type MeliVitrineListResult = {
  tab: MeliVitrineTabKey;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  items: Array<{
    id: string;
    tab: MeliVitrineTabKey;
    sourceUrl: string;
    title: string;
    productUrl: string;
    imageUrl: string;
    price: number;
    oldPrice: number | null;
    discountText: string;
    seller: string;
    rating: number | null;
    reviewsCount: number | null;
    shippingText: string;
    installmentsText: string;
    badgeText: string;
    collectedAt: string;
  }>;
  tabs: Array<{ key: MeliVitrineTabKey; label: string; activeCount: number }>;
  lastSyncAt: string | null;
  stale: boolean;
};

function normalizeText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeSearchableText(value: string): string {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isPausedAdText(value: string): boolean {
  const normalized = normalizeSearchableText(value);
  if (!normalized) return false;
  return PAUSED_AD_MARKERS.some((marker) => normalized.includes(marker));
}

function parseIntegerDigits(value: string): number {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return 0;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseAmountCentsFromNode(nodeText: string, centsText = ""): number {
  const fraction = parseIntegerDigits(nodeText);
  if (!fraction) return 0;
  const centsRaw = parseIntegerDigits(centsText);
  const cents = Math.max(0, Math.min(99, centsRaw));
  return fraction * 100 + cents;
}

function parseRating(value: string): number | null {
  const normalized = normalizeText(value).replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function parseReviewsCount(value: string): number | null {
  const parsed = parseIntegerDigits(value);
  return parsed > 0 ? parsed : null;
}

function normalizeSeller(value: string): string {
  const normalized = normalizeText(value);
  return normalized.replace(/^por\s+/i, "").trim();
}

function sanitizeDiscountText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (/pix/i.test(normalized)) return "";
  return normalized;
}

function normalizeInstallmentsText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";

  const match = normalized.match(/(\d{1,2})x\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) {
    return normalized.replace(/^ou\s+/i, "").trim();
  }

  const times = Number.parseInt(match[1], 10);
  const amount = String(match[2] || "").trim();
  if (!Number.isFinite(times) || times <= 0 || !amount) {
    return normalized.replace(/^ou\s+/i, "").trim();
  }

  const suffix = /sem juros/i.test(normalized) ? " sem juros" : "";
  return `${times}x de R$${amount}${suffix}`.trim();
}

function sanitizeShippingText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  return normalized
    .replace(/por\s*ser\s*sua\s*primeira\s*compra/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeBadgeText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (/mais\s*vendid/i.test(normalized)) return "";
  return normalized;
}

function toAbsoluteUrl(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value, MELI_BASE_URL).toString();
  } catch {
    return "";
  }
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

function shuffleArray<T>(input: T[]): T[] {
  const out = [...input];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [out[index], out[randomIndex]] = [out[randomIndex], out[index]];
  }
  return out;
}

function buildProductId(tab: MeliVitrineTabKey, productUrl: string): string {
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
    rating: input.rating,
    reviewsCount: input.reviewsCount,
    shippingText: input.shippingText,
    installmentsText: input.installmentsText,
    badgeText: input.badgeText,
  });
  return createHash("sha1").update(payload).digest("hex");
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": BROWSER_UA,
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(Math.max(5000, MELI_VITRINE_FETCH_TIMEOUT_MS)),
  });

  if (!response.ok) {
    throw new Error(`Falha ao buscar ${url} (HTTP ${response.status})`);
  }
  return await response.text();
}

function extractTabProducts(input: {
  tabKey: MeliVitrineTabKey;
  sourceUrl: string;
  html: string;
}): ExtractedProduct[] {
  const { tabKey, sourceUrl, html } = input;
  const $ = load(html);
  const cards = $(".poly-card").toArray();
  const dedupe = new Map<string, ExtractedProduct>();

  for (const card of cards) {
    const cardText = normalizeText($(card).text());
    if (isPausedAdText(cardText)) continue;

    const title = normalizeText($(card).find(".poly-component__title").first().text());
    const rawLink = String($(card).find("a.poly-component__title").first().attr("href") || $(card).find("a[href*='/p/']").first().attr("href") || "");
    const productUrl = canonicalizeProductUrl(rawLink);
    const imageUrl = toAbsoluteUrl(String($(card).find("img.poly-component__picture").first().attr("src") || $(card).find("img.poly-component__picture").first().attr("data-src") || ""));

    const currentAmount = $(card).find(".poly-price__current .andes-money-amount").first();
    const currentFraction = normalizeText(currentAmount.find(".andes-money-amount__fraction").first().text());
    const currentCents = normalizeText(currentAmount.find(".andes-money-amount__cents").first().text());
    const priceCents = parseAmountCentsFromNode(currentFraction, currentCents);

    if (!title || !productUrl || !imageUrl || priceCents <= 0) continue;

    const previousAmount = $(card).find("s.andes-money-amount--previous").first();
    const previousFraction = normalizeText(previousAmount.find(".andes-money-amount__fraction").first().text());
    const previousCents = normalizeText(previousAmount.find(".andes-money-amount__cents").first().text());
    const oldPriceCents = previousFraction ? parseAmountCentsFromNode(previousFraction, previousCents) : 0;

    const base: Omit<ExtractedProduct, "payloadHash"> = {
      id: buildProductId(tabKey, productUrl),
      tab: tabKey,
      sourceUrl,
      productUrl,
      title,
      imageUrl,
      priceCents,
      oldPriceCents: oldPriceCents > 0 ? oldPriceCents : null,
      discountText: sanitizeDiscountText($(card).find(".andes-money-amount__discount, .poly-price__disc_label").first().text()),
      seller: normalizeSeller($(card).find(".poly-component__seller").first().text()),
      rating: parseRating($(card).find(".poly-reviews__rating").first().text()),
      reviewsCount: parseReviewsCount($(card).find(".poly-reviews__total").first().text()),
      shippingText: sanitizeShippingText($(card).find(".poly-component__shipping").first().text()),
      installmentsText: normalizeInstallmentsText($(card).find(".poly-price__installments").first().text()),
      badgeText: sanitizeBadgeText($(card).find(".poly-component__highlight").first().text()),
    };

    const payloadHash = buildPayloadHash(base);
    dedupe.set(productUrl, { ...base, payloadHash });
  }

  return [...dedupe.values()];
}

function normalizeTabKey(value: unknown): MeliVitrineTabKey {
  const raw = String(value || "").trim().toLowerCase();
  const mapped = MELI_VITRINE_TAB_ALIAS_MAP[raw];
  if (mapped) return mapped;
  const found = MELI_VITRINE_TABS.find((tab) => tab.key === raw);
  return found ? found.key : DEFAULT_TAB_KEY;
}

function getSafePage(value: unknown): number {
  const parsed = Number.parseInt(String(value || "1"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

function getSafeLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || "24"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 24;
  return Math.max(1, Math.min(parsed, 60));
}

async function getLastSuccessfulSync(): Promise<LastSyncRow | null> {
  return await queryOne<LastSyncRow>(
    `SELECT created_at, finished_at
       FROM meli_vitrine_sync_runs
      WHERE status = 'success'
      ORDER BY created_at DESC
      LIMIT 1`,
  );
}

export async function isMeliVitrineStale(): Promise<boolean> {
  const lastSync = await getLastSuccessfulSync();
  if (!lastSync?.created_at) return true;
  const lastMs = Date.parse(String(lastSync.finished_at || lastSync.created_at));
  if (!Number.isFinite(lastMs)) return true;
  return Date.now() - lastMs >= MELI_VITRINE_SYNC_INTERVAL_MS;
}

async function persistSyncError(input: {
  source: string;
  startedAt: string;
  message: string;
}) {
  await execute(
    `INSERT INTO meli_vitrine_sync_runs
      (source, status, message, scanned_tabs, fetched_cards, added_count, updated_count, removed_count, unchanged_count, started_at, finished_at)
     VALUES ($1, 'error', $2, 0, 0, 0, 0, 0, 0, $3, NOW())`,
    [input.source, input.message, input.startedAt],
  );
}

async function upsertTabProducts(
  client: PoolClient,
  tab: MeliVitrineTabConfig,
  products: ExtractedProduct[],
): Promise<{ added: number; updated: number; removed: number; unchanged: number }> {
  const existingRows = await client.query<ExistingRow>(
    `SELECT product_url, payload_hash, is_active
       FROM meli_vitrine_products
      WHERE tab_key = $1`,
    [tab.key],
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
      `INSERT INTO meli_vitrine_products
        (id, tab_key, source_url, product_url, title, image_url, price_cents, old_price_cents, discount_text, seller, rating, reviews_count, shipping_text, installments_text, badge_text, payload_hash, is_active, first_seen_at, last_seen_at, collected_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,TRUE,NOW(),NOW(),NOW())
       ON CONFLICT (tab_key, product_url) DO UPDATE
       SET id = EXCLUDED.id,
           source_url = EXCLUDED.source_url,
           title = EXCLUDED.title,
           image_url = EXCLUDED.image_url,
           price_cents = EXCLUDED.price_cents,
           old_price_cents = EXCLUDED.old_price_cents,
           discount_text = EXCLUDED.discount_text,
           seller = EXCLUDED.seller,
           rating = EXCLUDED.rating,
           reviews_count = EXCLUDED.reviews_count,
           shipping_text = EXCLUDED.shipping_text,
           installments_text = EXCLUDED.installments_text,
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
        product.productUrl,
        product.title,
        product.imageUrl,
        product.priceCents,
        product.oldPriceCents,
        product.discountText,
        product.seller,
        product.rating,
        product.reviewsCount,
        product.shippingText,
        product.installmentsText,
        product.badgeText,
        product.payloadHash,
      ],
    );
  }

  const removedUrls = existingRows.rows
    .filter((row) => row.is_active === true && !seen.has(String(row.product_url)))
    .map((row) => String(row.product_url));

  let removed = 0;
  if (removedUrls.length > 0) {
    const result = await client.query(
      `UPDATE meli_vitrine_products
          SET is_active = FALSE, updated_at = NOW()
        WHERE tab_key = $1
          AND product_url = ANY($2::text[])
          AND is_active = TRUE`,
      [tab.key, removedUrls],
    );
    removed = Math.max(0, result.rowCount || 0);
  }

  return { added, updated, removed, unchanged };
}

export async function syncMeliVitrine(input: {
  source?: string;
  force?: boolean;
  onlyIfStale?: boolean;
} = {}): Promise<MeliVitrineSyncResult> {
  const source = normalizeText(String(input.source || "manual")) || "manual";
  const startedAt = new Date().toISOString();
  const onlyIfStale = input.onlyIfStale !== false;

  try {
    if (!input.force && onlyIfStale) {
      const stale = await isMeliVitrineStale();
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
          message: "Sync ignorado porque a vitrine ainda está dentro da janela de 2h.",
        };
      }
    }

    const extractedByTab = new Map<MeliVitrineTabConfig, ExtractedProduct[]>();
    let fetchedCards = 0;

    for (const tab of MELI_VITRINE_TABS) {
      const mergedByUrl = new Map<string, ExtractedProduct>();
      for (const sourceUrl of tab.sourceUrls) {
        const html = await fetchHtml(sourceUrl);
        const extracted = extractTabProducts({
          tabKey: tab.key,
          sourceUrl,
          html,
        });
        fetchedCards += extracted.length;
        for (const product of extracted) {
          if (mergedByUrl.has(product.productUrl)) continue;
          mergedByUrl.set(product.productUrl, product);
        }
      }

      const products = shuffleArray([...mergedByUrl.values()]);
      if (products.length === 0) {
        throw new Error(`Nenhum produto valido encontrado para a aba ${tab.key}.`);
      }
      extractedByTab.set(tab, products);
    }

    const counters = await transaction(async (client) => {
      let added = 0;
      let updated = 0;
      let removed = 0;
      let unchanged = 0;

      for (const [tab, products] of extractedByTab.entries()) {
        const result = await upsertTabProducts(client, tab, products);
        added += result.added;
        updated += result.updated;
        removed += result.removed;
        unchanged += result.unchanged;
      }

      await client.query(
        `INSERT INTO meli_vitrine_sync_runs
          (source, status, message, scanned_tabs, fetched_cards, added_count, updated_count, removed_count, unchanged_count, started_at, finished_at)
         VALUES ($1, 'success', '', $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          source,
          MELI_VITRINE_TABS.length,
          fetchedCards,
          added,
          updated,
          removed,
          unchanged,
          startedAt,
        ],
      );

      return { added, updated, removed, unchanged };
    });

    const lastSync = await getLastSuccessfulSync();
    return {
      success: true,
      skipped: false,
      source,
      scannedTabs: MELI_VITRINE_TABS.length,
      fetchedCards,
      addedCount: counters.added,
      updatedCount: counters.updated,
      removedCount: counters.removed,
      unchangedCount: counters.unchanged,
      lastSyncAt: lastSync?.finished_at || lastSync?.created_at || null,
      message: "Sync da vitrine ML concluído com sucesso.",
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

export async function listMeliVitrine(input: {
  tab?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<MeliVitrineListResult> {
  const tab = normalizeTabKey(input.tab);
  const page = getSafePage(input.page);
  const limit = getSafeLimit(input.limit);
  const offset = (page - 1) * limit;

  const [countRow, rows, tabRows, lastSync] = await Promise.all([
    queryOne<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM meli_vitrine_products WHERE tab_key = $1 AND is_active = TRUE",
      [tab],
    ),
    query<{
      id: string;
      tab_key: MeliVitrineTabKey;
      source_url: string;
      title: string;
      product_url: string;
      image_url: string;
      price_cents: number;
      old_price_cents: number | null;
      discount_text: string;
      seller: string;
      rating: number | null;
      reviews_count: number | null;
      shipping_text: string;
      installments_text: string;
      badge_text: string;
      collected_at: string;
    }>(
      `SELECT id, tab_key, source_url, title, product_url, image_url, price_cents, old_price_cents, discount_text, seller, rating, reviews_count, shipping_text, installments_text, badge_text, collected_at
         FROM meli_vitrine_products
        WHERE tab_key = $1
          AND is_active = TRUE
        ORDER BY updated_at DESC, collected_at DESC
        LIMIT $2 OFFSET $3`,
      [tab, limit, offset],
    ),
    query<{ tab_key: MeliVitrineTabKey; active_count: string }>(
      `SELECT tab_key, COUNT(*)::text AS active_count
         FROM meli_vitrine_products
        WHERE is_active = TRUE
        GROUP BY tab_key`,
    ),
    getLastSuccessfulSync(),
  ]);

  const total = Number.parseInt(String(countRow?.total || "0"), 10) || 0;
  const tabCountMap = new Map<MeliVitrineTabKey, number>();
  for (const row of tabRows) {
    tabCountMap.set(row.tab_key, Number.parseInt(String(row.active_count || "0"), 10) || 0);
  }

  const tabs = MELI_VITRINE_TABS.map((item) => ({
    key: item.key,
    label: item.label,
    activeCount: tabCountMap.get(item.key) || 0,
  }));

  const lastSyncAt = lastSync?.finished_at || lastSync?.created_at || null;
  const stale = await isMeliVitrineStale();

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
      title: String(row.title || ""),
      productUrl: String(row.product_url || ""),
      imageUrl: String(row.image_url || ""),
      price: Number((Number(row.price_cents || 0) / 100).toFixed(2)),
      oldPrice: row.old_price_cents === null || row.old_price_cents === undefined
        ? null
        : Number((Number(row.old_price_cents) / 100).toFixed(2)),
      discountText: String(row.discount_text || ""),
      seller: String(row.seller || ""),
      rating: row.rating === null || row.rating === undefined
        ? null
        : Number(row.rating),
      reviewsCount: row.reviews_count === null || row.reviews_count === undefined
        ? null
        : Number(row.reviews_count),
      shippingText: String(row.shipping_text || ""),
      installmentsText: String(row.installments_text || ""),
      badgeText: String(row.badge_text || ""),
      collectedAt: String(row.collected_at || ""),
    })),
    tabs,
    lastSyncAt,
    stale,
  };
}

