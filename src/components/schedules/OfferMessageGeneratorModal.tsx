import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Link2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { useTemplates } from "@/hooks/useTemplates";
import { useShopeeLinkModule } from "@/contexts/ShopeeLinkModuleContext";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { useAmazonAffiliateTag } from "@/hooks/useAmazonAffiliateTag";
import { convertMarketplaceLink } from "@/lib/marketplace-link-converter";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import {
  applyTemplatePlaceholders,
  buildTemplatePlaceholderData,
  templateRequestsAiGeneratedCta,
  templateRequestsImageAttachment,
  templateRequestsPersonalizedCta,
  templateRequestsRandomCta,
} from "@/lib/template-placeholders";
import { AMAZON_TEMPLATE_MODULE, MELI_TEMPLATE_MODULE } from "@/lib/marketplace-template-modules";
import type { ShopeeProduct } from "@/components/shopee/ProductCard";
import type { Template } from "@/lib/types";
import type { MeliTemplateProductInput } from "@/lib/meli-template-placeholders";
import type { AmazonTemplateProductInput } from "@/lib/amazon-template-placeholders";
import { validateStrictMeliProductSnapshot } from "@/lib/meli-product-snapshot-validation";

type SupportedMarketplace = "shopee" | "mercadolivre" | "amazon";

interface MarketplaceOfferProduct extends Partial<ShopeeProduct> {
  productUrl?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  installmentsText?: string;
  seller?: string;
  reviewsCount?: number | null;
  discountText?: string;
  badgeText?: string;
  asin?: string;
}

type MeliProductSnapshotResponse = {
  productUrl?: string;
  title?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  installmentsText?: string;
  seller?: string;
  rating?: number | null;
  reviewsCount?: number | null;
};

type AmazonProductSnapshotResponse = {
  productUrl?: string;
  title?: string;
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
};

type RandomCtaNextResponse = {
  phrase?: string;
};

type PersonalizedCtaNextResponse = {
  phrase?: string;
};

type AiCtaPlaceholdersNextResponse = {
  items?: Record<string, string>;
};

export interface OfferGeneratorResult {
  name: string;
  message: string;
  templateId: string;
  affiliateLink: string;
  marketplace: SupportedMarketplace;
  placeholderData: Record<string, string>;
  scheduleSource: string | null;
  imagePolicy: string | null;
  productImageUrl: string | null;
}

interface OfferMessageGeneratorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerated: (result: OfferGeneratorResult) => void;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const parsed = String(value || "").trim();
    if (parsed) return parsed;
  }
  return "";
}

function parseLocalizedNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const raw = String(value || "").trim();
  if (!raw) return undefined;

  let normalized = raw
    .replace(/[R$\s]/gi, "")
    .replace(/[^0-9.,-]/g, "");

  if (!normalized) return undefined;

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
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return parseLocalizedNumber(value);
}

function toPositiveNumber(value: unknown): number | undefined {
  const parsed = parseLocalizedNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeUrlInput(rawUrl: string): string {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function detectMarketplaceFromUrl(rawUrl: string): SupportedMarketplace | null {
  try {
    const parsed = new URL(normalizeUrlInput(rawUrl));
    const host = parsed.hostname.toLowerCase();

    if (host === "amazon.com.br" || host.endsWith(".amazon.com.br")) {
      return "amazon";
    }

    if (
      host === "meli.la"
      || host.endsWith(".meli.la")
      || host === "mlb.am"
      || host.endsWith(".mlb.am")
      || host.includes("mercadolivre")
      || host.includes("mercadolibre")
    ) {
      return "mercadolivre";
    }

    if (host.includes("shopee.") || host.endsWith("shope.ee")) {
      return "shopee";
    }
  } catch {
    return null;
  }

  return null;
}

function isStrictMercadoLivreProductUrl(rawUrl: string): boolean {
  const normalized = normalizeUrlInput(rawUrl);
  if (!normalized) return false;

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!(host.includes("mercadolivre.") || host.includes("mercadolibre."))) {
      return false;
    }

    let decodedPath = String(parsed.pathname || "");
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
      // Keep raw path when decode fails.
    }

    const normalizedPath = decodedPath.toLowerCase();
    if (
      normalizedPath.includes("/social/")
      || normalizedPath.includes("/sec/")
      || normalizedPath.includes("/afiliados/")
      || normalizedPath.includes("/noindex/services/")
      || normalizedPath.includes("/authentication")
      || normalizedPath.includes("/login")
    ) {
      return false;
    }

    const hasProductPathHint = (
      /\/(p|up|item)\//i.test(decodedPath)
      || /(?:^|\/)ML[A-Z]{1,4}-?\d+(?:[/_-]|$)/i.test(decodedPath)
    );
    if (!hasProductPathHint) {
      return false;
    }

    return /(?:^|\/)ML[A-Z]{1,4}-?\d+(?:[/_-]|$)/i.test(decodedPath);
  } catch {
    return false;
  }
}

function addMercadoLivreResolveNonce(rawUrl: string): string {
  const normalized = normalizeUrlInput(rawUrl);
  if (!normalized) return "";
  if (detectMarketplaceFromUrl(normalized) !== "mercadolivre") return normalized;

  try {
    const parsed = new URL(normalized);
    const existingHash = String(parsed.hash || "").replace(/^#/, "").trim();
    const nonce = `autolinks-resolve-${Date.now()}`;
    parsed.hash = existingHash ? `${existingHash}-${nonce}` : nonce;
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function marketplaceLabel(value: SupportedMarketplace): string {
  if (value === "mercadolivre") return "Mercado Livre";
  if (value === "amazon") return "Amazon";
  return "Shopee";
}

function mergeTemplatePlaceholderData(
  marketplace: SupportedMarketplace,
  product: MarketplaceOfferProduct | null,
  affiliateLink: string,
): Record<string, string> {
  const genericData = buildTemplatePlaceholderData(
    product as Partial<ShopeeProduct> | null,
    affiliateLink,
  );

  if (marketplace === "mercadolivre") {
    const moduleData = MELI_TEMPLATE_MODULE.buildPlaceholderData(
      product as MeliTemplateProductInput,
      affiliateLink,
    );
    return {
      ...genericData,
      ...moduleData,
      "{desconto}": genericData["{desconto}"] || "",
    };
  }

  if (marketplace === "amazon") {
    const moduleData = AMAZON_TEMPLATE_MODULE.buildPlaceholderData(
      product as AmazonTemplateProductInput,
      affiliateLink,
    );
    return {
      ...genericData,
      ...moduleData,
      "{desconto}": firstNonEmptyString(genericData["{desconto}"], moduleData["{desconto}"]),
    };
  }

  return genericData;
}

function applyMarketplaceTemplate(
  marketplace: SupportedMarketplace,
  templateContent: string,
  placeholderData: Record<string, string>,
): string {
  if (marketplace === "mercadolivre") {
    return MELI_TEMPLATE_MODULE.applyPlaceholders(templateContent, placeholderData);
  }
  if (marketplace === "amazon") {
    return AMAZON_TEMPLATE_MODULE.applyPlaceholders(templateContent, placeholderData);
  }
  return applyTemplatePlaceholders(templateContent, placeholderData);
}

function withRandomCtaPlaceholderData(
  placeholderData: Record<string, string>,
  randomPhrase: string,
): Record<string, string> {
  const normalizedPhrase = String(randomPhrase || "").trim();
  if (!normalizedPhrase) return placeholderData;

  return {
    ...placeholderData,
    "{cta_aleatoria}": normalizedPhrase,
    "{{cta_aleatoria}}": normalizedPhrase,
    "{cta aleatoria}": normalizedPhrase,
    "{{cta aleatoria}}": normalizedPhrase,
  };
}

function withPersonalizedCtaPlaceholderData(
  placeholderData: Record<string, string>,
  personalizedPhrase: string,
): Record<string, string> {
  const normalizedPhrase = String(personalizedPhrase || "").trim();
  if (!normalizedPhrase) return placeholderData;

  return {
    ...placeholderData,
    "{cta_personalizada}": normalizedPhrase,
    "{{cta_personalizada}}": normalizedPhrase,
    "{cta personalizada}": normalizedPhrase,
    "{{cta personalizada}}": normalizedPhrase,
  };
}

function withAiGeneratedCtaPlaceholderData(
  placeholderData: Record<string, string>,
  generatedPlaceholderData: Record<string, string>,
): Record<string, string> {
  if (!generatedPlaceholderData || Object.keys(generatedPlaceholderData).length === 0) {
    return placeholderData;
  }

  return {
    ...placeholderData,
    ...generatedPlaceholderData,
  };
}

function resolveProductImageUrl(product: Partial<ShopeeProduct> | null | undefined): string {
  const source = (product || {}) as Record<string, unknown>;
  return firstNonEmptyString(
    source.imageUrl,
    source.image_url,
    source.image,
    source.thumbnail,
  );
}

function normalizeGeneratedName(value: string, fallback: string): string {
  const trimmed = String(value || "").trim();
  const base = trimmed || fallback;
  return base.slice(0, 60);
}

export function OfferMessageGeneratorModal({ open, onOpenChange, onGenerated }: OfferMessageGeneratorModalProps) {
  const { templates, isLoading: templatesLoading } = useTemplates("message");
  const { isConfigured, convertLink } = useShopeeLinkModule();
  const {
    sessions,
    isLoading: meliSessionsLoading,
  } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const hasActiveMeliSession = useMemo(
    () => sessions.some((session) => session.status === "active"),
    [sessions],
  );
  const activeMeliSessionId = useMemo(
    () => firstNonEmptyString(sessions.find((session) => session.status === "active")?.id),
    [sessions],
  );
  const {
    isConfigured: hasAmazonTagConfigured,
    isLoading: amazonTagLoading,
  } = useAmazonAffiliateTag();

  const [converterLink, setConverterLink] = useState("");
  const [converterTemplateId, setConverterTemplateId] = useState("");
  const [converting, setConverting] = useState(false);

  const fallbackTemplateId = useMemo(
    () => templates.find((template) => template.isDefault)?.id || templates[0]?.id || "",
    [templates],
  );

  const selectedTemplateId = useMemo(
    () => converterTemplateId || fallbackTemplateId,
    [converterTemplateId, fallbackTemplateId],
  );

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) || null,
    [selectedTemplateId, templates],
  );

  const selectedTemplateLabel = selectedTemplate?.name || "Selecionar modelo de mensagem";
  const trimmedConverterLink = useMemo(
    () => converterLink.trim(),
    [converterLink],
  );
  const detectedMarketplace = useMemo(
    () => detectMarketplaceFromUrl(trimmedConverterLink),
    [trimmedConverterLink],
  );

  useEffect(() => {
    if (!open) return;

    if (!converterTemplateId && fallbackTemplateId) {
      setConverterTemplateId(fallbackTemplateId);
    }
  }, [converterTemplateId, fallbackTemplateId, open]);

  useEffect(() => {
    if (templates.length === 0) {
      if (converterTemplateId) setConverterTemplateId("");
      return;
    }
    if (!converterTemplateId) return;
    if (templates.some((template) => template.id === converterTemplateId)) return;

    setConverterTemplateId(fallbackTemplateId);
  }, [converterTemplateId, fallbackTemplateId, templates]);

  const resetState = () => {
    setConverterLink("");
    setConverting(false);
    setConverterTemplateId(fallbackTemplateId);
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetState();
    }
    onOpenChange(nextOpen);
  };

  const resolveRandomCtaPreviewPhrase = async (templateContent: string): Promise<string> => {
    if (!templateRequestsRandomCta(templateContent)) return "";

    try {
      const response = await invokeBackendRpc<RandomCtaNextResponse>("cta-random-next", {
        body: { source: "schedules-offer-generator" },
      });
      return firstNonEmptyString(response?.phrase);
    } catch {
      return "";
    }
  };

  const resolvePersonalizedCtaPreviewPhrase = async (templateContent: string): Promise<string> => {
    if (!templateRequestsPersonalizedCta(templateContent)) return "";

    try {
      const response = await invokeBackendRpc<PersonalizedCtaNextResponse>("cta-personalizada-next", {
        body: { source: "schedules-offer-generator" },
      });
      return firstNonEmptyString(response?.phrase);
    } catch {
      return "";
    }
  };

  const resolveAiGeneratedCtaPreviewData = async (
    template: Template,
    offerTitle: string,
  ): Promise<Record<string, string>> => {
    if (!templateRequestsAiGeneratedCta(template.content)) return {};

    try {
      const response = await invokeBackendRpc<AiCtaPlaceholdersNextResponse>("cta-ia-placeholders-next", {
        body: {
          templateId: template.id,
          templateContent: template.content,
          offerTitle,
          source: "schedules-offer-generator",
          persist: false,
        },
      });
      return response?.items && typeof response.items === "object"
        ? response.items
        : {};
    } catch {
      return {};
    }
  };

  const resolveConverterInput = (): { link: string; marketplace: SupportedMarketplace } | null => {
    const link = converterLink.trim();
    if (!link) {
      toast.error("Cole um link da Shopee, Mercado Livre ou Amazon primeiro");
      return null;
    }

    const marketplace = detectMarketplaceFromUrl(link);
    if (!marketplace) {
      toast.error("Use um link válido da Shopee, Mercado Livre ou Amazon");
      return null;
    }

    if (marketplace === "shopee" && !isConfigured) {
      toast.error("Preencha as credenciais da Shopee antes de converter");
      return null;
    }

    if (marketplace === "mercadolivre") {
      if (meliSessionsLoading) {
        toast.error("Aguarde o carregamento das sessões do Mercado Livre");
        return null;
      }
      if (!hasActiveMeliSession) {
        toast.error("Conecte uma sessão Mercado Livre ativa para converter");
        return null;
      }
    }

    if (marketplace === "amazon") {
      if (amazonTagLoading) {
        toast.error("Aguarde o carregamento da configuração Amazon");
        return null;
      }
      if (!hasAmazonTagConfigured) {
        toast.error("Configure sua tag Amazon antes de converter");
        return null;
      }
    }

    return { link, marketplace };
  };

  const canGenerate = !converting && !!trimmedConverterLink && !!selectedTemplateId;

  const handleGenerate = async () => {
    const resolvedInput = resolveConverterInput();
    if (!resolvedInput) return;

    const template = templates.find((item) => item.id === selectedTemplateId);
    if (!template) {
      toast.error("Escolha um modelo de mensagem primeiro");
      return;
    }

    const { link, marketplace } = resolvedInput;

    setConverting(true);
    try {
      const randomCtaPhrase = await resolveRandomCtaPreviewPhrase(template.content);
      const personalizedCtaPhrase = await resolvePersonalizedCtaPreviewPhrase(template.content);

      if (templateRequestsPersonalizedCta(template.content) && !personalizedCtaPhrase) {
        toast.warning("Seu modelo usa {cta_personalizada}, mas você ainda não tem CTA personalizada ativa.");
      }

      if (marketplace === "shopee") {
        const conversion = await convertLink(link, { source: "schedules-nova-oferta-shopee" });
        const affiliateLink = firstNonEmptyString(conversion.affiliateLink, link);
        const product = (conversion.product || null) as MarketplaceOfferProduct | null;
        const basePlaceholderData = mergeTemplatePlaceholderData("shopee", product, affiliateLink);
        const aiGeneratedCtaPlaceholderData = await resolveAiGeneratedCtaPreviewData(
          template,
          firstNonEmptyString(product?.title, "Oferta Shopee"),
        );
        const placeholderData = withAiGeneratedCtaPlaceholderData(
          withPersonalizedCtaPlaceholderData(
            withRandomCtaPlaceholderData(basePlaceholderData, randomCtaPhrase),
            personalizedCtaPhrase,
          ),
          aiGeneratedCtaPlaceholderData,
        );
        const message = applyMarketplaceTemplate("shopee", template.content, placeholderData);

        onGenerated({
          name: normalizeGeneratedName(firstNonEmptyString(product?.title), "Oferta Shopee"),
          message,
          templateId: template.id,
          affiliateLink,
          marketplace: "shopee",
          placeholderData,
          scheduleSource: templateRequestsImageAttachment(template.content) ? "shopee_catalog" : "shopee_templates",
          imagePolicy: templateRequestsImageAttachment(template.content) ? "required" : null,
          productImageUrl: firstNonEmptyString(resolveProductImageUrl(product)) || null,
        });

        toast.success("Mensagem gerada. Continue configurando o agendamento.");
        handleDialogOpenChange(false);
        return;
      }

      if (marketplace === "mercadolivre") {
        const conversion = await convertMarketplaceLink({
          url: link,
          source: "schedules-nova-oferta-meli",
          sessionId: activeMeliSessionId || undefined,
          forceResolve: true,
        });
        if (conversion.marketplace !== "mercadolivre") {
          throw new Error("Use um link válido do Mercado Livre.");
        }

        let snapshotTargetUrl = firstNonEmptyString(
          conversion.resolvedLink,
          conversion.originalLink,
          link,
        );
        let resolvedForSnapshot = conversion;

        if (!isStrictMercadoLivreProductUrl(snapshotTargetUrl)) {
          const sourceToResolve = firstNonEmptyString(conversion.originalLink, link, snapshotTargetUrl);
          const forcedResolveUrl = addMercadoLivreResolveNonce(sourceToResolve);

          try {
            const resolvedConversion = await convertMarketplaceLink({
              url: forcedResolveUrl,
              source: "schedules-nova-oferta-meli-resolve-url",
              sessionId: activeMeliSessionId || undefined,
              forceResolve: true,
            });
            if (resolvedConversion.marketplace === "mercadolivre") {
              resolvedForSnapshot = resolvedConversion;
              snapshotTargetUrl = firstNonEmptyString(
                resolvedConversion.resolvedLink,
                resolvedConversion.originalLink,
                snapshotTargetUrl,
              );
            }
          } catch {
            // Keep existing target URL and let strict validation below fail with a clear message.
          }
        }

        if (!isStrictMercadoLivreProductUrl(snapshotTargetUrl)) {
          throw new Error("URL precisa estar resolvida para uma página real de produto do Mercado Livre.");
        }

        const affiliateLink = firstNonEmptyString(
          resolvedForSnapshot.affiliateLink,
          conversion.affiliateLink,
          snapshotTargetUrl,
        );

        let productSnapshot: MeliProductSnapshotResponse;
        try {
          productSnapshot = await invokeBackendRpc<MeliProductSnapshotResponse>("meli-product-snapshot", {
            body: {
              productUrl: snapshotTargetUrl,
              sessionId: activeMeliSessionId || undefined,
              forceResolve: true,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? String(error.message || "") : "";
          throw new Error(message || "Não foi possível capturar os dados da página do produto Mercado Livre.");
        }

        const snapshotValidation = validateStrictMeliProductSnapshot(productSnapshot);
        if (!snapshotValidation.ok || !snapshotValidation.normalized) {
          const missing = [...new Set(snapshotValidation.missingFields)].join(", ");
          throw new Error(
            `Não foi possível gerar a mensagem porque faltam dados obrigatórios da página do produto: ${missing}.`,
          );
        }

        const normalizedSnapshot = snapshotValidation.normalized;
        const product: MarketplaceOfferProduct = {
          title: normalizedSnapshot.title,
          productUrl: firstNonEmptyString(normalizedSnapshot.productUrl, snapshotTargetUrl),
          imageUrl: normalizedSnapshot.imageUrl,
          price: normalizedSnapshot.price,
          oldPrice: normalizedSnapshot.oldPrice,
          installmentsText: firstNonEmptyString(normalizedSnapshot.installmentsText),
          seller: firstNonEmptyString(normalizedSnapshot.seller),
          rating: normalizedSnapshot.rating,
          reviewsCount: normalizedSnapshot.reviewsCount,
        };

        const basePlaceholderData = mergeTemplatePlaceholderData("mercadolivre", product, affiliateLink);
        const aiGeneratedCtaPlaceholderData = await resolveAiGeneratedCtaPreviewData(
          template,
          firstNonEmptyString(product.title, "Oferta Mercado Livre"),
        );
        const placeholderData = withAiGeneratedCtaPlaceholderData(
          withPersonalizedCtaPlaceholderData(
            withRandomCtaPlaceholderData(basePlaceholderData, randomCtaPhrase),
            personalizedCtaPhrase,
          ),
          aiGeneratedCtaPlaceholderData,
        );
        const message = applyMarketplaceTemplate("mercadolivre", template.content, placeholderData);

        onGenerated({
          name: normalizeGeneratedName(firstNonEmptyString(product.title), "Oferta Mercado Livre"),
          message,
          templateId: template.id,
          affiliateLink,
          marketplace: "mercadolivre",
          placeholderData,
          scheduleSource: "meli_templates",
          imagePolicy: templateRequestsImageAttachment(template.content) ? "required" : null,
          productImageUrl: firstNonEmptyString(product.imageUrl) || null,
        });

        toast.success("Mensagem gerada. Continue configurando o agendamento.");
        handleDialogOpenChange(false);
        return;
      }

      const conversion = await convertMarketplaceLink({
        url: link,
        source: "schedules-nova-oferta-amazon",
      });
      if (conversion.marketplace !== "amazon") {
        throw new Error("Use um link válido da Amazon.");
      }

      const snapshotTargetUrl = firstNonEmptyString(conversion.resolvedLink, conversion.originalLink, link);
      const affiliateLink = firstNonEmptyString(conversion.affiliateLink, snapshotTargetUrl);
      const productSnapshot = await invokeBackendRpc<AmazonProductSnapshotResponse>("amazon-product-snapshot", {
        body: {
          productUrl: snapshotTargetUrl,
          asin: conversion.asin,
        },
      });

      const hasSnapshotCoreFields = Boolean(firstNonEmptyString(productSnapshot?.title)) && (
        (toFiniteNumber(productSnapshot?.price) ?? 0) > 0
        || Boolean(firstNonEmptyString(productSnapshot?.discountText))
        || Boolean(firstNonEmptyString(productSnapshot?.imageUrl))
      );
      if (!hasSnapshotCoreFields) {
        throw new Error("Não foi possível extrair os dados do produto Amazon. Tente novamente em alguns instantes.");
      }

      const originalLink = firstNonEmptyString(productSnapshot?.productUrl, snapshotTargetUrl);
      const product: MarketplaceOfferProduct = {
        title: firstNonEmptyString(productSnapshot?.title, "Produto Amazon"),
        productUrl: firstNonEmptyString(productSnapshot?.productUrl, originalLink),
        imageUrl: firstNonEmptyString(productSnapshot?.imageUrl),
        price: toFiniteNumber(productSnapshot?.price) ?? null,
        oldPrice: toFiniteNumber(productSnapshot?.oldPrice) ?? null,
        discountText: firstNonEmptyString(productSnapshot?.discountText),
        installmentsText: firstNonEmptyString(productSnapshot?.installmentsText),
        seller: firstNonEmptyString(productSnapshot?.seller),
        badgeText: firstNonEmptyString(productSnapshot?.badgeText),
        asin: firstNonEmptyString(productSnapshot?.asin, conversion.asin),
        rating: toFiniteNumber(productSnapshot?.rating),
        reviewsCount: toFiniteNumber(productSnapshot?.reviewsCount) ?? null,
      };

      const basePlaceholderData = mergeTemplatePlaceholderData("amazon", product, affiliateLink);
      const aiGeneratedCtaPlaceholderData = await resolveAiGeneratedCtaPreviewData(
        template,
        firstNonEmptyString(product.title, "Produto Amazon"),
      );
      const placeholderData = withAiGeneratedCtaPlaceholderData(
        withPersonalizedCtaPlaceholderData(
          withRandomCtaPlaceholderData(basePlaceholderData, randomCtaPhrase),
          personalizedCtaPhrase,
        ),
        aiGeneratedCtaPlaceholderData,
      );
      const message = applyMarketplaceTemplate("amazon", template.content, placeholderData);

      onGenerated({
        name: normalizeGeneratedName(firstNonEmptyString(product.title), "Oferta Amazon"),
        message,
        templateId: template.id,
        affiliateLink,
        marketplace: "amazon",
        placeholderData,
        scheduleSource: "amazon_templates",
        imagePolicy: templateRequestsImageAttachment(template.content) ? "required" : null,
        productImageUrl: firstNonEmptyString(product.imageUrl) || null,
      });

      toast.success("Mensagem gerada. Continue configurando o agendamento.");
      handleDialogOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      const normalized = message
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (normalized.includes("cache da vitrine") || normalized.includes("atualize a vitrine")) {
        toast.error("Serviço Amazon desatualizado em execução. Reinicie o runtime para usar extração direta da página do produto.");
      } else {
        toast.error(message || "Não deu pra converter o link");
      }
    } finally {
      setConverting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nova Oferta</DialogTitle>
          <DialogDescription>
            Cole um link de marketplace, escolha o modelo de mensagem e gere o conteúdo para o agendamento.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={detectedMarketplace ? "border-primary/30 text-primary" : "text-muted-foreground"}
            >
              {detectedMarketplace ? `Marketplace: ${marketplaceLabel(detectedMarketplace)}` : "Marketplace: aguardando link"}
            </Badge>
            <Badge variant="secondary" className="text-[11px]">
              {templates.length} {templates.length === 1 ? "modelo" : "modelos"}
            </Badge>
          </div>

          <div className="space-y-2">
            <Label>Link do produto</Label>
            <Input
              placeholder="Cole o link da Shopee, Mercado Livre ou Amazon"
              value={converterLink}
              onChange={(event) => setConverterLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canGenerate) {
                  void handleGenerate();
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <Label>Modelo de mensagem</Label>
            {templates.length > 0 ? (
              <Select value={selectedTemplateId} onValueChange={setConverterTemplateId}>
                <SelectTrigger>
                  <SelectValue placeholder={selectedTemplateLabel} />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                      {template.isDefault ? " *" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Nenhum modelo disponível. Crie um modelo na aba Modelos.
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={handleGenerate} disabled={!canGenerate || templatesLoading}>
              {converting ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4 mr-1.5" />
              )}
              Gerar mensagem
            </Button>
          </div>

          <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5" />
            O conteúdo gerado será preenchido automaticamente no novo agendamento.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
