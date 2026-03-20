import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BarChart3,
  Calendar,
  ChevronRight,
  Clock,
  LinkIcon,
  MessageSquare,
  Route,
  Search,
  ShoppingBag,
  ShoppingCart,
  Wifi,
  Bot,
} from "lucide-react";
import { subDays, startOfDay } from "date-fns";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
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
import { getAllChannelHealth } from "@/lib/channel-central";
import { ROUTES } from "@/lib/routes";
import { nowBRT } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { TelegramIcon, WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";

const dayLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
const CHANNEL_HEALTH_INTERVAL_MS = 5 * 60 * 1000;

type Accent = "primary" | "success" | "info" | "warning" | "destructive";

interface MetricCard {
  label: string;
  value: string;
  help: string;
  icon: typeof MessageSquare;
  accent: Accent;
}

type HealthBadgeTone = "success" | "warning" | "destructive" | "muted";

export default function Dashboard() {
  const viewport = useViewportProfile();
  const compactDashboard = viewport.isMobile || (viewport.isTablet && viewport.orientation === "portrait");
  const { user } = useAuth();
  const { canAccess, getFeaturePolicy, isCheckingAccess } = useAccessControl();
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
  const automationList = useMemo(
    () => (Array.isArray(automations)
      ? (automations as Array<{ is_active?: boolean | null }>)
      : []),
    [automations],
  );

  const accentBg: Record<Accent, string> = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    info: "bg-info/10 text-info",
    warning: "bg-warning/10 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  };

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
    const successRate24h = operations24h > 0 ? Math.round((success24h / operations24h) * 100) : null;

    const convertedLinks7d = entries7d.filter((entry) => entry.status === "success" || entry.processingStatus === "sent").length;

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
      successRate24h,
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

  const chartData = useMemo(() => {
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
        day: dayLabels[date.getDay()],
        totalEnvios: automacoes + rotas + agendamentos,
        automacoes,
        rotas,
        agendamentos,
      };
    });
  }, [entries]);

  const usage7d = useMemo(() => {
    return chartData.reduce(
      (acc, row) => ({
        totalEnvios: acc.totalEnvios + row.totalEnvios,
        automacoes: acc.automacoes + row.automacoes,
        rotas: acc.rotas + row.rotas,
        agendamentos: acc.agendamentos + row.agendamentos,
      }),
      { totalEnvios: 0, automacoes: 0, rotas: 0, agendamentos: 0 },
    );
  }, [chartData]);

  const recentActivity = useMemo(() => {
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
  const tgOnline = tgSessions.filter((session) => session.status === "online").length;
  const totalSessions = waSessions.length + tgSessions.length;

  const waServiceOnline = channelHealth?.whatsapp.online === true;
  const tgServiceOnline = channelHealth?.telegram.online === true;
  const shopeeServiceOnline = shopeeHealth?.online === true;
  const meliServiceOnline = meliHealth?.online === true;
  const sanitizeError = (value: string | null | undefined) => {
    if (!value) return null;
    const normalized = value.trim();
    if (!normalized) return null;
    return normalized.length > 90 ? `${normalized.slice(0, 90)}...` : normalized;
  };
  const statusByTone: Record<HealthBadgeTone, string> = {
    success: "text-success border-success/20",
    warning: "text-warning border-warning/20",
    destructive: "text-destructive border-destructive/20",
    muted: "text-muted-foreground border-border",
  };

  const metricCards = useMemo<MetricCard[]>(() => {
    return [
      {
        label: "Envios nas últimas 24h",
        value: String(analytics.operations24h),
        help: `${analytics.success24h} ok / ${analytics.errors24h} com erro`,
        icon: MessageSquare,
        accent: "primary",
      },
      {
        label: "Acertos nas últimas 24h",
        value: analytics.successRate24h === null ? "-" : `${analytics.successRate24h}%`,
        help: "De tudo que foi enviado",
        icon: BarChart3,
        accent: analytics.successRate24h !== null && analytics.successRate24h < 70 ? "warning" : "success",
      },
      {
        label: "Links convertidos (7 dias)",
        value: String(analytics.convertedLinks7d),
        help: "Shopee e Mercado Livre",
        icon: LinkIcon,
        accent: "info",
      },
      {
        label: "Rotas ligadas",
        value: String(analytics.routeActive),
        help: `${analytics.routePaused} pausada(s) / ${analytics.routeError} com erro`,
        icon: Route,
        accent: analytics.routeError > 0 ? "warning" : "success",
      },
      {
        label: "Na fila pra enviar",
        value: String(analytics.pendingSchedules),
        help: `${analytics.dueNext24h} saem nas próximas 24h`,
        icon: Calendar,
        accent: "warning",
      },
      {
        label: "Automações ligadas",
        value: String(analytics.activeAutomations),
        help: `${automationList.length} criada(s) no total`,
        icon: Bot,
        accent: analytics.activeAutomations > 0 ? "success" : "info",
      },
    ];
  }, [analytics, automationList.length]);

  const isLoading = histLoading || sessLoading || routesLoading || groupsLoading || postsLoading || linkHubLoading || automationsLoading || meliLoading;
  const isHealthLoading = channelHealthLoading || shopeeHealthLoading || meliHealthLoading || isCheckingAccess;

  const quickActions = [
    {
      label: "Converter link",
      desc: shopeeConfigured ? "Shopee pronto" : "Preencha suas credenciais da Shopee",
      icon: LinkIcon,
      href: ROUTES.app.shopeeConversor,
      accent: "primary" as const,
    },
    {
      label: "Pesquisar ofertas",
      desc: "Achar produtos pra divulgar",
      icon: Search,
      href: ROUTES.app.shopeePesquisa,
      accent: "success" as const,
    },
    {
      label: "Criar rota",
      desc: `${analytics.routeActive} rota(s) ligada(s)`,
      icon: Route,
      href: ROUTES.app.routes,
      accent: "info" as const,
    },
    {
      label: "Agendar post",
      desc: `${analytics.pendingSchedules} na fila`,
      icon: Calendar,
      href: ROUTES.app.schedules,
      accent: "warning" as const,
    },
  ];

  const waError = sanitizeError(channelHealth?.whatsapp.error);
  const tgError = sanitizeError(channelHealth?.telegram.error);
  const shopeeError = sanitizeError(shopeeHealth?.error);
  const meliError = sanitizeError(meliHealth?.error);
  const healthCards = [
    {
      id: "wa",
      title: "WhatsApp",
      details:
        waSessions.length === 0
          ? "Nenhuma sessão"
          : waServiceOnline
            ? `${waOnline}/${waSessions.length} sessões conectadas`
            : waError || `${waOnline}/${waSessions.length} sessões conectadas`,
      statusText:
        waSessions.length === 0 || !waServiceOnline || waOnline === 0
          ? "Offline"
          : "Online",
      statusTone:
        waSessions.length === 0
          ? "warning"
          : !waServiceOnline
            ? "destructive"
            : waOnline === 0
              ? "warning"
              : "success",
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
          : tgServiceOnline
            ? `${tgOnline}/${tgSessions.length} sessões conectadas`
            : tgError || `${tgOnline}/${tgSessions.length} sessões conectadas`,
      statusText:
        tgSessions.length === 0 || !tgServiceOnline || tgOnline === 0
          ? "Offline"
          : "Online",
      statusTone:
        tgSessions.length === 0
          ? "warning"
          : !tgServiceOnline
            ? "destructive"
            : tgOnline === 0
              ? "warning"
              : "success",
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
      statusText: !shopeeConfigured
        ? "Offline"
        : shopeeServiceOnline
          ? "Online"
          : "Offline",
      statusTone: !shopeeConfigured ? "warning" : shopeeServiceOnline ? "success" : "destructive",
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
      statusText: meliSessions.length === 0
        ? "Offline"
        : !meliServiceOnline
          ? "Offline"
          : analytics.meliActive === 0
            ? "Offline"
            : "Online",
      statusTone: meliSessions.length === 0
        ? "warning"
        : !meliServiceOnline
          ? "destructive"
          : analytics.meliActive === 0
            ? "warning"
            : "success",
      icon: ShoppingCart,
      iconColorClass: "text-primary",
      iconBgClass: "bg-primary/10",
    },
  ] as const;

  const serviceFeatureAccess = useMemo(() => {
    const resolve = (feature: "telegramConnections" | "shopeeAutomations" | "mercadoLivre") => {
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
    };
  }, [canAccess, getFeaturePolicy]);

  const visibleHealthCards = healthCards.map((card) => {
    if (card.id === "tg" && !serviceFeatureAccess.tg.enabled) {
      return {
        ...card,
        details: serviceFeatureAccess.tg.note,
        statusText: "Nao incluido no plano",
        statusTone: "muted" as HealthBadgeTone,
      };
    }
    if (card.id === "shopee" && !serviceFeatureAccess.shopee.enabled) {
      return {
        ...card,
        details: serviceFeatureAccess.shopee.note,
        statusText: "Nao incluido no plano",
        statusTone: "muted" as HealthBadgeTone,
      };
    }
    if (card.id === "meli" && !serviceFeatureAccess.meli.enabled) {
      return {
        ...card,
        details: serviceFeatureAccess.meli.note,
        statusText: "Nao incluido no plano",
        statusTone: "muted" as HealthBadgeTone,
      };
    }
    return card;
  });

  return (
    <div className="ds-page pb-[calc(var(--safe-area-bottom)+0.25rem)]">
      <PageHeader title="Painel geral" description={`Resumo do dia • ${nowBRT("EEEE, d 'de' MMMM")}`}>
        <Button asChild size={compactDashboard ? "default" : "sm"} className="w-full sm:w-auto">
          <Link to={ROUTES.app.shopeeConversor}>Converter link</Link>
        </Button>
      </PageHeader>

      {!isLoading && (
        <OnboardingChecklist
          hasSession={totalSessions > 0}
          hasGroups={groups.length > 0}
          hasShopee={shopeeConfigured}
          hasAutomation={automationList.length > 0}
        />
      )}

      {compactDashboard ? (
        <ScrollArea className="w-full whitespace-nowrap">
          <div className="flex gap-3 pb-2">
            {isLoading
              ? Array.from({ length: 4 }).map((_, idx) => (
                  <Card key={idx} className="glass min-w-[220px] max-w-[260px]">
                    <CardContent className="p-4">
                      <Skeleton className="h-16 w-full" />
                    </CardContent>
                  </Card>
                ))
              : metricCards.map((item) => (
                  <Card key={item.label} className="glass min-w-[220px] max-w-[260px] border-border/60">
                    <CardContent className="space-y-2.5 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs text-muted-foreground">{item.label}</p>
                          <p className="mt-1 text-2xl font-bold leading-none">{item.value}</p>
                        </div>
                        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", accentBg[item.accent])}>
                          <item.icon className="h-4 w-4" />
                        </div>
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground/90">{item.help}</p>
                    </CardContent>
                  </Card>
                ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      ) : (
        <div className="ds-card-grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-6">
          {isLoading
            ? Array.from({ length: 6 }).map((_, idx) => (
                <Card key={idx} className="glass">
                  <CardContent className="p-3.5 sm:p-4">
                    <Skeleton className="h-16 w-full" />
                  </CardContent>
                </Card>
              ))
            : metricCards.map((item) => (
                <Card key={item.label} className="glass group hover:ring-1 hover:ring-primary/20 transition-all">
                  <CardContent className="space-y-2 p-3.5 text-center sm:p-4">
                    <div className="flex items-center justify-center">
                      <div className={cn("h-9 w-9 rounded-xl flex items-center justify-center", accentBg[item.accent])}>
                        <item.icon className="h-4 w-4" />
                      </div>
                    </div>
                    <p className="text-xl font-bold">{item.value}</p>
                    <p className="text-xs text-muted-foreground">{item.label}</p>
                    <p className="text-xs text-muted-foreground/80">{item.help}</p>
                  </CardContent>
                </Card>
              ))}
        </div>
      )}

      <div className="flex flex-col gap-4 sm:gap-5">
        <div className="ds-card-grid order-2 lg:order-1 lg:grid-cols-5">
          <Card className="glass order-2 lg:order-1 lg:col-span-3">
            <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Uso do sistema (7 dias)
            </CardTitle>
            {!isLoading && !compactDashboard && (
              <p className="text-xs text-muted-foreground">
                {usage7d.totalEnvios} envio(s) no período • {usage7d.automacoes} automação(ões) • {usage7d.rotas} rota(s) • {usage7d.agendamentos} agendamento(s)
              </p>
            )}
            {!isLoading && compactDashboard && (
              <p className="text-xs text-muted-foreground">
                {usage7d.totalEnvios} envio(s) no periodo
              </p>
            )}
            </CardHeader>
            <CardContent>
            {isLoading ? (
              <Skeleton className="h-[190px] w-full sm:h-[220px]" />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={compactDashboard ? 190 : 220}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                    <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" allowDecimals={false} />
                    <Tooltip
                      formatter={(value: number, key: string) => {
                        const labels: Record<string, string> = {
                          totalEnvios: "Envios totais",
                          automacoes: "Automacoes",
                          rotas: "Rotas",
                          agendamentos: "Agendamentos",
                        };
                        return [value, labels[key] || key];
                      }}
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "10px",
                        fontSize: "11px",
                      }}
                    />
                    <Line type="linear" dataKey="totalEnvios" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                    {!compactDashboard && (
                      <>
                        <Line type="linear" dataKey="automacoes" stroke="hsl(var(--success))" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                        <Line type="linear" dataKey="rotas" stroke="hsl(var(--info))" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                        <Line type="linear" dataKey="agendamentos" stroke="hsl(var(--warning))" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                      </>
                    )}
                  </LineChart>
                </ResponsiveContainer>
                {compactDashboard ? (
                  <div className="mt-3 text-center text-xs text-muted-foreground">
                    Foco em envios totais no mobile.
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs">
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" />Envios totais</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" />Automacoes</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-info" />Rotas</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" />Agendamentos</span>
                  </div>
                )}
              </>
            )}
            </CardContent>
        </Card>

        <Card className="glass order-1 lg:order-2 lg:col-span-2 lg:self-start">
            <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Wifi className="h-4 w-4 text-muted-foreground" />
                Saúde dos serviços
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {isLoading || isHealthLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              visibleHealthCards.map((card) => (
                <div key={card.id} className="flex items-center gap-2.5 rounded-xl bg-secondary/50 p-2.5 sm:gap-3 sm:p-3">
                  <div className={cn("h-9 w-9 rounded-lg flex items-center justify-center", card.iconBgClass)}>
                    <card.icon className={cn("h-4 w-4", card.iconColorClass)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold">{card.title}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{card.details}</p>
                  </div>
                  <Badge variant="outline" className={cn("text-xs", statusByTone[card.statusTone])}>
                    {card.statusText}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
        </div>

        <div className="ds-card-grid order-1 lg:order-2 lg:grid-cols-5">
          <Card className="glass lg:col-span-2 h-full flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-muted-foreground" />
              Ações rápidas
            </CardTitle>
            </CardHeader>
            <CardContent className="pt-2 flex-1">
            {isLoading ? (
              <Skeleton className="h-28 w-full" />
            ) : (
              <div className={cn("grid h-full grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-2.5 sm:auto-rows-fr", compactDashboard && "sm:grid-cols-1")}>
                {quickActions.map((action) => (
                  <Link key={action.label} to={action.href} className="group h-full">
                    <div className="flex h-full min-h-[92px] items-center gap-3 rounded-xl bg-secondary/50 p-3 transition-all hover:bg-secondary hover:ring-1 hover:ring-border sm:min-h-[86px]">
                      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", accentBg[action.accent])}>
                        <action.icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold leading-tight">{action.label}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{action.desc}</p>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
            </CardContent>
        </Card>

        <Card className="glass lg:col-span-3 h-full flex flex-col">
          <CardHeader className="pb-2 gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Atividade recente
            </CardTitle>
            <Button variant="ghost" size="sm" className="h-9 justify-start px-2 text-xs sm:h-8 sm:justify-center" asChild>
              <Link to={ROUTES.app.history}>Ver tudo <ChevronRight className="h-3 w-3 ml-0.5" /></Link>
            </Button>
          </CardHeader>
          <CardContent className="flex-1">
            {histLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : recentActivity.length === 0 ? (
              <div className="text-center py-8">
                <MessageSquare className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">Nada por aqui ainda</p>
                <p className="text-xs text-muted-foreground/60 mt-0.5">Quando você usar o sistema, a atividade aparece aqui</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentActivity.map((item, idx) => (
                  <div key={`${item.text}-${idx}`} className="flex items-center gap-2.5 rounded-xl p-2.5 transition-colors hover:bg-secondary/50 sm:gap-3">
                    <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-secondary", item.color)}>
                      <item.Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="line-clamp-2 text-xs sm:line-clamp-1">{item.text}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-xs text-muted-foreground">{item.time} atrás</span>
                        {item.status === "success" && <Badge variant="outline" className="text-xs h-4 px-1.5 text-success border-success/20">ok</Badge>}
                        {item.status === "error" && <Badge variant="outline" className="text-xs h-4 px-1.5 text-destructive border-destructive/20">erro</Badge>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-1.5 pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>{analytics.dueNext24h} agendamento(s) saem nas próximas 24h</span>
              <Link to={ROUTES.app.schedules} className="inline-flex items-center hover:text-foreground transition-colors">
                Abrir agenda <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
      </div>
    </div>
  );
}



