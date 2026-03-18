import type { ShopeeProduct } from "@/components/shopee/ProductCard";
import { applyPlaceholders } from "@/lib/marketplace-utils";

type TemplatePlaceholderData = Record<string, string>;
const IMAGE_PLACEHOLDER_LINE_REGEX = /^[ \t]*(?:\{imagem\}|\{\{imagem\}\})[ \t]*(?:\r?\n|$)/gim;

function safeNumber(value: unknown, fallback = Number.NaN) {
  const parsed = Number(value);
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

  const salePrice = safeNumber(rawProduct.salePrice ?? rawProduct.price);
  const originalPriceRaw = safeNumber(
    rawProduct.originalPrice
    ?? rawProduct.priceMinBeforeDiscount
    ?? rawProduct.priceBeforeDiscount
    ?? rawProduct.priceMin,
  );
  const originalPrice = Number.isFinite(originalPriceRaw) && originalPriceRaw > 0
    ? originalPriceRaw
    : salePrice;
  const hasSalePrice = Number.isFinite(salePrice) && salePrice > 0;
  const hasOriginalPrice = Number.isFinite(originalPrice) && originalPrice > 0;

  const discountFromProduct = safeNumber(rawProduct.discount ?? rawProduct.priceDiscountRate, 0);
  const discountComputed = hasOriginalPrice && hasSalePrice && originalPrice > salePrice
    ? Math.round((1 - salePrice / originalPrice) * 100)
    : 0;
  const discount = Math.max(0, discountFromProduct || discountComputed);

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
};
