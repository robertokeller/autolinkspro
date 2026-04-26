/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, type PropsWithChildren } from "react";
import type { ShopeeProduct } from "@/components/shopee/ProductCard";
import { useShopeeCredentials, type ShopeeConnectionInfo } from "@/hooks/useShopeeCredentials";
import {
  convertShopeeLink,
  convertShopeeLinks,
  type ShopeeLinkBatchConversion,
  type ShopeeLinkConversion,
  type ShopeeSubIdTrackingInput,
} from "@/lib/shopee-link-converter";
import { extractMarketplaceLinks } from "@/lib/marketplace-utils";

type ShopeeConversionStatus = "real" | "partial" | "fallback";

interface ShopeeLinkConversionResult extends ShopeeLinkConversion {
  status: ShopeeConversionStatus;
  hasProductData: boolean;
}

interface ShopeeLinkBatchConversionResult extends ShopeeLinkBatchConversion {
  status: ShopeeConversionStatus;
  hasProductData: boolean;
}

interface ShopeeConvertOptions {
  source?: string;
  verifyConnection?: boolean;
  subId?: string;
  subIds?: string[];
}

type ShopeeConvertContentOptions = ShopeeConvertOptions;

interface ShopeeConvertContentResult {
  originalContent: string;
  convertedContent: string;
  conversions: ShopeeLinkBatchConversionResult[];
  convertedCount: number;
  firstAffiliateLink: string;
  firstProduct: Partial<ShopeeProduct> | null;
}

interface ShopeeLinkModuleContextValue {
  isConfigured: boolean;
  isLoading: boolean;
  connectionInfo: ShopeeConnectionInfo;
  ensureConnection: (strict?: boolean) => Promise<boolean>;
  convertLink: (link: string, options?: ShopeeConvertOptions) => Promise<ShopeeLinkConversionResult>;
  convertLinks: (links: string[], options?: ShopeeConvertOptions) => Promise<ShopeeLinkBatchConversionResult[]>;
  convertContentLinks: (content: string, options?: ShopeeConvertContentOptions) => Promise<ShopeeConvertContentResult>;
}

const ShopeeLinkModuleContext = createContext<ShopeeLinkModuleContextValue | null>(null);

function hasProductData(product: Partial<ShopeeProduct> | null | undefined) {
  if (!product) return false;
  const title = String(product.title || "").trim();
  const salePrice = Number(product.salePrice);
  const imageUrl = String(product.imageUrl || "").trim();
  return Boolean(title || (Number.isFinite(salePrice) && salePrice > 0) || imageUrl);
}

function toStatus(usedService: boolean, hasData: boolean): ShopeeConversionStatus {
  if (!usedService) return "fallback";
  return hasData ? "real" : "partial";
}

function normalizeSource(source: string | undefined, fallback: string) {
  const value = String(source || "").trim();
  return value || fallback;
}

function toTrackingInput(options?: ShopeeConvertOptions): ShopeeSubIdTrackingInput | undefined {
  if (!options) return undefined;
  if (!options.subId && (!Array.isArray(options.subIds) || options.subIds.length === 0)) {
    return undefined;
  }
  return {
    subId: options.subId,
    subIds: options.subIds,
  };
}

export function ShopeeLinkModuleProvider({ children }: PropsWithChildren) {
  const {
    isConfigured,
    isLoading,
    connectionInfo,
    testConnection,
  } = useShopeeCredentials();

  const ensureConnection = useCallback(async (strict = false) => {
    if (!isConfigured) {
      if (strict) {
        throw new Error("Credenciais Shopee não configuradas. Ajuste em Configurações > Shopee.");
      }
      return false;
    }

    if (connectionInfo.status === "connected") {
      return true;
    }

    const ok = await testConnection();
    if (!ok && strict) {
      throw new Error("Não foi possível validar a conexão com a Shopee no momento.");
    }

    return ok;
  }, [connectionInfo.status, isConfigured, testConnection]);

  const convertLinkInternal = useCallback(async (link: string, options?: ShopeeConvertOptions) => {
    const source = normalizeSource(options?.source, "global-link-converter");
    const shouldVerify = options?.verifyConnection !== false;

    if (shouldVerify) {
      await ensureConnection(true);
    } else if (!isConfigured) {
      throw new Error("Credenciais Shopee não configuradas.");
    }

    const conversion = await convertShopeeLink(link, source, toTrackingInput(options));
    const hasData = hasProductData(conversion.product);

    return {
      ...conversion,
      hasProductData: hasData,
      status: toStatus(conversion.usedService, hasData),
    } satisfies ShopeeLinkConversionResult;
  }, [ensureConnection, isConfigured]);

  const convertLinksInternal = useCallback(async (links: string[], options?: ShopeeConvertOptions) => {
    const source = normalizeSource(options?.source, "global-link-converter-batch");
    const shouldVerify = options?.verifyConnection !== false;

    if (shouldVerify) {
      await ensureConnection(true);
    } else if (!isConfigured) {
      throw new Error("Credenciais Shopee não configuradas.");
    }

    const conversions = await convertShopeeLinks(links, source, toTrackingInput(options));

    return conversions.map((conversion) => {
      const hasData = hasProductData(conversion.product);
      return {
        ...conversion,
        hasProductData: hasData,
        status: toStatus(conversion.usedService, hasData),
      } satisfies ShopeeLinkBatchConversionResult;
    });
  }, [ensureConnection, isConfigured]);

  const convertContentLinks = useCallback(async (content: string, options?: ShopeeConvertContentOptions) => {
    const originalContent = String(content || "");
    const source = normalizeSource(options?.source, "global-content-converter");

    const shopeeLinks = [...new Set(
      extractMarketplaceLinks(originalContent)
        .filter((item) => item.marketplace === "shopee")
        .map((item) => item.url),
    )];

    if (shopeeLinks.length === 0) {
      return {
        originalContent,
        convertedContent: originalContent,
        conversions: [],
        convertedCount: 0,
        firstAffiliateLink: "",
        firstProduct: null,
      } satisfies ShopeeConvertContentResult;
    }

    const conversions = await convertLinksInternal(shopeeLinks, {
      source,
      verifyConnection: options?.verifyConnection,
    });

    let convertedContent = originalContent;
    let convertedCount = 0;

    for (const conversion of conversions) {
      const originalLink = String(conversion.originalLink || "").trim();
      const affiliateLink = String(conversion.affiliateLink || "").trim();
      const resolvedLink = String(conversion.resolvedLink || "").trim();

      if (!originalLink || !affiliateLink || affiliateLink === originalLink) {
        continue;
      }

      convertedContent = convertedContent.split(originalLink).join(affiliateLink);
      if (resolvedLink && resolvedLink !== originalLink) {
        convertedContent = convertedContent.split(resolvedLink).join(affiliateLink);
      }
      convertedCount += 1;
    }

    const firstSuccess = conversions.find((conversion) => !conversion.error) || null;

    return {
      originalContent,
      convertedContent,
      conversions,
      convertedCount,
      firstAffiliateLink: firstSuccess?.affiliateLink || "",
      firstProduct: firstSuccess?.product || null,
    } satisfies ShopeeConvertContentResult;
  }, [convertLinksInternal]);

  const value = useMemo<ShopeeLinkModuleContextValue>(() => ({
    isConfigured,
    isLoading,
    connectionInfo,
    ensureConnection,
    convertLink: convertLinkInternal,
    convertLinks: convertLinksInternal,
    convertContentLinks,
  }), [
    isConfigured,
    isLoading,
    connectionInfo,
    ensureConnection,
    convertLinkInternal,
    convertLinksInternal,
    convertContentLinks,
  ]);

  return (
    <ShopeeLinkModuleContext.Provider value={value}>
      {children}
    </ShopeeLinkModuleContext.Provider>
  );
}

export function useShopeeLinkModule() {
  const context = useContext(ShopeeLinkModuleContext);
  if (!context) {
    throw new Error("useShopeeLinkModule precisa ser usado dentro de ShopeeLinkModuleProvider");
  }
  return context;
}

