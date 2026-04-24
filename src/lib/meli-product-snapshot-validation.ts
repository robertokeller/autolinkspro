export interface MeliProductSnapshotLike {
  productUrl?: unknown;
  title?: unknown;
  imageUrl?: unknown;
  price?: unknown;
  oldPrice?: unknown;
  installmentsText?: unknown;
  seller?: unknown;
  rating?: unknown;
  reviewsCount?: unknown;
}

export interface StrictMeliProductSnapshot {
  productUrl: string;
  title: string;
  imageUrl: string;
  price: number;
  oldPrice: number;
  installmentsText: string;
  seller: string;
  rating: number;
  reviewsCount: number;
}

export interface StrictMeliProductSnapshotValidation {
  ok: boolean;
  missingFields: string[];
  normalized: StrictMeliProductSnapshot | null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const parsed = String(value || "").trim();
    if (parsed) return parsed;
  }
  return "";
}

function parseLocalizedNumber(value: unknown): number {
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

function toPositiveNumber(value: unknown): number {
  const parsed = parseLocalizedNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function isHttpUrl(value: string): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value);
}

export function validateStrictMeliProductSnapshot(
  snapshot: MeliProductSnapshotLike | null | undefined,
): StrictMeliProductSnapshotValidation {
  const source = (snapshot || {}) as Record<string, unknown>;

  const title = firstNonEmptyString(source.title);
  const productUrl = firstNonEmptyString(source.productUrl);
  const imageUrl = firstNonEmptyString(source.imageUrl);
  const installmentsText = firstNonEmptyString(source.installmentsText);
  const seller = firstNonEmptyString(source.seller);

  const price = toPositiveNumber(source.price);
  const oldPrice = toPositiveNumber(source.oldPrice);
  const rating = toPositiveNumber(source.rating);
  const reviewsCountRaw = toPositiveNumber(source.reviewsCount);
  const reviewsCount = Number.isFinite(reviewsCountRaw)
    ? Math.floor(reviewsCountRaw)
    : Number.NaN;

  const missingFields: string[] = [];
  if (!title) missingFields.push("titulo");
  if (!Number.isFinite(price)) missingFields.push("preco");
  if (!Number.isFinite(oldPrice)) missingFields.push("preco original");
  if (!isHttpUrl(imageUrl)) missingFields.push("imagem");
  if (!Number.isFinite(rating)) missingFields.push("avaliacao");
  if (!Number.isFinite(reviewsCount) || reviewsCount <= 0) missingFields.push("avaliacoes");

  if (missingFields.length > 0) {
    return {
      ok: false,
      missingFields,
      normalized: null,
    };
  }

  return {
    ok: true,
    missingFields: [],
    normalized: {
      productUrl,
      title,
      imageUrl,
      price,
      oldPrice,
      installmentsText,
      seller,
      rating,
      reviewsCount,
    },
  };
}
