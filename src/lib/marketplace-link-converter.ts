import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { convertShopeeLink } from "@/lib/shopee-link-converter";

export type MarketplaceKind = "shopee" | "mercadolivre" | "amazon";

export interface MarketplaceConversionResult {
  marketplace: MarketplaceKind;
  originalLink: string;
  resolvedLink?: string;
  affiliateLink: string;
  cached?: boolean;
  conversionTimeMs?: number;
  asin?: string;
  status?: string;
}

type ShopeeFallbackResult = {
  affiliateLink: string;
  resolvedLink?: string;
  status?: string;
  cached?: boolean;
  conversionTimeMs?: number;
};

type ConvertMarketplaceLinkInput = {
  url: string;
  source?: string;
  sessionId?: string;
  shopeeFallback?: (url: string, source: string) => Promise<ShopeeFallbackResult>;
};

function normalizeUrlInput(rawUrl: string): string {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function detectMarketplace(rawUrl: string): MarketplaceKind | null {
  try {
    const parsed = new URL(normalizeUrlInput(rawUrl));
    const host = parsed.hostname.toLowerCase();
    if (host === "amazon.com.br" || host.endsWith(".amazon.com.br")) return "amazon";
    if (
      host === "meli.la"
      || host.endsWith(".meli.la")
      || host === "mlb.am"
      || host.endsWith(".mlb.am")
      || host.includes("mercadolivre")
      || host.includes("mercadolibre")
      || host.includes("mercadopago")
      || host.includes("mlstatic")
    ) {
      return "mercadolivre";
    }
    if (host.includes("shopee.") || host.endsWith("shope.ee")) return "shopee";
  } catch {
    return null;
  }
  return null;
}

function normalizeForComparison(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ç/g, "c")
    .replace(/ã/g, "a")
    .replace(/õ/g, "o")
    .replace(/á/g, "a")
    .replace(/é/g, "e")
    .replace(/í/g, "i")
    .replace(/ó/g, "o")
    .replace(/ú/g, "u");
}

function isMarketplaceConvertNotImplementedError(message: string): boolean {
  const normalized = normalizeForComparison(message);
  return (
    (
      normalized.includes("funcao nao implementada")
      || normalized.includes("function not implemented")
    )
    && normalized.includes("marketplace-convert-link")
  );
}

async function fallbackConvertMarketplaceLink(input: ConvertMarketplaceLinkInput): Promise<MarketplaceConversionResult> {
  const sourceUrl = normalizeUrlInput(input.url);
  const marketplace = detectMarketplace(sourceUrl);
  if (!marketplace) {
    throw new Error("Marketplace não suportado. Use links da Shopee, Mercado Livre ou Amazon.");
  }

  if (marketplace === "amazon") {
    const result = await invokeBackendRpc<{ affiliateLink?: string; asin?: string; conversionTimeMs?: number }>(
      "amazon-convert-link",
      { body: { url: sourceUrl, source: input.source || "global-conversor-fallback" } },
    );
    const affiliateLink = String(result.affiliateLink || sourceUrl).trim();
    return {
      marketplace: "amazon",
      originalLink: sourceUrl,
      resolvedLink: sourceUrl,
      affiliateLink,
      asin: result.asin,
      conversionTimeMs: Number(result.conversionTimeMs || 0) || undefined,
    };
  }

  if (marketplace === "mercadolivre") {
    const result = await invokeBackendRpc<{ affiliateLink?: string; cached?: boolean; conversionTimeMs?: number }>(
      "meli-convert-link",
      {
        body: {
          url: sourceUrl,
          sessionId: input.sessionId,
          source: input.source || "global-conversor-fallback",
        },
      },
    );
    const affiliateLink = String(result.affiliateLink || sourceUrl).trim();
    return {
      marketplace: "mercadolivre",
      originalLink: sourceUrl,
      resolvedLink: sourceUrl,
      affiliateLink,
      cached: result.cached === true,
      conversionTimeMs: Number(result.conversionTimeMs || 0) || undefined,
    };
  }

  if (input.shopeeFallback) {
    const custom = await input.shopeeFallback(sourceUrl, input.source || "global-conversor-fallback");
    return {
      marketplace: "shopee",
      originalLink: sourceUrl,
      resolvedLink: custom.resolvedLink || sourceUrl,
      affiliateLink: String(custom.affiliateLink || sourceUrl).trim(),
      status: custom.status,
      cached: custom.cached === true,
      conversionTimeMs: Number(custom.conversionTimeMs || 0) || undefined,
    };
  }

  const shopee = await convertShopeeLink(sourceUrl, input.source || "global-conversor-fallback");
  return {
    marketplace: "shopee",
    originalLink: shopee.originalLink,
    resolvedLink: shopee.resolvedLink,
    affiliateLink: shopee.affiliateLink,
  };
}

export async function convertMarketplaceLink(input: ConvertMarketplaceLinkInput): Promise<MarketplaceConversionResult> {
  const sourceUrl = normalizeUrlInput(input.url);
  if (!sourceUrl) {
    throw new Error("Cole um link para converter.");
  }

  try {
    const result = await invokeBackendRpc<MarketplaceConversionResult>("marketplace-convert-link", {
      body: {
        url: sourceUrl,
        source: input.source || "global-conversor",
        sessionId: input.sessionId,
      },
    });
    return {
      marketplace: result.marketplace,
      originalLink: String(result.originalLink || sourceUrl),
      resolvedLink: result.resolvedLink,
      affiliateLink: String(result.affiliateLink || sourceUrl).trim(),
      cached: result.cached === true,
      conversionTimeMs: Number(result.conversionTimeMs || 0) || undefined,
      asin: result.asin,
      status: result.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (!isMarketplaceConvertNotImplementedError(message)) {
      throw error;
    }
    return await fallbackConvertMarketplaceLink(input);
  }
}
