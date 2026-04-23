import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, Loader2, RefreshCw, Search, TrendingUp } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useHistorico } from "@/hooks/useHistorico";
import { formatBRT } from "@/lib/timezone";

type HistoryEntry = ReturnType<typeof useHistorico>["entries"][number];

const COUNTER_LABELS: Record<"total" | "sent" | "failed" | "blocked", string> = {
  total: "Total",
  sent: "Enviadas",
  failed: "Com erro",
  blocked: "Bloqueadas",
};

const COUNTER_KEYS = ["total", "sent", "failed", "blocked"] as const;

const COUNTER_STATUS_MAP: Record<(typeof COUNTER_KEYS)[number], string> = {
  total: "all",
  sent: "sent",
  failed: "failed",
  blocked: "blocked",
};

type MechanismFilter = "all" | "schedule" | "automatic_routes" | "smart_automation";

type SecondaryFilterConfig = {
  placeholder: string;
  allLabel: string;
  options: string[];
};

function cleanEndpointLabel(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "-";
  if (raw.toLowerCase().startsWith("route:")) {
    const name = raw.slice(6).trim();
    return name ? `Rota ${name}` : "Rota";
  }
  return raw;
}

function mechanismName(entry: HistoryEntry): string {
  if (entry.mechanism === "automatic_routes") {
    return entry.routeName || cleanEndpointLabel(entry.source);
  }
  if (entry.mechanism === "smart_automation") {
    return cleanEndpointLabel(entry.source);
  }
  if (entry.mechanism === "schedule") {
    return "Envio agendado";
  }
  return "-";
}

function buildSearchText(entry: HistoryEntry): string {
  return [
    entry.typeLabel,
    entry.title,
    mechanismName(entry),
    entry.source,
    entry.destination,
    entry.routeName,
    entry.message,
    entry.errorMessage,
    entry.status,
    entry.connectionLabel,
    entry.traceId,
    entry.traceStep,
  ]
    .join(" ")
    .toLowerCase();
}

export default function HistoryPage() {
  const autoProbeAttemptsRef = useRef(0);
  const AUTO_PROBE_MAX_ATTEMPTS = 8;

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [mechanism, setMechanism] = useState<MechanismFilter>("all");
  const [secondaryFilter, setSecondaryFilter] = useState("all");
  const [connection, setConnection] = useState("all");
  const [timeRange, setTimeRange] = useState("all");

  const { entries, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch, serverCounts, isLoadingCounts, hasClientNoiseFiltered, clientNoiseFilteredCount } = useHistorico({
    timeRange,
    status,
    mechanism,
  });

  const secondaryFilterConfig = useMemo<SecondaryFilterConfig>(() => {
    if (mechanism === "automatic_routes") {
      const options = Array.from(
        new Set<string>(
          entries
            .filter((entry) => entry.routeId && !["none", "unmatched"].includes(entry.routeId) && entry.routeName)
            .map((entry) => entry.routeName.trim())
            .filter(Boolean),
        ),
      ).sort((a, b) => a.localeCompare(b));

      return {
        placeholder: "Filtrar por rota",
        allLabel: "Todas as rotas",
        options,
      };
    }

    if (mechanism === "smart_automation") {
      const options = Array.from(
        new Set<string>(
          entries
            .map((entry) => String(entry.source || "").trim())
            .filter(Boolean),
        ),
      ).sort((a, b) => a.localeCompare(b));

      return {
        placeholder: "Filtrar por automação",
        allLabel: "Todas as automações",
        options,
      };
    }

    if (mechanism === "schedule") {
      const options = Array.from(
        new Set<string>(
          entries
            .map((entry) => mechanismName(entry))
            .filter(Boolean),
        ),
      ).sort((a, b) => a.localeCompare(b));

      return {
        placeholder: "Filtrar por agendamento",
        allLabel: "Todos os agendamentos",
        options,
      };
    }

    return {
      placeholder: "Escolha um tipo primeiro",
      allLabel: "Todos os itens",
      options: [],
    };
  }, [mechanism, entries]);

  const visibleEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((entry) => {
      const matchesSecondaryFilter = secondaryFilter === "all"
        || (mechanism === "automatic_routes" && entry.routeName === secondaryFilter)
        || (mechanism === "smart_automation" && String(entry.source || "").trim() === secondaryFilter)
        || (mechanism === "schedule" && mechanismName(entry) === secondaryFilter)
        || mechanism === "all";

      if (!matchesSecondaryFilter) return false;
      if (connection !== "all" && entry.connection !== connection) return false;
      if (!q) return true;

      return buildSearchText(entry).includes(q);
    });
  }, [connection, mechanism, search, secondaryFilter, entries]);

  // Server counts reflect the full period — not limited by pagination.
  // Fall back to client counts while the count query is loading.
  const clientCounts = useMemo(() => {
    return visibleEntries.reduce(
      (acc, entry) => {
        if (entry.processingStatus === "sent") acc.sent += 1;
        else if (entry.processingStatus === "error" || entry.processingStatus === "failed") acc.failed += 1;
        else if (entry.processingStatus === "blocked") acc.blocked += 1;
        return acc;
      },
      { total: visibleEntries.length, sent: 0, failed: 0, blocked: 0 },
    );
  }, [visibleEntries]);

  const counters = serverCounts ?? clientCounts;

  useEffect(() => {
    autoProbeAttemptsRef.current = 0;
  }, [timeRange, status, mechanism]);

  useEffect(() => {
    const hasClientScopedFilters = search.trim().length > 0 || connection !== "all" || secondaryFilter !== "all";
    if (isLoading || isFetching || isFetchingNextPage) return;
    if (visibleEntries.length > 0) return;
    if (!hasClientNoiseFiltered) return;
    if (!hasNextPage) return;
    if (hasClientScopedFilters) return;
    if (autoProbeAttemptsRef.current >= AUTO_PROBE_MAX_ATTEMPTS) return;

    autoProbeAttemptsRef.current += 1;
    void fetchNextPage();
  }, [
    connection,
    fetchNextPage,
    hasClientNoiseFiltered,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
    search,
    secondaryFilter,
    visibleEntries.length,
  ]);

  return (
    <div className="ds-page">
      <PageHeader
        title="Histórico"
        description="Veja tudo que foi capturado e o que aconteceu com cada mensagem"
      >
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={isFetching}
          onClick={() => { void refetch(); }}
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
      </PageHeader>

      <Card className="glass">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(260px,2fr)_repeat(5,minmax(0,1fr))]">
            <div className="relative min-w-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por mensagem, rota ou erro..."
                aria-label="Pesquisar no histórico"
                className="h-10 pl-9"
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="sent">Enviada com sucesso</SelectItem>
                <SelectItem value="failed">Não foi enviada</SelectItem>
                <SelectItem value="blocked">Bloqueada</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={mechanism}
              onValueChange={(value) => {
                setMechanism(value as MechanismFilter);
                setSecondaryFilter("all");
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os tipos</SelectItem>
                <SelectItem value="schedule">Agendamentos</SelectItem>
                <SelectItem value="automatic_routes">Rotas</SelectItem>
                <SelectItem value="smart_automation">Piloto automático</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={secondaryFilter}
              onValueChange={setSecondaryFilter}
              disabled={mechanism === "all"}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={secondaryFilterConfig.placeholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{secondaryFilterConfig.allLabel}</SelectItem>
                {secondaryFilterConfig.options.map((itemName) => (
                  <SelectItem key={itemName} value={itemName}>
                    {itemName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={connection} onValueChange={setConnection}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Conexão" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as conexões</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="telegram">Telegram</SelectItem>
              </SelectContent>
            </Select>
            <Select value={timeRange} onValueChange={setTimeRange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Período" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Hoje</SelectItem>
                <SelectItem value="yesterday">Ontem</SelectItem>
                <SelectItem value="last_3_days">Últimos 3 dias</SelectItem>
                <SelectItem value="last_7_days">Últimos 7 dias</SelectItem>
                <SelectItem value="all">Todo o período</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="glass">
              <CardContent className="p-4">
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-xl border bg-muted/20 p-2 space-y-1.5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {COUNTER_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    const targetStatus = COUNTER_STATUS_MAP[key];
                    setStatus((prev) => (prev === targetStatus ? "all" : targetStatus));
                  }}
                  className={`rounded-lg border px-3 py-2 text-center transition-colors ${
                    status === COUNTER_STATUS_MAP[key]
                      ? "border-primary bg-primary/10"
                      : "border-transparent bg-background hover:border-border"
                  }`}
                  aria-pressed={status === COUNTER_STATUS_MAP[key]}
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{COUNTER_LABELS[key]}</p>
                  {isLoadingCounts && !serverCounts ? (
                    <p className="text-base font-semibold leading-none text-muted-foreground">—</p>
                  ) : (
                    <p className="text-base font-semibold leading-none">{counters[key]}</p>
                  )}
                </button>
              ))}
            </div>
            {serverCounts && !hasClientNoiseFiltered && (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground px-1">
                <TrendingUp className="h-3 w-3 shrink-0" />
                Total do período selecionado
              </p>
            )}
            {serverCounts && hasClientNoiseFiltered && (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground px-1">
                <TrendingUp className="h-3 w-3 shrink-0" />
                Contadores do período completo; lista ocultando ruídos recentes
              </p>
            )}
          </div>
          {visibleEntries.length === 0 ? (
            <EmptyState
              icon={Clock}
              title={hasClientNoiseFiltered ? "Somente ruídos ocultados" : "Nenhuma mensagem aqui"}
              description={hasClientNoiseFiltered
                ? `Ocultamos ${clientNoiseFilteredCount} registros de ruído (ex.: sem rota ativa ou origem sem rota configurada). Ajuste o período/mecanismo para ver envios, bloqueios úteis e falhas reais.`
                : "Mude os filtros pra encontrar o que você procura."}
            />
          ) : (
            <>
          <div className="hidden grid-cols-[1.9fr_1.1fr_1.1fr_170px] gap-3 rounded-xl border bg-muted/30 px-4 py-2.5 text-xs font-semibold text-muted-foreground md:grid">
            <span>Evento</span>
            <span>Fluxo</span>
            <span>Mecanismo</span>
            <span className="text-right">Horário</span>
          </div>
          {visibleEntries.map((entry) => (
            <Card key={entry.id} className="glass">
              <CardContent className="grid gap-3 p-4 md:grid-cols-[1.9fr_1.1fr_1.1fr_170px] md:items-start">
                <div className="min-w-0 space-y-1 text-left">
                  <p className="text-sm font-semibold">{entry.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {cleanEndpointLabel(entry.source)} {"->"} {cleanEndpointLabel(entry.destination)}
                  </p>
                  {entry.message && (
                    <p className="text-xs text-muted-foreground line-clamp-2">Mensagem: {entry.message}</p>
                  )}
                  {entry.errorMessage && (
                    <p className="text-xs text-destructive line-clamp-2">Erro: {entry.errorMessage}</p>
                  )}
                  {entry.traceStep && (
                    <p className="text-xs text-muted-foreground">Etapa: {entry.traceStep}</p>
                  )}
                  {entry.traceId && (
                    <p className="text-xs text-muted-foreground">TraceId: {entry.traceId}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1 text-left md:self-center">
                  <Badge variant="outline" className="text-xs">
                    {entry.processingStatusLabel}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {entry.connectionLabel}
                  </Badge>
                </div>

                <div className="space-y-1 text-center md:self-center">
                  <Badge variant="secondary" className="text-xs">
                    {entry.mechanismLabel}
                  </Badge>
                  <p className="text-xs text-muted-foreground">{mechanismName(entry)}</p>
                </div>

                <div className="flex shrink-0 flex-col gap-1 text-left md:text-right">
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground md:justify-end">
                    <Clock className="h-3 w-3" />
                    {formatBRT(entry.createdAt, "dd/MM/yyyy HH:mm:ss")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Captura: {formatBRT(entry.capturedAt, "HH:mm:ss")}
                  </span>
                </div>

              </CardContent>
            </Card>
          ))}
            {hasNextPage && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isFetchingNextPage}
                  onClick={() => { void fetchNextPage(); }}
                  className="gap-2"
                >
                  {isFetchingNextPage ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {isFetchingNextPage ? "Carregando..." : "Carregar mais"}
                </Button>
              </div>
            )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
