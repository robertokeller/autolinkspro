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
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
  const { user } = useAuth();
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
    const realEntries = entries.filter((entry) => entry.isFinalOutcome || ["success", "error"].includes(entry.status));
    const now = new Date();

    return Array.from({ length: 7 }).map((_, i) => {
      const date = subDays(now, 6 - i);
      const dayStart = startOfDay(date);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const dayEntries = realEntries.filter((entry) => {
        const createdAt = new Date(entry.createdAt);
        return createdAt >= dayStart && createdAt < dayEnd;
      });

      return {
        day: dayLabels[date.getDay()],
        operacoes: dayEntries.length,
        convertidos: dayEntries.filter((entry) => entry.status === "success" || entry.processingStatus === "sent").length,
        falhas: dayEntries.filter((entry) => entry.status === "error" || entry.processingStatus === "failed").length,
      };
    });
  }, [entries]);

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
  const formatUptime = (uptimeSec: number | null | undefined) => {
    if (!uptimeSec || uptimeSec <= 0) return "Uptime indisponível";
    if (uptimeSec < 60) return `${uptimeSec}s online`;
    if (uptimeSec < 3600) return `${Math.floor(uptimeSec / 60)}min online`;
    if (uptimeSec < 86400) return `${Math.floor(uptimeSec / 3600)}h online`;
    return `${Math.floor(uptimeSec / 86400)}d online`;
  };
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
        label: "Operações (24h)",
        value: String(analytics.operations24h),
        help: `${analytics.success24h} sucesso(s) / ${analytics.errors24h} falha(s)`,
        icon: MessageSquare,
        accent: "primary",
      },
      {
        label: "Taxa de sucesso (24h)",
        value: analytics.successRate24h === null ? "-" : `${analytics.successRate24h}%`,
        help: "Baseado no histórico recente",
        icon: BarChart3,
        accent: analytics.successRate24h !== null && analytics.successRate24h < 70 ? "warning" : "success",
      },
      {
        label: "Links convertidos (7d)",
        value: String(analytics.convertedLinks7d),
        help: "Shopee e Mercado Livre",
        icon: LinkIcon,
        accent: "info",
      },
      {
        label: "Rotas ativas",
        value: String(analytics.routeActive),
        help: `${analytics.routePaused} pausada(s) / ${analytics.routeError} em erro`,
        icon: Route,
        accent: analytics.routeError > 0 ? "warning" : "success",
      },
      {
        label: "Fila de agendamentos",
        value: String(analytics.pendingSchedules),
        help: `${analytics.dueNext24h} para as próximas 24h`,
        icon: Calendar,
        accent: "warning",
      },
      {
        label: "Automações ativas",
        value: String(analytics.activeAutomations),
        help: `${automationList.length} automação(ões) cadastrada(s)`,
        icon: Bot,
        accent: analytics.activeAutomations > 0 ? "success" : "info",
      },
    ];
  }, [analytics, automationList.length]);

  const isLoading = histLoading || sessLoading || routesLoading || groupsLoading || postsLoading || linkHubLoading || automationsLoading || meliLoading;
  const isHealthLoading = channelHealthLoading || shopeeHealthLoading || meliHealthLoading;

  const quickActions = [
    {
      label: "Converter link",
      desc: shopeeConfigured ? "Shopee configurado" : "Configure suas credenciais da Shopee",
      icon: LinkIcon,
      href: ROUTES.app.shopeeConversor,
      accent: "primary" as const,
    },
    {
      label: "Pesquisar ofertas",
      desc: "Encontrar produtos para divulgar",
      icon: Search,
      href: ROUTES.app.shopeePesquisa,
      accent: "success" as const,
    },
    {
      label: "Criar rota",
      desc: `${analytics.routeActive} rota(s) ativa(s)`,
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
          ? "Nenhuma sessão conectada"
          : waServiceOnline
            ? `${waOnline}/${waSessions.length} sessões online`
            : waError || `${waOnline}/${waSessions.length} sessões online`,
      statusText:
        waSessions.length === 0
          ? "Não configurado"
          : !waServiceOnline
            ? "Serviço offline"
            : waOnline === 0
              ? "Sem sessão online"
              : formatUptime(channelHealth?.whatsapp.uptimeSec),
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
          ? "Nenhuma sessão conectada"
          : tgServiceOnline
            ? `${tgOnline}/${tgSessions.length} sessões online`
            : tgError || `${tgOnline}/${tgSessions.length} sessões online`,
      statusText:
        tgSessions.length === 0
          ? "Não configurado"
          : !tgServiceOnline
            ? "Serviço offline"
            : tgOnline === 0
              ? "Sem sessão online"
              : formatUptime(channelHealth?.telegram.uptimeSec),
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
        ? "Credenciais da API não configuradas"
        : shopeeServiceOnline
          ? "Credenciais configuradas e serviço respondendo"
          : shopeeError || "Serviço não respondeu ao health check",
      statusText: !shopeeConfigured
        ? "Não configurado"
        : shopeeServiceOnline
          ? formatUptime(shopeeHealth?.uptimeSec)
          : "Serviço offline",
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
          ? `${analytics.meliActive}/${meliSessions.length} sessões ativas`
          : meliError || `${analytics.meliActive}/${meliSessions.length} sessões ativas`,
      statusText: meliSessions.length === 0
        ? "Não configurado"
        : !meliServiceOnline
          ? "Serviço offline"
          : analytics.meliActive === 0
            ? "Sem sessão ativa"
            : formatUptime(meliHealth?.uptimeSec),
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

  return (
    <div className="ds-page">
      <PageHeader title="Dashboard" description={`Visão geral • ${nowBRT("EEEE, d 'de' MMMM")}`} />

      {!isLoading && (
        <OnboardingChecklist
          hasSession={totalSessions > 0}
          hasGroups={groups.length > 0}
          hasShopee={shopeeConfigured}
          hasAutomation={automationList.length > 0}
        />
      )}

      <div className="ds-card-grid grid-cols-2 lg:grid-cols-6">
        {isLoading
          ? Array.from({ length: 6 }).map((_, idx) => (
              <Card key={idx} className="glass">
                <CardContent className="p-4">
                  <Skeleton className="h-16 w-full" />
                </CardContent>
              </Card>
            ))
          : metricCards.map((item) => (
              <Card key={item.label} className="glass group hover:ring-1 hover:ring-primary/20 transition-all">
                <CardContent className="p-4 space-y-2 text-center">
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

      <div className="ds-card-grid lg:grid-cols-5">
        <Card className="glass lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Atividade dos últimos 7 dias
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="gradOps" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradConv" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradErr" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                    <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "10px",
                        fontSize: "11px",
                      }}
                    />
                    <Area type="monotone" dataKey="operacoes" stroke="hsl(var(--primary))" fillOpacity={1} fill="url(#gradOps)" strokeWidth={2} />
                    <Area type="monotone" dataKey="convertidos" stroke="hsl(var(--success))" fillOpacity={1} fill="url(#gradConv)" strokeWidth={2} />
                    <Area type="monotone" dataKey="falhas" stroke="hsl(var(--destructive))" fillOpacity={1} fill="url(#gradErr)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" />Operações</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" />Convertidos</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-destructive" />Falhas</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="glass lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Wifi className="h-4 w-4 text-muted-foreground" />
                Saúde operacional
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {isLoading || isHealthLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              healthCards.map((card) => (
                <div key={card.id} className="flex items-center gap-3 p-3 rounded-xl bg-secondary/50">
                  <div className={cn("h-9 w-9 rounded-lg flex items-center justify-center", card.iconBgClass)}>
                    <card.icon className={cn("h-4 w-4", card.iconColorClass)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold">{card.title}</p>
                    <p className="text-xs text-muted-foreground">{card.details}</p>
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

      <div className="ds-card-grid lg:grid-cols-5">
        <Card className="glass lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-muted-foreground" />
              Ações rápidas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              <Skeleton className="h-36 w-full" />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {quickActions.map((action) => (
                  <Link key={action.label} to={action.href} className="group">
                    <div className="h-full rounded-xl bg-secondary/50 p-3.5 text-center transition-all hover:bg-secondary hover:ring-1 hover:ring-border">
                      <div className={cn("mx-auto mb-2.5 flex h-8 w-8 items-center justify-center rounded-lg", accentBg[action.accent])}>
                        <action.icon className="h-4 w-4" />
                      </div>
                      <p className="text-xs font-semibold leading-tight">{action.label}</p>
                      <p className="mt-1 text-xs leading-snug text-muted-foreground">{action.desc}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass lg:col-span-3">
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Atividade recente
            </CardTitle>
            <Button variant="ghost" size="sm" className="text-xs h-8 px-2" asChild>
              <Link to={ROUTES.app.history}>Ver tudo <ChevronRight className="h-3 w-3 ml-0.5" /></Link>
            </Button>
          </CardHeader>
          <CardContent>
            {histLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : recentActivity.length === 0 ? (
              <div className="text-center py-8">
                <MessageSquare className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">Nenhuma atividade registrada</p>
                <p className="text-xs text-muted-foreground/60 mt-0.5">As ações do sistema aparecerão aqui</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentActivity.map((item, idx) => (
                  <div key={`${item.text}-${idx}`} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-secondary/50 transition-colors">
                    <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-secondary", item.color)}>
                      <item.Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs truncate">{item.text}</p>
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

            <div className="pt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>{analytics.dueNext24h} agendamento(s) nas próximas 24h</span>
              <Link to={ROUTES.app.schedules} className="inline-flex items-center hover:text-foreground transition-colors">
                Abrir agenda <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
