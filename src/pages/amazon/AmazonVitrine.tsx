import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { PageWrapper } from "@/components/PageWrapper";
import { MercadoLivreScheduleModal } from "@/components/mercadolivre/MercadoLivreScheduleModal";
import { AmazonProductCard, type AmazonVitrineItem } from "@/components/amazon/AmazonProductCard";
import { useAuth } from "@/contexts/AuthContext";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { useAmazonAffiliateTag } from "@/hooks/useAmazonAffiliateTag";
import { convertMarketplaceLink } from "@/lib/marketplace-link-converter";
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

type AmazonVitrineItem = {
  id: string;
  tab: string;
  asin?: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  price: number;
  oldPrice: number | null;
  discountText: string;
  seller: string;
  shippingText?: string;
  installmentsText?: string;
  badgeText: string;
};

type AmazonVitrinePayload = {
  tab: string;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  items: AmazonVitrineItem[];
  tabs: Array<{ key: string; label: string; activeCount?: number }>;
  lastSyncAt: string | null;
  stale: boolean;
};

type AmazonScheduleProduct = {
  title?: string;
  affiliateLink: string;
  productUrl?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  discountText?: string;
  badgeText?: string;
  asin?: string;
  installmentsText?: string;
  seller?: string;
};

type AmazonConvertedPreview = {
  product: AmazonVitrineItem;
  affiliateLink: string;
  conversionTimeMs: number;
};

const PAGE_LIMIT = 50;
const DEFAULT_TAB = "destaques";
const TAB_DISPLAY_ORDER = [
  "destaques",
  "top_performance",
  "mais_vendidos",
  "ofertas_quentes",
  "melhor_avaliados",
] as const;
const TAB_KEY_ALIASES: Record<string, (typeof TAB_DISPLAY_ORDER)[number]> = {
  destaques: "destaques",
  top_performance: "top_performance",
  mais_vendidos: "mais_vendidos",
  ofertas_quentes: "ofertas_quentes",
  melhor_avaliados: "melhor_avaliados",
  mais_amados: "melhor_avaliados",
};
const TAB_LABEL_BY_KEY: Record<(typeof TAB_DISPLAY_ORDER)[number], string> = {
  destaques: "Destaques",
  top_performance: "Top Performance",
  mais_vendidos: "Mais Vendidos",
  ofertas_quentes: "Ofertas Quentes",
  melhor_avaliados: "Melhor Avaliados",
};

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
  mais_amados: Star,
};

function normalizeTab(tab: { key: string; label: string; activeCount?: number }) {
  const rawKey = String(tab.key || "").trim().toLowerCase();
  const rawLabel = String(tab.label || "").trim().toLowerCase();
  const normalizedKey = TAB_KEY_ALIASES[rawKey]
    || (rawLabel.includes("amado") ? "melhor_avaliados" : undefined)
    || (rawLabel.includes("avali") ? "melhor_avaliados" : undefined)
    || rawKey;

  return {
    ...tab,
    key: normalizedKey,
    label: TAB_LABEL_BY_KEY[normalizedKey as keyof typeof TAB_LABEL_BY_KEY] || tab.label,
  };
}

function sortTabs(tabs: Array<{ key: string; label: string; activeCount?: number }>) {
  const order = new Map(TAB_DISPLAY_ORDER.map((key, index) => [key, index]));

  return [...tabs]
    .map(normalizeTab)
    .sort((left, right) => {
      const leftIndex = order.get(left.key) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = order.get(right.key) ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return left.label.localeCompare(right.label, "pt-BR");
    });
}

function resolveTabIcon(tab: { key: string; label: string }): LucideIcon {
  const byKey = TAB_ICON_BY_KEY[String(tab.key || "").trim().toLowerCase()];
  if (byKey) return byKey;

  const normalizedLabel = String(tab.label || "").toLowerCase();
  if (normalizedLabel.includes("vend")) return TrendingUp;
  if (normalizedLabel.includes("quente") || normalizedLabel.includes("oferta")) return BadgePercent;
  if (normalizedLabel.includes("avali")) return Star;
  if (normalizedLabel.includes("top") || normalizedLabel.includes("destaque")) return Award;
  return Award;
}

export default function AmazonVitrine() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState(DEFAULT_TAB);
  const [knownTabs, setKnownTabs] = useState<Array<{ key: string; label: string; activeCount?: number }>>([
    { key: DEFAULT_TAB, label: "Destaques" },
  ]);
  const [page, setPage] = useState(1);
  const [isSyncingVitrine, setIsSyncingVitrine] = useState(false);
  const [convertingProductId, setConvertingProductId] = useState("");
  const [schedulingProductId, setSchedulingProductId] = useState("");
  const [scheduleProduct, setScheduleProduct] = useState<AmazonScheduleProduct | null>(null);
  const [convertedPreview, setConvertedPreview] = useState<AmazonConvertedPreview | null>(null);

  const { isConfigured: hasAmazonTagConfigured, isLoading: loadingAmazonTag } = useAmazonAffiliateTag();

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["amazon-vitrine", activeTab, page],
    queryFn: async () => await invokeBackendRpc<AmazonVitrinePayload>("amazon-vitrine-list", {
      body: {
        tab: activeTab,
        page,
        limit: PAGE_LIMIT,
      },
    }),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
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
    setKnownTabs(sortTabs(payload.tabs));
  }, [payload.tabs]);

  const tabs = useMemo(() => sortTabs(knownTabs), [knownTabs]);

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

  const buildScheduleProduct = (item: AmazonVitrineItem, affiliateLink: string): AmazonScheduleProduct => ({
    title: item.title,
    affiliateLink,
    productUrl: item.productUrl,
    imageUrl: item.imageUrl,
    price: item.price,
    oldPrice: item.oldPrice,
    discountText: item.discountText,
    badgeText: item.badgeText,
    asin: item.asin,
    installmentsText: item.installmentsText,
    seller: item.seller,
  });

  const convertProductLink = async (input: {
    productUrl: string;
    source: string;
  }) => {
    if (!hasAmazonTagConfigured) {
      throw new Error("Configure sua tag Amazon em /amazon/configuracoes para converter links.");
    }

    const response = await convertMarketplaceLink({
      url: input.productUrl,
      source: input.source,
    });

    if (response.marketplace !== "amazon") {
      throw new Error("O link informado não foi reconhecido como produto Amazon.");
    }

    const affiliateLink = String(response.affiliateLink || "").trim();
    if (!affiliateLink) {
      throw new Error("Conversão retornou link vazio.");
    }

    return {
      affiliateLink,
      conversionTimeMs: Number(response.conversionTimeMs || 0),
    };
  };

  const handleConvertClick = async (item: AmazonVitrineItem) => {
    if (!hasAmazonTagConfigured) {
      toast.error("Configure sua tag Amazon para habilitar a conversão.");
      return;
    }

    setConvertingProductId(item.id);
    try {
      const { affiliateLink, conversionTimeMs } = await convertProductLink({
        productUrl: item.productUrl,
        source: "amazon-vitrine",
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

  const handleScheduleClick = async (item: AmazonVitrineItem) => {
    if (!hasAmazonTagConfigured) {
      toast.error("Configure sua tag Amazon para agendar com link afiliado.");
      return;
    }

    setSchedulingProductId(item.id);
    try {
      const { affiliateLink } = await convertProductLink({
        productUrl: item.productUrl,
        source: "amazon-vitrine-schedule",
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
      toast.error("Não foi possível copiar o link.");
    }
  };

  const handleRefreshClick = async () => {
    setIsSyncingVitrine(true);
    try {
      await invokeBackendRpc<{
        skipped?: boolean;
        message?: string;
      }>("amazon-vitrine-sync", {
        body: {
          source: "ui-vitrineamazon-refresh",
          onlyIfStale: false,
        },
      });
      toast.success("Vitrine Amazon atualizada!");
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : "Não foi possível atualizar a vitrine Amazon.";
      toast.error(message);
    } finally {
      await refetch();
      setIsSyncingVitrine(false);
    }
  };

  return (
    <PageWrapper fallbackLabel="Carregando vitrine Amazon...">
      <div className="mx-auto w-full max-w-7xl space-y-5 pb-[calc(var(--safe-area-bottom)+0.5rem)] sm:space-y-6">
      <PageHeader
        title="Vitrine de ofertas"
        description="Produtos em destaque com links de afiliado"
      >
        <Button size="sm" variant="outline" onClick={() => { void handleRefreshClick(); }} disabled={isFetching || isSyncingVitrine}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", (isFetching || isSyncingVitrine) && "animate-spin")} />
          Atualizar
        </Button>
      </PageHeader>

      {!loadingAmazonTag && !hasAmazonTagConfigured && (
        <Card className="border-amber-500/30">
          <CardContent className="pt-4 text-sm text-muted-foreground">
            Configure sua tag Amazon em Configurações para habilitar a conversão e o agendamento de links nesta vitrine.
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
              {error instanceof Error ? error.message : "Não foi possível carregar a vitrine Amazon."}
            </CardContent>
          </Card>
        )}

        {!error && payload.items.length === 0 && (
          <EmptyState
            icon={ShoppingCart}
            title="Sem produtos na vitrine"
            description="Aguarde o próximo sync ou clique em Atualizar para tentar novamente."
          />
        )}

        {!error && payload.items.length > 0 && (
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:gap-5">
            {payload.items.map((item) => (
              <AmazonProductCard
                key={item.id}
                item={item}
                onConvert={handleConvertClick}
                onSchedule={handleScheduleClick}
                isConverting={convertingProductId === item.id}
                isScheduling={schedulingProductId === item.id}
              />
            ))}
          </div>
        )}

        {!error && payload.total > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="text-muted-foreground">Página {page} de {totalPages}</span>
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
                Próxima
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
              O link de afiliado foi gerado usando o conversor padrão. Você pode copiar, abrir ou criar um agendamento agora.
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
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Link Afiliado</p>
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

          <DialogFooter className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
            <Button variant="outline" onClick={() => { void handleCopyConvertedLink(); }} className="w-full sm:w-auto">
              <Copy className="mr-2 h-4 w-4" />
              Copiar Link
            </Button>

            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <a href={convertedPreview?.affiliateLink || "#"} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Abrir Link
                </a>
              </Button>
              <Button onClick={handleCreateScheduleFromConverted} className="w-full sm:w-auto">
                <CalendarDays className="mr-2 h-4 w-4" />
                Agendar Envio
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
        templateScope="amazon"
        marketplaceLabel="Amazon"
        product={scheduleProduct || undefined}
      />
      </div>
    </PageWrapper>
  );
}
