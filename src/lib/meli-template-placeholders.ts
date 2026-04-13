import { applyTemplatePlaceholders } from "@/lib/template-placeholders";

const EMPTY_LINE_REGEX = /^[ \t]+$/gm;
const BLANK_PRICE_LINE_REGEX = /^[ \t]*De R\$\s*por R\$\s*$/gim;
const CURRENT_ONLY_PRICE_LINE_REGEX = /^[ \t]*De R\$\s*por R\$\s*([0-9]+(?:[.,][0-9]{2})?)\s*$/gim;
const EMPTY_STORE_LINE_REGEX = /^[ \t]*Loja:\s*$/gim;
const EMPTY_RATING_LINE_REGEX = /^[ \t]*Nota:\s*(?:\(\s*\))?\s*$/gim;
const PARTIAL_RATING_LINE_REGEX = /^[ \t]*Nota:\s*([0-9]+(?:[.,][0-9])?)\s*\(\s*\)\s*$/gim;

export interface MeliTemplateProductInput {
  title?: string;
  productUrl?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  installmentsText?: string;
  seller?: string;
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

export function buildMeliTemplatePlaceholderData(
  product: MeliTemplateProductInput | null | undefined,
  affiliateLink: string,
): Record<string, string> {
  const source = (product || {}) as Record<string, unknown>;
  const rating = safeNumber(source.rating, 0);
  const reviewsCount = safeNumber(source.reviewsCount, 0);

  return {
    "{titulo}": firstNonEmptyString(source.title),
    "{preco}": formatPrice(source.price),
    "{preco_original}": formatPrice(source.oldPrice),
    "{link}": firstNonEmptyString(affiliateLink, source.productUrl),
    // {imagem} is attachment-only placeholder and must stay empty in text content.
    "{imagem}": "",
    "{avaliacao}": rating > 0 ? String(rating.toFixed(1)) : "",
    "{avaliacoes}": reviewsCount > 0 ? String(Math.floor(reviewsCount)) : "",
    "{parcelamento}": normalizeInstallmentsText(source.installmentsText),
    "{vendedor}": firstNonEmptyString(source.seller),
  };
}

export function applyMeliTemplatePlaceholders(
  templateContent: string,
  placeholderData: Record<string, string>,
): string {
  const replaced = applyTemplatePlaceholders(templateContent, placeholderData);
  return replaced
    .replace(CURRENT_ONLY_PRICE_LINE_REGEX, "R$ $1")
    .replace(BLANK_PRICE_LINE_REGEX, "")
    .replace(EMPTY_STORE_LINE_REGEX, "")
    .replace(EMPTY_RATING_LINE_REGEX, "")
    .replace(PARTIAL_RATING_LINE_REGEX, "Nota: $1")
    .replace(EMPTY_LINE_REGEX, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
