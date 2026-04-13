import { useMemo } from "react";
import {
  Bot,
  Calendar,
  LinkIcon,
  MessageSquare,
  Route,
  Search,
  ShoppingBag,
  ShoppingCart,
  Tag,
} from "lucide-react";
import { subDays, startOfDay } from "date-fns";
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
    const weekStart = subDays(now, 6);
    const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const realEntries = entries.filter((entry) => entry.isFinalOutcome || ["success", "error"].includes(entry.status));
    const entries24h = realEntries.filter((entry) => new Date(entry.createdAt) >= last24h);
    const entries7d = realEntries.filter((entry) => new Date(entry.createdAt) >= weekStart);

    const operations24h = entries24h.length;
    const success24h = entries24h.filter((entry) => entry.status === "success" || entry.processingStatus === "sent").length;
    const errors24h = entries24h.filter((entry) => entry.status === "error" || entry.processingStatus === "failed").length;
    const convertedLinks7d = entries7d.filter(
      (entry) => entry.type === "link_converted" && (entry.status === "success" || entry.processingStatus === "sent"),
    ).length;

    const routeActive = routes.filter((route) => route.status === "active").length;
    const routePaused = routes.filter((route) => route.status === "paused").length;
    const routeError = routes.filter((route) => route.status === "error").length;

    const pendingPosts = posts.filter((post) => post.status === "pending" || post.status === "scheduled");
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
      convertedLinks7d,
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
  }, [automationList, entries, linkHubPages, meliSessions, posts, routes]);

  const effectiveOperationalLimits = useMemo(
    () => (planId ? resolveEffectiveOperationalLimitsByPlanId(planId) : null),
    [planId],
  );

  const chartData = useMemo<ChartRow[]>(() => {
    const sentEntries = entries.filter((entry) => entry.processingStatus === "sent");
    const now = new Date();

    return Array.from({ length: 7 }).map((_, i) => {
      const date = subDays(now, 6 - i);
      const dayStart = startOfDay(date);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const dayEntries = sentEntries.filter((entry) => {
        const createdAt = new Date(entry.createdAt);
        return createdAt >= dayStart && createdAt < dayEnd;
      });

      const automacoes = dayEntries.filter((entry) => entry.mechanism === "smart_automation").length;
      const rotas = dayEntries.filter((entry) => entry.mechanism === "automatic_routes").length;
      const agendamentos = dayEntries.filter((entry) => entry.mechanism === "schedule").length;

      return {
        day: DAY_LABELS[date.getDay()],
        totalEnvios: automacoes + rotas + agendamentos,
        automacoes,
        rotas,
        agendamentos,
      };
    });
  }, [entries]);

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
    return entries.slice(0, 6).map((entry) => {
      const details = typeof entry.details === "string"
        ? (() => {
            try {
              return JSON.parse(entry.details).message || entry.details;
            } catch {
              return entry.details;
            }
          })()
        : "";

      const mins = Math.round((Date.now() - new Date(entry.createdAt).getTime()) / 60000);
      const timeLabel = mins < 1
        ? "agora"
        : mins < 60
          ? `${mins}min`
          : mins < 1440
            ? `${Math.round(mins / 60)}h`
            : `${Math.round(mins / 1440)}d`;

      const typeIcon = entry.type === "link_converted"
        ? LinkIcon
        : entry.type === "route_forward"
          ? Route
          : entry.type === "schedule_sent"
            ? Calendar
            : MessageSquare;

      const typeColor = entry.status === "error"
        ? "text-destructive"
        : entry.type === "link_converted"
          ? "text-primary"
          : entry.type === "route_forward"
            ? "text-info"
            : entry.type === "schedule_sent"
              ? "text-warning"
              : "text-success";

      return {
        text: details || `${entry.source} -> ${entry.destination}`,
        time: timeLabel,
        status: entry.status,
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
      help: `${analytics.success24h} ok • ${analytics.errors24h} com erro`,
      icon: MessageSquare,
      accent: "primary",
    },
    {
      label: "Links convertidos (7 dias)",
      value: String(analytics.convertedLinks7d),
      help: "Conversões de link confirmadas",
      icon: LinkIcon,
      accent: "info",
    },
    {
      label: "Rotas ativas",
      value: String(analytics.routeActive),
      help: `${analytics.routePaused} pausada(s) • ${analytics.routeError} com erro`,
      icon: Route,
      accent: analytics.routeError > 0 ? "warning" : "success",
    },
    {
      label: "Agendamentos pendentes",
      value: String(analytics.pendingSchedules),
      help: `${analytics.dueNext24h} em 24h • ${analytics.overduePosts} atrasado(s)`,
      icon: Calendar,
      accent: "warning",
    },
    {
      label: "Automacoes ativas",
      value: String(analytics.activeAutomations),
      help: `${automationList.length} criada(s) no total`,
      icon: Bot,
      accent: analytics.activeAutomations > 0 ? "success" : "info",
    },
  ], [analytics, automationList.length]);

  const isLoading = histLoading || sessLoading || routesLoading || groupsLoading || postsLoading || linkHubLoading || automationsLoading || meliLoading;
  const isHealthLoading = channelHealthLoading || shopeeHealthLoading || meliHealthLoading || amazonHealthLoading || isCheckingAccess;

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
        desc: "Achar produtos para divulgar agora",
        icon: Search,
        href: ROUTES.app.shopeePesquisa,
        accent: "success",
      },
      buildFeatureAction(
        "linkHub",
        {
          label: "Gerir Link Hub",
          desc: `${analytics.activeLinkHubPages} pagina(s) ativa(s)`,
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
          desc: `${analytics.routeActive} rota(s) ligada(s)`,
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
          desc: `${analytics.pendingSchedules} na fila`,
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
        href: ROUTES.app.account,
        cta: "Renovar agora",
        accent: "destructive",
      });
    } else if (Number.isFinite(daysToExpiry) && daysToExpiry <= 3) {
      alerts.push({
        id: "plan-expiring",
        title: "Plano vencendo",
        description: daysToExpiry <= 0 ? "Vence hoje." : `Vence em ${daysToExpiry} dia(s).`,
        href: ROUTES.app.account,
        cta: "Evitar bloqueio",
        accent: "warning",
      });
    }

    if (waSessions.length > 0 && (!waServiceOnline || waOnline === 0)) {
      alerts.push({
        id: "wa-offline",
        title: "Sessão crítica offline",
        description: "WhatsApp sem sessão online pode interromper sua operação.",
        href: ROUTES.app.connectionsWhatsApp,
        cta: "Revisar sessões",
        accent: "destructive",
      });
    }

    if (analytics.overduePosts > 0) {
      alerts.push({
        id: "overdue-posts",
        title: "Agendamentos atrasados",
        description: `${analytics.overduePosts} item(ns) já passou(ram) da hora prevista de envio.`,
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
        description: `${analytics.meliDisconnected}/${meliSessions.length} sessão(ões) desconectada(s) ou com erro.`,
        href: ROUTES.app.mercadolivreConfiguracoes,
        cta: "Revisar Mercado Livre",
        accent: allDisconnected ? "destructive" : "warning",
      });
    }

    const usageSignals = [
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
      .filter((item): item is { id: string; label: string; used: number; limit: number; href: string; ratio: number } => Boolean(item))
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 2);

    for (const signal of usageSignals) {
      alerts.push({
        id: signal.id,
        title: `Limite quase no teto: ${signal.label}`,
        description: `${signal.used}/${signal.limit} (${Math.round(signal.ratio)}%) em uso.`,
        href: signal.href,
        cta: "Ajustar agora",
        accent: "warning",
      });
    }

    return alerts.slice(0, 4);
  }, [analytics.activeAutomations, analytics.meliDisconnected, analytics.overduePosts, analytics.pendingSchedules, analytics.routeActive, effectiveOperationalLimits?.automations, effectiveOperationalLimits?.routes, effectiveOperationalLimits?.schedules, isPlanExpired, meliSessions.length, planExpiresAt, waOnline, waServiceOnline, waSessions.length]);

  function usageCountsOrNull(value: number) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  const waError = sanitizeError(channelHealth?.whatsapp.error);
  const tgError = sanitizeError(channelHealth?.telegram.error);
  const shopeeError = sanitizeError(shopeeHealth?.error);
  const meliError = sanitizeError(meliHealth?.error);
  const amazonError = sanitizeError(amazonHealth?.error);

  const healthCards: readonly HealthCardViewModel[] = [
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
  ];

  const serviceFeatureAccess = useMemo(() => {
    const resolve = (feature: AppFeature) => {
      if (canAccess(feature)) return { enabled: true, note: "" };
      const policy = getFeaturePolicy(feature);
      const blockedMessage = sanitizeError(policy.blockedMessage);
      if (policy.mode === "hidden") {
        return { enabled: false, note: "Nao faz parte do seu plano atual." };
      }
      return {
        enabled: false,
        note: blockedMessage || "Nao faz parte do seu plano atual.",
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
        statusText: "Nao incluido no plano",
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
                <p className="text-sm font-semibold text-destructive">Seu plano venceu e o envio automatico foi interrompido</p>
                <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
                  Rotas, automacoes e agendamentos ficam pausados ate a renovacao. Escolha um plano para reativar tudo com seguranca.
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
          <DashboardUsageCard chartData={chartData} compactDashboard={compactDashboard} isLoading={isLoading} usage7d={usage7d} />
          <DashboardHealthCards isHealthLoading={isHealthLoading} isLoading={isLoading} visibleHealthCards={visibleHealthCards} />
        </div>

        <DashboardMetricCards compactDashboard={compactDashboard} isLoading={isLoading} metricCards={metricCards} />

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
