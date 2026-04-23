import type { ShopeeProduct } from "@/components/shopee/ProductCard";
import { applyPlaceholders } from "@/lib/marketplace-utils";

type TemplatePlaceholderData = Record<string, string>;
const IMAGE_PLACEHOLDER_LINE_REGEX = /^[ \t]*(?:\{imagem\}|\{\{imagem\}\})[ \t]*(?:\r?\n|$)/gim;
const RANDOM_CTA_PLACEHOLDER_REGEX = /\{\{?\s*cta[_ ]aleatoria\s*\}\}?/i;
const PERSONALIZED_CTA_PLACEHOLDER_REGEX = /\{\{?\s*cta[_ ]personalizada\s*\}\}?/i;
const AI_GENERATED_CTA_PLACEHOLDER_REGEX = /\{\{?\s*(?:cta[_ ]gerada[_ ]por[_ ]ia|cta[_ ]ia[_ ]gerada|cta[_ ]urgencia|cta[_ ]escassez|cta[_ ]oportunidade|cta[_ ]beneficio|cta[_ ]curiosidade|cta[_ ]preco[_ ]forte|cta[_ ]achadinho|cta[_ ]prova[_ ]social|cta[_ ]desejo|cta[_ ]dica[_ ]amiga)\s*\}\}?/i;

function parseLocalizedNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.NaN;
  }

  const raw = String(value || "").trim();
  if (!raw) return Number.NaN;

  let normalized = raw
    .replace(/[R$\s]/gi, "")
    .replace(/[^0-9.,-]/g, "");

  if (!normalized) return Number.NaN;

  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/,/g, "");
  } else if (/^-?\d+,\d+$/.test(normalized)) {
    normalized = normalized.replace(",", ".");
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function safeNumber(value: unknown, fallback = Number.NaN) {
  const parsed = parseLocalizedNumber(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    const parsed = String(value || "").trim();
    if (parsed) return parsed;
  }
  return "";
}

function formatPrice(value: number) {
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : "";
}

export function buildTemplatePlaceholderData(
  product: Partial<ShopeeProduct> | null | undefined,
  affiliateLink: string,
): TemplatePlaceholderData {
  const rawProduct = (product || {}) as Record<string, unknown>;

  const salePrice = safeNumber(
    rawProduct.salePrice
    ?? rawProduct.price
    ?? rawProduct.currentPrice
    ?? rawProduct.current_price,
  );
  const originalPriceRaw = safeNumber(
    rawProduct.originalPrice
    ?? rawProduct.oldPrice
    ?? rawProduct.old_price
    ?? rawProduct.priceOriginal
    ?? rawProduct.price_original
    ?? rawProduct.priceMinBeforeDiscount
    ?? rawProduct.priceBeforeDiscount
    ?? rawProduct.priceMin,
  );
  const originalPrice = Number.isFinite(originalPriceRaw) && originalPriceRaw > 0
    ? originalPriceRaw
    : salePrice;
  const hasSalePrice = Number.isFinite(salePrice) && salePrice > 0;
  const hasOriginalPrice = Number.isFinite(originalPrice) && originalPrice > 0;

  const discountFromProduct = safeNumber(
    rawProduct.discount
    ?? rawProduct.priceDiscountRate
    ?? rawProduct.discountRate
    ?? rawProduct.discountPercent,
    0,
  );
  const discountComputed = hasOriginalPrice && hasSalePrice && originalPrice > salePrice
    ? Math.round((1 - salePrice / originalPrice) * 100)
    : 0;
  const discount = Math.max(0, discountComputed || discountFromProduct);

  const title = firstNonEmptyString(rawProduct.title, rawProduct.productName);
  const link = firstNonEmptyString(
    affiliateLink,
    rawProduct.affiliateLink,
    rawProduct.offerLink,
    rawProduct.link,
    rawProduct.productLink,
  );
  const rating = safeNumber(rawProduct.rating ?? rawProduct.ratingStar, 0);

  return {
    "{titulo}": title,
    "{preco}": formatPrice(salePrice),
    "{preco_original}": formatPrice(originalPrice),
    "{desconto}": discount > 0 ? String(discount) : "",
    "{link}": link,
    // {imagem} only signals that an attachment should be sent.
    // It must never expand to a text URL inside the message content.
    "{imagem}": "",
    "{avaliacao}": rating > 0 ? String(rating) : "",
  };
}

export function stripStandaloneImagePlaceholderLines(templateContent: string): string {
  return String(templateContent || "").replace(IMAGE_PLACEHOLDER_LINE_REGEX, "");
}

export function templateRequestsImageAttachment(templateContent: string): boolean {
  const normalized = String(templateContent || "").toLowerCase();
  return normalized.includes("{imagem}") || normalized.includes("{{imagem}}");
}

export function templateRequestsRandomCta(templateContent: string): boolean {
  return RANDOM_CTA_PLACEHOLDER_REGEX.test(String(templateContent || ""));
}

export function templateRequestsPersonalizedCta(templateContent: string): boolean {
  return PERSONALIZED_CTA_PLACEHOLDER_REGEX.test(String(templateContent || ""));
}

export function templateRequestsAiGeneratedCta(templateContent: string): boolean {
  return AI_GENERATED_CTA_PLACEHOLDER_REGEX.test(String(templateContent || ""));
}

export function applyTemplatePlaceholders(
  templateContent: string,
  placeholderData: Record<string, string>,
): string {
  const contentWithoutImageLine = stripStandaloneImagePlaceholderLines(templateContent);
  const safePlaceholderData = {
    ...(placeholderData || {}),
    "{imagem}": "",
    "{{imagem}}": "",
  };
  return applyPlaceholders(contentWithoutImageLine, safePlaceholderData);
}

export const SAMPLE_TEMPLATE_PLACEHOLDER_DATA: TemplatePlaceholderData = {
  "{titulo}": "Fone Bluetooth TWS Pro",
  "{preco}": "67.90",
  "{preco_original}": "189.90",
  "{desconto}": "64",
  "{link}": "https://shope.ee/aff123",
  "{imagem}": "",
  "{avaliacao}": "4.8",
  "{cta_aleatoria}": "Comenta QUERO e garanta o seu antes que acabe!",
  "{cta_personalizada}": "Comenta QUERO que eu te envio os detalhes agora.",
  "{cta_gerada_por_ia}": "Clique no link e aproveite essa oferta enquanto esta disponivel",
};
