import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/EmptyState";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { RoutePendingState } from "@/components/RoutePendingState";
import { toast } from "sonner";
import { ExternalLink, Loader2, RefreshCw, ShoppingCart } from "lucide-react";

type MeliVitrineItem = {
  id: string;
  tab: string;
  sourceUrl: string;
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
  collectedAt: string;
};

type MeliVitrinePayload = {
  tab: string;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  items: MeliVitrineItem[];
  tabs: Array<{ key: string; label: string; activeCount: number }>;
  lastSyncAt: string | null;
  stale: boolean;
};

const PAGE_LIMIT = 24;
const DEFAULT_TAB = "all";

const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});

function formatPrice(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return brlFormatter.format(value);
}

function formatSyncDate(value: string | null) {
  if (!value) return "nunca";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "nunca";
  return date.toLocaleString("pt-BR");
}

export default function MercadoLivreVitrine() {
  const [activeTab, setActiveTab] = useState(DEFAULT_TAB);
  const [page, setPage] = useState(1);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [convertingProductId, setConvertingProductId] = useState("");
  const [convertedByProductId, setConvertedByProductId] = useState<Record<string, string>>({});

  const { sessions, isLoading: sessionsLoading } = useMercadoLivreSessions({ enableAutoMonitor: false });

  useEffect(() => {
    if (selectedSessionId) return;
    if (sessions.length === 0) return;
    const activeSession = sessions.find((session) => session.status === "active");
    setSelectedSessionId(activeSession?.id || sessions[0].id);
  }, [selectedSessionId, sessions]);

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
    tab: activeTab,
    page,
    limit: PAGE_LIMIT,
    total: 0,
    hasMore: false,
    items: [],
    tabs: [],
    lastSyncAt: null,
    stale: true,
  };

  const totalPages = useMemo(() => Math.max(1, Math.ceil(payload.total / Math.max(1, payload.limit))), [payload.total, payload.limit]);

  const handleTabChange = (tabKey: string) => {
    setActiveTab(tabKey);
    setPage(1);
  };

  const handleConvertClick = async (item: MeliVitrineItem) => {
    if (!selectedSessionId) {
      toast.error("Selecione uma sessão Mercado Livre ativa para converter.");
      return;
    }

    setConvertingProductId(item.id);
    try {
      const response = await invokeBackendRpc<{
        affiliateLink?: string;
        conversionTimeMs?: number;
      }>("meli-convert-link", {
        body: {
          sessionId: selectedSessionId,
          url: item.productUrl,
          source: "meli-vitrine",
        },
      });

      const affiliateLink = String(response.affiliateLink || "").trim();
      if (!affiliateLink) {
        throw new Error("Conversão retornou link vazio.");
      }

      setConvertedByProductId((prev) => ({ ...prev, [item.id]: affiliateLink }));
      window.open(affiliateLink, "_blank", "noopener,noreferrer");

      const conversionTimeMs = Number(response.conversionTimeMs || 0);
      toast.success("Link afiliado gerado!", {
        description: conversionTimeMs > 0
          ? `Tempo de conversão: ${conversionTimeMs} ms`
          : "O link afiliado foi aberto em nova aba.",
      });
    } catch (convertError) {
      toast.error(convertError instanceof Error ? convertError.message : "Falha ao converter link.");
    } finally {
      setConvertingProductId("");
    }
  };

  if (isLoading && !data) {
    return <RoutePendingState label="Carregando vitrine ML..." />;
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        title="Vitrine ML"
        description="Ofertas do Mercado Livre atualizadas automaticamente a cada 2 horas."
      >
        <Button size="sm" variant="outline" onClick={() => { void refetch(); }} disabled={isFetching}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
      </PageHeader>

      <Card className="glass">
        <CardContent className="grid gap-3 pt-5 md:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Último sync</p>
            <p className="text-sm font-medium">{formatSyncDate(payload.lastSyncAt)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Status da vitrine</p>
            <p className="text-sm font-medium">{payload.stale ? "Desatualizada" : "Atualizada"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Sessão para conversão</p>
            <Select value={selectedSessionId || undefined} onValueChange={setSelectedSessionId} disabled={sessionsLoading || sessions.length === 0}>
              <SelectTrigger className="mt-1 h-9">
                <SelectValue placeholder={sessions.length === 0 ? "Sem sessão ML ativa" : "Selecione a sessão"} />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {session.name} {session.status === "active" ? "• ativa" : `• ${session.status}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex min-w-full gap-2 pb-2">
          {payload.tabs.map((tab) => (
            <Button
              key={tab.key}
              size="sm"
              variant={activeTab === tab.key ? "default" : "outline"}
              className="h-9 shrink-0 rounded-full px-4"
              onClick={() => handleTabChange(tab.key)}
            >
              {tab.label} ({tab.activeCount})
            </Button>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      {error && (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Não foi possível carregar a vitrine ML."}
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
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:gap-5">
          {payload.items.map((item) => {
            const converting = convertingProductId === item.id;
            const convertedLink = convertedByProductId[item.id] || "";

            return (
              <Card key={item.id} className="overflow-hidden">
                <CardHeader className="p-0">
                  <div className="aspect-square bg-muted">
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2.5 p-3">
                  <p className="line-clamp-3 text-sm font-medium">{item.title}</p>

                  {item.badgeText && <p className="text-xs font-semibold text-primary">{item.badgeText}</p>}
                  {item.seller && <p className="text-xs text-muted-foreground">{item.seller}</p>}
                  {(item.rating || item.reviewsCount) && (
                    <p className="text-xs text-muted-foreground">
                      {item.rating ? `${item.rating.toFixed(1)} ⭐` : ""} {item.reviewsCount ? `(${item.reviewsCount})` : ""}
                    </p>
                  )}

                  {item.oldPrice && <p className="text-xs text-muted-foreground line-through">{formatPrice(item.oldPrice)}</p>}
                  <p className="text-base font-bold">{formatPrice(item.price)}</p>
                  {item.discountText && <p className="text-xs font-medium text-green-600">{item.discountText}</p>}
                  {item.shippingText && <p className="text-xs text-muted-foreground">{item.shippingText}</p>}
                  {item.installmentsText && <p className="line-clamp-2 text-xs text-muted-foreground">{item.installmentsText}</p>}

                  <div className="flex gap-2 pt-1">
                    <Button asChild variant="outline" size="sm" className="flex-1">
                      <a href={item.productUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="mr-1 h-3.5 w-3.5" />
                        Anúncio
                      </a>
                    </Button>

                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={converting}
                      onClick={() => { void handleConvertClick(item); }}
                    >
                      {converting ? (
                        <>
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          Convertendo
                        </>
                      ) : (
                        "Converter"
                      )}
                    </Button>
                  </div>

                  {convertedLink && (
                    <a
                      href={convertedLink}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-xs text-primary hover:underline"
                      title={convertedLink}
                    >
                      {convertedLink}
                    </a>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {!error && payload.total > 0 && (
        <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2 text-sm">
          <span>Mostrando {payload.items.length} de {payload.total} itens</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            >
              Anterior
            </Button>
            <span>Página {page} de {totalPages}</span>
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
  );
}
