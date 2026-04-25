import type { ShopeeProduct } from "@/components/shopee/ProductCard";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { normalizeShopeeSubIdList } from "@/lib/shopee-subid";

export interface ShopeeLinkConversion {
  originalLink: string;
  resolvedLink: string;
  affiliateLink: string;
  usedService: boolean;
  product: Partial<ShopeeProduct> | null;
}

export interface ShopeeLinkBatchConversion {
  originalLink: string;
  resolvedLink: string;
  affiliateLink: string;
  usedService: boolean;
  product: Partial<ShopeeProduct> | null;
  error: string | null;
}

export interface ShopeeSubIdTrackingInput {
  subId?: string;
  subIds?: string[];
}

function normalizeLinkInput(input: string) {
  return String(input || "").trim();
}

function normalizeShopeeSubIdsInput(input?: ShopeeSubIdTrackingInput): string[] {
  if (!input) return [];

  const values = Array.isArray(input.subIds)
    ? input.subIds
    : (input.subId ? [input.subId] : []);
  return normalizeShopeeSubIdList(values, 5);
}

function stripShopeeLpAffParam(link: string) {
  const value = normalizeLinkInput(link);
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (!parsed.searchParams.has("lp")) return value;

    const lpValues = parsed.searchParams.getAll("lp");
    if (!lpValues.some((item) => item.trim().toLowerCase() === "aff")) {
      return value;
    }

    const nextParams = new URLSearchParams();
    for (const [key, paramValue] of parsed.searchParams.entries()) {
      if (key === "lp" && paramValue.trim().toLowerCase() === "aff") {
        continue;
      }
      nextParams.append(key, paramValue);
    }

    const nextSearch = nextParams.toString();
    return `${parsed.origin}${parsed.pathname}${nextSearch ? `?${nextSearch}` : ""}${parsed.hash}`;
  } catch {
    return value.replace(/[?&]lp=aff(?=(&|#|$))/gi, (match, suffix) => {
      if (match.startsWith("?")) {
        return suffix === "&" ? "?" : "";
      }
      return suffix === "&" ? "&" : "";
    }).replace(/[?&]$/, "");
  }
}

export async function convertShopeeLink(
  link: string,
  source = "frontend",
  tracking?: ShopeeSubIdTrackingInput,
): Promise<ShopeeLinkConversion> {
  const originalLink = normalizeLinkInput(link);
  if (!originalLink) {
    throw new Error("URL Shopee obrigatoria");
  }

  const response = await invokeBackendRpc<{
    affiliateLink?: string;
    product?: Partial<ShopeeProduct> | null;
    resolvedUrl?: string;
    usedService?: boolean;
  }>("shopee-convert-link", {
    body: {
      url: originalLink,
      source,
      subIds: normalizeShopeeSubIdsInput(tracking),
    },
  });

  return {
    originalLink,
    resolvedLink: String(response.resolvedUrl || originalLink),
    affiliateLink: stripShopeeLpAffParam(String(response.affiliateLink || originalLink)),
    usedService: response.usedService === true,
    product: response.product || null,
  };
}

export async function convertShopeeLinks(
  links: string[],
  source = "frontend",
  tracking?: ShopeeSubIdTrackingInput,
): Promise<ShopeeLinkBatchConversion[]> {
  const normalized = links
    .map((item) => normalizeLinkInput(item))
    .filter(Boolean);

  if (normalized.length === 0) {
    return [];
  }

  const response = await invokeBackendRpc<{
    conversions?: Array<{
      originalLink?: string;
      resolvedLink?: string;
      affiliateLink?: string;
      usedService?: boolean;
      product?: Partial<ShopeeProduct> | null;
      error?: string | null;
    }>;
  }>("shopee-convert-links", {
    body: {
      urls: normalized,
      source,
      subIds: normalizeShopeeSubIdsInput(tracking),
    },
  });

  const conversions = Array.isArray(response.conversions) ? response.conversions : [];
  return conversions.map((item) => {
    const originalLink = String(item.originalLink || "");
    return {
      originalLink,
      resolvedLink: String(item.resolvedLink || originalLink),
      affiliateLink: stripShopeeLpAffParam(String(item.affiliateLink || originalLink)),
      usedService: item.usedService === true,
      product: item.product || null,
      error: item.error ? String(item.error) : null,
    };
  });
}

