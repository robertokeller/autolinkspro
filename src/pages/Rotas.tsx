import { useEffect, useMemo, useState } from "react";
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
  AlertTriangle, Info, Layers, Users, Clock,
  LinkIcon, FileText, Filter, Copy, RefreshCw, PlayCircle, PauseCircle,
} from "lucide-react";
import { useRotas } from "@/hooks/useRotas";
import { useGrupos } from "@/hooks/useGrupos";
import { useTemplates } from "@/hooks/useTemplates";
import { useSessoes } from "@/hooks/useSessoes";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { useShopeeCredentials } from "@/hooks/useShopeeCredentials";
import { useShopeeSubIds } from "@/hooks/useShopeeSubIds";
import { useServiceHealth } from "@/hooks/useServiceHealth";
import { getAllChannelHealth } from "@/lib/channel-central";
import { RouteHealthBadge } from "@/components/routes/RouteHealthBadge";
import { computeRouteHealth } from "@/lib/route-health";
import type { AppRoute, Group, MasterGroup, Template } from "@/lib/types";
import type { MeliSession } from "@/hooks/useMercadoLivreSessions";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { buildRoutePayload, emptyNewRoute, type NewRouteForm } from "@/pages/routes/route-form";
import { ChannelPlatformIcon } from "@/components/icons/ChannelPlatformIcon";
import { SessionSelect } from "@/components/selectors/SessionSelect";
import { GroupSelect } from "@/components/selectors/GroupSelect";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";
import { pickDefaultShopeeSubId } from "@/lib/shopee-subid";

type UnifiedSession = {
  id: string;
  label: string;
  platform: "whatsapp" | "telegram";
  status: string;
};

type SessionConnectionState = "online" | "pending" | "offline";

const PENDING_SESSION_STATES = new Set([
  "connecting",
  "warning",
  "awaiting_code",
  "awaiting_password",
  "qr_code",
  "pairing_code",
]);

function getSessionConnectionState(status: string | undefined): SessionConnectionState {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "online") return "online";
  if (PENDING_SESSION_STATES.has(normalized)) return "pending";
  return "offline";
}

function parseClockToMinutes(value: string, fallback: number): number {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return fallback;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return (hh * 60) + mm;
}

function isInsideQuietHours(start: string, end: string, now = new Date()): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = parseClockToMinutes(start, 22 * 60);
  const endMinutes = parseClockToMinutes(end, 8 * 60);

  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function getChannelOnline(
  platform: "whatsapp" | "telegram" | undefined,
  whatsappOnline: boolean | null,
  telegramOnline: boolean | null,
): boolean | null {
  if (platform === "whatsapp") return whatsappOnline;
  if (platform === "telegram") return telegramOnline;
  return null;
}

function ptCount(value: number, singular: string, plural: string): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe} ${safe === 1 ? singular : plural}`;
}

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
  const { templates: rawMessageTemplates } = useTemplates("message");
  const { templates: rawShopeeTemplates } = useTemplates("shopee");
  const { templates: rawMeliTemplates } = useTemplates("meli");
  const { templates: rawAmazonTemplates } = useTemplates("amazon");
  const { allSessions: rawAllSessions, refreshSessions } = useSessoes();
  const { sessions: rawMeliSessions } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const { isConfigured: shopeeConfiguredRaw, isLoading: shopeeConfigLoading } = useShopeeCredentials();
  const { subIds: shopeeSubIds, isLoading: isShopeeSubIdsLoading } = useShopeeSubIds();
  const { data: channelHealth, refetch: refetchChannelHealth } = useQuery({
    queryKey: ["channel-health", "routes-page"],
    queryFn: getAllChannelHealth,
    staleTime: 30 * 1000,
  });
  const groups = rawGroups as Group[];
  const masterGroups = rawMasterGroups as MasterGroup[];
  const messageTemplates = rawMessageTemplates as Template[];
  const shopeeTemplates = rawShopeeTemplates as Template[];
  const meliTemplates = rawMeliTemplates as Template[];
  const amazonTemplates = rawAmazonTemplates as Template[];
  const allSessions = rawAllSessions as UnifiedSession[];
  const meliSessions = rawMeliSessions as MeliSession[];
  const { health: shopeeHealth, refresh: refreshShopeeHealth } = useServiceHealth("shopee");
  const { health: meliHealth, refresh: refreshMeliHealth } = useServiceHealth("meli");
  const { health: amazonHealth, refresh: refreshAmazonHealth } = useServiceHealth("amazon");
  const shopeeOnline = shopeeHealth ? shopeeHealth.online : null;
  const meliOnline = meliHealth ? meliHealth.online : null;
  const amazonOnline = amazonHealth ? amazonHealth.online : null;
  const amazonTagConfigured = amazonHealth ? amazonHealth.tagConfigured === true : null;
  const shopeeConfigured = shopeeConfigLoading ? null : shopeeConfiguredRaw;
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
    1: "Dê um nome, escolha a sessão e o grupo que será monitorado.",
    2: "Escolha para onde as ofertas serão enviadas.",
    3: "Ajuste a conversão de links, modelos de mensagem e filtros.",
  };
  const hasAnySession = allSessions.length > 0;
  const hasAvailableMeliSession = meliSessions.some((session) => session.status === "active" || session.status === "untested");
  const groupsById = useMemo<Map<string, Group>>(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups],
  );
  const sessionsById = useMemo<Map<string, UnifiedSession>>(
    () => new Map(allSessions.map((session) => [session.id, session])),
    [allSessions],
  );
  const templatesById = useMemo<Map<string, Template>>(
    () => new Map([...messageTemplates, ...shopeeTemplates, ...meliTemplates, ...amazonTemplates].map((template) => [template.id, template])),
    [messageTemplates, shopeeTemplates, meliTemplates, amazonTemplates],
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
  const defaultShopeeSubId = useMemo(() => pickDefaultShopeeSubId(shopeeSubIds), [shopeeSubIds]);
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
  // When creating a new route, if a session was selected and options are available, allow advancing
  // (the warning will inform user that capture won't happen until connection is restored).
  const canGoStep2 = !!nr.name.trim() && !!nr.sourceSessionId && (isEditing || sourceSessionConnected || sourceGroups.length > 0) && !!nr.sourceGroupId;
  const canGoStep3 = !!nr.destSessionId && (isEditing || destSessionConnected || destGroups.length > 0 || destMasterGroups.length > 0) && (
    nr.destinationType === "master"
      ? nr.masterGroupIds.length > 0
      : nr.destinationGroupIds.length > 0
  );
  const canCreate = canGoStep2
    && canGoStep3
    && (!nr.autoConvertMercadoLivre || hasAvailableMeliSession)
    && (!nr.autoConvertShopee || !!nr.shopeeSubId);
  const shouldShowMainMessageModelSelector = nr.autoConvertShopee;
  const selectedTemplateInMessageScope = nr.templateId
    ? messageTemplates.some((template) => template.id === nr.templateId)
    : false;
  const selectedMeliTemplateInMessageScope = nr.meliTemplateId
    ? messageTemplates.some((template) => template.id === nr.meliTemplateId)
    : false;
  const selectedAmazonTemplateInMessageScope = nr.amazonTemplateId
    ? messageTemplates.some((template) => template.id === nr.amazonTemplateId)
    : false;

  useEffect(() => {
    if (!showNew) return;
    if (!nr.autoConvertShopee) return;
    if (nr.shopeeSubId) return;
    if (!defaultShopeeSubId) return;

    setNr((prev) => {
      if (!prev.autoConvertShopee || prev.shopeeSubId) return prev;
      return { ...prev, shopeeSubId: defaultShopeeSubId };
    });
  }, [defaultShopeeSubId, nr.autoConvertShopee, nr.shopeeSubId, showNew]);

  const handleFullSync = async () => {
    setIsSyncing(true);
    try {
      const hasConnectedSession = allSessions.some((session) => session.status === "online");
      if (!hasConnectedSession) {
        toast.error("Nenhuma sessão conectada para atualizar as rotas.");
        return;
      }

      const [channelHealthResult, shopeeHealthResult, meliHealthResult] = await Promise.all([
        refetchChannelHealth(),
        refreshShopeeHealth(),
        refreshMeliHealth(),
        refreshAmazonHealth(),
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
      const usesAmazon = activeRoutes.some((route) => route.rules.autoConvertAmazon);

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
      if (usesShopee && shopeeConfigured === false) {
        blockers.push("Credenciais Shopee não configuradas");
      }
      if (usesAmazon && amazonHealth?.tagConfigured !== true) {
        blockers.push("Tag de afiliado Amazon não configurada");
      }
      if (usesAmazon && amazonHealth?.online === false) {
        blockers.push("Serviço Amazon offline");
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
        const preview = uniqueBlockers.slice(0, 3).join(" | ");
        const rest = uniqueBlockers.length > 3 ? ` | +${uniqueBlockers.length - 3} pendências` : "";
        toast.error(`Atualização não concluída. ${preview}${rest}`);
        return;
      }

      await refreshSessions({ silent: true });
      await syncGroups();
      const refreshedRoutes = await refreshAllRoutes();
      if (!refreshedRoutes) return;

      const serviceStatuses = [
        {
          label: "WhatsApp",
          online: latestChannelHealth?.whatsapp.online === true ? true : latestChannelHealth?.whatsapp.online === false ? false : null,
        },
        {
          label: "Telegram",
          online: latestChannelHealth?.telegram.online === true ? true : latestChannelHealth?.telegram.online === false ? false : null,
        },
        {
          label: "Shopee",
          online: shopeeHealthResult?.online === true ? true : shopeeHealthResult?.online === false ? false : null,
        },
        {
          label: "Mercado Livre",
          online: meliHealthResult?.online === true ? true : meliHealthResult?.online === false ? false : null,
        },
      ] as const;

      const okServices = serviceStatuses.filter((service) => service.online === true).map((service) => service.label);
      const offlineServices = serviceStatuses.filter((service) => service.online === false).map((service) => service.label);
      const unknownServices = serviceStatuses.filter((service) => service.online === null).map((service) => service.label);

      const parts: string[] = [];
      if (okServices.length > 0) parts.push(`Serviços OK: ${okServices.join(", ")}`);
      if (offlineServices.length > 0) parts.push(`Indisponíveis: ${offlineServices.join(", ")}`);
      if (unknownServices.length > 0) parts.push(`Sem resposta: ${unknownServices.join(", ")}`);

      if (offlineServices.length === 0 && unknownServices.length === 0) {
        toast.success(`Atualização concluída. ${parts.join(" | ")}`);
      } else {
        toast.warning(`Atualização concluída com alertas. ${parts.join(" | ")}`);
      }
    } catch {
      toast.error("Não foi possível atualizar.");
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
      toast.error("Escolha pelo menos um grupo de destino para essa sessão.");
      return;
    }

    if (nr.destinationType === "master" && normalizedMasterGroupIds.length === 0) {
      setNr(normalizedNr);
      toast.error("Escolha pelo menos um grupo mestre para essa sessão.");
      return;
    }

    if (normalizedNr.autoConvertShopee && !normalizedNr.shopeeSubId) {
      toast.error("Escolha um Sub ID para a conversão Shopee.");
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
    const selectedMasterGroupIds = route.rules.masterGroupIds || (route.masterGroupId ? [route.masterGroupId] : []);
    setNr({
      name: route.name,
      sourceSessionId,
      sourceGroupId: route.sourceGroupId,
      destSessionId: route.rules.sessionId || "",
      destinationType: selectedMasterGroupIds.length > 0 ? "master" : "groups",
      destinationGroupIds: [...route.destinationGroupIds],
      masterGroupIds: selectedMasterGroupIds,
      autoConvertShopee: route.rules.autoConvertShopee,
      shopeeSubId: route.rules.autoConvertShopee
        ? (route.rules.shopeeSubId || defaultShopeeSubId)
        : "",
      autoConvertMercadoLivre: route.rules.autoConvertMercadoLivre ?? false,
      autoConvertAmazon: route.rules.autoConvertAmazon ?? false,
      templateId: route.rules.templateId || "",
      meliTemplateId: route.rules.meliTemplateId || (route.rules.autoConvertMercadoLivre ? (route.rules.templateId || "") : ""),
      amazonTemplateId: route.rules.amazonTemplateId || "",
      positiveKeywords: route.rules.positiveKeywords.join(", "),
      negativeKeywords: route.rules.negativeKeywords.join(", "),
      quietHoursEnabled: route.rules.quietHoursEnabled === true,
      quietHoursStart: route.rules.quietHoursStart || "22:00",
      quietHoursEnd: route.rules.quietHoursEnd || "08:00",
    });
    setEditingRouteId(route.id);
    setStep(1);
    setShowNew(true);
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
      const resumed = await toggleRoute(routeId, "paused");
      if (resumed) toast.success("Rota atualizada");
    })();
  };

  return (
    <>
      <div className="mb-[var(--ds-page-gap)] rounded-xl border border-border/60 bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
        <PageHeader title="Rotas automáticas" description="Crie rotas para capturar ofertas de um grupo e enviar para outros automaticamente.">
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 max-sm:h-10 max-sm:flex-1"
              disabled={isSyncing || syncingGroups}
              onClick={() => { void handleFullSync(); }}
            >
              <RefreshCw className={cn("h-4 w-4", (isSyncing || syncingGroups) && "animate-spin")} />
              Atualizar
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 max-sm:h-10 max-sm:flex-1"
              disabled={routes.length === 0}
              onClick={() => { void setAllRoutesStatus(allPaused ? "active" : "paused"); }}
            >
              {allPaused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
              {allPaused ? "Retomar rotas" : "Pausar rotas"}
            </Button>
            <Button size="sm" onClick={openNewRoute} className="gap-1.5 max-sm:h-10 max-sm:w-full">
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
              const health = computeRouteHealth({
                route,
                groupsById,
                sessionsById,
                masterGroupsById,
                meliSessionsById,
                templatesById,
                whatsappOnline,
                telegramOnline,
                shopeeOnline,
                meliOnline,
                amazonOnline,
                shopeeConfigured,
                amazonTagConfigured,
              });
              const source = groupsById.get(route.sourceGroupId);
              const masterTargetIds = route.rules.masterGroupIds || (route.masterGroupId ? [route.masterGroupId] : []);
              const masterTargets = masterTargetIds
                .map((id) => masterGroupsById.get(id))
                .filter((group): group is MasterGroup => Boolean(group));
              const destinationNames = masterTargets.length > 0
                ? masterTargets.map((group) => group.name)
                : route.destinationGroupIds.map((id) => groupsById.get(id)?.name).filter((name): name is string => Boolean(name));
              const destinationPreview = summarizeNames(destinationNames);
              const session = route.rules.sessionId ? sessionsById.get(route.rules.sessionId) : undefined;
              const isActive = route.status === "active";
              const sourceSession = source ? sessionsById.get(source.sessionId) : undefined;
              const template = route.rules.templateId
                ? templatesById.get(route.rules.templateId)
                : null;
              const amazonTemplate = route.rules.amazonTemplateId
                ? templatesById.get(route.rules.amazonTemplateId)
                : null;
              const hasShopeeConversion = route.rules.autoConvertShopee;
              const hasMeliConversion = route.rules.autoConvertMercadoLivre;
              const hasAmazonConversion = route.rules.autoConvertAmazon;
              const hasQuietHours = route.rules.quietHoursEnabled === true;
              const quietHoursStart = route.rules.quietHoursStart || "22:00";
              const quietHoursEnd = route.rules.quietHoursEnd || "08:00";
              const sourceConn = getSessionConnectionState(sourceSession?.status);
              const destinationConn = getSessionConnectionState(session?.status);
              const sourceChannelOnline = getChannelOnline(sourceSession?.platform, whatsappOnline, telegramOnline);
              const destinationChannelOnline = getChannelOnline(session?.platform, whatsappOnline, telegramOnline);
              const quietHoursBlocking = hasQuietHours && isInsideQuietHours(quietHoursStart, quietHoursEnd);

              const runtimeIssues = health.issues;
              const runtimeSummary = health.primaryIssue?.detail || "";
              const runtimeSummaryIsError = health.primaryIssue?.status === "error";
              const destinationCountLabel = masterTargets.length > 0
                ? ptCount(masterTargets.length, "grupo mestre", "grupos mestre")
                : ptCount(route.destinationGroupIds.length, "grupo", "grupos");
              
              const conversionBadges = [];
              if (hasShopeeConversion) conversionBadges.push("Shopee");
              if (hasMeliConversion) conversionBadges.push("Mercado Livre");
              if (hasAmazonConversion) conversionBadges.push("Amazon");

              const filtersSummary =
                route.rules.positiveKeywords.length > 0 || route.rules.negativeKeywords.length > 0
                  ? `Filtros: +${route.rules.positiveKeywords.length} / -${route.rules.negativeKeywords.length}`
                  : null;

              return (
                <Card
                  key={route.id}
                  className={cn(
                    "glass overflow-hidden border-border/60 transition-all hover:border-primary/20",
                    health.level === "healthy" && "ring-1 ring-success/20",
                    health.level === "partial" && "ring-1 ring-warning/20",
                    health.level === "error" && "ring-1 ring-destructive/20",
                  )}
                >
                  {/* Status bar */}
                  <div
                    className={cn(
                      "h-0.5 w-full",
                      health.level === "healthy"
                        ? "bg-success"
                        : health.level === "partial"
                          ? "bg-warning"
                          : "bg-destructive",
                    )}
                  />
                  <CardContent className="px-4 py-3 space-y-2.5">

                    {/* Header: Name + Health + Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <div className="min-w-0 flex-1 flex items-center gap-2 overflow-hidden">
                        <p className="text-sm font-semibold tracking-tight truncate">{route.name}</p>
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
                          amazonOnline={amazonOnline}
                          shopeeConfigured={shopeeConfigured}
                          amazonTagConfigured={amazonTagConfigured}
                        />
                      </div>
                      
                      {/* Actions */}
                      <div className="flex shrink-0 items-center justify-end">
                        <div className="flex items-center justify-center mr-1 px-1.5 py-0.5 bg-muted/40 rounded text-2xs font-medium text-muted-foreground">
                           <span className="tabular-nums text-foreground mr-1">{route.messagesForwarded}</span> enviadas
                        </div>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" title="Reiniciar rota ativa" onClick={() => handleRefreshRoute(route.id, route.status)}>
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => toggleRoute(route.id, route.status)}>
                          {isActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 text-success" />}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground"><MoreVertical className="h-3.5 w-3.5" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-[min(calc(100vw-1rem),18rem)]">
                            <DropdownMenuItem onClick={() => handleEditRoute(route)}>
                              <Pencil className="mr-2 h-3.5 w-3.5" />Editar rota
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => toggleRoute(route.id, route.status)}>
                              {isActive ? <><Pause className="mr-2 h-3.5 w-3.5" />Pausar rota</> : <><Play className="mr-2 h-3.5 w-3.5" />Ativar rota</>}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleRefreshRoute(route.id, route.status)}>
                              <RefreshCw className="mr-2 h-3.5 w-3.5" />Reiniciar rota
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => duplicateRoute(route.id)}>
                              <Copy className="mr-2 h-3.5 w-3.5" />Duplicar rota
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteId(route.id)}>
                              <Trash2 className="mr-2 h-3.5 w-3.5" />Excluir rota
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {/* Flow & Info Container */}
                    <div className="flex flex-col gap-2">
                      {/* Source -> Destination */}
                      <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground flex-wrap">
                        {sourceSession && <ChannelPlatformIcon platform={sourceSession.platform} className="h-3.5 w-3.5 shrink-0" />}
                        <span className="truncate font-medium text-foreground/90 max-w-[40vw] sm:max-w-none">{source?.name || "—"}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/50 mx-0.5" />
                        {session && <ChannelPlatformIcon platform={session.platform} className="h-3.5 w-3.5 shrink-0" />}
                        {masterTargets.length > 0 && !session && <Layers className="h-3.5 w-3.5 shrink-0" />}
                        <span className="truncate font-medium text-foreground/90 max-w-[40vw] sm:max-w-none">{destinationPreview}</span>
                        <span className="text-muted-foreground/70 shrink-0 text-xs">({destinationCountLabel})</span>
                      </div>

                      {/* Badges Flow */}
                      {(conversionBadges.length > 0 || hasQuietHours || filtersSummary) && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {conversionBadges.map((name, i) => (
                            <Badge key={i} variant="secondary" className="px-1.5 py-0 text-2xs bg-primary/5 hover:bg-primary/10 text-primary border-primary/20 font-medium">
                              {name}
                            </Badge>
                          ))}
                          
                          {hasQuietHours && (
                            <Badge variant="outline" className="gap-1 px-1.5 py-0 text-2xs text-muted-foreground font-normal border-border/50">
                              <Clock className="h-2.5 w-2.5" />{quietHoursStart}–{quietHoursEnd}
                            </Badge>
                          )}
                          {filtersSummary && (
                            <Badge variant="outline" className="gap-1 px-1.5 py-0 text-2xs text-muted-foreground font-normal border-border/50">
                              <Filter className="h-2.5 w-2.5" />{filtersSummary}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Blockers */}
                    {runtimeIssues.length > 0 && (
                      <div className="pt-2 mt-1 border-t border-border/40">
                        <p
                          className={cn(
                            "flex items-center gap-1.5 text-xs font-medium truncate",
                            runtimeSummaryIsError ? "text-destructive" : "text-warning",
                          )}
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          <span className="truncate">{runtimeSummary}</span>
                        </p>
                      </div>
                    )}

                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Route} title="Nenhuma rota criada" description="Crie uma rota para copiar ofertas de um grupo e enviar para seus grupos." actionLabel="Criar rota" onAction={openNewRoute} />
        )}
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir rota?</AlertDialogTitle>
            <AlertDialogDescription>
              A rota <strong>{deleteRouteObj?.name}</strong> será apagada permanentemente. Nenhuma mensagem será encaminhada por ela.
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
        <DialogContent className="w-[min(calc(100vw-0.75rem),42rem)] max-w-none max-h-[94dvh] overflow-hidden p-0">
          <div className="flex max-h-[94dvh] flex-col">
            <div className="space-y-4 border-b px-4 pt-4 pb-3 sm:px-6 sm:pt-6 sm:pb-5">
              <DialogHeader className="space-y-1.5">
                <DialogTitle>{isEditing ? "Editar rota" : "Nova rota"} - Passo {step} de {totalSteps}</DialogTitle>
                <DialogDescription>{stepDescriptions[step] || stepDescriptions[1]}</DialogDescription>
              </DialogHeader>

              {/* Step indicators */}
              <div className="flex gap-1">
                {[1, 2, 3].map((s) => (
                  <div key={s} className={cn("h-1 flex-1 rounded-full transition-colors", s <= step ? "bg-primary" : "bg-muted")} />
                ))}
              </div>
            </div>

            <div className="max-h-[calc(94dvh-210px)] overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
              {/* STEP 1: Source Session + Source Group */}
              {step === 1 && (
                <div className="space-y-5">
              <div className="space-y-2">
                <Label>Nome da rota</Label>
                <Input placeholder="Ex: Ofertas Tech -> Grupos VIP" value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} />
                <p className="text-xs text-muted-foreground">Um nome para você identificar esta rota facilmente.</p>
              </div>

              <div className="space-y-2">
                <Label>Sessão de captura</Label>
                {!isEditing && !hasAnySession ? (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/5 border border-destructive/20">
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-destructive">Nenhuma sessão disponível</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Cadastre ao menos uma sessão WhatsApp ou Telegram antes de criar uma rota.</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <SessionSelect
                      value={nr.sourceSessionId}
                      onValueChange={(v) => setNr({ ...nr, sourceSessionId: v, sourceGroupId: "" })}
                      sessions={allSessions}
                      placeholder="Escolha a sessão de captura..."
                    />
                    <p className="text-xs text-muted-foreground">A sessão que vai monitorar e capturar as mensagens do grupo de origem.</p>
                  </>
                )}
              </div>

              {nr.sourceSessionId && (
                <div className="space-y-2">
                  <Label>Grupo de origem (monitorado)</Label>
                  {!sourceSessionConnected && !isEditing && (
                    <p className="text-xs text-warning p-2 rounded-lg bg-warning/10 border border-warning/20">
                      Sessão offline — mostrando grupos do último estado. A rota não vai capturar mensagens enquanto a sessão estiver desconectada.
                    </p>
                  )}
                  {!sourceSessionConnected && isEditing && (
                    <p className="text-xs text-warning p-2 rounded-lg bg-warning/10 border border-warning/20">
                      Sessão offline — você pode continuar editando. A rota não vai capturar mensagens enquanto a sessão estiver desconectada.
                    </p>
                  )}
                  {sourceGroups.length === 0 ? (
                    <p className="text-xs text-muted-foreground p-3 bg-muted rounded-lg">Nenhum grupo sincronizado para essa sessão. Sincronize os grupos primeiro.</p>
                  ) : (
                    <>
                      <GroupSelect
                        value={nr.sourceGroupId}
                        onValueChange={(v) => setNr({ ...nr, sourceGroupId: v })}
                        groups={sourceGroups.map((g) => ({
                          id: g.id,
                          name: g.name,
                          memberCount: g.memberCount,
                        }))}
                        placeholder="Escolha o grupo de origem..."
                      />
                      <p className="text-xs text-muted-foreground">As mensagens que chegarem nesse grupo serão processadas pela rota.</p>
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
                <Label>Sessão de envio</Label>
                <SessionSelect
                  value={nr.destSessionId}
                  onValueChange={(v) => setNr({ ...nr, destSessionId: v, destinationGroupIds: [], masterGroupIds: [] })}
                  sessions={allSessions}
                  placeholder="Escolha a sessão de envio..."
                />
                <p className="text-xs text-muted-foreground">
                  As mensagens vão ser enviadas por essa sessão. Pode ser diferente da sessão de captura.
                </p>
              </div>

              {/* Show destinations only after selecting dest session */}
              {nr.destSessionId && !destSessionConnected && (
                <p className="text-xs text-warning p-2 rounded-lg bg-warning/10 border border-warning/20">
                  Sessão de envio offline — mostrando grupos do último estado. As mensagens não vão ser enviadas enquanto a sessão estiver desconectada.
                </p>
              )}
              {nr.destSessionId && (
                <>
                  <div className="space-y-2">
                    <Label>Tipo de destino</Label>
                    <div className="grid grid-cols-1 gap-3 min-[430px]:grid-cols-2">
                      <button
                        className={cn(
                          "flex flex-col items-center gap-2 p-4 rounded-xl border transition-all",
                          nr.destinationType === "groups" ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:bg-secondary/50"
                        )}
                        onClick={() => setNr({ ...nr, destinationType: "groups", masterGroupIds: [] })}
                      >
                        <Users className={cn("h-5 w-5", nr.destinationType === "groups" ? "text-primary" : "text-muted-foreground")} />
                        <div className="text-center">
                          <p className="text-xs font-medium">Grupos individuais</p>
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
                          <p className="text-xs font-medium">Grupo mestre</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Envia para todos os sub-grupos</p>
                        </div>
                      </button>
                    </div>
                  </div>

                  {nr.destinationType === "master" ? (
                    <div className="space-y-2">
                      <Label>Grupos mestre</Label>
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
                          selectedLabel={(count) => ptCount(count, "grupo mestre", "grupos mestre")}
                          emptyMessage="Nenhum grupo mestre"
                          title="Grupos mestre"
                        />
                      )}
                      <p className="text-xs text-muted-foreground">A mensagem será enviada para os grupos dos grupos mestre que você escolher.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>Grupos de destino</Label>
                      {destGroups.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-3 bg-muted rounded-lg">
                          Nenhum grupo disponível para a sessão {destSession?.label}. Sincronize os grupos primeiro.
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
                          selectedLabel={(count) => ptCount(count, "grupo", "grupos")}
                          emptyMessage="Nenhum grupo para essa sessão"
                          title="Grupos de destino"
                        />
                      )}
                      {nr.destinationGroupIds.length > 0 && (
                        <p className="text-xs text-muted-foreground">{ptCount(nr.destinationGroupIds.length, "grupo selecionado", "grupos selecionados")}.</p>
                      )}
                    </div>
                  )}
                </>
              )}
                </div>
              )}

              {/* STEP 3: Configuration */}
              {step === 3 && (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <LinkIcon className="h-4 w-4 text-primary" />
                      <Label className="text-sm font-semibold">Conversão de links</Label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Ative os marketplaces que essa rota deve converter. Os detalhes aparecem somente para os canais ativos.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Card className="glass border-border/60">
                      <CardContent className="p-0">
                        <div className="flex items-start justify-between gap-4 px-4 py-3">
                          <div className="space-y-1 pr-3">
                            <div className="flex items-center gap-2">
                              <Label className="text-sm font-medium">Shopee</Label>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                                  nr.autoConvertShopee ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                                )}
                              >
                                {nr.autoConvertShopee ? "Ativo" : "Desativado"}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground">Converte links da Shopee para seu afiliado.</p>
                          </div>
                          <Switch
                            checked={nr.autoConvertShopee}
                            onCheckedChange={(checked) => {
                              setNr((prev) => ({
                                ...prev,
                                autoConvertShopee: checked,
                                templateId: checked ? prev.templateId : "",
                                shopeeSubId: checked ? (prev.shopeeSubId || defaultShopeeSubId) : "",
                              }));
                            }}
                          />
                        </div>

                        {nr.autoConvertShopee && (
                          <div className="space-y-4 border-t border-border/50 px-4 py-4">
                            <div className="space-y-2">
                              <Label className="text-xs">Sub ID Shopee (obrigatório)</Label>
                              <Select
                                value={nr.shopeeSubId}
                                onValueChange={(value) => setNr((prev) => ({ ...prev, shopeeSubId: value }))}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder={isShopeeSubIdsLoading ? "Carregando Sub IDs..." : "Selecione o Sub ID"} />
                                </SelectTrigger>
                                <SelectContent>
                                  {!!nr.shopeeSubId && !shopeeSubIds.some((item) => item.value === nr.shopeeSubId) && (
                                    <SelectItem value={nr.shopeeSubId}>
                                      {nr.shopeeSubId} (indisponível)
                                    </SelectItem>
                                  )}
                                  {shopeeSubIds.length === 0 ? (
                                    <SelectItem value="_none" disabled>
                                      Cadastre um Sub ID em Configurações Shopee
                                    </SelectItem>
                                  ) : (
                                    shopeeSubIds.map((subId) => (
                                      <SelectItem key={subId.id} value={subId.value}>
                                        {subId.value}{subId.isDefault ? " (padrão)" : ""}
                                      </SelectItem>
                                    ))
                                  )}
                                </SelectContent>
                              </Select>
                              <p className="text-xs text-muted-foreground">O Sub ID padrão de Configurações é selecionado automaticamente.</p>
                            </div>

                            {shouldShowMainMessageModelSelector && (
                              <div className="space-y-2.5">
                                <Label className="text-xs">Modelo de mensagem Shopee</Label>
                                <Select value={nr.templateId || "original"} onValueChange={(v) => setNr({ ...nr, templateId: v })}>
                                  <SelectTrigger><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="original">
                                      <span className="flex items-center gap-2">Manter mensagem original</span>
                                    </SelectItem>
                                    {!!nr.templateId && !selectedTemplateInMessageScope && (
                                      <SelectItem value={nr.templateId}>
                                        <span className="flex items-center gap-2">Modelo atual (indisponível)</span>
                                      </SelectItem>
                                    )}
                                    {messageTemplates.map((t) => (
                                      <SelectItem key={t.id} value={t.id}>
                                        <span className="flex items-center gap-2">Modelo {t.name}</span>
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <div className="flex items-start gap-2 rounded-md bg-muted/70 px-2.5 py-2">
                                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <p className="text-xs text-muted-foreground">
                                    Com "Manter mensagem original", apenas os links da Shopee são convertidos.
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card className="glass border-border/60">
                      <CardContent className="p-0">
                        <div className="flex items-start justify-between gap-4 px-4 py-3">
                          <div className="space-y-1 pr-3">
                            <div className="flex items-center gap-2">
                              <Label className="text-sm font-medium">Mercado Livre</Label>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                                  nr.autoConvertMercadoLivre ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                                )}
                              >
                                {nr.autoConvertMercadoLivre ? "Ativo" : "Desativado"}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground">Converte links do Mercado Livre para seu afiliado.</p>
                          </div>
                          <Switch
                            checked={nr.autoConvertMercadoLivre}
                            onCheckedChange={(checked) => {
                              setNr((prev) => ({
                                ...prev,
                                autoConvertMercadoLivre: checked,
                                meliTemplateId: checked ? prev.meliTemplateId : "",
                              }));
                            }}
                          />
                        </div>

                        {nr.autoConvertMercadoLivre && (
                          <div className="space-y-3 border-t border-border/50 px-4 py-4">
                            {!hasAvailableMeliSession && (
                              <p className="rounded-lg border border-warning/20 bg-warning/10 p-2 text-xs text-warning">
                                Nenhuma sessão Mercado Livre no momento. Conecte uma sessão para usar a conversão.
                              </p>
                            )}
                            <div className="space-y-2.5">
                              <Label className="text-xs">Modelo de mensagem Mercado Livre</Label>
                              <Select value={nr.meliTemplateId || "original"} onValueChange={(v) => setNr({ ...nr, meliTemplateId: v })}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="original">
                                    <span className="flex items-center gap-2">Manter mensagem original</span>
                                  </SelectItem>
                                  {!!nr.meliTemplateId && !selectedMeliTemplateInMessageScope && (
                                    <SelectItem value={nr.meliTemplateId}>
                                      <span className="flex items-center gap-2">Modelo atual (indisponível)</span>
                                    </SelectItem>
                                  )}
                                  {messageTemplates.map((t) => (
                                    <SelectItem key={t.id} value={t.id}>
                                      <span className="flex items-center gap-2">Modelo {t.name}</span>
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <div className="flex items-start gap-2 rounded-md bg-muted/70 px-2.5 py-2">
                                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <p className="text-xs text-muted-foreground">
                                  Com "Manter mensagem original", somente links do Mercado Livre são convertidos.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card className="glass border-border/60">
                      <CardContent className="p-0">
                        <div className="flex items-start justify-between gap-4 px-4 py-3">
                          <div className="space-y-1 pr-3">
                            <div className="flex items-center gap-2">
                              <Label className="text-sm font-medium">Amazon</Label>
                              <span
                                className={cn(
                                  "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                                  nr.autoConvertAmazon ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                                )}
                              >
                                {nr.autoConvertAmazon ? "Ativo" : "Desativado"}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground">Converte links da Amazon para seu afiliado.</p>
                          </div>
                          <Switch
                            checked={nr.autoConvertAmazon}
                            onCheckedChange={(checked) => {
                              setNr((prev) => ({
                                ...prev,
                                autoConvertAmazon: checked,
                                amazonTemplateId: checked ? prev.amazonTemplateId : "",
                              }));
                            }}
                          />
                        </div>

                        {nr.autoConvertAmazon && (
                          <div className="space-y-2.5 border-t border-border/50 px-4 py-4">
                            <Label className="text-xs">Modelo de mensagem Amazon</Label>
                            <Select value={nr.amazonTemplateId || "original"} onValueChange={(v) => setNr({ ...nr, amazonTemplateId: v })}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="original">
                                  <span className="flex items-center gap-2">Manter mensagem original</span>
                                </SelectItem>
                                {!!nr.amazonTemplateId && !selectedAmazonTemplateInMessageScope && (
                                  <SelectItem value={nr.amazonTemplateId}>
                                    <span className="flex items-center gap-2">Modelo atual (indisponível)</span>
                                  </SelectItem>
                                )}
                                {messageTemplates.map((t) => (
                                  <SelectItem key={t.id} value={t.id}>
                                    <span className="flex items-center gap-2">Modelo {t.name}</span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <div className="flex items-start gap-2 rounded-md bg-muted/70 px-2.5 py-2">
                              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <p className="text-xs text-muted-foreground">
                                Com "Manter mensagem original", somente links da Amazon são convertidos.
                              </p>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  <Card className="glass border-border/60">
                    <CardContent className="space-y-4 p-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Filter className="h-4 w-4 text-primary" />
                          <Label className="text-sm font-semibold">Filtros de palavras-chave</Label>
                        </div>
                        <p className="text-xs text-muted-foreground">Opcional: deixe em branco para encaminhar todas as ofertas.</p>
                      </div>

                      <div className="grid gap-4 min-[560px]:grid-cols-2">
                        <div className="space-y-2">
                          <Label className="flex items-center gap-1.5 text-xs">
                            <span className="inline-block h-2 w-2 rounded-full bg-success" />
                            Palavras positivas
                          </Label>
                          <Textarea
                            rows={2}
                            placeholder="iPhone, Samsung, notebook"
                            value={nr.positiveKeywords}
                            onChange={(e) => setNr({ ...nr, positiveKeywords: e.target.value })}
                          />
                          <p className="text-xs text-muted-foreground">
                            Separe por vírgula. Só passa se existir ao menos uma palavra positiva.
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label className="flex items-center gap-1.5 text-xs">
                            <span className="inline-block h-2 w-2 rounded-full bg-destructive" />
                            Palavras negativas
                          </Label>
                          <Textarea
                            rows={2}
                            placeholder="spam, bug, teste"
                            value={nr.negativeKeywords}
                            onChange={(e) => setNr({ ...nr, negativeKeywords: e.target.value })}
                          />
                          <p className="text-xs text-muted-foreground">
                            Separe por vírgula. Se houver uma palavra negativa, a mensagem é descartada.
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="glass border-border/60">
                    <CardContent className="space-y-4 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1 pr-3">
                          <Label className="text-sm font-semibold">Janela de envio</Label>
                          <p className="text-xs text-muted-foreground">
                            Segura disparos fora do horário permitido e retoma automaticamente no próximo horário liberado.
                          </p>
                        </div>
                        <Switch
                          checked={nr.quietHoursEnabled}
                          onCheckedChange={(checked) => {
                            setNr((prev) => ({
                              ...prev,
                              quietHoursEnabled: checked,
                            }));
                          }}
                        />
                      </div>

                      {nr.quietHoursEnabled && (
                        <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">Não enviar mensagens automáticas entre os horários abaixo.</p>
                          <div className="grid gap-3 min-[430px]:grid-cols-2">
                            <div className="space-y-1.5">
                              <Label className="text-xs">Início do bloqueio</Label>
                              <Input
                                type="time"
                                value={nr.quietHoursStart}
                                onChange={(e) => setNr((prev) => ({ ...prev, quietHoursStart: e.target.value || "22:00" }))}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">Fim do bloqueio</Label>
                              <Input
                                type="time"
                                value={nr.quietHoursEnd}
                                onChange={(e) => setNr((prev) => ({ ...prev, quietHoursEnd: e.target.value || "08:00" }))}
                              />
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">Exemplo: 22:00-08:00 pausa os envios durante a madrugada.</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>

            {/* Footer */}
            <DialogFooter className="border-t bg-card px-4 py-3 sm:px-6 sm:py-4">
              {step < totalSteps ? (
                <Button className="max-sm:w-full" onClick={() => setStep(step + 1)} disabled={step === 1 ? !canGoStep2 : !canGoStep3}>
                  Próximo
                </Button>
              ) : (
                <Button className="max-sm:w-full" onClick={handleCreateRoute} disabled={!canCreate}>
                  {isEditing ? "Salvar" : "Criar rota"}
                </Button>
              )}
              {step > 1 ? (
                <Button className="max-sm:w-full" variant="ghost" onClick={() => setStep(step - 1)}>Voltar</Button>
              ) : (
                <Button className="max-sm:w-full" variant="ghost" onClick={closeNew}>Cancelar</Button>
              )}
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
