import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/PageHeader";
import { BrasilMap } from "@/components/metrics/BrasilMap";
import { CapacidadePorGrupo } from "@/components/metrics/CapacidadePorGrupo";
import { GruposDesempenho } from "@/components/metrics/GruposDesempenho";
import { HistoricoMovimentos } from "@/components/metrics/HistoricoMovimentos";
import { RecapturaAutomatica } from "@/components/metrics/RecapturaAutomatica";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";
import { useAuth } from "@/contexts/AuthContext";
import { useWhatsAppSessions } from "@/hooks/useWhatsAppSessions";
import {
  type AnalyticsAdminGroup,
  type GeographyMetrics,
  type CrossGroupOverlapMetrics,
  fetchAdminGroups,
  fetchGroupSummary,
  fetchCrossGroupOverlap,
  syncAllWhatsAppGroups,
} from "@/integrations/analytics-client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import {
  BellRing,
  Globe2,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  UserMinus,
  UserPlus,
  Users,
  WifiOff,
  X,
  GitMerge,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type DashboardOverview = {
  totalMembers: number;
  totalGroups: number;
  groupsConsidered: number;
  growthRate: number;
  totalJoined: number;
  totalLeft: number;
  capacityPercent: number;
  geography: GeographyMetrics;
  groupsWithData: number;
  groupsFailed: number;
};

const WHATSAPP_GROUP_CAPACITY = 1024;
const EMPTY_GROUPS: AnalyticsAdminGroup[] = [];

function createEmptyGeography(): GeographyMetrics {
  return {
    byState: [],
    byDDD: [],
    topState: "N/A",
    topDDD: "N/A",
    stateDiversity: 0,
    dddDiversity: 0,
    mapData: [],
  };
}

function toSafeNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function interpolateHexColor(start: string, end: string, ratio: number): string {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  const parse = (hex: string) => {
    const normalized = hex.replace("#", "");
    const full = normalized.length === 3
      ? normalized.split("").map((c) => c + c).join("")
      : normalized;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  };

  const s = parse(start);
  const e = parse(end);
  const r = Math.round(s.r + (e.r - s.r) * safeRatio);
  const g = Math.round(s.g + (e.g - s.g) * safeRatio);
  const b = Math.round(s.b + (e.b - s.b) * safeRatio);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function aggregateGeography(geographies: GeographyMetrics[]): GeographyMetrics {
  if (geographies.length === 0) return createEmptyGeography();

  const stateMap = new Map<string, { count: number; ibgeCode: number; ddds: Set<string> }>();
  const dddMap = new Map<string, { count: number; state: string }>();
  let totalMembers = 0;

  for (const geo of geographies) {
    for (const state of geo.byState || []) {
      const key = String(state.uf || "").trim();
      if (!key) continue;
      const existing = stateMap.get(key) || { count: 0, ibgeCode: toSafeNumber(state.ibgeCode), ddds: new Set<string>() };
      existing.count += toSafeNumber(state.count);
      if (!existing.ibgeCode) existing.ibgeCode = toSafeNumber(state.ibgeCode);
      for (const ddd of state.ddds || []) {
        const clean = String(ddd || "").trim();
        if (clean) existing.ddds.add(clean);
      }
      stateMap.set(key, existing);
      totalMembers += toSafeNumber(state.count);
    }

    for (const dddEntry of geo.byDDD || []) {
      const ddd = String(dddEntry.ddd || "").trim();
      if (!ddd) continue;
      const existing = dddMap.get(ddd) || { count: 0, state: String(dddEntry.state || "").trim() };
      existing.count += toSafeNumber(dddEntry.count);
      if (!existing.state) existing.state = String(dddEntry.state || "").trim();
      dddMap.set(ddd, existing);
    }
  }

  const byState = Array.from(stateMap.entries())
    .map(([uf, item]) => ({
      uf,
      ibgeCode: item.ibgeCode,
      count: item.count,
      percentage: totalMembers > 0 ? Number(((item.count / totalMembers) * 100).toFixed(1)) : 0,
      ddds: Array.from(item.ddds).sort(),
    }))
    .sort((a, b) => b.count - a.count);

  const byDDD = Array.from(dddMap.entries())
    .map(([ddd, item]) => ({
      ddd,
      state: item.state || "N/A",
      count: item.count,
      percentage: totalMembers > 0 ? Number(((item.count / totalMembers) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const maxCount = Math.max(1, ...byState.map((state) => state.count));
  const mapData = byState
    .filter((state) => state.ibgeCode > 0)
    .map((state) => ({
      codIbge: state.ibgeCode,
      fillColor: interpolateHexColor("#E5E7EB", "#3B82F6", state.count / maxCount),
      strokeColor: "#1F1A17",
      strokeWidth: 1,
      count: state.count,
      percentage: state.percentage,
      state: state.uf,
    }));

  return {
    byState,
    byDDD,
    topState: byState[0]?.uf || "N/A",
    topDDD: byDDD[0]?.ddd || "N/A",
    stateDiversity: byState.length,
    dddDiversity: byDDD.length,
    mapData,
  };
}

function formatWeeklyGrowth(value: number): string {
  const safe = toSafeNumber(value);
  return `${safe > 0 ? "+" : ""}${safe.toFixed(1)}`;
}

export default function Metricas() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { sessions, isLoading: sessionsLoading } = useWhatsAppSessions();

  const [period, setPeriod] = useState<string>("30d");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);

  const days = Math.max(1, Number.parseInt(period.replace("d", ""), 10) || 30);

  const onlineSessions = useMemo(
    () => sessions.filter((session) => session.status === "online"),
    [sessions],
  );

  const waHealthQuery = useQuery({
    queryKey: ["whatsapp-service-health-metricas", user?.id],
    enabled: !!user,
    staleTime: 3 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    queryFn: async () => {
      try {
        const payload = await invokeBackendRpc("whatsapp-connect", { body: { action: "health" } });
        const data = payload as { online?: boolean; error?: string } | null;
        return { online: data?.online === true, error: data?.error ?? null };
      } catch {
        return { online: false, error: "Serviço WhatsApp indisponível" };
      }
    },
  });

  const waServiceOnline = waHealthQuery.data?.online === true;
  const waServiceChecked = !waHealthQuery.isLoading;

  const groupsQuery = useQuery({
    queryKey: ["analytics-admin-groups", user?.id],
    queryFn: fetchAdminGroups,
    enabled: !!user,
    staleTime: 2 * 60 * 1000,
  });

  const allGroups = groupsQuery.data ?? EMPTY_GROUPS;

  const onlineSessionIds = useMemo(
    () => new Set(onlineSessions.map((session) => String(session.id || "").trim()).filter(Boolean)),
    [onlineSessions],
  );

  // Enforce strict mode in this page: only groups where the user is admin
  // and that belong to currently connected sessions.
  const scopedAdminGroups = useMemo(
    () => allGroups.filter((group) => group.isAdmin && onlineSessionIds.has(group.sessionId)),
    [allGroups, onlineSessionIds],
  );

  useEffect(() => {
    setSelectedGroupIds((current) => {
      if (current.length === 0) return current;
      const allowed = new Set(scopedAdminGroups.map((group) => group.id));
      const next = current.filter((groupId) => allowed.has(groupId));
      return next.length === current.length ? current : next;
    });
  }, [scopedAdminGroups]);
  
  // Filter groups based on selection
  const displayGroups = useMemo(() => {
    if (selectedGroupIds.length === 0) return scopedAdminGroups;
    return scopedAdminGroups.filter((group) => selectedGroupIds.includes(group.id));
  }, [scopedAdminGroups, selectedGroupIds]);

  const metricsDataReady = !sessionsLoading && !groupsQuery.isLoading;
  const hasConnectedSessions = onlineSessions.length > 0;
  const hasAdminGroupsInConnectedSessions = scopedAdminGroups.length > 0;
  const hasSelectionWithoutResults = selectedGroupIds.length > 0 && displayGroups.length === 0;
  const showNoConnectedSessions = metricsDataReady && !hasConnectedSessions;
  const showNoAdminGroups = metricsDataReady && hasConnectedSessions && !hasAdminGroupsInConnectedSessions;
  const showNoFilteredResults = metricsDataReady && hasAdminGroupsInConnectedSessions && hasSelectionWithoutResults;

  const groupFilterEmptyMessage = showNoConnectedSessions
    ? "Conecte uma sessão WhatsApp para listar grupos."
    : showNoAdminGroups
      ? "Nenhum grupo administrado encontrado nas sessões conectadas."
      : "Nenhum grupo disponível.";
  
  const groupsCacheKey = useMemo(
    () => displayGroups.map((group) => group.id).sort().join(","),
    [displayGroups],
  );

  // Apply scope based on selection ("all" for consolidated, "filtered" when groups selected)
  const selectedScope = selectedGroupIds.length === 0 ? "all" : "filtered";

  const overviewQuery = useQuery({
    queryKey: ["analytics-dashboard-overview", user?.id, selectedScope, days, groupsCacheKey],
    enabled: !!user,
    staleTime: 2 * 60 * 1000,
    queryFn: async (): Promise<DashboardOverview> => {
      if (displayGroups.length === 0) {
        return {
          totalMembers: 0,
          totalGroups: 0,
          groupsConsidered: 0,
          growthRate: 0,
          totalJoined: 0,
          totalLeft: 0,
          capacityPercent: 0,
          geography: createEmptyGeography(),
          groupsWithData: 0,
          groupsFailed: 0,
        };
      }

      const settled = await Promise.allSettled(
        displayGroups.map((group) => fetchGroupSummary(group.id, days)),
      );
      const successfulSummaries = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
      const groupsWithData = successfulSummaries.length;
      const groupsFailed = Math.max(0, displayGroups.length - groupsWithData);

      if (groupsWithData === 0) {
        return {
          totalMembers: 0,
          totalGroups: displayGroups.length,
          groupsConsidered: 0,
          growthRate: 0,
          totalJoined: 0,
          totalLeft: 0,
          capacityPercent: 0,
          geography: createEmptyGeography(),
          groupsWithData: 0,
          groupsFailed,
        };
      }

      const totalMembers = successfulSummaries.reduce(
        (sum, summary) => sum + Math.max(0, toSafeNumber(summary.composition?.totalMembers)),
        0,
      );

      const totalJoined = successfulSummaries.reduce(
        (sum, summary) => sum + Math.max(0, toSafeNumber(summary.churn?.summary?.totalJoined)),
        0,
      );
      const totalLeft = successfulSummaries.reduce(
        (sum, summary) => sum + Math.max(0, toSafeNumber(summary.churn?.summary?.totalLeft)),
        0,
      );
      const netGrowth = totalJoined - totalLeft;
      const growthRate = Number(((netGrowth / Math.max(1, days)) * 7).toFixed(1));
      const capacityPercent = groupsWithData > 0
        ? Number(((totalMembers / (groupsWithData * WHATSAPP_GROUP_CAPACITY)) * 100).toFixed(1))
        : 0;

      return {
        totalMembers,
        totalGroups: displayGroups.length,
        groupsConsidered: groupsWithData,
        growthRate,
        totalJoined,
        totalLeft,
        capacityPercent,
        geography: aggregateGeography(successfulSummaries.map((summary) => summary.geography)),
        groupsWithData,
        groupsFailed,
      };
    },
  });

  const overlapQuery = useQuery({
    queryKey: ["analytics-cross-group-overlap", user?.id, days, groupsCacheKey],
    enabled: !!user && displayGroups.length >= 2,
    staleTime: 3 * 60 * 1000,
    queryFn: () => fetchCrossGroupOverlap({
      days,
      scopeGroupIds: displayGroups.map((g) => g.id),
    }),
  });

  const dashboardLoading = !metricsDataReady || overviewQuery.isLoading;

  const handleSyncAndRefresh = useCallback(async () => {
    if (!user) return;

    setIsSyncing(true);
    let syncResult: Awaited<ReturnType<typeof syncAllWhatsAppGroups>> | null = null;
    let syncError: string | null = null;

    try {
      syncResult = await syncAllWhatsAppGroups();
    } catch (error) {
      syncError = error instanceof Error ? error.message : String(error);
      console.error("[Metricas] sync error:", error);
    }

    // Always refresh the UI regardless of sync outcome — groups already in DB
    // must appear even when the WhatsApp service is temporarily unavailable.
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["analytics-admin-groups", user.id] }),
      qc.invalidateQueries({ queryKey: ["analytics-dashboard-overview", user.id] }),
      qc.invalidateQueries({ queryKey: ["groups", user.id] }),
      qc.invalidateQueries({ queryKey: ["whatsapp-sessions", user.id] }),
      qc.invalidateQueries({ queryKey: ["whatsapp-runtime-health", user.id] }),
    ]);

    if (syncError) {
      toast.error(`Erro ao sincronizar grupos: ${syncError}`);
    } else if (syncResult) {
      if (syncResult.sessionsSynced > 0) {
        toast.success(`Sincronização concluída: ${syncResult.sessionsSynced} sessão(s), ${syncResult.totalGroups} grupos.`);
      } else {
        toast.warning("Nenhuma sessão online foi sincronizada. Grupos existentes carregados do banco.");
      }
      if (syncResult.errors.length > 0) {
        const preview = syncResult.errors.slice(0, 2).join(" | ");
        toast.warning(`Ocorreram ${syncResult.errors.length} erro(s) na sincronização. ${preview}`);
      }
    } else {
      toast.warning("Nenhuma sessão online foi sincronizada. Grupos existentes carregados do banco.");
    }

    setIsSyncing(false);
  }, [qc, user]);

  const overview = overviewQuery.data;
  const geography = overview?.geography ?? createEmptyGeography();

  return (
    <div className="ds-page">
      <PageHeader
        title="Métricas de grupos"
        description="Dashboard consolidado dos grupos em que você é admin nas sessões WhatsApp conectadas."
      >
        <div className="z-30 flex w-full min-w-0 flex-wrap items-start gap-2.5 sm:justify-end">
          {selectedGroupIds.length > 0 && (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {selectedGroupIds.map((groupId) => {
                const group = scopedAdminGroups.find((g) => g.id === groupId);
                if (!group) return null;
                return (
                  <Badge 
                    key={groupId} 
                    variant="secondary" 
                    className="h-7 gap-1 px-2 text-[10px] font-bold uppercase tracking-wider bg-primary/10 hover:bg-primary/20 text-primary border-primary/20 transition-all animate-in zoom-in-95 duration-200"
                  >
                    <span className="max-w-[120px] truncate">{group.name}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedGroupIds((current) => current.filter((id) => id !== groupId));
                      }}
                      className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20 transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
          )}

          <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            {/* Seletor de Grupos */}
            <div className="relative w-full sm:w-[280px] lg:w-[320px]">
              <MultiOptionDropdown
                value={selectedGroupIds}
                onChange={setSelectedGroupIds}
                items={scopedAdminGroups.map((group) => ({
                  id: group.id,
                  label: group.name,
                  meta: `${group.memberCount} membros`,
                }))}
                placeholder="Todos os meus grupos"
                selectedLabel={(count) => count === 0 ? "Todos os meus grupos" : `${count} selecionado(s)`}
                emptyMessage={groupFilterEmptyMessage}
                title="Filtrar por grupos"
                showSelectedBadges={false}
              />
            </div>

            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              {/* Seletor de Período */}
              <div className="relative w-full sm:w-[170px]">
                <Select value={period} onValueChange={setPeriod}>
                  <SelectTrigger className="h-10 bg-background shadow-sm transition-all hover:bg-muted/50 border-border/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[100]">
                    <SelectItem value="7d">Últimos 7 dias</SelectItem>
                    <SelectItem value="30d">Últimos 30 dias</SelectItem>
                    <SelectItem value="90d">Últimos 90 dias</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Botão Sincronizar */}
              <Button 
                onClick={handleSyncAndRefresh} 
                disabled={isSyncing} 
                variant="default"
                className={cn(
                  "h-10 w-full px-4 shadow-md transition-all active:scale-95 whitespace-nowrap font-bold sm:w-auto",
                  isSyncing ? "opacity-70 cursor-wait bg-primary/80" : "bg-primary text-primary-foreground hover:shadow-lg hover:-translate-y-0.5"
                )}
              >
                {isSyncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                <span className="hidden lg:inline">{isSyncing ? "Sincronizando..." : "Sincronizar"}</span>
                <span className="lg:hidden">{isSyncing ? "..." : "Sinc."}</span>
              </Button>
            </div>
          </div>
        </div>
      </PageHeader>

      {waServiceChecked && !waServiceOnline && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="flex items-center gap-3 py-3 text-sm text-muted-foreground">
            <WifiOff className="h-4 w-4 shrink-0 text-warning" />
            <span>
              Serviço WhatsApp offline — as métricas analíticas (composição, churn, saúde) não estão disponíveis.
              Dados básicos dos grupos vêm do banco de dados.
              {" "}
              <button
                type="button"
                onClick={handleSyncAndRefresh}
                disabled={isSyncing}
                className="font-medium text-warning underline-offset-2 hover:underline"
              >
                Tentar reconectar
              </button>
            </span>
          </CardContent>
        </Card>
      )}

      {(showNoConnectedSessions || showNoAdminGroups || showNoFilteredResults) && (
        <Card className="border-border/60 bg-muted/25">
          <CardContent className="py-4 text-sm text-muted-foreground">
            {showNoConnectedSessions && (
              <p>
                Nenhuma sessão WhatsApp conectada no momento.
                Conecte ao menos uma sessão online para visualizar métricas dos grupos administrados.
              </p>
            )}

            {showNoAdminGroups && (
              <div className="space-y-3">
                <p>
                  Há sessões conectadas, mas ainda não encontramos grupos onde você é admin nessas sessões.
                  Clique em "Atualizar" para sincronizar permissões e carregar o conjunto correto.
                </p>
                <Button onClick={handleSyncAndRefresh} disabled={isSyncing} size="sm" variant="secondary" className="h-8 gap-2">
                  {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {isSyncing ? "Sincronizando..." : "Atualizar agora"}
                </Button>
              </div>
            )}

            {showNoFilteredResults && (
              <div className="space-y-3">
                <p>Nenhum grupo corresponde ao filtro atual. Limpe o filtro para voltar ao conjunto completo.</p>
                <Button type="button" variant="secondary" size="sm" className="h-8" onClick={() => setSelectedGroupIds([])}>
                  Limpar filtro
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="geral" className="animate-in fade-in duration-500">
        <div className="flex items-center justify-between mb-8 border-b border-border/40 pb-px">
          <TabsList className="h-10 bg-transparent p-0 gap-8 rounded-none border-none">
            <TabsTrigger 
              value="geral" 
              className="relative h-10 px-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none transition-all duration-200 gap-2 font-semibold text-muted-foreground data-[state=active]:text-foreground"
            >
              <TrendingUp className="h-4 w-4" />
              Geral
            </TabsTrigger>
            
            <TabsTrigger 
              value="historico" 
              className="relative h-10 px-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none transition-all duration-200 gap-2 font-semibold text-muted-foreground data-[state=active]:text-foreground"
            >
              <History className="h-4 w-4" />
              Histórico
            </TabsTrigger>
            
            <TabsTrigger 
              value="recaptura" 
              className="relative h-10 px-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none transition-all duration-200 gap-2 font-semibold text-muted-foreground data-[state=active]:text-foreground"
            >
              <BellRing className="h-4 w-4" />
              Recaptura
            </TabsTrigger>

          </TabsList>
          

        </div>

        <TabsContent value="geral" className="space-y-6 focus-visible:outline-none">
          <div className="space-y-6">
              {dashboardLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-[148px] w-full rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              {/* Total Membros */}
              <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild>
              <Card className="group relative flex flex-col overflow-hidden border-border/50 shadow-sm transition-all hover:-translate-y-1 hover:border-blue-500/30 hover:shadow-md cursor-default">
                <div className="absolute top-0 left-0 h-1 w-full bg-blue-500/20 group-hover:bg-blue-500/40 transition-colors" />
                <CardContent className="flex flex-1 flex-col items-center justify-center p-4 text-center">
                  <div className="mb-2.5 rounded-full bg-blue-500/10 p-2.5 text-blue-600 ring-4 ring-blue-500/5 transition-transform group-hover:scale-110">
                    <Users className="h-5 w-5" />
                  </div>
                  <div className="w-full space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">Membros</p>
                    <div className="flex flex-col items-center">
                      <p className="text-2xl font-black tracking-tight text-foreground leading-none">
                        {(overview?.totalMembers ?? 0).toLocaleString("pt-BR")}
                      </p>
                      {overview?.totalGroups !== undefined && (
                        <p className="mt-2.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/60">
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                          ~{Math.round((overview.totalMembers || 0) / Math.max(1, overview.groupsConsidered || overview.totalGroups || 1))} / grupo
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
              </TooltipTrigger><TooltipContent side="bottom" className="max-w-[200px] text-center text-xs">Total de membros ativos em todos os grupos selecionados. A média por grupo indica a distribuição da base.</TooltipContent></Tooltip></TooltipProvider>

              {/* Sobreposição de membros */}
              <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild>
              <Card className="group relative flex flex-col overflow-hidden border-border/50 shadow-sm transition-all hover:-translate-y-1 hover:border-violet-500/30 hover:shadow-md cursor-default">
                <div className="absolute top-0 left-0 h-1 w-full bg-violet-500/20 group-hover:bg-violet-500/40 transition-colors" />
                <CardContent className="flex flex-1 flex-col items-center justify-center p-4 text-center">
                  <div className="mb-2.5 rounded-full bg-violet-500/10 p-2.5 text-violet-600 ring-4 ring-violet-500/5 transition-transform group-hover:scale-110">
                    <GitMerge className="h-5 w-5" />
                  </div>
                  <div className="w-full space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">Sobreposição</p>
                    <div className="flex flex-col items-center">
                      {dashboardLoading || (displayGroups.length >= 2 && overlapQuery.isLoading) ? (
                        <div className="h-8 w-12 animate-pulse rounded bg-muted" />
                      ) : displayGroups.length < 2 ? (
                        <p className="text-2xl font-black tracking-tight text-muted-foreground/40 leading-none">—</p>
                      ) : (
                        <p className={cn("text-2xl font-black tracking-tight leading-none", (overlapQuery.data?.overlapCount ?? 0) > 0 ? "text-violet-600" : "text-muted-foreground/60")}>
                          {(overlapQuery.data?.overlapCount ?? 0).toLocaleString("pt-BR")}
                        </p>
                      )}
                      <p className="mt-2.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/60">
                        <span className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
                        {displayGroups.length < 2
                          ? "≥2 grupos necessários"
                          : overlapQuery.data?.totalPhonesAnalyzed
                            ? `de ${overlapQuery.data.totalPhonesAnalyzed.toLocaleString("pt-BR")} únicos`
                            : "em múltiplos grupos"}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              </TooltipTrigger><TooltipContent side="bottom" className="max-w-[200px] text-center text-xs">Número de membros que estão em mais de um grupo ao mesmo tempo. Alta sobreposição pode indicar audiência concentrada.</TooltipContent></Tooltip></TooltipProvider>

              {/* Crescimento Semanal */}
              <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild>
              <Card className="group relative flex flex-col overflow-hidden border-border/50 shadow-sm transition-all hover:-translate-y-1 hover:border-primary/30 hover:shadow-md cursor-default">
                <div className={cn("absolute top-0 left-0 h-1 w-full transition-colors", (overview?.growthRate ?? 0) >= 0 ? "bg-green-500/20 group-hover:bg-green-500/40" : "bg-red-500/20 group-hover:bg-red-500/40")} />
                <CardContent className="flex flex-1 flex-col items-center justify-center p-4 text-center">
                  <div className={cn("mb-2.5 rounded-full p-2.5 ring-4 transition-transform group-hover:scale-110", (overview?.growthRate ?? 0) >= 0 ? "bg-green-500/10 text-green-600 ring-green-500/5" : "bg-red-500/10 text-red-600 ring-red-500/5")}>
                    <TrendingUp className={cn("h-5 w-5", (overview?.growthRate ?? 0) < 0 && "rotate-180")} />
                  </div>
                  <div className="w-full space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">Crescimento</p>
                    <div className="flex flex-col items-center">
                      <p className={cn("text-2xl font-black tracking-tight leading-none", (overview?.growthRate ?? 0) >= 0 ? "text-green-600" : "text-red-600")}>
                        {formatWeeklyGrowth(overview?.growthRate ?? 0)}
                      </p>
                      <p className="mt-2.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/60 uppercase">
                        <span className={cn("h-1.5 w-1.5 rounded-full animate-pulse", (overview?.growthRate ?? 0) >= 0 ? "bg-green-400" : "bg-red-400")} />
                        Proj. / Sem
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              </TooltipTrigger><TooltipContent side="bottom" className="max-w-[200px] text-center text-xs">Projeção de crescimento semanal baseada nas entradas e saídas do período. Valor positivo = crescimento, negativo = perda.</TooltipContent></Tooltip></TooltipProvider>

              {/* Entradas */}
              <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild>
              <Card className="group relative flex flex-col overflow-hidden border-border/50 shadow-sm transition-all hover:-translate-y-1 hover:border-emerald-500/30 hover:shadow-md cursor-default">
                <div className="absolute top-0 left-0 h-1 w-full bg-emerald-500/20 group-hover:bg-emerald-500/40 transition-colors" />
                <CardContent className="flex flex-1 flex-col items-center justify-center p-4 text-center">
                  <div className="mb-2.5 rounded-full bg-emerald-500/10 p-2.5 text-emerald-600 ring-4 ring-emerald-500/5 transition-transform group-hover:scale-110 relative">
                    <UserPlus className="h-5 w-5" />
                  </div>
                  <div className="w-full space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">Entradas</p>
                    <div className="flex flex-col items-center">
                      <p className="text-2xl font-black tracking-tight text-emerald-600 leading-none">
                        {(overview?.totalJoined ?? 0).toLocaleString("pt-BR")}
                      </p>
                      <p className="mt-2.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/60">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        {Math.round(((overview?.totalJoined ?? 0) / Math.max(1, overview?.totalMembers || 0)) * 100)}% alcance
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              </TooltipTrigger><TooltipContent side="bottom" className="max-w-[200px] text-center text-xs">Total de novos membros que entraram nos grupos no período selecionado. O % de alcance compara com o total atual de membros.</TooltipContent></Tooltip></TooltipProvider>

              {/* Saídas */}
              <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild>
              <Card className="group relative flex flex-col overflow-hidden border-border/50 shadow-sm transition-all hover:-translate-y-1 hover:border-rose-500/30 hover:shadow-md cursor-default">
                <div className="absolute top-0 left-0 h-1 w-full bg-rose-500/20 group-hover:bg-rose-500/40 transition-colors" />
                <CardContent className="flex flex-1 flex-col items-center justify-center p-4 text-center">
                  <div className="mb-2.5 rounded-full bg-rose-500/10 p-2.5 text-rose-600 ring-4 ring-rose-500/5 transition-transform group-hover:scale-110 relative">
                    <UserMinus className="h-5 w-5" />
                  </div>
                  <div className="w-full space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">Churn</p>
                    <div className="flex flex-col items-center">
                      <p className="text-2xl font-black tracking-tight text-rose-600 leading-none">
                        {(overview?.totalLeft ?? 0).toLocaleString("pt-BR")}
                      </p>
                      <p className="mt-2.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/60">
                        <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
                        {Math.round(((overview?.totalLeft ?? 0) / Math.max(1, overview?.totalMembers || 0)) * 100)}% perda
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              </TooltipTrigger><TooltipContent side="bottom" className="max-w-[200px] text-center text-xs">Membros que saíram ou foram removidos (churn) no período. O % de perda compara com o total atual de membros.</TooltipContent></Tooltip></TooltipProvider>

              {/* Capacidade Ocupada */}
              <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild>
              <Card className="group relative flex flex-col overflow-hidden border-border/50 shadow-sm transition-all hover:-translate-y-1 hover:border-indigo-500/30 hover:shadow-md cursor-default">
                <div className="absolute top-0 left-0 h-1 w-full bg-indigo-500/20 group-hover:bg-indigo-500/40 transition-colors" />
                <CardContent className="flex flex-1 flex-col items-center justify-center p-4 text-center">
                  <div className="mb-2.5 rounded-full bg-indigo-500/10 p-2.5 text-indigo-600 ring-4 ring-indigo-500/5 transition-transform group-hover:scale-110">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div className="w-full space-y-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">Ocupação</p>
                    <div className="flex flex-col items-center">
                      <p className="text-2xl font-black tracking-tight text-indigo-600 leading-none">
                        {(overview?.capacityPercent ?? 0).toFixed(1)}<span className="text-sm ml-0.5">%</span>
                      </p>
                    </div>
                    <div className="mx-auto w-16 h-1.5 bg-indigo-100 dark:bg-indigo-900/30 rounded-full overflow-hidden mt-3">
                      <div 
                        className="h-full bg-indigo-500 transition-all duration-1000 group-hover:brightness-110 animate-in slide-in-from-left duration-1000" 
                        style={{ width: `${Math.min(100, overview?.capacityPercent ?? 0)}%` }} 
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
              </TooltipTrigger><TooltipContent side="bottom" className="max-w-[200px] text-center text-xs">Percentual médio de capacidade ocupada nos grupos. O limite do WhatsApp é 1.024 membros por grupo.</TooltipContent></Tooltip></TooltipProvider>
            </div>
          )}

          {overview && overview.groupsWithData < overview.totalGroups && (
            <Card className="border-warning/40 bg-warning/5">
              <CardContent className="pt-4 text-sm text-muted-foreground">
                {overview.groupsWithData} de {overview.totalGroups} grupo(s) retornaram dados completos no período.
                {overview.groupsFailed > 0 && ` ${overview.groupsFailed} grupo(s) foram excluidos da soma por falha de coleta.`}
                Clique em "Atualizar" para sincronizar novamente.
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card className="lg:col-span-2 overflow-hidden border-border/50 shadow-sm transition-all hover:bg-card/50">
            <CardHeader className="px-5 py-4 border-b border-border/40 sm:px-6">
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-base font-bold">
                  <Globe2 className="h-5 w-5 text-blue-500" />
                  Densidade Geográfica dos Membros
                </div>
              </CardTitle>
            </CardHeader>

            <CardContent className="p-0 sm:p-6">
              {dashboardLoading ? (
                <div className="p-6">
                  <Skeleton className="h-[400px] w-full rounded-lg" />
                </div>
              ) : (
                <div className="flex flex-col lg:flex-row lg:gap-8">
                  {/* Mapa Container */}
                  <div className="flex-1 flex items-center justify-center bg-muted/20 border-b border-border/30 lg:border-b-0 lg:border lg:rounded-xl p-4 min-h-[350px] sm:min-h-[400px]">
                    <div className="w-full h-full max-w-2xl flex items-center justify-center">
                      <BrasilMap data={geography.mapData} height={380} showLegend={false} />
                    </div>
                  </div>

                  {/* Lista de Estados */}
                  <div className="w-full p-6 lg:w-[320px] lg:p-0 flex flex-col space-y-5">
                    <div className="flex items-center justify-between border-b border-border/40 pb-2">
                      <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                        Performance por UF
                      </div>
                      <div className="text-[10px] font-medium text-muted-foreground">
                        {geography.byState.length} estados
                      </div>
                    </div>
                    
                    <div className="space-y-3 flex-1 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar">
                      {(() => {
                        const topEntries = geography.byState;
                        const maxCountAcross = Math.max(...geography.byState.map((s) => s.count), 1);
                        
                        return topEntries.map((stateEntry) => {
                          const percentageRelative = (stateEntry.count / maxCountAcross) * 100;
                          return (
                            <div
                              key={stateEntry.uf}
                              className="group/item flex items-center gap-4 text-xs sm:text-sm"
                            >
                              <div className="w-8 shrink-0">
                                <span className="font-bold text-foreground group-hover/item:text-blue-500 transition-colors">
                                  {stateEntry.uf}
                                </span>
                              </div>

                              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden relative">
                                <div
                                  className="h-full bg-blue-500/70 group-hover/item:bg-blue-500 rounded-full transition-all duration-700 ease-out"
                                  style={{ width: `${percentageRelative}%` }}
                                />
                              </div>

                              <div className="w-16 text-right shrink-0">
                                <span className="font-mono text-[11px] font-bold text-muted-foreground tabular-nums">
                                  {stateEntry.count.toLocaleString("pt-BR")}
                                </span>
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="lg:col-span-1">
              <GruposDesempenho
                groups={displayGroups}
                selectedScope={selectedScope}
                days={days}
              />
            </div>
            <div className="lg:col-span-1">
              <CapacidadePorGrupo groups={displayGroups} capacity={WHATSAPP_GROUP_CAPACITY} />
            </div>
          </div>
          </div>
        </TabsContent>

        <TabsContent value="historico" className="animate-in slide-in-from-bottom-2 duration-300 focus-visible:outline-none">
          <HistoricoMovimentos groups={displayGroups} days={days} selectedGroupIds={selectedGroupIds} />
        </TabsContent>

        <TabsContent value="recaptura" className="animate-in slide-in-from-bottom-2 duration-300 focus-visible:outline-none">
          <RecapturaAutomatica groups={displayGroups} selectedGroupIds={selectedGroupIds} />
        </TabsContent>

      </Tabs>
    </div>
  );
}

