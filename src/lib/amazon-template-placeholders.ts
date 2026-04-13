import { applyTemplatePlaceholders } from "@/lib/template-placeholders";

const EMPTY_LINE_REGEX = /^[ \t]*$/gm;
const BLANK_PRICE_LINE_REGEX = /^[ \t]*De R\$\s*por R\$\s*$/gim;
const CURRENT_ONLY_PRICE_LINE_REGEX = /^[ \t]*De R\$\s*por R\$\s*([0-9]+(?:[.,][0-9]{2})?)\s*$/gim;
const EMPTY_META_LINE_REGEX = /^[ \t]*(?:Loja|Vendedor|Selo|ASIN|Parcelamento):\s*$/gim;

export interface AmazonTemplateProductInput {
  title?: string;
  productUrl?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  discountText?: string;
  installmentsText?: string;
  seller?: string;
  badgeText?: string;
  asin?: string;
  rating?: number | null;
  reviewsCount?: number | null;
}

function safeNumber(value: unknown, fallback = Number.NaN): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const parsed = String(value || "").trim();
    if (parsed) return parsed;
  }
  return "";
}

function formatPrice(value: unknown): string {
  const numeric = safeNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return numeric.toFixed(2).replace(".", ",");
}

function normalizeInstallmentsText(value: unknown): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = normalized.match(/(\d{1,2})x\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) return normalized.replace(/^ou\s+/i, "").trim();
  const suffix = /sem juros/i.test(normalized) ? " sem juros" : "";
  return `${match[1]}x de R$${match[2]}${suffix}`.trim();
}

function formatRating(value: unknown): string {
  const numeric = safeNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return numeric.toFixed(1).replace(".", ",");
}

function formatReviewsCount(value: unknown): string {
  const numeric = safeNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return String(Math.floor(numeric));
}

function deriveDiscountText(input: AmazonTemplateProductInput | null | undefined): string {
  const source = (input || {}) as Record<string, unknown>;
  const fromSource = firstNonEmptyString(source.discountText);
  if (fromSource) return fromSource;

  const oldPrice = safeNumber(source.oldPrice, 0);
  const price = safeNumber(source.price, 0);
  if (oldPrice > 0 && price > 0 && oldPrice > price) {
    const percent = Math.round(((oldPrice - price) / oldPrice) * 100);
    if (Number.isFinite(percent) && percent > 0) return `${percent}% off`;
  }
  return "";
}

export function buildAmazonTemplatePlaceholderData(
  product: AmazonTemplateProductInput | null | undefined,
  affiliateLink: string,
): Record<string, string> {
  const source = (product || {}) as Record<string, unknown>;

  const title = firstNonEmptyString(source.title);
  const price = formatPrice(source.price);
  const oldPrice = formatPrice(source.oldPrice);
  const discount = deriveDiscountText(product);
  const installments = normalizeInstallmentsText(source.installmentsText);
  const seller = firstNonEmptyString(source.seller);
  const rating = formatRating(source.rating);
  const reviews = formatReviewsCount(source.reviewsCount);
  const link = firstNonEmptyString(affiliateLink, source.productUrl);

  return {
    "{titulo}": title,
    "{título}": title,
    "{preco}": price,
    "{preço}": price,
    "{preco_original}": oldPrice,
    "{preço_original}": oldPrice,
    "{desconto}": discount,
    "{parcelamento}": installments,
    "{vendedor}": seller,
    "{link}": link,
    "{imagem}": "",
    "{avaliacao}": rating,
    "{avaliacoes}": reviews,
  };
}

export function applyAmazonTemplatePlaceholders(
  templateContent: string,
  placeholderData: Record<string, string>,
): string {
  const replaced = applyTemplatePlaceholders(templateContent, {
    ...placeholderData,
    "{parcelamento}": String(placeholderData["{parcelamento}"] || ""),
    "{avaliacao}": String(placeholderData["{avaliacao}"] || ""),
    "{avaliacoes}": String(placeholderData["{avaliacoes}"] || ""),
    "{selo}": String(placeholderData["{selo}"] || ""),
    "{asin}": String(placeholderData["{asin}"] || ""),
  });
  return replaced
    .replace(CURRENT_ONLY_PRICE_LINE_REGEX, "R$ $1")
    .replace(BLANK_PRICE_LINE_REGEX, "")
    .replace(EMPTY_META_LINE_REGEX, "")
    .replace(EMPTY_LINE_REGEX, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
