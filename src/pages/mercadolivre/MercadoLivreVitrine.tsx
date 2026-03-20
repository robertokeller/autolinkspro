import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { RoutePendingState } from "@/components/RoutePendingState";
import { MercadoLivreScheduleModal } from "@/components/mercadolivre/MercadoLivreScheduleModal";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Award,
  BadgePercent,
  CalendarDays,
  Copy,
  ExternalLink,
  Flame,
  Loader2,
  RefreshCw,
  ShoppingCart,
  Star,
  Store,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

type MeliVitrineItem = {
  id: string;
  tab: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  price: number;
  oldPrice: number | null;
  discountText: string;
  seller: string;
  rating: number | null;
  reviewsCount: number | null;
  shippingText: string;
  installmentsText: string;
  badgeText: string;
};

type MeliVitrinePayload = {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  items: MeliVitrineItem[];
  tabs: Array<{ key: string; label: string; activeCount?: number }>;
};

type MeliScheduleProduct = {
  title?: string;
  affiliateLink: string;
  productUrl?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  installmentsText?: string;
  seller?: string;
  rating?: number | null;
  reviewsCount?: number | null;
};

type MeliConvertedPreview = {
  product: MeliVitrineItem;
  affiliateLink: string;
  conversionTimeMs: number;
};

const PAGE_LIMIT = 24;
const DEFAULT_TAB = "destaques";

const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return brlFormatter.format(value);
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "";
  return Math.floor(value).toLocaleString("pt-BR");
}

function calculateDiscountPercent(oldPrice: number | null | undefined, price: number | null | undefined): number {
  if (oldPrice === null || oldPrice === undefined || !Number.isFinite(oldPrice) || oldPrice <= 0) return 0;
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return 0;
  if (oldPrice <= price) return 0;
  const percent = Math.round(((oldPrice - price) / oldPrice) * 100);
  return Number.isFinite(percent) ? Math.max(0, percent) : 0;
}

function normalizeInstallmentsText(value: string): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = normalized.match(/(\d{1,2})x\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) return normalized.replace(/^ou\s+/i, "").trim();
  const suffix = /sem juros/i.test(normalized) ? " sem juros" : "";
  return `${match[1]}x de R$${match[2]}${suffix}`;
}

const TAB_ICON_BY_KEY: Record<string, LucideIcon> = {
  destaques: Award,
  top_performance: Award,
  mais_vendidos: TrendingUp,
  ofertas_quentes: Flame,
  melhor_avaliados: Star,
};

function resolveTabIcon(tab: { key: string; label: string }): LucideIcon {
  const byKey = TAB_ICON_BY_KEY[String(tab.key || "").trim()];
  if (byKey) return byKey;

  const normalizedLabel = String(tab.label || "").toLowerCase();
  if (normalizedLabel.includes("vend")) return TrendingUp;
  if (normalizedLabel.includes("quente") || normalizedLabel.includes("oferta")) return BadgePercent;
  if (normalizedLabel.includes("avali")) return Star;
  if (normalizedLabel.includes("top") || normalizedLabel.includes("destaque")) return Award;
  return Award;
}

export default function MercadoLivreVitrine() {
  const [activeTab, setActiveTab] = useState(DEFAULT_TAB);
  const [knownTabs, setKnownTabs] = useState<Array<{ key: string; label: string; activeCount?: number }>>([
    { key: DEFAULT_TAB, label: "Destaques" },
  ]);
  const [page, setPage] = useState(1);
  const [isSyncingVitrine, setIsSyncingVitrine] = useState(false);
  const [convertingProductId, setConvertingProductId] = useState("");
  const [schedulingProductId, setSchedulingProductId] = useState("");
  const [scheduleProduct, setScheduleProduct] = useState<MeliScheduleProduct | null>(null);
  const [convertedPreview, setConvertedPreview] = useState<MeliConvertedPreview | null>(null);

  const { sessions } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const activeSessions = useMemo(
    () => sessions.filter((session) => session.status === "active"),
    [sessions],
  );
  const hasActiveMeliSession = activeSessions.length > 0;

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["meli-vitrine", activeTab, page],
    queryFn: async () => await invokeBackendRpc<MeliVitrinePayload>("meli-vitrine-list", {
      body: {
        tab: activeTab,
        page,
        limit: PAGE_LIMIT,
      },
    }),
    staleTime: 30_000,
    refetchInterval: 2 * 60 * 1000,
  });

  const payload = data ?? {
    page,
    limit: PAGE_LIMIT,
    total: 0,
    hasMore: false,
    items: [],
    tabs: [],
  };

  useEffect(() => {
    if (payload.tabs.length === 0) return;
    setKnownTabs(payload.tabs);
  }, [payload.tabs]);

  const tabs = useMemo(() => knownTabs, [knownTabs]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.key === activeTab)) {
      setActiveTab(tabs[0]?.key || DEFAULT_TAB);
      setPage(1);
    }
  }, [activeTab, tabs]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(payload.total / Math.max(1, payload.limit))),
    [payload.total, payload.limit],
  );

  const handleTabChange = (tabKey: string) => {
    if (tabKey === activeTab) return;
    setActiveTab(tabKey);
    setPage(1);
  };

  const buildScheduleProduct = (item: MeliVitrineItem, affiliateLink: string): MeliScheduleProduct => ({
    title: item.title,
    affiliateLink,
    productUrl: item.productUrl,
    imageUrl: item.imageUrl,
    price: item.price,
    oldPrice: item.oldPrice,
    installmentsText: item.installmentsText,
    seller: item.seller,
    rating: item.rating,
    reviewsCount: item.reviewsCount,
  });

  const convertProductLink = async (input: {
    productUrl: string;
    source: string;
  }) => {
    if (!hasActiveMeliSession) {
      throw new Error("Nenhuma sessão Mercado Livre ativa para conversão.");
    }

    const response = await invokeBackendRpc<{
      affiliateLink?: string;
      conversionTimeMs?: number;
    }>("meli-convert-link", {
      body: {
        url: input.productUrl,
        source: input.source,
      },
    });

    const affiliateLink = String(response.affiliateLink || "").trim();
    if (!affiliateLink) {
      throw new Error("Conversão retornou link vazio.");
    }

    return {
      affiliateLink,
      conversionTimeMs: Number(response.conversionTimeMs || 0),
    };
  };

  const handleConvertClick = async (item: MeliVitrineItem) => {
    if (!hasActiveMeliSession) {
      toast.error("Nenhuma sessão Mercado Livre ativa para conversão.");
      return;
    }

    setConvertingProductId(item.id);
    try {
      const { affiliateLink, conversionTimeMs } = await convertProductLink({
        productUrl: item.productUrl,
        source: "meli-vitrine",
      });

      setConvertedPreview({
        product: item,
        affiliateLink,
        conversionTimeMs,
      });

      toast.success("Link afiliado gerado com sucesso.");
    } catch (convertError) {
      toast.error(convertError instanceof Error ? convertError.message : "Falha ao converter link.");
    } finally {
      setConvertingProductId("");
    }
  };

  const handleScheduleClick = async (item: MeliVitrineItem) => {
    if (!hasActiveMeliSession) {
      toast.error("Conecte uma sessão Mercado Livre ativa para agendar com link afiliado.");
      return;
    }

    setSchedulingProductId(item.id);
    try {
      const { affiliateLink } = await convertProductLink({
        productUrl: item.productUrl,
        source: "meli-vitrine-schedule",
      });

      setScheduleProduct(buildScheduleProduct(item, affiliateLink));
    } catch (scheduleError) {
      toast.error(scheduleError instanceof Error ? scheduleError.message : "Falha ao preparar agendamento.");
    } finally {
      setSchedulingProductId("");
    }
  };

  const handleCreateScheduleFromConverted = () => {
    if (!convertedPreview) return;
    setScheduleProduct(buildScheduleProduct(convertedPreview.product, convertedPreview.affiliateLink));
    setConvertedPreview(null);
  };

  const handleCopyConvertedLink = async () => {
    const link = String(convertedPreview?.affiliateLink || "").trim();
    if (!link) return;

    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link afiliado copiado.");
    } catch {
      toast.error("Não foi possivel copiar o link.");
    }
  };

  const handleRefreshClick = async () => {
    setIsSyncingVitrine(true);
    try {
      await invokeBackendRpc<{
        skipped?: boolean;
        message?: string;
      }>("meli-vitrine-sync", {
        body: {
          source: "ui-vitrineml-refresh",
          onlyIfStale: false,
        },
      });
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : "Não foi possivel atualizar a vitrine ML.";
      toast.error(message);
    } finally {
      await refetch();
      setIsSyncingVitrine(false);
    }
  };

  if (isLoading && !data) {
    return <RoutePendingState label="Carregando vitrine ML..." />;
  }

  return (
    <div className="mx-auto w-full max-w-[1380px] space-y-5 pb-[calc(var(--safe-area-bottom)+0.5rem)] sm:space-y-6">
      <PageHeader
        title="Vitrine de ofertas"
        description="Produtos em destaque com links de afiliado"
      >
        <Button size="sm" variant="outline" onClick={() => { void handleRefreshClick(); }} disabled={isFetching || isSyncingVitrine}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", (isFetching || isSyncingVitrine) && "animate-spin")} />
          Atualizar
        </Button>
      </PageHeader>

      {activeSessions.length === 0 && (
        <Card className="border-amber-500/30">
          <CardContent className="pt-4 text-sm text-muted-foreground">
            Conecte uma sessão Mercado Livre ativa em Configurações para habilitar a conversão e agendamento de links nesta vitrine.
          </CardContent>
        </Card>
      )}

      <div className="space-y-5">
        <ScrollArea className="w-full whitespace-nowrap">
          <div className="mx-auto flex w-max min-w-full justify-center gap-2.5 pb-2">
            {tabs.map((tab) => {
              const Icon = resolveTabIcon(tab);
              return (
                <Button
                  key={tab.key}
                  size="sm"
                  variant={activeTab === tab.key ? "default" : "outline"}
                  className="h-9 shrink-0 gap-2 rounded-full px-4 text-sm sm:h-10"
                  onClick={() => handleTabChange(tab.key)}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </Button>
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        {!error && (
          <p className="text-sm text-muted-foreground">
            {payload.total.toLocaleString("pt-BR")} itens encontrados
          </p>
        )}

        {error && (
          <Card>
            <CardContent className="pt-6 text-sm text-destructive">
              {error instanceof Error ? error.message : "Não foi possivel carregar a vitrine ML."}
            </CardContent>
          </Card>
        )}

        {!error && payload.items.length === 0 && (
          <EmptyState
            icon={ShoppingCart}
            title="Sem produtos na vitrine"
            description="Aguarde o proximo sync ou clique em Atualizar para tentar novamente."
          />
        )}

        {!error && payload.items.length > 0 && (
          <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 sm:gap-4 xl:grid-cols-3 2xl:grid-cols-4">
            {payload.items.map((item) => {
              const converting = convertingProductId === item.id;
              const scheduling = schedulingProductId === item.id;
              const discountPercent = calculateDiscountPercent(item.oldPrice, item.price);
              const installmentsText = normalizeInstallmentsText(item.installmentsText);
              const reviewsCountLabel = formatCount(item.reviewsCount);

              return (
                <Card
                  key={item.id}
                  className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
                >
                  <div className="relative aspect-square overflow-hidden bg-muted/40">
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      loading="lazy"
                      className="h-full w-full object-contain p-2 transition-transform duration-300 group-hover:scale-105"
                      onError={(event) => { event.currentTarget.src = "/placeholder.svg"; }}
                    />

                    {discountPercent > 0 && (
                      <Badge className="absolute right-2 top-2 bg-destructive text-xs text-white">
                        -{discountPercent}%
                      </Badge>
                    )}
                  </div>

                  <CardContent className="flex flex-1 flex-col gap-2.5 p-3 sm:p-4">
                    <p className="line-clamp-2 min-h-[2.65rem] text-sm font-semibold leading-5">
                      {item.title}
                    </p>

                    <div className="space-y-1">
                      {item.seller && (
                        <p className="line-clamp-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <Store className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{item.seller}</span>
                        </p>
                      )}

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        {item.rating ? (
                          <span className="inline-flex items-center gap-1">
                            <Star className="h-3.5 w-3.5 fill-warning text-warning" />
                            {item.rating.toFixed(1)}
                          </span>
                        ) : null}
                        <span>{reviewsCountLabel ? `${reviewsCountLabel} avaliacoes` : "Sem avaliacoes"}</span>
                      </div>
                    </div>

                    <div className="space-y-1">
                      {item.oldPrice && (
                        <p className="text-xs text-muted-foreground line-through">
                          {formatPrice(item.oldPrice)}
                        </p>
                      )}
                      <p className="text-lg font-bold tracking-tight text-primary sm:text-xl">{formatPrice(item.price)}</p>
                      {installmentsText && (
                        <p className="line-clamp-1 text-xs text-muted-foreground">{installmentsText}</p>
                      )}
                    </div>

                    <div className="mt-auto space-y-2 pt-1 sm:flex sm:items-center sm:gap-2 sm:space-y-0">
                      <Button
                        size="sm"
                        className="h-10 w-full text-xs sm:h-9 sm:flex-1"
                        disabled={converting || !hasActiveMeliSession}
                        onClick={() => { void handleConvertClick(item); }}
                      >
                        {converting ? (
                          <>
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            Convertendo...
                          </>
                        ) : (
                          "Converter"
                        )}
                      </Button>

                      <div className="flex items-center gap-2 sm:w-auto">
                        <Button asChild size="sm" variant="outline" className="h-10 flex-1 text-xs sm:h-9 sm:flex-none">
                          <a href={item.productUrl} target="_blank" rel="noreferrer">
                            <ExternalLink className="mr-1 h-3.5 w-3.5" />
                            Anuncio
                          </a>
                        </Button>

                        <Button
                          size="icon"
                          variant="outline"
                          className="h-10 w-10 shrink-0 sm:h-9 sm:w-9"
                          title="Agendar envio"
                          disabled={scheduling || !hasActiveMeliSession}
                          onClick={() => { void handleScheduleClick(item); }}
                        >
                          {scheduling ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CalendarDays className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {!error && payload.total > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="text-muted-foreground">Pagina {page} de {totalPages}</span>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              >
                Anterior
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!payload.hasMore}
                onClick={() => setPage((prev) => prev + 1)}
              >
                Proxima
              </Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!convertedPreview} onOpenChange={(open) => { if (!open) setConvertedPreview(null); }}>
        <DialogContent className="w-[min(calc(100vw-1rem),40rem)] max-w-none">
          <DialogHeader>
            <DialogTitle>Link convertido com sucesso</DialogTitle>
            <DialogDescription>
              O link de afiliado foi gerado usando o conversor padrao. Voce pode copiar, abrir ou criar um agendamento agora.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Produto</p>
              <p className="mt-1 line-clamp-2 text-sm font-medium">
                {convertedPreview?.product.title || ""}
              </p>
            </div>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Link afiliado</p>
              <p className="mt-1 break-all font-mono text-sm text-primary">
                {convertedPreview?.affiliateLink || ""}
              </p>
            </div>

            {!!convertedPreview?.conversionTimeMs && (
              <p className="text-xs text-muted-foreground">
                Tempo de conversão: {convertedPreview.conversionTimeMs} ms
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => { void handleCopyConvertedLink(); }}>
              <Copy className="mr-1.5 h-4 w-4" />
              Copiar link
            </Button>

            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline">
                <a href={convertedPreview?.affiliateLink || "#"} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                  Abrir link
                </a>
              </Button>
              <Button onClick={handleCreateScheduleFromConverted}>
                <CalendarDays className="mr-1.5 h-4 w-4" />
                Criar agendamento
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MercadoLivreScheduleModal
        open={!!scheduleProduct}
        onOpenChange={(open) => {
          if (!open) setScheduleProduct(null);
        }}
        product={scheduleProduct || undefined}
      />
    </div>
  );
}
