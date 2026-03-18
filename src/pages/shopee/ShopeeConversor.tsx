import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Copy, Link2, Loader2 } from "lucide-react";
import { ShopeeCredentialsBanner } from "@/components/ShopeeCredentialsBanner";
import { useAuth } from "@/contexts/AuthContext";
import { useShopeeLinkModule } from "@/contexts/ShopeeLinkModuleContext";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { ROUTES } from "@/lib/routes";
import { toast } from "sonner";
import { RoutePendingState } from "@/components/RoutePendingState";

interface MercadoLivreLinkConversion {
  originalLink: string;
  affiliateLink: string;
  cached: boolean;
  conversionTimeMs?: number;
}

export default function ShopeeConversor() {
  const { user } = useAuth();
  const { isConfigured, isLoading, convertLink } = useShopeeLinkModule();
  const { sessions } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const [converterInput, setConverterInput] = useState("");
  const [convertingShopee, setConvertingShopee] = useState(false);
  const [convertingMeli, setConvertingMeli] = useState(false);
  const [convertedLink, setConvertedLink] = useState("");
  const [convertedPlatform, setConvertedPlatform] = useState<"shopee" | "mercadolivre" | null>(null);

  const converting = convertingShopee || convertingMeli;
  const activeMeliSessions = sessions.filter((s) => s.status === "active" || s.status === "untested");
  const hasMeliSession = activeMeliSessions.length > 0;

  const convertMeliLink = async (url: string, sessionId: string): Promise<MercadoLivreLinkConversion | null> => {
    if (!user) {
      toast.error("Você precisa estar logado");
      return null;
    }
    if (!url.trim()) {
      toast.error("Cole o link do produto");
      return null;
    }
    if (!sessionId) {
      toast.error("Escolha uma conta Mercado Livre");
      return null;
    }

    setConvertingMeli(true);
    try {
      const res = await invokeBackendRpc<{ affiliateLink?: string; cached?: boolean; conversionTimeMs?: number }>(
        "meli-convert-link",
        { body: { url: url.trim(), sessionId, source: "meli-conversor" } },
      );
      const conversion: MercadoLivreLinkConversion = {
        originalLink: url.trim(),
        affiliateLink: String(res.affiliateLink || url.trim()),
        cached: res.cached === true,
        conversionTimeMs: res.conversionTimeMs,
      };
      if (res.cached) {
        toast.success("Link convertido (cache)", { description: conversion.affiliateLink });
      } else {
        toast.success("Link convertido!", { description: `${res.conversionTimeMs ? `${res.conversionTimeMs}ms` : ""}` });
      }
      return conversion;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Não deu pra converter o link";
      toast.error("Erro na conversão", { description: message });
      return null;
    } finally {
      setConvertingMeli(false);
    }
  };

  const handleConvert = async () => {
    const input = converterInput.trim();
    if (!input) {
      toast.error("Cole um link pra converter");
      return;
    }

    const normalized = input.toLowerCase();
    const isMeliUrl = normalized.includes("mercadolivre") || normalized.includes("mercadolibre") || normalized.includes("meli.la") || normalized.includes("mlb.am");
    const isShopeeUrl = normalized.includes("shopee");

    if (!isMeliUrl && !isShopeeUrl) {
      toast.error("Link não suportado. Use links da Shopee ou Mercado Livre.");
      return;
    }

    if (isMeliUrl) {
      const sessionId = activeMeliSessions[0]?.id;
      if (!sessionId) {
        toast.error("Nenhuma conta do Mercado Livre ativa. Conecte uma em Configurações ML.");
        return;
      }

      const result = await convertMeliLink(input, sessionId);
      if (!result) return;

      setConvertedLink(result.affiliateLink);
      setConvertedPlatform("mercadolivre");
      toast.success("Link Mercado Livre convertido!");
      return;
    }

    if (!isConfigured) {
      toast.error("Configure a Shopee primeiro pra converter links.");
      return;
    }

    setConvertingShopee(true);
    try {
      const conversion = await convertLink(input, { source: "shopee-conversor-hibrido" });
      const affiliateLink = conversion.affiliateLink || input;
      setConvertedLink(affiliateLink);
      setConvertedPlatform("shopee");

      if (conversion.status === "real") {
        toast.success("Link Shopee convertido!");
      } else if (conversion.status === "partial") {
        toast.warning("Link Shopee convertido (dados parciais).");
      } else {
        toast.warning("Link Shopee convertido em fallback.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra converter o link");
    } finally {
      setConvertingShopee(false);
    }
  };

  const handleCopyConvertedLink = async () => {
    if (!convertedLink) return;
    await navigator.clipboard.writeText(convertedLink);
    toast.success("Link copiado!");
  };

  if (isLoading) {
    return <RoutePendingState label="Carregando conversor Shopee..." />;
  }

  return (
    <div className="ds-page">
      <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        title="Conversor de links"
        description="Cole um link da Shopee ou Mercado Livre e gere seu link de afiliado pronto pra compartilhar."
      />
      {!isConfigured && <ShopeeCredentialsBanner />}

      <Card className="glass w-full">
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={isConfigured ? "default" : "secondary"} className="gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Shopee {isConfigured ? "configurada" : "não configurada"}
            </Badge>
            <Badge variant={hasMeliSession ? "default" : "secondary"} className="gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Mercado Livre {hasMeliSession ? "com sessão ativa" : "sem sessão ativa"}
            </Badge>
          </div>
          <CardTitle className="text-base">Conversão rápida</CardTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">
            O sistema detecta a loja do link e converte com a conta que você conectou.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Link do produto</Label>
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <Input
                placeholder="https://... (Shopee ou Mercado Livre)"
                value={converterInput}
                onChange={(e) => setConverterInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConvert()}
                disabled={converting}
              />
              <Button onClick={handleConvert} disabled={converting || (!isConfigured && !hasMeliSession)} className="sm:min-w-32">
                {converting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                <span className="ml-2">{converting ? "Convertendo..." : "Converter link"}</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Dica: aperte Enter pra converter sem clicar no botão.
            </p>
          </div>

          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div className="rounded-md border border-border/70 bg-background/40 p-3">
              Shopee: usa suas credenciais de afiliado pra gerar o link.
            </div>
            <div className="rounded-md border border-border/70 bg-background/40 p-3">
              Mercado Livre: usa a primeira conta ativa conectada nas configurações.
            </div>
          </div>

          {!hasMeliSession && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Para converter links do Mercado Livre, conecte uma conta em{" "}
              <Link to={ROUTES.app.mercadolivreConfiguracoes} className="text-primary hover:underline">
                Configurações ML
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>

      {convertedLink && (
        <Card className="glass w-full">
          <CardHeader className="space-y-2 pb-3">
            <CardTitle className="text-base">Link convertido com sucesso</CardTitle>
            <p className="text-sm text-muted-foreground">
              Confira a plataforma detectada e copie a URL para usar em mensagens, grupos ou automações.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Label className="text-sm text-muted-foreground">Plataforma</Label>
              <Badge variant="secondary">
                {convertedPlatform === "mercadolivre" ? "Mercado Livre" : "Shopee"}
              </Badge>
            </div>
            <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
              <Label className="mb-1.5 block text-sm text-muted-foreground">Link de afiliado gerado</Label>
              <p className="break-all font-mono text-sm leading-relaxed text-primary">{convertedLink}</p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button size="sm" onClick={handleCopyConvertedLink} className="sm:w-auto">
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copiar link
              </Button>
              <span className="text-xs text-muted-foreground">Copie e cole onde quiser, mantendo o rastreamento de afiliado.</span>
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}
