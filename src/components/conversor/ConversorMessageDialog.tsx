import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, CheckCheck, Copy, Eye, ImageIcon, Link2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useTemplates } from "@/hooks/useTemplates";
import { useShopeeLinkModule } from "@/contexts/ShopeeLinkModuleContext";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import type { MarketplaceConversionResult } from "@/lib/marketplace-link-converter";
import type { ShopeeProduct } from "@/components/shopee/ProductCard";
import type { Template } from "@/lib/types";
import { AMAZON_TEMPLATE_MODULE, MELI_TEMPLATE_MODULE } from "@/lib/marketplace-template-modules";
import {
  applyTemplatePlaceholders,
  buildTemplatePlaceholderData,
  templateRequestsAiGeneratedCta,
  templateRequestsImageAttachment,
  templateRequestsPersonalizedCta,
  templateRequestsRandomCta,
} from "@/lib/template-placeholders";
import { formatMessageForPlatform, renderRichTextPreviewHtml } from "@/lib/rich-text";
import { ROUTES } from "@/lib/routes";
import { toast } from "sonner";

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

type SupportedMarketplace = MarketplaceConversionResult["marketplace"];

interface GeneratedOffer {
  marketplace: SupportedMarketplace;
  templateId: string;
  templateName: string;
  message: string;
  affiliateLink: string;
  originalLink?: string;
  conversionTimeMs?: number | null;
  product: MarketplaceOfferProduct | null;
  imageUrl: string;
  requestsImageAttachment: boolean;
}

export interface SchedulableProductInput {
  title?: string;
  affiliateLink: string;
  imageUrl?: string;
  salePrice?: number;
  originalPrice?: number;
  discount?: number;
  sales?: number;
  commission?: number;
  shopName?: string;
}

interface ConversorMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversionResult: MarketplaceConversionResult | null;
  onSchedule: (payload: { templateId: string; message: string; product: SchedulableProductInput }) => void;
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
  rating?: number | null;
  reviewsCount?: number | null;
  badgeText?: string;
  asin?: string;
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

function firstNonEmptyString(...values: unknown[]) {
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
      product as Record<string, unknown>,
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
      product as Record<string, unknown>,
      affiliateLink,
    );
    return {
      ...genericData,
      ...moduleData,
      "{desconto}": firstNonEmptyString(moduleData["{desconto}"], genericData["{desconto}"]),
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

function toSchedulableProduct(offer: GeneratedOffer): SchedulableProductInput {
  const source = (offer.product || {}) as Record<string, unknown>;
  const salePrice = toPositiveNumber(source.salePrice ?? source.price);
  const originalPrice = toPositiveNumber(
    source.originalPrice
    ?? source.oldPrice
    ?? source.priceMinBeforeDiscount
    ?? source.priceBeforeDiscount
    ?? source.priceMin,
  );

  return {
    title: firstNonEmptyString(source.title, source.productName, "Oferta"),
    affiliateLink: offer.affiliateLink,
    imageUrl: offer.imageUrl,
    salePrice,
    originalPrice,
    discount: toFiniteNumber(source.discount ?? source.priceDiscountRate),
    sales: toFiniteNumber(source.sales),
    commission: toFiniteNumber(source.commission ?? source.commissionRate),
    shopName: firstNonEmptyString(source.shopName, source.seller),
  };
}

function marketplaceLabel(value: SupportedMarketplace): string {
  if (value === "mercadolivre") return "Mercado Livre";
  if (value === "amazon") return "Amazon";
  return "Shopee";
}

export function ConversorMessageDialog({
  open,
  onOpenChange,
  conversionResult,
  onSchedule,
}: ConversorMessageDialogProps) {
  const { templates, isLoading: templatesLoading } = useTemplates("message");
  const { convertLink } = useShopeeLinkModule();

  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [generatedOffer, setGeneratedOffer] = useState<GeneratedOffer | null>(null);
  const [imagePreviewFailed, setImagePreviewFailed] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const fallbackTemplateId = useMemo(
    () => templates.find((item) => item.isDefault)?.id || templates[0]?.id || "",
    [templates],
  );
  const fallbackTemplateName = useMemo(
    () => templates.find((item) => item.isDefault)?.name || templates[0]?.name || "Selecionar modelo de mensagem",
    [templates],
  );
  const effectiveTemplateId = selectedTemplateId || fallbackTemplateId;

  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === effectiveTemplateId) || null,
    [effectiveTemplateId, templates],
  );

  const generatedOfferPreviewHtml = useMemo(
    () => (generatedOffer ? renderRichTextPreviewHtml(generatedOffer.message) : ""),
    [generatedOffer],
  );

  useEffect(() => {
    setImagePreviewFailed(false);
  }, [generatedOffer?.imageUrl]);

  useEffect(() => {
    if (!open) {
      setSelectedTemplateId("");
      setGeneratedOffer(null);
      setGenerating(false);
      setCopied(false);
      setImagePreviewFailed(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setGeneratedOffer(null);
    setCopied(false);
    setImagePreviewFailed(false);
  }, [
    conversionResult?.affiliateLink,
    conversionResult?.originalLink,
    conversionResult?.marketplace,
    open,
  ]);

  const resolveRandomCtaPreviewPhrase = async (templateContent: string): Promise<string> => {
    if (!templateRequestsRandomCta(templateContent)) return "";

    try {
      const response = await invokeBackendRpc<RandomCtaNextResponse>("cta-random-next", {
        body: {
          source: "conversor-preview",
          persist: false,
        },
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
        body: {
          source: "conversor-preview",
        },
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
          source: "conversor-preview",
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

  const handleCopy = async () => {
    if (!generatedOffer?.message) return;
    await navigator.clipboard.writeText(formatMessageForPlatform(generatedOffer.message, "whatsapp"));
    setCopied(true);
    toast.success("Mensagem copiada!");
    window.setTimeout(() => setCopied(false), 2000);
  };

  const handleGenerate = async () => {
    if (!conversionResult) {
      toast.error("Converta um link antes de gerar a mensagem.");
      return;
    }

    const template = selectedTemplate;
    if (!template) {
      toast.error("Selecione um modelo de mensagem.");
      return;
    }

    if (!selectedTemplateId) {
      setSelectedTemplateId(template.id);
    }

    setGenerating(true);
    setGeneratedOffer(null);
    setCopied(false);

    try {
      const randomCtaPhrase = await resolveRandomCtaPreviewPhrase(template.content);
      const personalizedCtaPhrase = await resolvePersonalizedCtaPreviewPhrase(template.content);

      if (templateRequestsPersonalizedCta(template.content) && !personalizedCtaPhrase) {
        toast.warning("Este modelo usa {cta_personalizada}, mas você não tem CTA personalizada ativa.");
      }

      if (conversionResult.marketplace === "shopee") {
        const shopeeSourceLink = firstNonEmptyString(
          conversionResult.resolvedLink,
          conversionResult.originalLink,
          conversionResult.affiliateLink,
        );

        const conversion = await convertLink(shopeeSourceLink, {
          source: "conversor-gerar-mensagem-shopee",
        });

        const affiliateLink = firstNonEmptyString(
          conversionResult.affiliateLink,
          conversion.affiliateLink,
          shopeeSourceLink,
        );
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
        const imageUrl = resolveProductImageUrl(conversion.product);

        setGeneratedOffer({
          marketplace: "shopee",
          templateId: template.id,
          templateName: template.name,
          message,
          affiliateLink,
          originalLink: shopeeSourceLink,
          conversionTimeMs: Number.isFinite(Number(conversionResult.conversionTimeMs))
            ? Number(conversionResult.conversionTimeMs)
            : null,
          product,
          imageUrl,
          requestsImageAttachment: templateRequestsImageAttachment(template.content),
        });

        return;
      }

      if (conversionResult.marketplace === "mercadolivre") {
        const snapshotTargetUrl = firstNonEmptyString(
          conversionResult.resolvedLink,
          conversionResult.originalLink,
          conversionResult.affiliateLink,
        );
        const affiliateLink = firstNonEmptyString(conversionResult.affiliateLink, snapshotTargetUrl);

        let productSnapshot: MeliProductSnapshotResponse | null = null;
        try {
          productSnapshot = await invokeBackendRpc<MeliProductSnapshotResponse>("meli-product-snapshot", {
            body: {
              productUrl: snapshotTargetUrl,
            },
          });
        } catch {
          toast.warning("Link convertido, mas alguns dados do produto não puderam ser carregados.");
        }

        const product: MarketplaceOfferProduct = {
          title: firstNonEmptyString(productSnapshot?.title, "Oferta Mercado Livre"),
          productUrl: firstNonEmptyString(productSnapshot?.productUrl, snapshotTargetUrl),
          imageUrl: firstNonEmptyString(productSnapshot?.imageUrl),
          price: toFiniteNumber(productSnapshot?.price) ?? null,
          oldPrice: toFiniteNumber(productSnapshot?.oldPrice) ?? null,
          installmentsText: firstNonEmptyString(productSnapshot?.installmentsText),
          seller: firstNonEmptyString(productSnapshot?.seller),
          rating: toFiniteNumber(productSnapshot?.rating),
          reviewsCount: toFiniteNumber(productSnapshot?.reviewsCount) ?? null,
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

        setGeneratedOffer({
          marketplace: "mercadolivre",
          templateId: template.id,
          templateName: template.name,
          message,
          affiliateLink,
          originalLink: firstNonEmptyString(productSnapshot?.productUrl, snapshotTargetUrl),
          conversionTimeMs: Number.isFinite(Number(conversionResult.conversionTimeMs))
            ? Number(conversionResult.conversionTimeMs)
            : null,
          product,
          imageUrl: firstNonEmptyString(product.imageUrl),
          requestsImageAttachment: templateRequestsImageAttachment(template.content),
        });

        return;
      }

      const snapshotTargetUrl = firstNonEmptyString(
        conversionResult.resolvedLink,
        conversionResult.originalLink,
        conversionResult.affiliateLink,
      );
      const affiliateLink = firstNonEmptyString(conversionResult.affiliateLink, snapshotTargetUrl);

      const productSnapshot = await invokeBackendRpc<AmazonProductSnapshotResponse>("amazon-product-snapshot", {
        body: {
          productUrl: snapshotTargetUrl,
          asin: conversionResult.asin,
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
        asin: firstNonEmptyString(productSnapshot?.asin, conversionResult.asin),
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

      setGeneratedOffer({
        marketplace: "amazon",
        templateId: template.id,
        templateName: template.name,
        message,
        affiliateLink,
        originalLink,
        conversionTimeMs: Number.isFinite(Number(conversionResult.conversionTimeMs))
          ? Number(conversionResult.conversionTimeMs)
          : null,
        product,
        imageUrl: firstNonEmptyString(product.imageUrl),
        requestsImageAttachment: templateRequestsImageAttachment(template.content),
      });
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      toast.error(message || "Não foi possível gerar a mensagem.");
    } finally {
      setGenerating(false);
    }
  };

  const handleSchedule = () => {
    if (!generatedOffer) return;

    const payload = {
      templateId: generatedOffer.templateId,
      message: generatedOffer.message,
      product: toSchedulableProduct(generatedOffer),
    };

    onOpenChange(false);
    window.setTimeout(() => onSchedule(payload), 0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-1rem),64rem)] max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Link2 className="h-4 w-4 text-primary" />
            Gerar mensagem com modelo
          </DialogTitle>
          <DialogDescription>
            Selecione um modelo da aba de modelos de mensagem para gerar o preview completo a partir do link convertido.
          </DialogDescription>
        </DialogHeader>

        {!conversionResult ? (
          <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            Converta um link primeiro para liberar a geração da mensagem.
          </div>
        ) : templatesLoading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Carregando modelos de mensagem...
          </div>
        ) : templates.length === 0 ? (
          <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Você ainda não possui modelos de mensagem salvos para usar neste fluxo.
            </p>
            <Button asChild size="sm">
              <Link to={ROUTES.app.modelosMensagem}>Criar modelos de mensagem</Link>
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card className="glass">
              <CardHeader className="border-b pb-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-primary" />
                  Gerador de mensagem com modelo
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Plataforma detectada: <span className="font-medium text-foreground">{marketplaceLabel(conversionResult.marketplace)}</span>
                </p>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Link convertido</Label>
                  <Input value={conversionResult.affiliateLink} readOnly className="font-mono text-xs" />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Modelo de mensagem</Label>
                  <Select
                    value={selectedTemplateId}
                    onValueChange={(value) => {
                      setSelectedTemplateId(value);
                      setGeneratedOffer(null);
                      setCopied(false);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={fallbackTemplateName} />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((template: Template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name}
                          {template.isDefault ? " ★" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  onClick={() => void handleGenerate()}
                  disabled={generating || templates.length === 0}
                  className="h-10 w-full sm:w-auto"
                >
                  {generating ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <Link2 className="h-4 w-4 mr-1.5" />
                  )}
                  Gerar
                </Button>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader className="border-b pb-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Eye className="h-4 w-4 text-primary" />
                  Preview da mensagem
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  O preview completo aparece aqui depois de gerar.
                </p>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                {generatedOffer ? (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <Label className="text-xs text-muted-foreground">Mensagem gerada</Label>
                        <p className="text-xs text-muted-foreground">
                          Modelo: <span className="font-medium text-foreground">{generatedOffer.templateName}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Marketplace: <span className="font-medium text-foreground">{marketplaceLabel(generatedOffer.marketplace)}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => void handleCopy()} className="h-8 text-xs">
                          {copied ? (
                            <CheckCheck className="h-3.5 w-3.5 mr-1 text-success" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 mr-1" />
                          )}
                          {copied ? "Copiado!" : "Copiar"}
                        </Button>
                        <Button size="sm" onClick={handleSchedule} className="h-8 text-xs">
                          <CalendarDays className="h-3.5 w-3.5 mr-1" />
                          Agendar envio
                        </Button>
                      </div>
                    </div>

                    {generatedOffer.requestsImageAttachment ? (
                      <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <ImageIcon className="h-3.5 w-3.5" />
                          Prévia de mídia do placeholder {"{imagem}"}
                        </div>
                        {generatedOffer.imageUrl && !imagePreviewFailed ? (
                          <img
                            src={generatedOffer.imageUrl}
                            alt="Prévia da imagem da oferta"
                            className="h-40 w-full rounded-md border bg-muted object-cover"
                            loading="lazy"
                            onError={() => setImagePreviewFailed(true)}
                          />
                        ) : (
                          <div className="flex h-20 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs text-muted-foreground">
                            Este modelo usa {"{imagem}"}, mas esse produto não retornou uma imagem válida.
                          </div>
                        )}
                      </div>
                    ) : null}

                    <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5">
                      <Label className="mb-1 block text-xs text-muted-foreground">Link final usado na mensagem</Label>
                      <p className="break-all font-mono text-xs leading-relaxed text-primary">{generatedOffer.affiliateLink}</p>
                    </div>

                    <div
                      className="text-sm whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 leading-relaxed max-h-72 overflow-y-auto"
                      dangerouslySetInnerHTML={{
                        __html: generatedOfferPreviewHtml,
                      }}
                    />
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                    Selecione um modelo e clique em Gerar para visualizar a mensagem completa.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {conversionResult ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" className="text-[11px]">
              Link detectado: {marketplaceLabel(conversionResult.marketplace)}
            </Badge>
            {conversionResult.conversionTimeMs ? <span>{conversionResult.conversionTimeMs}ms</span> : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
