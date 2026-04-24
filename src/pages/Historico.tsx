import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useHistorico, type SendHistoryTarget } from "@/hooks/useHistorico";
import { formatBRT } from "@/lib/timezone";
import { toast } from "sonner";

type HistoryEntry = ReturnType<typeof useHistorico>["entries"][number];

type MechanismFilter = "all" | "route" | "schedule" | "automation";
type StatusFilter = "all" | "success" | "warning" | "error";
type TimeRangeFilter = "24h" | "7d" | "30d" | "all";
type PaginationItem = number | "ellipsis-left" | "ellipsis-right";

const HISTORY_PAGE_SIZE = 50;
const LEGACY_GROUP_WINDOW_MS = 2 * 60 * 1000;

function compactText(value: string): string {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function buildPaginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const items: PaginationItem[] = [1];
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);

  if (start > 2) items.push("ellipsis-left");
  for (let page = start; page <= end; page += 1) items.push(page);
  if (end < totalPages - 1) items.push("ellipsis-right");

  items.push(totalPages);
  return items;
}

function statusText(processingStatus: string): string {
  if (processingStatus === "sent") return "Enviado";
  if (processingStatus === "blocked") return "Bloqueado";
  if (processingStatus === "failed" || processingStatus === "error") return "Falhou";
  return "Processado";
}

function statusVariant(processingStatus: string): "default" | "secondary" | "outline" | "destructive" {
  if (processingStatus === "sent") return "default";
  if (processingStatus === "blocked") return "secondary";
  if (processingStatus === "failed" || processingStatus === "error") return "destructive";
  return "outline";
}

function mechanismLabelFromType(type: string): string {
  if (type === "route_forward") return "Rota";
  if (type === "schedule_sent") return "Agendamento";
  if (type === "automation_run") return "Automação";
  return "Evento";
}

function toUtcMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isFailureLikeStatus(processingStatus: string): boolean {
  return processingStatus === "failed" || processingStatus === "error";
}

function resolveLegacyRouteGroupKey(entry: HistoryEntry): string {
  if (entry.hasTargets) return "";
  if (entry.type !== "route_forward") return "";

  const destination = compactText(entry.destination || "");
  if (!destination || destination === "-") return "";

  const routeId = compactText(String(entry.details.routeId || entry.details.route_id || ""));
  const message = compactText(entry.message || "");
  if (!routeId || !message) return "";

  const bucket = Math.floor(toUtcMs(entry.date) / LEGACY_GROUP_WINDOW_MS);
  return `${routeId}|${entry.automationName}|${message.slice(0, 180)}|${bucket}`;
}

function groupLegacyRouteEntries(entries: HistoryEntry[]): {
  entries: HistoryEntry[];
  targetsByEntryId: Record<string, SendHistoryTarget[]>;
} {
  const groupedByKey = new Map<string, HistoryEntry[]>();
  const keyByEntryId = new Map<string, string>();

  entries.forEach((entry) => {
    const key = resolveLegacyRouteGroupKey(entry);
    if (!key) return;

    keyByEntryId.set(entry.id, key);
    if (!groupedByKey.has(key)) groupedByKey.set(key, []);
    groupedByKey.get(key)?.push(entry);
  });

  const output: HistoryEntry[] = [];
  const targetsByEntryId: Record<string, SendHistoryTarget[]> = {};
  const emitted = new Set<string>();

  entries.forEach((entry) => {
    const key = keyByEntryId.get(entry.id);
    if (!key) {
      output.push(entry);
      return;
    }

    const siblings = groupedByKey.get(key) || [entry];
    if (siblings.length <= 1) {
      output.push(entry);
      return;
    }

    if (emitted.has(key)) return;
    emitted.add(key);

    const parentId = `legacy-group:${siblings[0].id}`;
    const sortedChildren = siblings
      .slice()
      .sort((a, b) => toUtcMs(a.date) - toUtcMs(b.date));

    const childTargets: SendHistoryTarget[] = sortedChildren.map((child, index) => ({
      id: `legacy-target:${child.id}`,
      historyEntryId: parentId,
      destination: child.destination,
      destinationGroupId: "",
      platform: compactText(String(child.details.platform || "")),
      status: child.status,
      processingStatus: child.processingStatus,
      blockReason: child.blockReason,
      errorStep: child.errorStep,
      rawErrorMessage: child.rawErrorMessage,
      errorSummary: child.errorSummary,
      messageType: child.messageType,
      sendOrder: index,
      createdAt: child.date,
      title: child.title,
      message: child.message,
      details: child.details,
    }));

    const sent = childTargets.filter((target) => target.processingStatus === "sent").length;
    const blocked = childTargets.filter((target) => target.processingStatus === "blocked").length;
    const failed = childTargets.filter((target) => isFailureLikeStatus(target.processingStatus)).length;
    const processed = childTargets.filter((target) => target.processingStatus === "processed").length;
    const skipped = childTargets.filter((target) => target.processingStatus === "skipped").length;

    const firstProblem = childTargets.find((target) => isFailureLikeStatus(target.processingStatus) || target.processingStatus === "blocked");
    const mergedProcessingStatus = failed > 0
      ? "failed"
      : sent > 0
        ? "sent"
        : blocked > 0
          ? "blocked"
          : "processed";

    const first = siblings[0];
    output.push({
      ...first,
      id: parentId,
      destination: `${childTargets.length} destino(s)`,
      status: mergedProcessingStatus,
      title: statusText(mergedProcessingStatus),
      processingStatus: mergedProcessingStatus,
      blockReason: firstProblem?.blockReason || "",
      errorStep: firstProblem?.errorStep || "",
      rawErrorMessage: firstProblem?.rawErrorMessage || "",
      errorSummary: firstProblem?.errorSummary || first.errorSummary,
      hasTargets: true,
      targetSummary: {
        total: childTargets.length,
        sent,
        failed,
        blocked,
        processed,
        skipped,
      },
      details: {
        ...first.details,
        legacyGrouped: true,
        legacyGroupKey: key,
      },
    });

    targetsByEntryId[parentId] = childTargets;
  });

  return { entries: output, targetsByEntryId };
}

function buildEntrySearchText(entry: HistoryEntry, targets: SendHistoryTarget[] = []): string {
  const targetText = targets.flatMap((target) => [
    target.destination,
    target.platform,
    target.message,
    target.errorSummary,
    target.rawErrorMessage,
  ]).join(" ");

  return [
    entry.automationName,
    entry.destination,
    entry.message,
    entry.errorSummary,
    entry.rawErrorMessage,
    entry.type,
    mechanismLabelFromType(entry.type),
    statusText(entry.processingStatus),
    targetText,
  ].join(" ").toLowerCase();
}

export default function HistoryPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [mechanism, setMechanism] = useState<MechanismFilter>("all");
  const [timeRange, setTimeRange] = useState<TimeRangeFilter>("all");
  const [currentPage, setCurrentPage] = useState(1);

  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>({});
  const [targetsByEntryId, setTargetsByEntryId] = useState<Record<string, SendHistoryTarget[]>>({});
  const [loadingTargetsByEntryId, setLoadingTargetsByEntryId] = useState<Record<string, boolean>>({});

  const {
    entries,
    isLoading,
    isFetching,
    error,
    refetch,
    serverCounts,
    fetchEntryTargets,
    totalEntries: serverTotalEntries,
    totalPages: serverTotalPages,
  } = useHistorico({
    timeRange,
    status,
    mechanism,
    page: currentPage,
    pageSize: HISTORY_PAGE_SIZE,
  });

  useEffect(() => {
    setCurrentPage(1);
    setExpandedEntries({});
  }, [timeRange, status, mechanism]);

  useEffect(() => {
    setCurrentPage(1);
  }, [search]);

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;

    return entries.filter((entry) => {
      const loadedTargets = targetsByEntryId[entry.id] || [];
      return buildEntrySearchText(entry, loadedTargets).includes(query);
    });
  }, [entries, search, targetsByEntryId]);

  const groupedVisibleData = useMemo(() => groupLegacyRouteEntries(visibleEntries), [visibleEntries]);
  const displayEntries = groupedVisibleData.entries;
  const legacyTargetsByEntryId = groupedVisibleData.targetsByEntryId;

  const hasSearchQuery = search.trim().length > 0;
  const effectiveTotalEntries = hasSearchQuery ? displayEntries.length : serverTotalEntries;
  const effectiveTotalPages = hasSearchQuery ? 1 : serverTotalPages;

  useEffect(() => {
    if (currentPage > effectiveTotalPages) {
      setCurrentPage(effectiveTotalPages);
    }
  }, [currentPage, effectiveTotalPages]);

  const paginationItems = useMemo(
    () => buildPaginationItems(currentPage, effectiveTotalPages),
    [currentPage, effectiveTotalPages],
  );

  const listErrorMessage = useMemo(() => {
    if (!error) return "";
    if (error instanceof Error) return error.message;
    return "Não foi possível carregar o histórico.";
  }, [error]);

  const handleToggleTargets = async (entry: HistoryEntry) => {
    if (!entry.hasTargets) return;

    const isExpanded = Boolean(expandedEntries[entry.id]);
    if (isExpanded) {
      setExpandedEntries((prev) => ({ ...prev, [entry.id]: false }));
      return;
    }

    setExpandedEntries((prev) => ({ ...prev, [entry.id]: true }));

    const legacyTargets = legacyTargetsByEntryId[entry.id];
    if (legacyTargets) {
      setTargetsByEntryId((prev) => ({ ...prev, [entry.id]: legacyTargets }));
      return;
    }

    if (targetsByEntryId[entry.id]) return;

    setLoadingTargetsByEntryId((prev) => ({ ...prev, [entry.id]: true }));
    try {
      const targets = await fetchEntryTargets(entry.id);
      setTargetsByEntryId((prev) => ({ ...prev, [entry.id]: targets }));
    } catch (loadError) {
      toast.error(loadError instanceof Error ? loadError.message : "Falha ao carregar destinos do evento.");
      setExpandedEntries((prev) => ({ ...prev, [entry.id]: false }));
    } finally {
      setLoadingTargetsByEntryId((prev) => ({ ...prev, [entry.id]: false }));
    }
  };

  return (
    <div className="ds-page">
      <PageHeader
        title="Histórico"
        description="Acompanhe os envios, bloqueios e falhas com detalhes por destino"
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(260px,2fr)_repeat(3,minmax(0,1fr))]">
            <div className="relative min-w-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por origem, destino ou erro..."
                aria-label="Pesquisar no histórico"
                className="h-10 pl-9"
              />
            </div>

            <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="success">Enviadas</SelectItem>
                <SelectItem value="warning">Bloqueadas</SelectItem>
                <SelectItem value="error">Com erro</SelectItem>
              </SelectContent>
            </Select>

            <Select value={mechanism} onValueChange={(value) => setMechanism(value as MechanismFilter)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os tipos</SelectItem>
                <SelectItem value="route">Rotas</SelectItem>
                <SelectItem value="schedule">Agendamentos</SelectItem>
                <SelectItem value="automation">Automações</SelectItem>
              </SelectContent>
            </Select>

            <Select value={timeRange} onValueChange={(value) => setTimeRange(value as TimeRangeFilter)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Período" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24h">Últimas 24h</SelectItem>
                <SelectItem value="7d">Últimos 7 dias</SelectItem>
                <SelectItem value="30d">Últimos 30 dias</SelectItem>
                <SelectItem value="all">Todo o período</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-xl border bg-muted/20 p-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button
            type="button"
            className={`rounded-lg border px-3 py-2 text-center transition-colors ${status === "all" ? "border-primary bg-primary/10" : "border-transparent bg-background hover:border-border"}`}
            onClick={() => setStatus("all")}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total</p>
            <p className="text-base font-semibold leading-none">{serverCounts.total}</p>
          </button>
          <button
            type="button"
            className={`rounded-lg border px-3 py-2 text-center transition-colors ${status === "success" ? "border-primary bg-primary/10" : "border-transparent bg-background hover:border-border"}`}
            onClick={() => setStatus("success")}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Enviadas</p>
            <p className="text-base font-semibold leading-none">{serverCounts.success}</p>
          </button>
          <button
            type="button"
            className={`rounded-lg border px-3 py-2 text-center transition-colors ${status === "error" ? "border-primary bg-primary/10" : "border-transparent bg-background hover:border-border"}`}
            onClick={() => setStatus("error")}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Com erro</p>
            <p className="text-base font-semibold leading-none">{serverCounts.error}</p>
          </button>
          <button
            type="button"
            className={`rounded-lg border px-3 py-2 text-center transition-colors ${status === "warning" ? "border-primary bg-primary/10" : "border-transparent bg-background hover:border-border"}`}
            onClick={() => setStatus("warning")}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bloqueadas</p>
            <p className="text-base font-semibold leading-none">{serverCounts.warning}</p>
          </button>
        </div>

        <p className="mt-1 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
          <TrendingUp className="h-3 w-3 shrink-0" />
          Contadores do período completo com paginação por página.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Card key={index} className="glass">
              <CardContent className="p-4">
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {listErrorMessage && (
            <Card className="border-destructive/40 bg-destructive/[0.05]">
              <CardContent className="p-3 text-sm text-destructive">
                Falha ao carregar histórico: {listErrorMessage}
              </CardContent>
            </Card>
          )}

          {displayEntries.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="Nenhum evento encontrado"
              description={search.trim()
                ? "A busca não retornou resultados na página atual."
                : "Mude os filtros para localizar envios, bloqueios e falhas."}
            />
          ) : (
            <>
              {displayEntries.map((entry) => {
                const isExpanded = Boolean(expandedEntries[entry.id]);
                const isLoadingTargets = Boolean(loadingTargetsByEntryId[entry.id]);
                const targets = targetsByEntryId[entry.id] || legacyTargetsByEntryId[entry.id] || [];

                return (
                  <Card key={entry.id} className="glass">
                    <CardContent className="space-y-3 p-4">
                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={statusVariant(entry.processingStatus)} className="text-xs">
                              {statusText(entry.processingStatus)}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              {mechanismLabelFromType(entry.type)}
                            </Badge>
                            {entry.hasTargets && (
                              <Badge variant="outline" className="text-xs">
                                {entry.targetSummary.total} destino(s)
                              </Badge>
                            )}
                          </div>

                          <p className="text-sm font-semibold">{entry.automationName || "Evento"}</p>
                          <p className="text-xs text-muted-foreground">Destino: {entry.destination || "-"}</p>
                          {entry.message && (
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              Mensagem: {entry.message}
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 flex-col gap-1 text-left md:text-right">
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground md:justify-end">
                            <Clock className="h-3 w-3" />
                            {formatBRT(entry.date, "dd/MM/yyyy HH:mm:ss")}
                          </span>
                          <span className="text-xs text-muted-foreground">{entry.timeAgo}</span>
                        </div>
                      </div>

                      {(entry.processingStatus === "failed" || entry.processingStatus === "error" || entry.processingStatus === "blocked") && (
                        <p className="rounded-md border border-destructive/30 bg-destructive/[0.06] px-2 py-1.5 text-xs text-destructive">
                          Problema: {entry.errorSummary}
                        </p>
                      )}

                      {entry.hasTargets && (
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span>Enviados: {entry.targetSummary.sent}</span>
                            <span>Falhas: {entry.targetSummary.failed}</span>
                            <span>Bloqueios: {entry.targetSummary.blocked}</span>
                          </div>

                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5"
                            onClick={() => { void handleToggleTargets(entry); }}
                          >
                            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            {isExpanded ? "Ocultar destinos" : "Ver destinos"}
                          </Button>

                          {isExpanded && (
                            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                              {isLoadingTargets ? (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  Carregando destinos...
                                </div>
                              ) : targets.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Sem destinos filhos registrados para este evento.</p>
                              ) : (
                                targets.map((target) => (
                                  <div key={target.id} className="rounded-md border bg-background/80 px-2.5 py-2">
                                    <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                                      <div className="min-w-0 space-y-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <Badge variant={statusVariant(target.processingStatus)} className="text-[11px]">
                                            {statusText(target.processingStatus)}
                                          </Badge>
                                          {target.platform && (
                                            <Badge variant="outline" className="text-[11px]">
                                              {target.platform}
                                            </Badge>
                                          )}
                                        </div>
                                        <p className="text-xs font-medium">{target.destination}</p>
                                        {target.message && (
                                          <p className="text-xs text-muted-foreground line-clamp-1">
                                            Mensagem: {target.message}
                                          </p>
                                        )}
                                      </div>

                                      <span className="text-[11px] text-muted-foreground">
                                        {formatBRT(target.createdAt, "dd/MM HH:mm:ss")}
                                      </span>
                                    </div>

                                    {(target.processingStatus === "failed" || target.processingStatus === "error" || target.processingStatus === "blocked") && (
                                      <p className="mt-1 rounded border border-destructive/20 bg-destructive/[0.04] px-2 py-1 text-[11px] text-destructive">
                                        Problema: {target.errorSummary}
                                      </p>
                                    )}
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              <div className="space-y-2 pt-2">
                {effectiveTotalPages > 1 && (
                  <div className="flex flex-wrap items-center justify-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 px-2 text-xs"
                      disabled={currentPage <= 1}
                      onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Anterior
                    </Button>

                    {paginationItems.map((item) => {
                      if (typeof item !== "number") {
                        return (
                          <span key={item} className="px-1 text-xs text-muted-foreground">
                            ...
                          </span>
                        );
                      }

                      return (
                        <Button
                          key={item}
                          variant={item === currentPage ? "default" : "outline"}
                          size="sm"
                          className="h-8 min-w-8 px-2 text-xs"
                          onClick={() => setCurrentPage(item)}
                        >
                          {item}
                        </Button>
                      );
                    })}

                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 px-2 text-xs"
                      disabled={currentPage >= effectiveTotalPages}
                      onClick={() => setCurrentPage((prev) => Math.min(effectiveTotalPages, prev + 1))}
                    >
                      Próxima
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                <p className="text-center text-xs text-muted-foreground">
                  Página {currentPage} de {effectiveTotalPages} • {effectiveTotalEntries} evento(s) no período
                  {hasSearchQuery ? " • busca aplicada apenas na página atual" : ""}
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
