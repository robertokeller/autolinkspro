import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatPhoneDisplay } from "@/lib/phone-utils";
import {
  type AnalyticsAdminGroup,
  type MovementRecord,
  fetchMovementHistory,
  fetchMovementKpis,
} from "@/integrations/analytics-client";
import { ChevronLeft, ChevronRight, Clock, Search, UserMinus, UserPlus, Users, Zap, Timer } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  groups: AnalyticsAdminGroup[];
  days: number;
  selectedGroupIds: string[];
}

const PAGE_SIZE = 50;

type EventFilter = "all" | "member_joined" | "left";

// ── Formatters ───────────────────────────────────────────────────────────────

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function formatDatetime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ── Event badge ───────────────────────────────────────────────────────────────

function EventBadge({ type }: { type: MovementRecord["eventType"] }) {
  if (type === "member_joined") {
    return (
      <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15">
        <UserPlus className="h-3 w-3" />
        Entrada
      </Badge>
    );
  }
  if (type === "member_removed") {
    return (
      <Badge className="gap-1 border-orange-500/30 bg-orange-500/10 text-orange-600 hover:bg-orange-500/15">
        <UserMinus className="h-3 w-3" />
        Removido
      </Badge>
    );
  }
  return (
    <Badge className="gap-1 border-rose-500/30 bg-rose-500/10 text-rose-600 hover:bg-rose-500/15">
      <UserMinus className="h-3 w-3" />
      Saída
    </Badge>
  );
}

// ── KPI mini card ─────────────────────────────────────────────────────────────

function MiniKpiCard({
  icon,
  label,
  value,
  sub,
  tooltip,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tooltip: string;
  color: "emerald" | "rose" | "orange" | "amber" | "violet";
}) {
  const colorMap = {
    emerald: {
      bar: "bg-emerald-500/20 group-hover:bg-emerald-500/40",
      ring: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/5",
      dot: "bg-emerald-400",
      text: "text-emerald-600",
      border: "hover:border-emerald-500/30",
    },
    rose: {
      bar: "bg-rose-500/20 group-hover:bg-rose-500/40",
      ring: "bg-rose-500/10 text-rose-600 ring-rose-500/5",
      dot: "bg-rose-400",
      text: "text-rose-600",
      border: "hover:border-rose-500/30",
    },
    orange: {
      bar: "bg-orange-500/20 group-hover:bg-orange-500/40",
      ring: "bg-orange-500/10 text-orange-600 ring-orange-500/5",
      dot: "bg-orange-400",
      text: "text-orange-600",
      border: "hover:border-orange-500/30",
    },
    amber: {
      bar: "bg-amber-500/20 group-hover:bg-amber-500/40",
      ring: "bg-amber-500/10 text-amber-600 ring-amber-500/5",
      dot: "bg-amber-400",
      text: "text-amber-600",
      border: "hover:border-amber-500/30",
    },
    violet: {
      bar: "bg-violet-500/20 group-hover:bg-violet-500/40",
      ring: "bg-violet-500/10 text-violet-600 ring-violet-500/5",
      dot: "bg-violet-400",
      text: "text-violet-600",
      border: "hover:border-violet-500/30",
    },
  }[color];

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Card className={cn("group relative flex flex-col overflow-hidden border-border/50 shadow-sm transition-all hover:shadow-md cursor-default", colorMap.border)}>
            <div className={cn("absolute top-0 left-0 h-1 w-full transition-colors", colorMap.bar)} />
            <CardContent className="flex flex-1 flex-col items-center justify-center px-3 py-4 text-center">
              <div className={cn("mb-2 rounded-full p-2 ring-4", colorMap.ring)}>
                {icon}
              </div>
              <div className="w-full space-y-0.5">
                <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/80 leading-tight">{label}</p>
                <p className={cn("text-xl font-black tracking-tight leading-none", colorMap.text)}>{value}</p>
                {sub && (
                  <p className="mt-1 flex items-center justify-center gap-1 text-[9px] font-medium text-muted-foreground/60">
                    <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", colorMap.dot)} />
                    {sub}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[200px] text-center text-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function HistoricoMovimentos({ groups, days, selectedGroupIds }: Props) {
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [phoneSearch, setPhoneSearch] = useState("");
  const [page, setPage] = useState(0);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

  // Reset page when filters change
  const handleEventFilter = (v: EventFilter) => { setEventFilter(v); setPage(0); };
  const handlePhoneSearch = (v: string) => { setPhoneSearch(v); setPage(0); };

  const displayGroups = useMemo(
    () => selectedGroupIds.length > 0
      ? groups.filter((g) => selectedGroupIds.includes(g.id))
      : groups,
    [groups, selectedGroupIds],
  );

  // Resolve which group to display — use explicit selection or fall back to first
  const primaryGroup = useMemo(() => {
    if (activeGroupId) {
      const found = displayGroups.find((g) => g.id === activeGroupId);
      if (found) return found;
    }
    return displayGroups[0] ?? null;
  }, [activeGroupId, displayGroups]);

  const primaryGroupId = primaryGroup?.id ?? null;

  const historyQuery = useQuery({
    queryKey: ["analytics-movement-history", primaryGroupId, days, eventFilter, page],
    enabled: !!primaryGroupId,
    staleTime: 60_000,
    queryFn: () => fetchMovementHistory(primaryGroupId!, days, eventFilter, page, PAGE_SIZE),
  });

  const kpiQuery = useQuery({
    queryKey: ["analytics-movement-kpis", primaryGroupId, days],
    enabled: !!primaryGroupId,
    staleTime: 2 * 60_000,
    queryFn: () => fetchMovementKpis(primaryGroupId!, days),
  });

  const kpis = kpiQuery.data;
  const history = historyQuery.data;

  // Client-side phone filter (applied on top of server pagination)
  const filtered = useMemo(() => {
    const items = history?.items ?? [];
    const search = phoneSearch.replace(/\D/g, "");
    if (!search) return items;
    return items.filter((item) => item.memberPhone.replace(/\D/g, "").includes(search));
  }, [history?.items, phoneSearch]);

  const totalPages = history ? Math.ceil(history.total / PAGE_SIZE) : 0;
  const rangeStart = page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, history?.total ?? 0);

  if (!primaryGroupId) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 py-20 text-center text-sm text-muted-foreground">
        <Clock className="mb-3 h-8 w-8 opacity-40" />
        <p className="font-medium">Selecione ao menos um grupo para ver o histórico.</p>
        <p className="mt-1 text-xs opacity-60">Os movimentos são registrados a partir do momento em que o grupo é conectado.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {kpiQuery.isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] w-full rounded-xl" />
          ))
        ) : (
          <>
            {/* 1. Entradas */}
            <MiniKpiCard
              icon={<UserPlus className="h-4 w-4" />}
              label="Entradas"
              value={(kpis?.totalJoins ?? 0).toLocaleString("pt-BR")}
              sub={`últimos ${days} dias`}
              tooltip="Total de novos membros que entraram no grupo no período selecionado."
              color="emerald"
            />
            {/* 2. Saídas */}
            <MiniKpiCard
              icon={<UserMinus className="h-4 w-4" />}
              label="Saídas"
              value={(kpis?.totalLeaves ?? 0).toLocaleString("pt-BR")}
              sub={`últimos ${days} dias`}
              tooltip="Total de membros que saíram ou foram removidos do grupo no período selecionado."
              color="rose"
            />
            {/* 3. Saídas em menos de 24h */}
            <MiniKpiCard
              icon={<Zap className="h-4 w-4" />}
              label="Saídas &lt;24h"
              value={(kpis?.exitsUnder24h ?? 0).toLocaleString("pt-BR")}
              sub={
                (kpis?.totalLeaves ?? 0) > 0
                  ? `${Math.round(((kpis?.exitsUnder24h ?? 0) / (kpis?.totalLeaves ?? 1)) * 100)}% das saídas`
                  : "sem saídas"
              }
              tooltip="Membros que saíram em menos de 24 horas após entrar. Alta taxa indica baixa aderência ou conteúdo inadequado."
              color="orange"
            />
            {/* 4. Saídas em menos de 7 dias */}
            <MiniKpiCard
              icon={<Timer className="h-4 w-4" />}
              label="Saídas &lt;7 dias"
              value={(kpis?.exitsUnder7d ?? 0).toLocaleString("pt-BR")}
              sub={
                (kpis?.totalLeaves ?? 0) > 0
                  ? `${Math.round(((kpis?.exitsUnder7d ?? 0) / (kpis?.totalLeaves ?? 1)) * 100)}% das saídas`
                  : "sem saídas"
              }
              tooltip="Membros que saíram em menos de 7 dias após entrar. Inclui os que saíram em menos de 24 horas."
              color="amber"
            />
            {/* 5. Tempo médio de permanência */}
            <MiniKpiCard
              icon={<Clock className="h-4 w-4" />}
              label="Tempo Médio"
              value={kpis?.avgPermanenceFormatted ?? "—"}
              sub={kpis?.avgPermanenceFormatted ? "de permanência" : "dados insuficientes"}
              tooltip="Tempo médio de permanência dos membros que saíram. Calculado apenas para quem já entrou e saiu no período."
              color="violet"
            />
          </>
        )}
      </div>

      {/* History table card */}
      <Card className="overflow-hidden border-border/50 shadow-sm">
        <CardHeader className="border-b border-border/40 px-5 py-4 sm:px-6">
          {/* Title row */}
          <CardTitle className="flex items-center gap-2 text-base font-bold">
            <Users className="h-5 w-5 text-muted-foreground/70" />
            Histórico de movimentos
            {history && (
              <span className="text-sm font-normal text-muted-foreground">
                ({history.total.toLocaleString("pt-BR")})
              </span>
            )}
          </CardTitle>

          {/* Filter row */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
            {/* Group filter */}
            <Select
              value={primaryGroupId ?? ""}
              onValueChange={(v) => { setActiveGroupId(v); setPage(0); }}
            >
              <SelectTrigger className="h-9 w-full sm:w-[200px]">
                <SelectValue placeholder="Selecionar grupo" />
              </SelectTrigger>
              <SelectContent>
                {displayGroups.map((g) => (
                  <SelectItem key={g.id} value={g.id} className="text-xs">
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Event type filter */}
            <Select value={eventFilter} onValueChange={(v) => handleEventFilter(v as EventFilter)}>
              <SelectTrigger className="h-9 w-full sm:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os eventos</SelectItem>
                <SelectItem value="member_joined">Apenas entradas</SelectItem>
                <SelectItem value="left">Apenas saídas</SelectItem>
              </SelectContent>
            </Select>

            {/* Phone search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                className="h-9 pl-9 text-sm"
                placeholder="Buscar por telefone..."
                value={phoneSearch}
                onChange={(e) => handlePhoneSearch(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {historyQuery.isLoading ? (
            <div className="divide-y divide-border/30">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="ml-auto h-4 w-28" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-sm text-muted-foreground">
              <Clock className="mb-3 h-8 w-8 opacity-30" />
              <p className="font-medium">Nenhum movimento encontrado.</p>
              <p className="mt-1 text-xs opacity-60">
                Tente ajustar os filtros ou aguarde novos eventos serem registrados.
              </p>
            </div>
          ) : (
            <>
              {/* Column headers */}
              <div className="hidden grid-cols-[1fr_110px_148px_100px] gap-4 border-b border-border/40 bg-muted/30 px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground sm:grid">
                <span>Telefone</span>
                <span>Evento</span>
                <span>Data / Hora</span>
                <span>Permanência</span>
              </div>

              <div className="divide-y divide-border/20">
                {filtered.map((item) => (
                  <div
                    key={item.id}
                    className="px-5 py-3 transition-colors hover:bg-muted/20"
                  >
                    {/* Mobile: 2-row layout */}
                    <div className="flex items-center justify-between gap-3 sm:hidden">
                      <span className="font-mono text-sm font-medium text-foreground truncate">
                        {formatPhoneDisplay(item.memberPhone)}
                      </span>
                      <EventBadge type={item.eventType} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground sm:hidden">
                      <span>{formatDatetime(item.eventTimestamp)}</span>
                      <span className="shrink-0">
                        {item.timePermanenceMinutes != null
                          ? formatMinutes(item.timePermanenceMinutes)
                          : <span className="opacity-40">—</span>}
                      </span>
                    </div>

                    {/* Desktop: single-row grid */}
                    <div className="hidden sm:grid sm:grid-cols-[1fr_110px_148px_100px] sm:items-center sm:gap-4">
                      <span className="font-mono text-sm font-medium text-foreground">
                        {formatPhoneDisplay(item.memberPhone)}
                      </span>
                      <span>
                        <EventBadge type={item.eventType} />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDatetime(item.eventTimestamp)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {item.timePermanenceMinutes != null
                          ? formatMinutes(item.timePermanenceMinutes)
                          : <span className="opacity-40">—</span>}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border/40 px-5 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                    className="h-8 gap-1 text-xs"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Anterior
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {rangeStart}–{rangeEnd} de {history?.total.toLocaleString("pt-BR")}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                    className="h-8 gap-1 text-xs"
                  >
                    Próxima
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
