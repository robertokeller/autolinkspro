const SHOPEE_SUB_ID_MAX_LENGTH = 80;

const SHOPEE_SUB_ID_ALLOWED = new RegExp(`^[A-Za-z0-9]{1,${SHOPEE_SUB_ID_MAX_LENGTH}}$`);

type ShopeeSubIdLike = {
  value: string;
  isDefault?: boolean;
};

export function normalizeShopeeSubId(value: unknown): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!SHOPEE_SUB_ID_ALLOWED.test(normalized)) return "";
  return normalized;
}

export function pickDefaultShopeeSubId<T extends ShopeeSubIdLike>(items: T[]): string {
  if (!Array.isArray(items) || items.length === 0) return "";

  const explicitDefault = items.find((item) => item.isDefault === true) || null;
  const explicitValue = normalizeShopeeSubId(explicitDefault?.value);
  if (explicitValue) return explicitValue;

  for (const item of items) {
    const value = normalizeShopeeSubId(item.value);
    if (value) return value;
  }

  return "";
}

export function normalizeShopeeSubIdList(value: unknown, maxItems = 5): string[] {
  const values = Array.isArray(value) ? value : [value];
  const deduped = new Set<string>();

  for (const item of values) {
    const normalized = normalizeShopeeSubId(item);
    if (!normalized || deduped.has(normalized)) continue;
    deduped.add(normalized);
    if (deduped.size >= maxItems) break;
  }

  return [...deduped];
}
