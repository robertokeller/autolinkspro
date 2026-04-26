import { useMemo } from "react";
import {
  Bot,
  Calendar,
  LinkIcon,
  MessageSquare,
  Route,
  Search,
  ShieldAlert,
  ShoppingBag,
  ShoppingCart,
  Tag,
} from "lucide-react";
import { startOfDay, subDays } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { TelegramIcon, WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";
import { useAccessControl } from "@/hooks/useAccessControl";
import { useAgendamentos } from "@/hooks/useAgendamentos";
import { useGrupos } from "@/hooks/useGrupos";
import { useHistorico } from "@/hooks/useHistorico";
import { useLinkHub } from "@/hooks/useLinkHub";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { useRotas } from "@/hooks/useRotas";
import { useSessoes } from "@/hooks/useSessoes";
import { useShopeeAutomacoes } from "@/hooks/useShopeeAutomacoes";
import { useShopeeCredentials } from "@/hooks/useShopeeCredentials";
import { useServiceHealth } from "@/hooks/useServiceHealth";
import { useViewportProfile } from "@/hooks/useViewportProfile";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import { resolveEffectiveOperationalLimitsByPlanId, type AppFeature } from "@/lib/access-control";
import { getAllChannelHealth } from "@/lib/channel-central";
import { ROUTES } from "@/lib/routes";
import { nowBRT } from "@/lib/timezone";
import { Link } from "react-router-dom";
import {
  DashboardHealthCards,
  DashboardMetricCards,
  DashboardQuickActions,
  DashboardRecentActivity,
  DashboardRiskAlerts,
  DashboardUsageCard,
  type ChartRow,
  type HealthBadgeTone,
  type HealthCardViewModel,
  type MetricCard,
  type QuickActionCard,
  type RecentActivityItem,
  type RiskAlertItem,
  type UsageSummary,
} from "@/features/dashboard/DashboardSections";

const DAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
const CHANNEL_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const DASHBOARD_USAGE_CHART_INTERVAL_MS = 60 * 1000;
const DASHBOARD_SEND_TYPES = ["automation_run", "route_forward", "schedule_sent"] as const;
const DASHBOARD_CHART_PAGE_SIZE = 250;
const DASHBOARD_CHART_MAX_PAGES = 8;

function ptCount(value: number, singular: string, plural: string): string {
  if (!Number.isFinite(value)) return `0 ${plural}`;
  return `${value} ${value === 1 ? singular : plural}`;
}

export default function Dashboard() {
  const viewport = useViewportProfile();
  const compactDashboard = viewport.isMobile || (viewport.isTablet && viewport.orientation === "portrait");
  const { user } = useAuth();
  const { canAccess, getFeaturePolicy, isCheckingAccess, planId, planExpiresAt, isPlanExpired } = useAccessControl();
  const { entries, isLoading: histLoading } = useHistorico();
  const { waSessions, tgSessions, isLoading: sessLoading } = useSessoes();
  const { sessions: meliSessions, isLoading: meliLoading } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const { isConfigured: shopeeConfigured } = useShopeeCredentials();
  const { routes, isLoading: routesLoading } = useRotas();
  const { syncedGroups: groups, isLoading: groupsLoading } = useGrupos();
  const { posts, isLoading: postsLoading } = useAgendamentos();
  const { pages: linkHubPages, isLoading: linkHubLoading } = useLinkHub();
  const { automations, isLoading: automationsLoading } = useShopeeAutomacoes();
  const { data: channelHealth, isLoading: channelHealthLoading } = useQuery({
    queryKey: ["channel-health", user?.id, "dashboard"],
    queryFn: getAllChannelHealth,
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? CHANNEL_HEALTH_INTERVAL_MS : false),
    staleTime: CHANNEL_HEALTH_INTERVAL_MS,
  });
  const {
    data: confirmedSendsChartData,
    isLoading: confirmedSendsChartLoading,
    isError: confirmedSendsChartError,
  } = useQuery({
    queryKey: ["dashboard-confirmed-sends-chart", user?.id],
    enabled: Boolean(user?.id),
    staleTime: DASHBOARD_USAGE_CHART_INTERVAL_MS,
    refetchInterval: () => (document.visibilityState === "visible" ? DASHBOARD_USAGE_CHART_INTERVAL_MS : false),
    queryFn: async (): Promise<ChartRow[]> => {
      if (!user?.id) return [];
      const now = new Date();
      const dayBuckets = Array.from({ length: 7 }, (_, index) => {
        const date = subDays(now, 6 - index);
        const dayStart = startOfDay(date);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        return {
          day: DAY_LABELS[date.getDay()],
          dayStart,
          dayEnd,
          automacoes: 0,
          rotas: 0,
          agendamentos: 0,
        };
      });

      type HistoryChartRow = {
        id: string;
        type: string;
        created_at: string;
        processing_status: string;
        details: unknown;
      };

      const extractSentCount = (row: HistoryChartRow): number => {
        const details = row.details && typeof row.details === "object" && !Array.isArray(row.details)
          ? row.details as Record<string, unknown>
          : null;
        const targetSummary = details?.targetSummary && typeof details.targetSummary === "object" && !Array.isArray(details.targetSummary)
          ? details.targetSummary as Record<string, unknown>
          : null;
        const summarySent = targetSummary?.sent;
        const sentTargets = typeof summarySent === "number"
          ? summarySent
          : typeof summarySent === "string" && summarySent.trim()
            ? Number(summarySent)
            : Number.NaN;

        if (Number.isFinite(sentTargets) && sentTargets > 0) {
          return Math.floor(sentTargets);
        }

        return String(row.processing_status || "").toLowerCase() === "sent" ? 1 : 0;
      };

      const windowStartIso = dayBuckets[0]?.dayStart.toISOString() || new Date(0).toISOString();
      let cursor: { created_at: string; id: string } | null = null;

      for (let page = 0; page < DASHBOARD_CHART_MAX_PAGES; page++) {
        let query = backend
          .from("history_entries")
          .select("id,type,created_at,processing_status,details")
          .eq("user_id", user.id)
          .in("type", [...DASHBOARD_SEND_TYPES])
          .in("processing_status", ["sent", "blocked", "failed", "error", "processed", "skipped"])
          .gte("created_at", windowStartIso)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(DASHBOARD_CHART_PAGE_SIZE);

        if (cursor) {
          query = query.cursor(cursor);
        }

        const { data, error, next_cursor } = await query;
        if (error) throw error;

        const batch = (data || []) as HistoryChartRow[];
        if (batch.length === 0) break;

        for (const row of batch) {
          const createdAt = new Date(row.created_at);
          if (Number.isNaN(createdAt.getTime())) continue;

          const sentCount = extractSentCount(row);
          if (sentCount <= 0) continue;

          const bucket = dayBuckets.find((item) => createdAt >= item.dayStart && createdAt < item.dayEnd);
          if (!bucket) continue;

          if (row.type === "automation_run") bucket.automacoes += sentCount;
          if (row.type === "route_forward") bucket.rotas += sentCount;
          if (row.type === "schedule_sent") bucket.agendamentos += sentCount;
        }

        if (!next_cursor || batch.length < DASHBOARD_CHART_PAGE_SIZE) break;
        cursor = next_cursor;
      }

      return dayBuckets.map((bucket) => ({
        day: bucket.day,
        totalEnvios: bucket.automacoes + bucket.rotas + bucket.agendamentos,
        automacoes: bucket.automacoes,
        rotas: bucket.rotas,
        agendamentos: bucket.agendamentos,
      }));
    },
  });
  const {
    data: sendsKpis24h,
    isLoading: sendsKpis24hLoading,
    isError: sendsKpis24hError,
  } = useQuery({
    queryKey: ["dashboard-sends-kpis-24h", user?.id],
    enabled: Boolean(user?.id),
    staleTime: DASHBOARD_USAGE_CHART_INTERVAL_MS,
    refetchInterval: () => (document.visibilityState === "visible" ? DASHBOARD_USAGE_CHART_INTERVAL_MS : false),
    queryFn: async (): Promise<{ operations24h: number; success24h: number; errors24h: number; blocked24h: number }> => {
      if (!user?.id) {
        return {
          operations24h: 0,
          success24h: 0,
          errors24h: 0,
          blocked24h: 0,
        };
      }

      const since24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const countEntries = async (processingStatuses?: string[]) => {
        let query = backend
          .from("history_entries")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .in("type", [...DASHBOARD_SEND_TYPES])
          .gte("created_at", since24hIso);

        if (Array.isArray(processingStatuses) && processingStatuses.length > 0) {
          if (processingStatuses.length === 1) {
            query = query.eq("processing_status", processingStatuses[0]);
          } else {
            query = query.in("processing_status", processingStatuses);
          }
        }

        const { count, error } = await query;
        if (error) throw error;
        return Math.max(0, count || 0);
      };

      const [operations24h, success24h, errors24h, blocked24h] = await Promise.all([
        countEntries(),
        countEntries(["sent"]),
        countEntries(["error", "failed"]),
        countEntries(["blocked"]),
      ]);

      return {
        operations24h,
        success24h,
        errors24h,
        blocked24h,
      };
    },
  });
  const { health: shopeeHealth, isLoading: shopeeHealthLoading } = useServiceHealth("shopee");
  const { health: meliHealth, isLoading: meliHealthLoading } = useServiceHealth("meli");
  const { health: amazonHealth, isLoading: amazonHealthLoading } = useServiceHealth("amazon");

  const automationList = useMemo(
    () => (Array.isArray(automations)
      ? (automations as Array<{ is_active?: boolean | null }>)
      : []),
    [automations],
  );

  const analytics = useMemo(() => {
    const now = new Date();
    const last24h = subDays(now, 1);
    const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const finalProcessingStates = new Set(["sent", "blocked", "failed", "error", "processed", "skipped"]);
    const realEntries = entries.filter((entry) => finalProcessingStates.has(String(entry.processingStatus || entry.status || "").toLowerCase()));
    const entries24h = realEntries.filter((entry) => new Date(entry.date) >= last24h);

    const fallbackOperations24h = entries24h.length;
    const fallbackSuccess24h = entries24h.filter((entry) => entry.status === "success" || entry.processingStatus === "sent").length;
    const fallbackErrors24h = entries24h.filter((entry) => entry.status === "error" || entry.processingStatus === "failed").length;
    const fallbackBlocked24h = entries24h.filter((entry) => entry.processingStatus === "blocked").length;

    const operations24h = sendsKpis24h?.operations24h ?? (sendsKpis24hError ? fallbackOperations24h : 0);
    const success24h = sendsKpis24h?.success24h ?? (sendsKpis24hError ? fallbackSuccess24h : 0);
    const errors24h = sendsKpis24h?.errors24h ?? (sendsKpis24hError ? fallbackErrors24h : 0);
    const blocked24h = sendsKpis24h?.blocked24h ?? (sendsKpis24hError ? fallbackBlocked24h : 0);

    const routeActive = routes.filter((route) => route.status === "active").length;
    const routePaused = routes.filter((route) => route.status === "paused").length;
    const routeError = routes.filter((route) => route.status === "error").length;

    const pendingPosts = posts.filter((post) => post.status === "pending");
    const overduePosts = pendingPosts.filter((post) => new Date(post.scheduledAt) < now).length;
    const dueNext24h = pendingPosts.filter((post) => {
      const scheduledAt = new Date(post.scheduledAt);
      return scheduledAt >= now && scheduledAt <= next24h;
    }).length;

    const activeAutomations = automationList.filter((item) => item.is_active).length;
    const activeLinkHubPages = linkHubPages.filter((item) => item.isActive).length;
    const meliActive = meliSessions.filter((session) => session.status === "active").length;
    const meliDisconnected = meliSessions.filter((session) => ["expired", "error", "not_found"].includes(session.status)).length;

    return {
      operations24h,
      success24h,
      errors24h,
      blocked24h,
      routeActive,
      routePaused,
      routeError,
      pendingSchedules: pendingPosts.length,
      overduePosts,
      dueNext24h,
      activeAutomations,
      activeLinkHubPages,
      meliActive,
      meliDisconnected,
    };
  }, [automationList, entries, linkHubPages, meliSessions, posts, routes, sendsKpis24h, sendsKpis24hError]);

  const effectiveOperationalLimits = useMemo(
    () => (planId ? resolveEffectiveOperationalLimitsByPlanId(planId) : null),
    [planId],
  );

  const fallbackChartData = useMemo<ChartRow[]>(() => {
    const sentEntries = entries.filter((entry) => entry.processingStatus === "sent");
    const now = new Date();

    return Array.from({ length: 7 }).map((_, i) => {
      const date = subDays(now, 6 - i);
      const dayStart = startOfDay(date);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const dayEntries = sentEntries.filter((entry) => {
        const createdAt = new Date(entry.date);
        return createdAt >= dayStart && createdAt < dayEnd;
      });

      const automacoes = dayEntries.filter((entry) => entry.type === "automation_run").length;
      const rotas = dayEntries.filter((entry) => entry.type === "route_forward").length;
      const agendamentos = dayEntries.filter((entry) => entry.type === "schedule_sent").length;

      return {
        day: DAY_LABELS[date.getDay()],
        totalEnvios: automacoes + rotas + agendamentos,
        automacoes,
        rotas,
        agendamentos,
      };
    });
  }, [entries]);

  const chartData = useMemo<ChartRow[]>(
    () => confirmedSendsChartData || (confirmedSendsChartError ? fallbackChartData : []),
    [confirmedSendsChartData, confirmedSendsChartError, fallbackChartData],
  );

  const usage7d = useMemo<UsageSummary>(
    () => chartData.reduce(
      (acc, row) => ({
        totalEnvios: acc.totalEnvios + row.totalEnvios,
        automacoes: acc.automacoes + row.automacoes,
        rotas: acc.rotas + row.rotas,
        agendamentos: acc.agendamentos + row.agendamentos,
      }),
      { totalEnvios: 0, automacoes: 0, rotas: 0, agendamentos: 0 },
    ),
    [chartData],
  );

  const recentActivity = useMemo<RecentActivityItem[]>(() => {
    const firstText = (...values: unknown[]) => {
      for (const value of values) {
        if (typeof value !== "string") continue;
        const normalized = value.trim();
        if (normalized) return normalized;
      }
      return "";
    };

    const parseDateMs = (value: unknown) => {
      if (typeof value !== "string") return Number.NaN;
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) || parsed <= 0 ? Number.NaN : parsed;
    };

    const normalizeTimeToken = (entry: typeof entries[number]) => {
      const dateMs = parseDateMs((entry as { date?: unknown }).date) || parseDateMs((entry as { createdAt?: unknown }).createdAt);

      if (Number.isFinite(dateMs)) {
        const mins = Math.max(0, Math.round((Date.now() - dateMs) / 60000));
        if (mins < 1) return "agora";
        if (mins < 60) return `${mins}min`;
        if (mins < 1440) return `${Math.round(mins / 60)}h`;
        return `${Math.round(mins / 1440)}d`;
      }

      const rawTimeAgo = firstText((entry as { timeAgo?: unknown }).timeAgo).toLowerCase();
      if (rawTimeAgo === "agora") return "agora";
      const cleanedTimeAgo = rawTimeAgo.replace(/\s+atr[aá]s$/, "").trim();
      return cleanedTimeAgo || "-";
    };

    return entries.slice(0, 6).map((entry) => {
      const details = entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)
        ? entry.details
        : {};

      const detailsMessage = firstText(entry.message, details.message, details.text, details.summary);
      const sourceLabel = firstText(
        entry.automationName,
        (entry as { source?: unknown }).source,
        "Evento",
      );
      const destinationLabel = firstText(
        entry.destination,
        details.destination,
        details.target,
        typeof entry.targetSummary?.total === "number" && entry.targetSummary.total > 0
          ? ptCount(entry.targetSummary.total, "destino", "destinos")
          : "",
        "-",
      );

      const normalizedStatus = entry.processingStatus === "failed" || entry.processingStatus === "error"
        ? "error"
        : entry.processingStatus === "sent"
          ? "success"
          : entry.processingStatus === "blocked"
            ? "warning"
            : entry.status === "error"
              ? "error"
              : entry.status === "success"
                ? "success"
                : "info";

      const typeIcon = entry.type === "link_converted"
        ? LinkIcon
        : entry.type === "route_forward"
          ? Route
          : entry.type === "schedule_sent"
            ? Calendar
            : MessageSquare;

      const typeColor = normalizedStatus === "error"
        ? "text-destructive"
        : normalizedStatus === "warning"
          ? "text-warning"
        : entry.type === "link_converted"
          ? "text-primary"
          : entry.type === "route_forward"
            ? "text-info"
            : entry.type === "schedule_sent"
              ? "text-warning"
              : "text-success";

      return {
        text: detailsMessage || `${sourceLabel} -> ${destinationLabel}`,
        time: normalizeTimeToken(entry),
        status: normalizedStatus,
        Icon: typeIcon,
        color: typeColor,
      };
    });
  }, [entries]);

  const waOnline = waSessions.filter((session) => session.status === "online").length;
  const waConnecting = waSessions.filter((session) => session.status === "connecting" || session.status === "qr_code" || session.status === "pairing_code" || session.status === "awaiting_code" || session.status === "awaiting_password").length;
  const tgOnline = tgSessions.filter((session) => session.status === "online").length;
  const tgConnecting = tgSessions.filter((session) => session.status === "connecting" || session.status === "qr_code" || session.status === "awaiting_code" || session.status === "awaiting_password").length;
  const totalSessions = waSessions.length + tgSessions.length;

  const waServiceOnline = channelHealth?.whatsapp.online === true;
  const tgServiceOnline = channelHealth?.telegram.online === true;
  const shopeeServiceOnline = shopeeHealth?.online === true;
  const meliServiceOnline = meliHealth?.online === true;
  const amazonServiceOnline = amazonHealth?.serviceOnline === true;
  const amazonTagConfigured = amazonHealth?.tagConfigured === true;
  const amazonFullyOnline = amazonHealth?.online === true;

  const sanitizeError = (value: string | null | undefined) => {
    if (!value) return null;
    const normalized = value.trim();
    if (!normalized) return null;
    return normalized.length > 90 ? `${normalized.slice(0, 90)}...` : normalized;
  };

  const metricCards = useMemo<MetricCard[]>(() => [
    {
      label: "Envios processados (24h)",
      value: String(analytics.operations24h),
      help: `${analytics.success24h} OK • ${ptCount(analytics.errors24h, "erro", "erros")}`,
      icon: MessageSquare,
      accent: "primary",
    },
    {
      label: "Envios bloqueados (24h)",
      value: String(analytics.blocked24h),
      help: "Bloqueios por filtros, regras e validações",
      icon: ShieldAlert,
      accent: analytics.blocked24h > 0 ? "warning" : "success",
    },
    {
      label: "Rotas ativas",
      value: String(analytics.routeActive),
      help: `${ptCount(analytics.routePaused, "rota pausada", "rotas pausadas")} • ${ptCount(analytics.routeError, "rota com erro", "rotas com erro")}`,
      icon: Route,
      accent: analytics.routeError > 0 ? "warning" : "success",
    },
    {
      label: "Agendamentos pendentes",
      value: String(analytics.pendingSchedules),
      help: `${ptCount(analytics.dueNext24h, "agendamento nas próximas 24h", "agendamentos nas próximas 24h")} • ${ptCount(analytics.overduePosts, "agendamento atrasado", "agendamentos atrasados")}`,
      icon: Calendar,
      accent: "warning",
    },
    {
      label: "Automações Shopee ativas",
      value: String(analytics.activeAutomations),
      help: ptCount(automationList.length, "automação Shopee criada no total", "automações Shopee criadas no total"),
      icon: Bot,
      accent: analytics.activeAutomations > 0 ? "success" : "info",
    },
  ], [analytics, automationList.length]);

  const isLoading = histLoading || sessLoading || routesLoading || groupsLoading || postsLoading || linkHubLoading || automationsLoading || meliLoading;
  const isHealthLoading = channelHealthLoading || shopeeHealthLoading || meliHealthLoading || amazonHealthLoading || isCheckingAccess;
  const isUsageChartLoading = isLoading || (confirmedSendsChartLoading && !confirmedSendsChartData && !confirmedSendsChartError);
  const isMetricCardsLoading = isLoading || (sendsKpis24hLoading && !sendsKpis24h && !sendsKpis24hError);

  const quickActions = useMemo<QuickActionCard[]>(() => {
    const buildFeatureAction = (
      feature: AppFeature,
      action: Omit<QuickActionCard, "locked" | "ctaLabel">,
      unlockBenefit: string,
    ): QuickActionCard => {
      if (canAccess(feature)) return action;
      const policy = getFeaturePolicy(feature);
      const blockedMessage = sanitizeError(policy.blockedMessage) || "Disponível em plano com mais capacidade.";
      return {
        ...action,
        href: ROUTES.app.account,
        accent: "warning",
        locked: true,
        ctaLabel: "Liberar agora",
        desc: `${unlockBenefit}. ${blockedMessage}`,
      };
    };

    return [
      {
        label: "Converter link",
        desc: shopeeConfigured ? "Shopee pronto para conversão" : "Preencha suas credenciais da Shopee",
        icon: LinkIcon,
        href: ROUTES.app.shopeeConversor,
        accent: "primary",
      },
      {
        label: "Pesquisar ofertas",
        desc: "Encontre produtos para divulgar agora",
        icon: Search,
        href: ROUTES.app.shopeePesquisa,
        accent: "success",
      },
      buildFeatureAction(
        "linkHub",
        {
          label: "Gerenciar Link Hub",
          desc: ptCount(analytics.activeLinkHubPages, "página ativa", "páginas ativas"),
          icon: LinkIcon,
          href: ROUTES.app.linkHub,
          accent: "info",
        },
        "Crie uma central de links ativa para seus grupos",
      ),
      buildFeatureAction(
        "routes",
        {
          label: "Criar rota",
          desc: ptCount(analytics.routeActive, "rota ativa", "rotas ativas"),
          icon: Route,
          href: ROUTES.app.routes,
          accent: "info",
        },
        "Libere automação de repasse entre grupos",
      ),
      buildFeatureAction(
        "schedules",
        {
          label: "Agendar post",
          desc: ptCount(analytics.pendingSchedules, "agendamento na fila", "agendamentos na fila"),
          icon: Calendar,
          href: ROUTES.app.schedules,
          accent: "warning",
        },
        "Ganhe consistência com calendário automático",
      ),
    ];
  }, [analytics.activeLinkHubPages, analytics.pendingSchedules, analytics.routeActive, canAccess, getFeaturePolicy, shopeeConfigured]);

  const riskAlerts = useMemo<RiskAlertItem[]>(() => {
    const alerts: RiskAlertItem[] = [];

    const planExpiryMs = planExpiresAt ? Date.parse(planExpiresAt) : Number.NaN;
    const msToExpiry = Number.isFinite(planExpiryMs) ? planExpiryMs - Date.now() : Number.NaN;
    const daysToExpiry = Number.isFinite(msToExpiry) ? Math.ceil(msToExpiry / (1000 * 60 * 60 * 24)) : Number.NaN;

    if (isPlanExpired) {
      alerts.push({
        id: "plan-expired",
        title: "Plano expirado",
        description: "Alguns recursos ficam bloqueados até renovação.",
        impact: "Automações, rotas e agendamentos estão bloqueados",
        actionWindow: "agora",
        href: ROUTES.app.account,
        cta: "Renovar agora",
        accent: "destructive",
      });
    } else if (Number.isFinite(daysToExpiry) && daysToExpiry <= 3) {
      alerts.push({
        id: "plan-expiring",
        title: "Plano vencendo",
        description: daysToExpiry <= 0 ? "Vence hoje." : `Vence em ${ptCount(daysToExpiry, "dia", "dias")}.`,
        impact: daysToExpiry <= 0 ? "Renovação vence nas próximas horas" : ptCount(daysToExpiry, "dia restante no ciclo", "dias restantes no ciclo"),
        actionWindow: daysToExpiry <= 1 ? "hoje" : "até 72h",
        href: ROUTES.app.account,
        cta: "Evitar bloqueio",
        accent: "warning",
      });
    }

    if (!shopeeConfigured) {
      alerts.push({
        id: "shopee-not-configured",
        title: "Shopee sem credenciais",
        description: "Conversões e automações podem falhar sem autenticação da API.",
        impact: "Shopee sem integração ativa",
        actionWindow: "antes do próximo envio",
        href: ROUTES.app.shopeeConfiguracoes,
        cta: "Configurar Shopee",
        accent: "warning",
      });
    }

    if (waSessions.length > 0 && (!waServiceOnline || waOnline === 0)) {
      alerts.push({
        id: "wa-offline",
        title: "Sessão crítica offline",
        description: "WhatsApp sem sessão online pode interromper sua operação.",
        impact: `${waOnline}/${waSessions.length} ${waOnline === 1 ? "sessão online" : "sessões online"}`,
        actionWindow: "agora",
        href: ROUTES.app.connectionsWhatsApp,
        cta: "Revisar sessões",
        accent: "destructive",
      });
    }

    if (analytics.overduePosts > 0) {
      alerts.push({
        id: "overdue-posts",
        title: "Agendamentos atrasados",
        description: `${ptCount(analytics.overduePosts, "agendamento está atrasado", "agendamentos estão atrasados")} em relação ao horário previsto de envio.`,
        impact: ptCount(analytics.overduePosts, "envio fora do horário", "envios fora do horário"),
        actionWindow: analytics.overduePosts >= 5 ? "agora" : "hoje",
        href: ROUTES.app.schedules,
        cta: "Corrigir agenda",
        accent: "warning",
      });
    }

    if (meliSessions.length > 0 && analytics.meliDisconnected > 0) {
      const allDisconnected = analytics.meliDisconnected >= meliSessions.length;
      alerts.push({
        id: "meli-disconnected",
        title: "Sessões ML com falha",
        description: `${analytics.meliDisconnected}/${meliSessions.length} ${analytics.meliDisconnected === 1 ? "sessão desconectada ou com erro" : "sessões desconectadas ou com erro"}.`,
        impact: ptCount(analytics.meliDisconnected, "sessão com falha ativa", "sessões com falha ativa"),
        actionWindow: allDisconnected ? "agora" : "hoje",
        href: ROUTES.app.mercadolivreConfiguracoes,
        cta: "Revisar Mercado Livre",
        accent: allDisconnected ? "destructive" : "warning",
      });
    }

    const usageSignals = ([
      {
        id: "routes-limit",
        label: "rotas",
        used: usageCountsOrNull(analytics.routeActive),
        limit: effectiveOperationalLimits?.routes,
        href: ROUTES.app.routes,
      },
      {
        id: "schedules-limit",
        label: "agendamentos",
        used: usageCountsOrNull(analytics.pendingSchedules),
        limit: effectiveOperationalLimits?.schedules,
        href: ROUTES.app.schedules,
      },
      {
        id: "automations-limit",
        label: "automações",
        used: usageCountsOrNull(analytics.activeAutomations),
        limit: effectiveOperationalLimits?.automations,
        href: ROUTES.app.shopeeAutomacoes,
      },
    ]
      .map((item) => {
        if (!Number.isFinite(item.limit ?? Number.NaN) || item.limit == null || item.limit <= 0 || item.limit === -1) {
          return null;
        }
        const ratio = (item.used / item.limit) * 100;
        if (ratio < 80) return null;
        return {
          ...item,
          ratio,
        };
      })
      .filter(Boolean) as Array<{ id: string; label: string; used: number; limit: number; href: string; ratio: number }> )
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 2);

    for (const signal of usageSignals) {
      alerts.push({
        id: signal.id,
        title: `Limite quase no teto: ${signal.label}`,
        description: `${signal.used}/${signal.limit} (${Math.round(signal.ratio)}%) em uso.`,
        impact: `${signal.used}/${signal.limit} capacidade utilizada`,
        actionWindow: signal.ratio >= 95 ? "agora" : "monitorar hoje",
        href: signal.href,
        cta: "Ajustar agora",
        accent: "warning",
      });
    }

    return alerts.slice(0, 4);
  }, [analytics.activeAutomations, analytics.meliDisconnected, analytics.overduePosts, analytics.pendingSchedules, analytics.routeActive, effectiveOperationalLimits?.automations, effectiveOperationalLimits?.routes, effectiveOperationalLimits?.schedules, isPlanExpired, meliSessions.length, planExpiresAt, shopeeConfigured, waOnline, waServiceOnline, waSessions.length]);

  function usageCountsOrNull(value: number) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  const waError = sanitizeError(channelHealth?.whatsapp.error);
  const tgError = sanitizeError(channelHealth?.telegram.error);
  const shopeeError = sanitizeError(shopeeHealth?.error);
  const meliError = sanitizeError(meliHealth?.error);
  const amazonError = sanitizeError(amazonHealth?.error);

  const healthCards = useMemo<readonly HealthCardViewModel[]>(() => [
    {
      id: "wa",
      title: "WhatsApp",
      details:
        waSessions.length === 0
          ? "Nenhuma sessão"
          : !waServiceOnline
            ? waError || `${waOnline}/${waSessions.length} sessões conectadas`
            : waConnecting > 0
              ? `${waOnline}/${waSessions.length} online • ${waConnecting} autenticando`
              : `${waOnline}/${waSessions.length} sessões conectadas`,
      statusText: waSessions.length === 0 ? "Não configurado" : !waServiceOnline ? "Erro no serviço" : waOnline === waSessions.length ? "Online" : waConnecting > 0 && waOnline === 0 ? "Conectando" : waOnline === 0 ? "Offline" : "Parcial",
      statusTone: waSessions.length === 0 ? "muted" : !waServiceOnline ? "destructive" : waOnline === waSessions.length ? "success" : waOnline === 0 && waConnecting === 0 ? "destructive" : "warning",
      icon: WhatsAppIcon,
      iconColorClass: "text-brand-whatsapp",
      iconBgClass: "bg-brand-whatsapp/10",
    },
    {
      id: "tg",
      title: "Telegram",
      details:
        tgSessions.length === 0
          ? "Nenhuma sessão"
          : !tgServiceOnline
            ? tgError || `${tgOnline}/${tgSessions.length} sessões conectadas`
            : tgConnecting > 0
              ? `${tgOnline}/${tgSessions.length} online • ${tgConnecting} autenticando`
              : `${tgOnline}/${tgSessions.length} sessões conectadas`,
      statusText: tgSessions.length === 0 ? "Não configurado" : !tgServiceOnline ? "Erro no serviço" : tgOnline === tgSessions.length ? "Online" : tgConnecting > 0 && tgOnline === 0 ? "Conectando" : tgOnline === 0 ? "Offline" : "Parcial",
      statusTone: tgSessions.length === 0 ? "muted" : !tgServiceOnline ? "destructive" : tgOnline === tgSessions.length ? "success" : tgOnline === 0 && tgConnecting === 0 ? "destructive" : "warning",
      icon: TelegramIcon,
      iconColorClass: "text-brand-telegram",
      iconBgClass: "bg-brand-telegram/10",
    },
    {
      id: "shopee",
      title: "Shopee",
      details: !shopeeConfigured
        ? "Credenciais da API não preenchidas"
        : shopeeServiceOnline
          ? "Tudo certo, serviço funcionando"
          : shopeeError || "Serviço não respondeu",
      statusText: !shopeeConfigured ? "Não configurado" : shopeeServiceOnline ? "Online" : "Offline",
      statusTone: !shopeeConfigured ? "muted" : shopeeServiceOnline ? "success" : "destructive",
      icon: ShoppingBag,
      iconColorClass: "text-primary",
      iconBgClass: "bg-primary/10",
    },
    {
      id: "meli",
      title: "Mercado Livre",
      details: meliSessions.length === 0
        ? "Nenhuma sessão cadastrada"
        : meliServiceOnline
          ? `${analytics.meliActive}/${meliSessions.length} sessões funcionando`
          : meliError || `${analytics.meliActive}/${meliSessions.length} sessões funcionando`,
      statusText: meliSessions.length === 0 ? "Não configurado" : !meliServiceOnline ? "Erro no serviço" : analytics.meliActive >= meliSessions.length && meliSessions.length > 0 ? "Online" : analytics.meliActive === 0 ? "Offline" : "Parcial",
      statusTone: meliSessions.length === 0 ? "muted" : !meliServiceOnline ? "destructive" : analytics.meliActive >= meliSessions.length && meliSessions.length > 0 ? "success" : "warning",
      icon: ShoppingCart,
      iconColorClass: "text-primary",
      iconBgClass: "bg-primary/10",
    },
    {
      id: "amazon",
      title: "Amazon",
      details: !amazonTagConfigured
        ? "Tag de afiliado não configurada"
        : amazonServiceOnline
          ? "Serviço ativo e tag configurada"
          : amazonError || "Serviço Amazon indisponível",
      statusText: !amazonTagConfigured
        ? "Não configurado"
        : amazonFullyOnline
          ? "Online"
          : "Erro no serviço",
      statusTone: !amazonTagConfigured
        ? "muted"
        : amazonFullyOnline
          ? "success"
          : "destructive",
      icon: Tag,
      iconColorClass: "text-warning",
      iconBgClass: "bg-warning/10",
    },
  ], [
    amazonError,
    amazonFullyOnline,
    amazonServiceOnline,
    amazonTagConfigured,
    analytics.meliActive,
    meliError,
    meliServiceOnline,
    meliSessions.length,
    shopeeConfigured,
    shopeeError,
    shopeeServiceOnline,
    tgConnecting,
    tgError,
    tgOnline,
    tgServiceOnline,
    tgSessions.length,
    waConnecting,
    waError,
    waOnline,
    waServiceOnline,
    waSessions.length,
  ]);

  const serviceFeatureAccess = useMemo(() => {
      const resolve = (feature: AppFeature) => {
      if (canAccess(feature)) return { enabled: true, note: "" };
      const policy = getFeaturePolicy(feature);
      const blockedMessage = sanitizeError(policy.blockedMessage);
      if (policy.mode === "hidden") {
        return { enabled: false, note: "Não faz parte do seu plano atual." };
      }
      return {
        enabled: false,
        note: blockedMessage || "Não faz parte do seu plano atual.",
      };
    };

    return {
      tg: resolve("telegramConnections"),
      shopee: resolve("shopeeAutomations"),
      meli: resolve("mercadoLivre"),
      amazon: resolve("amazon"),
    };
  }, [canAccess, getFeaturePolicy]);

  const visibleHealthCards = useMemo<HealthCardViewModel[]>(
    () => healthCards.map((card) => {
      const blockedMap: Partial<Record<HealthCardViewModel["id"], { enabled: boolean; note: string }>> = {
        tg: serviceFeatureAccess.tg,
        shopee: serviceFeatureAccess.shopee,
        meli: serviceFeatureAccess.meli,
        amazon: serviceFeatureAccess.amazon,
      };
      const access = blockedMap[card.id];
      if (!access || access.enabled) return card;
      return {
        ...card,
        details: access.note,
        statusText: "Não incluído no plano",
        statusTone: "muted" as HealthBadgeTone,
      };
    }),
    [healthCards, serviceFeatureAccess],
  );

  return (
    <div className="ds-page pb-[calc(var(--safe-area-bottom)+0.25rem)]">
      <PageHeader title="Painel geral" description={`Resumo do dia • ${nowBRT("EEEE, d 'de' MMMM")}`} />

      <div className="flex flex-col gap-4 sm:gap-5">
        {isPlanExpired && (
          <section className="rounded-2xl border border-destructive/35 bg-destructive/5 p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-destructive">Seu plano venceu e o envio automático foi interrompido</p>
                <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
                  Rotas, automações e agendamentos ficam pausados até a renovação. Escolha um plano para reativar tudo com segurança.
                </p>
              </div>
              <Link
                to={`${ROUTES.app.account}?tab=plano&showPlans=1`}
                className="inline-flex h-9 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90"
              >
                Ver planos e renovar
              </Link>
            </div>
          </section>
        )}

        <div className="ds-card-grid order-1 lg:grid-cols-6">
          <DashboardUsageCard chartData={chartData} compactDashboard={compactDashboard} isLoading={isUsageChartLoading} usage7d={usage7d} />
          <DashboardHealthCards isHealthLoading={isHealthLoading} isLoading={isLoading} visibleHealthCards={visibleHealthCards} />
        </div>

        <DashboardMetricCards compactDashboard={compactDashboard} isLoading={isMetricCardsLoading} metricCards={metricCards} />

        <div className="ds-card-grid order-2 lg:grid-cols-5">
          <DashboardRiskAlerts isLoading={isLoading} alerts={riskAlerts} />
          <DashboardRecentActivity dueNext24h={analytics.dueNext24h} histLoading={histLoading} recentActivity={recentActivity} />
        </div>

        <div className="ds-card-grid order-3 lg:grid-cols-5">
          <DashboardQuickActions isLoading={isLoading} quickActions={quickActions} />
        </div>
      </div>
    </div>
  );
}
