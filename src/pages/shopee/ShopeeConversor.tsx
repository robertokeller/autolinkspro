import { useEffect, useState, type ComponentProps } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Copy, FileText, Link2, Loader2, Lock } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useShopeeLinkModule } from "@/contexts/ShopeeLinkModuleContext";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { useAccessControl } from "@/hooks/useAccessControl";
import { ScheduleProductModal } from "@/components/shopee/ScheduleProductModal";
import { backend } from "@/integrations/backend/client";
import { convertMarketplaceLink, type MarketplaceConversionResult } from "@/lib/marketplace-link-converter";
import { ROUTES } from "@/lib/routes";
import { toast } from "sonner";
import { PageWrapper } from "@/components/PageWrapper";

type ConversorScheduleProduct = NonNullable<ComponentProps<typeof ScheduleProductModal>["product"]>;

function detectInputMarketplace(rawInput: string): "shopee" | "mercadolivre" | "amazon" | null {
  try {
    const normalized = /^https?:\/\//i.test(rawInput.trim()) ? rawInput.trim() : `https://${rawInput.trim()}`;
    const host = new URL(normalized).hostname.toLowerCase();
    if (host === "amazon.com.br" || host.endsWith(".amazon.com.br")) return "amazon";
    if (
      host === "meli.la" || host.endsWith(".meli.la")
      || host === "mlb.am" || host.endsWith(".mlb.am")
      || host.includes("mercadolivre") || host.includes("mercadolibre")
    ) return "mercadolivre";
    if (host.includes("shopee.") || host.endsWith("shope.ee")) return "shopee";
  } catch {
    // unparseable — let the backend decide
  }
  return null;
}

function toScheduleProductFromConversion(result: MarketplaceConversionResult): ConversorScheduleProduct {
  const marketplaceTitle = result.marketplace === "mercadolivre"
    ? "Oferta Mercado Livre"
    : result.marketplace === "amazon"
      ? "Oferta Amazon"
      : "Oferta Shopee";

  return {
    title: marketplaceTitle,
    affiliateLink: result.affiliateLink,
    shopName: marketplaceTitle,
  };
}

export default function ShopeeConversor() {
  const { user } = useAuth();
  const { isConfigured, isLoading, convertLink } = useShopeeLinkModule();
  const { sessions } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const { canAccess, isCheckingAccess } = useAccessControl();

  const [converterInput, setConverterInput] = useState("");
  const [converting, setConverting] = useState(false);
  const [loadingAmazonTag, setLoadingAmazonTag] = useState(true);
  const [amazonTagConfigured, setAmazonTagConfigured] = useState(false);
  const [conversionResult, setConversionResult] = useState<MarketplaceConversionResult | null>(null);
  const [scheduleProduct, setScheduleProduct] = useState<ConversorScheduleProduct | null>(null);
  const [scheduleInitialMessage, setScheduleInitialMessage] = useState("");

  const hasMercadoLivreAccess = canAccess("mercadoLivre");
  const canUseTemplates = canAccess("templates");

  const activeMeliSessions = sessions.filter((s) => s.status === "active" || s.status === "untested");
  const hasMeliSession = activeMeliSessions.length > 0;

  // A marketplace is only usable when the plan allows it AND it is properly configured.
  const canConvertShopee = isConfigured;
  const canConvertMeli = hasMercadoLivreAccess && hasMeliSession;
  const canConvertAmazon = hasMercadoLivreAccess && amazonTagConfigured;
  const canConvertAnyMarketplace = canConvertShopee || canConvertMeli || canConvertAmazon;

  useEffect(() => {
    let cancelled = false;

    const loadAmazonTag = async () => {
      if (!user?.id) {
        if (!cancelled) {
          setAmazonTagConfigured(false);
          setLoadingAmazonTag(false);
        }
        return;
      }

      setLoadingAmazonTag(true);
      try {
        const { data, error } = await backend
          .from("amazon_affiliate_tags")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (error) throw error;
        if (!cancelled) setAmazonTagConfigured(Boolean(data?.id));
      } catch {
        if (!cancelled) setAmazonTagConfigured(false);
      } finally {
        if (!cancelled) setLoadingAmazonTag(false);
      }
    };

    void loadAmazonTag();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleConvert = async () => {
    const input = converterInput.trim();
    if (!input) {
      toast.error("Cole um link para converter.");
      return;
    }

    // Enforce plan-level access before calling the backend.
    const detectedMarketplace = detectInputMarketplace(input);
    if (detectedMarketplace === "amazon" || detectedMarketplace === "mercadolivre") {
      if (!hasMercadoLivreAccess) {
        const name = detectedMarketplace === "amazon" ? "Amazon" : "Mercado Livre";
        toast.error(`Seu plano não inclui conversão de links ${name}.`, {
          description: "Faça upgrade do plano para habilitar este marketplace.",
        });
        return;
      }
    }

    setConverting(true);
    try {
      const result = await convertMarketplaceLink({
        url: input,
        source: "global-conversor",
        sessionId: activeMeliSessions[0]?.id,
        shopeeFallback: async (url, source) => {
          if (!isConfigured) {
            throw new Error("Credenciais não configuradas em /shopee/configuracoes.");
          }
          const conversion = await convertLink(url, { source });
          return {
            affiliateLink: String(conversion.affiliateLink || url).trim(),
            status: conversion.status,
          };
        },
      });

      if (!result?.affiliateLink) {
        toast.error("Conversão retornou sem link final.");
        return;
      }

      setConversionResult(result);
      setScheduleProduct(null);
      setScheduleInitialMessage("");
      toast.success(result.cached ? "Link processado (cache)." : "Link processado com sucesso.", {
        description: result.conversionTimeMs ? `${result.conversionTimeMs}ms` : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível processar este link.";
      if (message.toLowerCase().includes("tag de afiliado")) {
        toast.error("Configure sua tag em Configurações para processar este tipo de link.");
      } else {
        toast.error(message);
      }
    } finally {
      setConverting(false);
    }
  };

  const handleCopyConvertedLink = async () => {
    if (!conversionResult?.affiliateLink) return;
    await navigator.clipboard.writeText(conversionResult.affiliateLink);
    toast.success("Link copiado!");
  };

  const handleOpenScheduleModal = () => {
    if (!conversionResult?.affiliateLink) {
      toast.error("Converta um link antes de gerar a mensagem.");
      return;
    }

    if (!canUseTemplates) {
      toast.error("Seu plano não inclui modelos de mensagem.", {
        description: "Faça upgrade para gerar mensagens com templates no conversor.",
      });
      return;
    }

    setScheduleInitialMessage(conversionResult.affiliateLink);
    setScheduleProduct(toScheduleProductFromConversion(conversionResult));
  };

  return (
    <PageWrapper fallbackLabel="Carregando...">
      <div className="ds-page">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <PageHeader
          title="Conversor global de links"
          description="Cole um link e gere seu link de afiliado em um único fluxo."
        />

        <Card className="glass w-full">
          <CardHeader className="space-y-3 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={isConfigured ? "default" : "secondary"} className="gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Shopee {isConfigured ? "configurada" : "não configurada"}
              </Badge>
              <Badge
                variant={hasMercadoLivreAccess ? (hasMeliSession ? "default" : "secondary") : "outline"}
                className="gap-1.5"
              >
                {hasMercadoLivreAccess ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                Mercado Livre{" "}
                {!hasMercadoLivreAccess
                  ? "não disponível no plano"
                  : hasMeliSession
                    ? "com sessão ativa"
                    : "sem sessão ativa"}
              </Badge>
              <Badge
                variant={hasMercadoLivreAccess ? (amazonTagConfigured ? "default" : "secondary") : "outline"}
                className="gap-1.5"
              >
                {hasMercadoLivreAccess ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                Amazon{" "}
                {!hasMercadoLivreAccess
                  ? "não disponível no plano"
                  : amazonTagConfigured
                    ? "com tag ativa"
                    : "sem tag ativa"}
              </Badge>
            </div>
            <CardTitle className="text-base">Conversão unificada</CardTitle>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Identifica automaticamente qual é a plataforma do link e o converte usando a ferramenta certa.
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2.5">
              <Label className="text-sm text-muted-foreground">Cole o link para converter</Label>
              <div className="flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center">
                <Input
                  className="h-11"
                  placeholder="Cole aqui o link para converter"
                  value={converterInput}
                  onChange={(e) => setConverterInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleConvert()}
                  disabled={converting}
                />
                <Button
                  onClick={() => void handleConvert()}
                  disabled={converting || !canConvertAnyMarketplace}
                  className="h-11 w-full justify-center sm:w-auto sm:min-w-40"
                >
                  {converting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  <span className="ml-2">{converting ? "Convertendo..." : "Converter link"}</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Dica: aperte Enter para converter sem clicar no botão.</p>
            </div>

            {!isConfigured && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Para converter Shopee, configure suas credenciais em{" "}
                <Link to={ROUTES.app.shopeeConfiguracoes} className="text-primary hover:underline">
                  Configurações Shopee
                </Link>
                .
              </p>
            )}

            {!hasMercadoLivreAccess && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Mercado Livre e Amazon não estão disponíveis no seu plano atual. Faça upgrade para habilitar a conversão desses marketplaces.
              </p>
            )}

            {hasMercadoLivreAccess && !hasMeliSession && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Para converter Mercado Livre, conecte uma conta em{" "}
                <Link to={ROUTES.app.mercadolivreConfiguracoes} className="text-primary hover:underline">
                  Configurações ML
                </Link>
                .
              </p>
            )}

            {hasMercadoLivreAccess && !amazonTagConfigured && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Para converter Amazon, configure sua tag em{" "}
                <Link to={ROUTES.app.amazonConfiguracoes} className="text-primary hover:underline">
                  Configurações Amazon
                </Link>
                .
              </p>
            )}
          </CardContent>
        </Card>

        {conversionResult && (
          <Card className="glass w-full">
            <CardHeader className="space-y-2 pb-3">
              <CardTitle className="text-base">Link convertido com sucesso</CardTitle>
              <p className="text-sm text-muted-foreground">Plataforma detectada automaticamente pelo módulo global.</p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <Label className="text-sm text-muted-foreground">Plataforma</Label>
                <Badge variant="secondary" className="w-fit">
                  {conversionResult.marketplace === "mercadolivre"
                    ? "Mercado Livre"
                    : conversionResult.marketplace === "amazon"
                      ? "Amazon"
                      : "Shopee"}
                </Badge>
              </div>

              <div className="rounded-md border border-primary/20 bg-primary/5 p-3.5">
                <Label className="mb-1.5 block text-sm text-muted-foreground">Link de afiliado gerado</Label>
                <p className="break-all font-mono text-sm leading-relaxed text-primary">{conversionResult.affiliateLink}</p>
              </div>

              {conversionResult.resolvedLink && conversionResult.resolvedLink !== conversionResult.originalLink && (
                <div className="rounded-md border bg-muted/30 p-3.5">
                  <Label className="mb-1.5 block text-sm text-muted-foreground">Link resolvido antes da conversão</Label>
                  <p className="break-all font-mono text-xs leading-relaxed text-muted-foreground">
                    {conversionResult.resolvedLink}
                  </p>
                </div>
              )}

              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                <Button size="sm" onClick={() => void handleCopyConvertedLink()} className="w-full sm:w-auto">
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copiar link
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleOpenScheduleModal}
                  disabled={!canUseTemplates}
                  className="w-full sm:w-auto"
                >
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                  Gerar mensagem
                </Button>
                <span className="text-xs text-muted-foreground">Copie e use em mensagens, grupos e automações.</span>
              </div>

              {!canUseTemplates && (
                <p className="text-xs text-muted-foreground">
                  Seu plano atual não inclui modelos de mensagem no conversor.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <ScheduleProductModal
          open={!!scheduleProduct}
          onOpenChange={(open) => {
            if (!open) {
              setScheduleProduct(null);
              setScheduleInitialMessage("");
            }
          }}
          initialMessage={scheduleInitialMessage}
          product={scheduleProduct || undefined}
        />
      </div>
      </div>
    </PageWrapper>
  );
}

