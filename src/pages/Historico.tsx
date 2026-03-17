import { useMemo, useState } from "react";
import { subDays } from "date-fns";
import { Clock, RefreshCw, Search } from "lucide-react";

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

const ALLOWED_MECHANISMS = new Set<HistoryEntry["mechanism"]>([
  "schedule",
  "automatic_routes",
  "smart_automation",
]);

const ALLOWED_CONNECTIONS = new Set<HistoryEntry["connection"]>(["whatsapp", "telegram", "other"]);

const COUNTER_LABELS: Record<"total" | "sent" | "failed" | "blocked", string> = {
  total: "Total",
  sent: "Enviadas",
  failed: "Falhas",
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
    return "Disparo agendado";
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
  const { entries, isLoading, isFetching, refetch } = useHistorico();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [mechanism, setMechanism] = useState<MechanismFilter>("all");
  const [secondaryFilter, setSecondaryFilter] = useState("all");
  const [connection, setConnection] = useState("all");
  const [timeRange, setTimeRange] = useState("last_7_days");

  const trackedEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.isMessageFlow
          && entry.isFinalOutcome
          && ALLOWED_MECHANISMS.has(entry.mechanism)
          && ALLOWED_CONNECTIONS.has(entry.connection),
      ),
    [entries],
  );

  const secondaryFilterConfig = useMemo<SecondaryFilterConfig>(() => {
    const scopedEntries = mechanism === "all"
      ? trackedEntries
      : trackedEntries.filter((entry) => entry.mechanism === mechanism);

    if (mechanism === "automatic_routes") {
      const options = Array.from(
        new Set<string>(
          scopedEntries
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
          scopedEntries
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
          scopedEntries
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
      placeholder: "Selecione um tipo primeiro",
      allLabel: "Todos os itens",
      options: [],
    };
  }, [mechanism, trackedEntries]);

  const preStatusFiltered = useMemo(() => {
    const now = new Date();
    const todayKey = formatBRT(now, "yyyy-MM-dd");
    const yesterdayKey = formatBRT(subDays(now, 1), "yyyy-MM-dd");
    const last3StartKey = formatBRT(subDays(now, 2), "yyyy-MM-dd");
    const last7StartKey = formatBRT(subDays(now, 6), "yyyy-MM-dd");

    const matchesTimeRange = (entryDateKey: string) => {
      if (timeRange === "all") return true;
      if (timeRange === "today") return entryDateKey === todayKey;
      if (timeRange === "yesterday") return entryDateKey === yesterdayKey;
      if (timeRange === "last_3_days") return entryDateKey >= last3StartKey && entryDateKey <= todayKey;
      if (timeRange === "last_7_days") return entryDateKey >= last7StartKey && entryDateKey <= todayKey;
      return true;
    };

    const q = search.trim().toLowerCase();
    return trackedEntries.filter((entry) => {
      const entryDateKey = formatBRT(entry.createdAt, "yyyy-MM-dd");
      const matchesSecondaryFilter = secondaryFilter === "all"
        || (mechanism === "automatic_routes" && entry.routeName === secondaryFilter)
        || (mechanism === "smart_automation" && String(entry.source || "").trim() === secondaryFilter)
        || (mechanism === "schedule" && mechanismName(entry) === secondaryFilter)
        || mechanism === "all";

      if (!matchesTimeRange(entryDateKey)) return false;
      if (mechanism !== "all" && entry.mechanism !== mechanism) return false;
      if (!matchesSecondaryFilter) return false;
      if (connection !== "all" && entry.connection !== connection) return false;
      if (!q) return true;

      return buildSearchText(entry).includes(q);
    });
  }, [connection, mechanism, search, secondaryFilter, timeRange, trackedEntries]);

  const filtered = useMemo(() => {
    if (status === "all") return preStatusFiltered;
    return preStatusFiltered.filter((entry) => entry.processingStatus === status);
  }, [preStatusFiltered, status]);

  const counters = useMemo(() => {
    return preStatusFiltered.reduce(
      (acc, entry) => {
        if (entry.processingStatus === "sent") acc.sent += 1;
        else if (entry.processingStatus === "failed") acc.failed += 1;
        else if (entry.processingStatus === "blocked") acc.blocked += 1;
        return acc;
      },
      { total: preStatusFiltered.length, sent: 0, failed: 0, blocked: 0 },
    );
  }, [preStatusFiltered]);

  return (
    <div className="ds-page">
      <PageHeader
        title="Histórico de mensagens"
        description="Apenas mensagens capturadas e o resultado do processamento"
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

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar mensagem, rota ou erro"
                aria-label="Pesquisar no histórico"
                className="pl-9"
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="sent">Enviada ao destino</SelectItem>
                <SelectItem value="failed">Falha ao enviar</SelectItem>
                <SelectItem value="blocked">Bloqueada por regra</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={mechanism}
              onValueChange={(value) => {
                setMechanism(value as MechanismFilter);
                setSecondaryFilter("all");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os tipos</SelectItem>
                <SelectItem value="schedule">Agendamentos</SelectItem>
                <SelectItem value="automatic_routes">Rotas automáticas</SelectItem>
                <SelectItem value="smart_automation">Piloto automático</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={secondaryFilter}
              onValueChange={setSecondaryFilter}
              disabled={mechanism === "all"}
            >
              <SelectTrigger>
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
              <SelectTrigger>
                <SelectValue placeholder="Conexão" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as conexões</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="telegram">Telegram</SelectItem>
                <SelectItem value="other">Sistema</SelectItem>
              </SelectContent>
            </Select>
            <Select value={timeRange} onValueChange={setTimeRange}>
              <SelectTrigger>
                <SelectValue placeholder="Período" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Hoje</SelectItem>
                <SelectItem value="yesterday">Ontem</SelectItem>
                <SelectItem value="last_3_days">Últimos 3 dias</SelectItem>
                <SelectItem value="last_7_days">Últimos 7 dias</SelectItem>
                <SelectItem value="all">Todo o período (7 dias)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="ds-card-grid mx-auto w-full max-w-5xl grid-cols-2 gap-2 rounded-md border bg-muted/20 p-2 sm:grid-cols-4">
            {COUNTER_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  const targetStatus = COUNTER_STATUS_MAP[key];
                  setStatus((prev) => (prev === targetStatus ? "all" : targetStatus));
                }}
                className={`rounded-md border px-3 py-2 text-center transition-colors ${
                  status === COUNTER_STATUS_MAP[key]
                    ? "border-primary bg-primary/10"
                    : "border-transparent bg-background hover:border-border"
                }`}
                aria-pressed={status === COUNTER_STATUS_MAP[key]}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{COUNTER_LABELS[key]}</p>
                <p className="text-base font-semibold leading-none">{counters[key]}</p>
              </button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="Nenhuma mensagem encontrada"
              description="Ajuste os filtros para encontrar eventos de captura, envio e falha."
            />
          ) : (
            <>
          <div className="hidden grid-cols-[1.9fr_1.1fr_1.1fr_170px] gap-3 rounded-md border bg-muted/30 px-4 py-2 text-xs font-semibold text-muted-foreground md:grid">
            <span>Evento</span>
            <span>Fluxo</span>
            <span>Mecanismo</span>
            <span className="text-right">Horário</span>
          </div>
          {filtered.map((entry) => (
            <Card key={entry.id}>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
