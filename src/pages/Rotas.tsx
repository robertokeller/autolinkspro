import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { rotaSchema } from "@/lib/validations";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Route, Plus, ArrowRight, Play, Pause, Trash2, MoreVertical, Pencil,
  AlertTriangle, Info, Layers, Users,
  LinkIcon, FileText, Filter, Copy, RefreshCw, PlayCircle, PauseCircle,
} from "lucide-react";
import { useRotas } from "@/hooks/useRotas";
import { useGrupos } from "@/hooks/useGrupos";
import { useTemplateModule } from "@/contexts/TemplateModuleContext";
import { useSessoes } from "@/hooks/useSessoes";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { useServiceHealth } from "@/hooks/useServiceHealth";
import { getAllChannelHealth } from "@/lib/channel-central";
import { RouteHealthBadge } from "@/components/routes/RouteHealthBadge";
import type { AppRoute, Group, MasterGroup, Template } from "@/lib/types";
import type { MeliSession } from "@/hooks/useMercadoLivreSessions";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { buildRoutePayload, emptyNewRoute, type NewRouteForm } from "@/pages/routes/route-form";
import { ChannelPlatformIcon } from "@/components/icons/ChannelPlatformIcon";
import { SessionSelect } from "@/components/selectors/SessionSelect";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";

type UnifiedSession = {
  id: string;
  label: string;
  platform: "whatsapp" | "telegram";
  status: string;
};

export default function RoutesPage() {
  const {
    routes,
    toggleRoute,
    setAllRoutesStatus,
    refreshAllRoutes,
    deleteRoute,
    createRoute,
    updateRoute,
    duplicateRoute,
  } = useRotas();
  const { syncedGroups: rawGroups, masterGroups: rawMasterGroups, syncGroups, syncing: syncingGroups } = useGrupos();
  const { templates: rawTemplates } = useTemplateModule();
  const { allSessions: rawAllSessions, refreshSessions } = useSessoes();
  const { sessions: rawMeliSessions } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const { data: channelHealth, refetch: refetchChannelHealth } = useQuery({
    queryKey: ["channel-health", "routes-page"],
    queryFn: getAllChannelHealth,
    staleTime: 30 * 1000,
  });
  const groups = rawGroups as Group[];
  const masterGroups = rawMasterGroups as MasterGroup[];
  const templates = rawTemplates as Template[];
  const allSessions = rawAllSessions as UnifiedSession[];
  const meliSessions = rawMeliSessions as MeliSession[];
  const { health: shopeeHealth, refresh: refreshShopeeHealth } = useServiceHealth("shopee");
  const { health: meliHealth, refresh: refreshMeliHealth } = useServiceHealth("meli");
  const shopeeOnline = shopeeHealth ? shopeeHealth.online : null;
  const meliOnline = meliHealth ? meliHealth.online : null;
  const whatsappOnline = channelHealth ? channelHealth.whatsapp.online : null;
  const telegramOnline = channelHealth ? channelHealth.telegram.online : null;
  const [showNew, setShowNew] = useState(false);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [step, setStep] = useState(1);
  const [nr, setNr] = useState<NewRouteForm>({ ...emptyNewRoute });
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const isEditing = !!editingRouteId;

  const totalSteps = 3;
  const stepDescriptions: Record<number, string> = {
    1: "Dê um nome, escolha a sessão e o grupo que vai ser monitorado.",
    2: "Escolha pra onde as ofertas vão ser enviadas.",
    3: "Ajuste a conversão de links, templates e filtros.",
  };
  const connectedSessions = allSessions.filter((s) => s.status === "online");
  const defaultMeliSession = meliSessions.find((session) => session.status === "active" || session.status === "untested") || null;
  const groupsById = useMemo<Map<string, Group>>(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups],
  );
  const sessionsById = useMemo<Map<string, UnifiedSession>>(
    () => new Map(allSessions.map((session) => [session.id, session])),
    [allSessions],
  );
  const templatesById = useMemo<Map<string, Template>>(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates],
  );
  const meliSessionsById = useMemo<Map<string, MeliSession>>(
    () => new Map(meliSessions.map((session) => [session.id, session])),
    [meliSessions],
  );
  const masterGroupsById = useMemo<Map<string, MasterGroup>>(
    () => new Map(masterGroups.map((group) => [group.id, group])),
    [masterGroups],
  );

  // Source session + groups
  const sourceSession = allSessions.find((s) => s.id === nr.sourceSessionId);
  const sourceSessionConnected = sourceSession?.status === "online";
  const sourceGroups = useMemo(() => {
    if (!nr.sourceSessionId) return [];
    return groups.filter((g) => g.sessionId === nr.sourceSessionId);
  }, [groups, nr.sourceSessionId]);

  // Destination session + groups
  const destSession = allSessions.find((s) => s.id === nr.destSessionId);
  const destSessionConnected = destSession?.status === "online";
  const destGroups = useMemo(() => {
    if (!nr.destSessionId) return [];
    return groups.filter((g) => g.sessionId === nr.destSessionId && g.id !== nr.sourceGroupId);
  }, [groups, nr.destSessionId, nr.sourceGroupId]);

  // Master groups - filter by linked groups that belong to the dest session's platform
  const destMasterGroups = useMemo(() => {
    if (!nr.destSessionId) return [];
    const destSessionGroupIds = new Set(
      groups.filter((g) => g.sessionId === nr.destSessionId).map((g) => g.id)
    );
    return masterGroups.filter((mg) =>
      mg.linkedGroups.some((lg) => destSessionGroupIds.has(lg.groupId))
    );
  }, [masterGroups, groups, nr.destSessionId]);

  // Step validation — when editing an existing route, allow offline sessions so the user
  // can update keywords, templates, etc. without requiring a live connection.
  const canGoStep2 = !!nr.name.trim() && !!nr.sourceSessionId && (isEditing || sourceSessionConnected) && !!nr.sourceGroupId;
  const canGoStep3 = !!nr.destSessionId && (isEditing || destSessionConnected) && (
    nr.destinationType === "master"
      ? nr.masterGroupIds.length > 0
      : nr.destinationGroupIds.length > 0
  );
  const hasMeliSessionSelected = !!nr.meliSessionId || !!defaultMeliSession?.id;
  const activeMeliSession = nr.meliSessionId
    ? meliSessionsById.get(nr.meliSessionId) || null
    : defaultMeliSession;
  const canCreate = canGoStep2 && canGoStep3 && (!nr.autoConvertMercadoLivre || hasMeliSessionSelected);

  useEffect(() => {
    if (!nr.autoConvertMercadoLivre) return;
    if (nr.meliSessionId) return;

    const nextSessionId = defaultMeliSession?.id;
    if (!nextSessionId) return;

    setNr((prev) => (prev.meliSessionId
      ? prev
      : {
          ...prev,
          meliSessionId: nextSessionId,
        }
    ));
  }, [defaultMeliSession?.id, nr.autoConvertMercadoLivre, nr.meliSessionId]);

  const handleFullSync = async () => {
    setIsSyncing(true);
    try {
      const hasConnectedSession = allSessions.some((session) => session.status === "online");
      if (!hasConnectedSession) {
        toast.error("Nenhuma sessão conectada pra atualizar as rotas.");
        return;
      }

      const [channelHealthResult, shopeeHealthResult, meliHealthResult] = await Promise.all([
        refetchChannelHealth(),
        refreshShopeeHealth(),
        refreshMeliHealth(),
      ]);

      const latestChannelHealth = channelHealthResult.data || channelHealth;

      const activeRoutes = routes.filter((route) => route.status === "active");
      const usesWhatsapp = activeRoutes.some((route) => {
        const source = groupsById.get(route.sourceGroupId);
        const sourcePlatform = source ? sessionsById.get(source.sessionId)?.platform : undefined;
        const destPlatform = route.rules.sessionId ? sessionsById.get(route.rules.sessionId)?.platform : undefined;
        return sourcePlatform === "whatsapp" || destPlatform === "whatsapp";
      });
      const usesTelegram = activeRoutes.some((route) => {
        const source = groupsById.get(route.sourceGroupId);
        const sourcePlatform = source ? sessionsById.get(source.sessionId)?.platform : undefined;
        const destPlatform = route.rules.sessionId ? sessionsById.get(route.rules.sessionId)?.platform : undefined;
        return sourcePlatform === "telegram" || destPlatform === "telegram";
      });
      const usesShopee = activeRoutes.some((route) => route.rules.autoConvertShopee);
      const usesMeli = activeRoutes.some((route) => route.rules.autoConvertMercadoLivre);

      const hasAnyActiveMeliSession = meliSessions.some((session) => session.status === "active" || session.status === "untested");
      const blockers: string[] = [];

      if (usesWhatsapp && latestChannelHealth?.whatsapp.online !== true) {
        blockers.push("WhatsApp offline");
      }
      if (usesTelegram && latestChannelHealth?.telegram.online !== true) {
        blockers.push("Telegram offline");
      }
      if (usesShopee && shopeeHealthResult?.online !== true) {
        blockers.push("Shopee offline");
      }
      if (usesMeli && meliHealthResult?.online !== true) {
        blockers.push("Mercado Livre offline");
      }
      if (usesMeli && !hasAnyActiveMeliSession) {
        blockers.push("Sessão do Mercado Livre não está pronta");
      }

      for (const route of activeRoutes) {
        const source = groupsById.get(route.sourceGroupId);
        const sourceSession = source ? sessionsById.get(source.sessionId) : null;
        const destinationSession = route.rules.sessionId ? sessionsById.get(route.rules.sessionId) : null;

        if (!sourceSession || sourceSession.status !== "online") {
          blockers.push(`Rota "${route.name}": sessão de captura offline`);
        }

        if (!destinationSession || destinationSession.status !== "online") {
          blockers.push(`Rota "${route.name}": sessão de envio offline`);
        }
      }

      if (blockers.length > 0) {
        const uniqueBlockers = Array.from(new Set(blockers));
        toast.error(`Não deu pra atualizar: ${uniqueBlockers.length} problema(s).`);
        toast.error(uniqueBlockers.slice(0, 3).join(" | "));
        return;
      }

      refreshSessions();
      await syncGroups();
      const refreshedRoutes = await refreshAllRoutes();
      if (!refreshedRoutes) return;

      const whatsappStatus = latestChannelHealth?.whatsapp.online === true ? "WhatsApp online" : "WhatsApp offline";
      const telegramStatus = latestChannelHealth?.telegram.online === true ? "Telegram online" : "Telegram offline";
      const shopeeStatus = shopeeHealthResult?.online === true ? "Shopee online" : "Shopee offline";
      const meliStatus = meliHealthResult?.online === true ? "Mercado Livre online" : "Mercado Livre offline";
      toast.success(`Tudo atualizado! ${whatsappStatus} | ${telegramStatus} | ${shopeeStatus} | ${meliStatus}`);
    } catch {
      toast.error("Não deu pra atualizar");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCreateRoute = async () => {
    const validDestinationGroupIds = new Set(destGroups.map((group) => group.id));
    const validMasterGroupIds = new Set(destMasterGroups.map((group) => group.id));

    const normalizedDestinationGroupIds = nr.destinationType === "groups"
      ? Array.from(new Set(nr.destinationGroupIds.filter((id) => validDestinationGroupIds.has(id))))
      : [];
    const normalizedMasterGroupIds = nr.destinationType === "master"
      ? Array.from(new Set(nr.masterGroupIds.filter((id) => validMasterGroupIds.has(id))))
      : [];

    const normalizedNr: NewRouteForm = {
      ...nr,
      destinationGroupIds: normalizedDestinationGroupIds,
      masterGroupIds: normalizedMasterGroupIds,
    };

    if (nr.destinationType === "groups" && normalizedDestinationGroupIds.length === 0) {
      setNr(normalizedNr);
      toast.error("Escolha pelo menos um grupo de destino pra essa sessão.");
      return;
    }

    if (nr.destinationType === "master" && normalizedMasterGroupIds.length === 0) {
      setNr(normalizedNr);
      toast.error("Escolha pelo menos um grupo mestre pra essa sessão.");
      return;
    }

    const parsed = rotaSchema.safeParse(normalizedNr);
    if (!parsed.success) { toast.error(parsed.error.errors[0].message); return; }
    const routeData = buildRoutePayload(normalizedNr);
    const result = editingRouteId
      ? await updateRoute(editingRouteId, routeData)
      : await createRoute(routeData);
    if (result) closeNew();
  };

  const resetRouteWizard = () => {
    setStep(1);
    setNr({ ...emptyNewRoute });
  };

  const openNewRoute = () => {
    setEditingRouteId(null);
    resetRouteWizard();
    setShowNew(true);
  };

  const closeNew = () => {
    setShowNew(false);
    setEditingRouteId(null);
    resetRouteWizard();
  };

  const handleEditRoute = (route: AppRoute) => {
    // Find source session by looking at source group's sessionId
    const sourceGroup = groupsById.get(route.sourceGroupId);
    const sourceSessionId = sourceGroup?.sessionId || "";
    setNr({
      name: route.name,
      sourceSessionId,
      sourceGroupId: route.sourceGroupId,
      destSessionId: route.rules.sessionId || "",
      destinationType: route.masterGroupId ? "master" : "groups",
      destinationGroupIds: [...route.destinationGroupIds],
      masterGroupIds: route.rules.masterGroupIds || (route.masterGroupId ? [route.masterGroupId] : []),
      autoConvertShopee: route.rules.autoConvertShopee,
      autoConvertMercadoLivre: route.rules.autoConvertMercadoLivre ?? false,
      meliSessionId: route.rules.meliSessionId || "",
      templateId: route.rules.templateId || "",
      positiveKeywords: route.rules.positiveKeywords.join(", "),
      negativeKeywords: route.rules.negativeKeywords.join(", "),
    });
    setEditingRouteId(route.id);
    setStep(1);
    setShowNew(true);
  };

  const statusConfig: Record<string, { label: string; class: string }> = {
    active: { label: "Ativa", class: "bg-success/10 text-success border-success/20" },
    paused: { label: "Pausada", class: "bg-warning/10 text-warning border-warning/20" },
    error: { label: "Erro", class: "bg-destructive/10 text-destructive border-destructive/20" },
  };

  const summarizeNames = (names: string[], max = 2) => {
    if (names.length === 0) return "-";
    if (names.length <= max) return names.join(", ");
    return `${names.slice(0, max).join(", ")} +${names.length - max}`;
  };

  const deleteRouteObj = routes.find((r) => r.id === deleteId);
  const allPaused = routes.length > 0 && routes.every((route) => route.status !== "active");
  const handleRefreshRoute = (routeId: string, currentStatus: AppRoute["status"]) => {
    if (currentStatus !== "active") {
      toast.info("Só rotas ligadas podem ser atualizadas. Ligue a rota primeiro.");
      return;
    }

    void (async () => {
      const paused = await toggleRoute(routeId, currentStatus);
      if (!paused) return;
      await toggleRoute(routeId, "paused");
      toast.success("Rota atualizada");
    })();
  };

  return (
    <div className="ds-page">
      <div className="sticky top-0 z-20 rounded-xl border border-border/60 bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
        <PageHeader title="Rotas automaticas" description="Monte rotas pra copiar ofertas de um grupo e enviar pra outros no automatico">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={isSyncing || syncingGroups}
              onClick={() => { void handleFullSync(); }}
            >
              <RefreshCw className={cn("h-4 w-4", (isSyncing || syncingGroups) && "animate-spin")} />
              Atualizar
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={routes.length === 0}
              onClick={() => { void setAllRoutesStatus(allPaused ? "active" : "paused"); }}
            >
              {allPaused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
              {allPaused ? "Retomar Rotas" : "Pausar Rotas"}
            </Button>
            <Button size="sm" onClick={openNewRoute} className="gap-1.5">
              <Plus className="h-4 w-4" />
              Nova rota
            </Button>
          </div>
        </PageHeader>
      </div>

      {/* Route list */}
      <div>
        {routes.length > 0 ? (
          <div className="space-y-3">
            {routes.map((route) => {
              const source = groupsById.get(route.sourceGroupId);
              const masterTargetIds = route.rules.masterGroupIds || (route.masterGroupId ? [route.masterGroupId] : []);
              const masterTargets = masterTargetIds
                .map((id) => masterGroupsById.get(id))
                .filter((group): group is MasterGroup => Boolean(group));
              const destinationNames = masterTargets.length > 0
                ? masterTargets.map((group) => group.name)
                : route.destinationGroupIds.map((id) => groupsById.get(id)?.name).filter((name): name is string => Boolean(name));
              const destinationPreview = summarizeNames(destinationNames);
              const status = statusConfig[route.status] || statusConfig.paused;
              const session = route.rules.sessionId ? sessionsById.get(route.rules.sessionId) : undefined;
              const isActive = route.status === "active";
              const sourceSession = source ? sessionsById.get(source.sessionId) : undefined;
              const template = route.rules.templateId
                ? templatesById.get(route.rules.templateId)
                : null;
              const meliSession = route.rules.meliSessionId
                ? meliSessionsById.get(route.rules.meliSessionId)
                : null;
              const hasShopeeConversion = route.rules.autoConvertShopee;
              const hasMeliConversion = route.rules.autoConvertMercadoLivre;

              return (
                <Card
                  key={route.id}
                  className={cn(
                    "glass overflow-hidden border-border/60 transition-all hover:border-primary/20 hover:shadow-md",
                    isActive && "ring-1 ring-success/20"
                  )}
                >
                  {/* Status bar */}
                  <div className={cn("h-0.5 w-full", isActive ? "bg-success" : route.status === "error" ? "bg-destructive" : "bg-muted-foreground/20")} />
                  <CardContent className="px-3 py-2.5 space-y-1.5">

                    {/* ── Row 1: name + status + health + msgs + actions ── */}
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 flex items-center gap-1.5 overflow-hidden">
                        <p className="text-sm font-semibold tracking-tight truncate">{route.name}</p>
                        <Badge variant="outline" className={cn("text-xs shrink-0", status.class)}>{status.label}</Badge>
                        <RouteHealthBadge
                          route={route}
                          groupsById={groupsById}
                          sessionsById={sessionsById}
                          masterGroupsById={masterGroupsById}
                          meliSessionsById={meliSessionsById}
                          templatesById={templatesById}
                          whatsappOnline={whatsappOnline}
                          telegramOnline={telegramOnline}
                          shopeeOnline={shopeeOnline}
                          meliOnline={meliOnline}
                        />
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{route.messagesForwarded} msgs</span>
                      <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-muted/35 p-0.5">
                        <Button size="icon" variant="ghost" className="h-6 w-6" title="Reiniciar rota ativa" onClick={() => handleRefreshRoute(route.id, route.status)}>
                          <RefreshCw className="h-3 w-3" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => toggleRoute(route.id, route.status)}>
                          {isActive ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3 text-success" />}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" className="h-6 w-6"><MoreVertical className="h-3 w-3" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleEditRoute(route)}>
                              <Pencil className="mr-2 h-3.5 w-3.5" />Editar Rota
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => toggleRoute(route.id, route.status)}>
                              {isActive ? <><Pause className="mr-2 h-3.5 w-3.5" />Pausar Rota</> : <><Play className="mr-2 h-3.5 w-3.5" />Ativar Rota</>}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleRefreshRoute(route.id, route.status)}>
                              <RefreshCw className="mr-2 h-3.5 w-3.5" />Reiniciar Rota
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => duplicateRoute(route.id)}>
                              <Copy className="mr-2 h-3.5 w-3.5" />Duplicar Rota
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteId(route.id)}>
                              <Trash2 className="mr-2 h-3.5 w-3.5" />Excluir Rota
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {/* ── Row 2: flow ── */}
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {sourceSession && <ChannelPlatformIcon platform={sourceSession.platform} className="h-3 w-3 shrink-0" />}
                      <span className="font-medium text-foreground truncate max-w-[130px]">{source?.name || "—"}</span>
                      {sourceSession?.label.split(" - ")[1] && (
                        <span className="hidden sm:inline shrink-0 truncate max-w-[90px]">· {sourceSession.label.split(" - ")[1]}</span>
                      )}
                      <ArrowRight className="h-3 w-3 shrink-0 text-primary" />
                      {session && <ChannelPlatformIcon platform={session.platform} className="h-3 w-3 shrink-0" />}
                      {masterTargets.length > 0 && !session && <Layers className="h-3 w-3 shrink-0" />}
                      <span className="font-medium text-foreground truncate max-w-[130px]">{destinationPreview}</span>
                      {session?.label.split(" - ")[1] && (
                        <span className="hidden sm:inline shrink-0 truncate max-w-[90px]">· {session.label.split(" - ")[1]}</span>
                      )}
                    </div>

                    {/* ── Row 3: configured features only ── */}
                    {(hasShopeeConversion || hasMeliConversion || route.rules.positiveKeywords.length > 0 || route.rules.negativeKeywords.length > 0) && (
                      <div className="flex items-center gap-1 flex-wrap">
                        {hasShopeeConversion && (
                          <Badge variant="outline" className="gap-0.5 text-2xs px-1.5 py-0">
                            <LinkIcon className="h-2 w-2" />Shopee
                          </Badge>
                        )}
                        {template && hasShopeeConversion && (
                          <Badge variant="outline" className="gap-0.5 text-2xs px-1.5 py-0">
                            <FileText className="h-2 w-2" />{template.name}
                          </Badge>
                        )}
                        {hasMeliConversion && (
                          <Badge variant="outline" className="gap-0.5 text-2xs px-1.5 py-0">
                            <LinkIcon className="h-2 w-2" />
                            {meliSession ? `ML: ${meliSession.name}` : "Mercado Livre"}
                          </Badge>
                        )}
                        {route.rules.positiveKeywords.length > 0 && (
                          <Badge variant="outline" className="gap-0.5 text-2xs px-1.5 py-0 text-success">
                            <Filter className="h-2 w-2" />+{route.rules.positiveKeywords.length}
                          </Badge>
                        )}
                        {route.rules.negativeKeywords.length > 0 && (
                          <Badge variant="outline" className="gap-0.5 text-2xs px-1.5 py-0 text-destructive">
                            <Filter className="h-2 w-2" />−{route.rules.negativeKeywords.length}
                          </Badge>
                        )}
                      </div>
                    )}

                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Route} title="Nenhuma rota criada" description="Crie uma rota pra copiar ofertas de um grupo e enviar pros seus." actionLabel="Criar rota" onAction={openNewRoute} />
        )}
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir rota?</AlertDialogTitle>
            <AlertDialogDescription>
              A rota <strong>{deleteRouteObj?.name}</strong> vai ser apagada de vez. Nenhuma mensagem vai mais ser encaminhada por ela.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (deleteId) deleteRoute(deleteId); setDeleteId(null); }}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Route Wizard */}
      <Dialog open={showNew} onOpenChange={(o) => { if (!o) closeNew(); }}>
        <DialogContent className="sm:max-w-2xl max-h-[92dvh] overflow-hidden p-0">
          <div className="flex max-h-[92dvh] flex-col">
            <div className="space-y-4 border-b px-5 pt-5 pb-4 sm:px-6 sm:pt-6 sm:pb-5">
              <DialogHeader className="space-y-1.5">
                <DialogTitle>{isEditing ? "Editar" : "Nova"} Rota - Passo {step} de {totalSteps}</DialogTitle>
                <DialogDescription>{stepDescriptions[step] || stepDescriptions[1]}</DialogDescription>
              </DialogHeader>

              {/* Step indicators */}
              <div className="flex gap-1">
                {[1, 2, 3].map((s) => (
                  <div key={s} className={cn("h-1 flex-1 rounded-full transition-colors", s <= step ? "bg-primary" : "bg-muted")} />
                ))}
              </div>
            </div>

            <div className="overflow-y-auto px-5 py-4 max-h-[calc(92dvh-210px)] sm:px-6 sm:py-5">
              {/* STEP 1: Source Session + Source Group */}
              {step === 1 && (
                <div className="space-y-5">
              <div className="space-y-2">
                <Label>Nome da Rota</Label>
                <Input placeholder="Ex: Ofertas Tech -> Grupos VIP" value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} />
                <p className="text-xs text-muted-foreground">Um nome para você identificar esta rota facilmente.</p>
              </div>

              <div className="space-y-2">
                <Label>Sessão de Captura</Label>
                {!isEditing && connectedSessions.length === 0 ? (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/5 border border-destructive/20">
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-destructive">Nenhuma sessão conectada</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Conecte uma sessão WhatsApp ou Telegram antes de criar uma rota.</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <SessionSelect
                      value={nr.sourceSessionId}
                      onValueChange={(v) => setNr({ ...nr, sourceSessionId: v, sourceGroupId: "" })}
                      sessions={isEditing ? allSessions : connectedSessions}
                      placeholder="Escolha a sessão de captura..."
                    />
                    <p className="text-xs text-muted-foreground">A sessão que vai monitorar e capturar as mensagens do grupo de origem.</p>
                  </>
                )}
              </div>

              {nr.sourceSessionId && (sourceSessionConnected || isEditing) && (
                <div className="space-y-2">
                  <Label>Grupo de Origem (monitorado)</Label>
                  {!sourceSessionConnected && (
                    <p className="text-xs text-warning p-2 rounded-lg bg-warning/10 border border-warning/20">
                      Sessão offline — mostrando grupos do último estado. A rota não vai capturar mensagens enquanto a sessão estiver desconectada.
                    </p>
                  )}
                  {sourceGroups.length === 0 ? (
                    <p className="text-xs text-muted-foreground p-3 bg-muted rounded-lg">Nenhum grupo sincronizado pra essa sessão. Sincronize os grupos primeiro.</p>
                  ) : (
                    <>
                      <Select value={nr.sourceGroupId} onValueChange={(v) => setNr({ ...nr, sourceGroupId: v })}>
                        <SelectTrigger><SelectValue placeholder="Escolha o grupo de origem..." /></SelectTrigger>
                        <SelectContent>
                          {sourceGroups.map((g) => (
                            <SelectItem key={g.id} value={g.id}>
                              <span className="flex items-center gap-2">
                                {g.name}
                                <Badge variant="outline" className="text-2xs">{g.memberCount} membros</Badge>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">As mensagens que chegarem nesse grupo vão ser processadas pela rota.</p>
                    </>
                  )}
                </div>
              )}
                </div>
              )}

              {/* STEP 2: Dest Session + Destinations */}
              {step === 2 && (
                <div className="space-y-5">
              {/* Destination Session */}
              <div className="space-y-2">
                <Label>Sessão de Envio</Label>
                <SessionSelect
                  value={nr.destSessionId}
                  onValueChange={(v) => setNr({ ...nr, destSessionId: v, destinationGroupIds: [], masterGroupIds: [] })}
                  sessions={isEditing ? allSessions : connectedSessions}
                  placeholder="Escolha a sessão de envio..."
                />
                <p className="text-xs text-muted-foreground">
                  As mensagens vão ser enviadas por essa sessão. Pode ser diferente da sessão de captura.
                </p>
              </div>

              {/* Show destinations only after selecting dest session */}
              {nr.destSessionId && (destSessionConnected || isEditing) && (
                !destSessionConnected && (
                  <p className="text-xs text-warning p-2 rounded-lg bg-warning/10 border border-warning/20">
                    Sessão de envio offline — mostrando grupos do último estado. As mensagens não vão ser enviadas enquanto a sessão estiver desconectada.
                  </p>
                )
              )}
              {nr.destSessionId && (destSessionConnected || isEditing) && (
                <>
                  <div className="space-y-2">
                    <Label>Tipo de Destino</Label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        className={cn(
                          "flex flex-col items-center gap-2 p-4 rounded-xl border transition-all",
                          nr.destinationType === "groups" ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:bg-secondary/50"
                        )}
                        onClick={() => setNr({ ...nr, destinationType: "groups", masterGroupIds: [] })}
                      >
                        <Users className={cn("h-5 w-5", nr.destinationType === "groups" ? "text-primary" : "text-muted-foreground")} />
                        <div className="text-center">
                          <p className="text-xs font-medium">Grupos Individuais</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Escolha um ou vários grupos</p>
                        </div>
                      </button>
                      <button
                        className={cn(
                          "flex flex-col items-center gap-2 p-4 rounded-xl border transition-all",
                          nr.destinationType === "master" ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:bg-secondary/50"
                        )}
                        onClick={() => setNr({ ...nr, destinationType: "master", destinationGroupIds: [] })}
                      >
                        <Layers className={cn("h-5 w-5", nr.destinationType === "master" ? "text-primary" : "text-muted-foreground")} />
                        <div className="text-center">
                          <p className="text-xs font-medium">Grupo Mestre</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Envia para todos os sub-grupos</p>
                        </div>
                      </button>
                    </div>
                  </div>

                  {nr.destinationType === "master" ? (
                    <div className="space-y-2">
                      <Label>Grupos Mestre</Label>
                      {destMasterGroups.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-3 bg-muted rounded-lg">
                          Nenhum grupo mestre com grupos da plataforma {destSession?.platform === "whatsapp" ? "WhatsApp" : "Telegram"}. Crie um na aba de Grupos Mestres.
                        </p>
                      ) : (
                        <MultiOptionDropdown
                          value={nr.masterGroupIds}
                          onChange={(ids) => setNr({ ...nr, masterGroupIds: ids })}
                          items={destMasterGroups.map((m) => ({
                            id: m.id,
                            label: m.name,
                            meta: `${m.linkedGroups.length} grupos`,
                          }))}
                          placeholder="Escolher grupos mestre"
                          selectedLabel={(count) => `${count} grupo(s) mestre`}
                          emptyMessage="Nenhum grupo mestre"
                          title="Grupos mestre"
                        />
                      )}
                      <p className="text-xs text-muted-foreground">A mensagem vai ser enviada pros grupos dos grupos mestre que você escolher.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>Grupos de Destino</Label>
                      {destGroups.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-3 bg-muted rounded-lg">
                          Nenhum grupo disponível pra sessão {destSession?.label}. Sincronize os grupos primeiro.
                        </p>
                      ) : (
                        <MultiOptionDropdown
                          value={nr.destinationGroupIds}
                          onChange={(ids) => setNr((prev) => ({ ...prev, destinationGroupIds: ids }))}
                          items={destGroups.map((g) => ({
                            id: g.id,
                            label: g.name,
                            meta: `${g.memberCount}`,
                          }))}
                          placeholder="Escolher grupos"
                          selectedLabel={(count) => `${count} grupo(s)`}
                          emptyMessage="Nenhum grupo pra essa sessão"
                          title="Grupos de destino"
                        />
                      )}
                      {nr.destinationGroupIds.length > 0 && (
                        <p className="text-xs text-muted-foreground">{nr.destinationGroupIds.length} grupo(s) selecionado(s).</p>
                      )}
                    </div>
                  )}
                </>
              )}
                </div>
              )}

              {/* STEP 3: Configuration */}
              {step === 3 && (
                <div className="space-y-5">
              {/* Marketplace conversion */}
              <Card className="glass">
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="flex items-center gap-2 pr-3">
                      <LinkIcon className="h-4 w-4 text-primary" />
                      <div>
                        <Label className="text-sm">Conversão Shopee</Label>
                        <p className="text-xs text-muted-foreground">Os links vão ser convertidos pro seu link de afiliado.</p>
                      </div>
                    </div>
                    <Switch
                      checked={nr.autoConvertShopee}
                      onCheckedChange={(checked) => {
                        setNr((prev) => ({
                          ...prev,
                          autoConvertShopee: checked,
                          templateId: checked ? prev.templateId : "",
                        }));
                      }}
                    />
                  </div>

                  {nr.autoConvertShopee && (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label className="text-xs">Template Shopee</Label>
                        <p className="text-xs text-muted-foreground">Escolha como a mensagem vai ficar depois da conversão da Shopee.</p>
                        <Select value={nr.templateId || "original"} onValueChange={(v) => setNr({ ...nr, templateId: v })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="original">
                              <span className="flex items-center gap-2">Manter mensagem original</span>
                            </SelectItem>
                            {templates.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                <span className="flex items-center gap-2">Template {t.name}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-secondary/50">
                        <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                        <p className="text-xs text-muted-foreground">
                          Se marcar "Manter mensagem original", só o link vai ser convertido pra afiliado.
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="flex items-center gap-2 pr-3">
                      <LinkIcon className="h-4 w-4 text-primary" />
                      <div>
                        <Label className="text-sm">Conversão Mercado Livre</Label>
                        <p className="text-xs text-muted-foreground">Os links do Mercado Livre vão ser convertidos pro seu link de afiliado.</p>
                      </div>
                    </div>
                    <Switch
                      checked={nr.autoConvertMercadoLivre}
                      onCheckedChange={(checked) => {
                        setNr((prev) => ({
                          ...prev,
                          autoConvertMercadoLivre: checked,
                          meliSessionId: checked ? (prev.meliSessionId || defaultMeliSession?.id || "") : "",
                        }));
                      }}
                    />
                  </div>

                  {nr.autoConvertMercadoLivre && (
                    <div className="space-y-2">
                      <Label className="text-xs">Sessão Mercado Livre</Label>
                      <div className="rounded-lg border bg-secondary/30 px-3 py-2">
                        <p className="text-xs font-medium text-foreground">
                          {activeMeliSession ? `${activeMeliSession.name} (${activeMeliSession.status})` : "Nenhuma sessão disponível"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Sessão definida automaticamente.
                        </p>
                      </div>
                      {!hasMeliSessionSelected && (
                        <p className="text-xs text-warning p-2 rounded-lg bg-warning/10 border border-warning/20">
                          Nenhuma sessão Mercado Livre no momento. Conecte uma sessão pra usar a conversão.
                        </p>
                      )}
                    </div>
                  )}

                </CardContent>
              </Card>

              {/* Keywords */}
              <Card className="glass">
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <Filter className="h-4 w-4 text-primary" />
                    <div>
                      <Label className="text-sm">Filtros por Palavras-chave</Label>
                      <p className="text-xs text-muted-foreground">Opcional: deixe em branco para enviar todas as ofertas</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-success inline-block" />
                      Palavras Positivas
                    </Label>
                    <Textarea
                      rows={2}
                      placeholder="iPhone, Samsung, notebook"
                      value={nr.positiveKeywords}
                      onChange={(e) => setNr({ ...nr, positiveKeywords: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                          Separe por vírgula. A mensagem só passa se tiver pelo menos uma palavra positiva. Se não tiver, ela é descartada.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-destructive inline-block" />
                      Palavras Negativas
                    </Label>
                    <Textarea
                      rows={2}
                      placeholder="spam, bug, teste"
                      value={nr.negativeKeywords}
                      onChange={(e) => setNr({ ...nr, negativeKeywords: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                          Separe por vírgula. Se tiver qualquer palavra negativa, a mensagem é descartada.
                    </p>
                  </div>
                </CardContent>
              </Card>
                </div>
              )}
            </div>

            {/* Footer */}
            <DialogFooter className="border-t bg-card px-5 py-3 sm:px-6 sm:py-4">
              {step > 1 ? (
                <Button variant="ghost" onClick={() => setStep(step - 1)}>Voltar</Button>
              ) : (
                <Button variant="ghost" onClick={closeNew}>Cancelar</Button>
              )}
              <div className="flex-1" />
              {step < totalSteps ? (
                <Button onClick={() => setStep(step + 1)} disabled={step === 1 ? !canGoStep2 : !canGoStep3}>
                  Próximo
                </Button>
              ) : (
                <Button onClick={handleCreateRoute} disabled={!canCreate}>
                  {isEditing ? "Salvar" : "Criar Rota"}
                </Button>
              )}
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

