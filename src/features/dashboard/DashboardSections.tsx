import { ComponentType } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  Calendar,
  ChevronRight,
  Clock,
  Lock,
  MessageSquare,
  ShieldAlert,
  Wifi,
  Zap,
} from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/routes";

type IconComponent = ComponentType<{ className?: string }>;

export type Accent = "primary" | "success" | "info" | "warning" | "destructive";
export type HealthBadgeTone = "success" | "warning" | "destructive" | "muted";

export interface MetricCard {
  label: string;
  value: string;
  help: string;
  icon: IconComponent;
  accent: Accent;
}

export interface ChartRow {
  day: string;
  totalEnvios: number;
  automacoes: number;
  rotas: number;
  agendamentos: number;
}

export interface UsageSummary {
  totalEnvios: number;
  automacoes: number;
  rotas: number;
  agendamentos: number;
}

export interface HealthCardViewModel {
  id: string;
  title: string;
  details: string;
  statusText: string;
  statusTone: HealthBadgeTone;
  icon: IconComponent;
  iconColorClass: string;
  iconBgClass: string;
}

export interface QuickActionCard {
  label: string;
  desc: string;
  icon: IconComponent;
  href: string;
  accent: Accent;
  locked?: boolean;
  ctaLabel?: string;
}

export interface RiskAlertItem {
  id: string;
  title: string;
  description: string;
  impact: string;
  actionWindow: string;
  href: string;
  cta: string;
  accent: Accent;
}

export interface RecentActivityItem {
  text: string;
  time: string;
  status: string;
  Icon: IconComponent;
  color: string;
}

const accentBg: Record<Accent, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  info: "bg-info/10 text-info",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

const statusByTone: Record<HealthBadgeTone, string> = {
  success: "text-success border-success/20",
  warning: "text-warning border-warning/20",
  destructive: "text-destructive border-destructive/20",
  muted: "text-muted-foreground border-border",
};

function ptCount(value: number, singular: string, plural: string): string {
  if (!Number.isFinite(value)) return `0 ${plural}`;
  return `${value} ${value === 1 ? singular : plural}`;
}

export function DashboardMetricCards({
  compactDashboard,
  isLoading,
  metricCards,
}: {
  compactDashboard: boolean;
  isLoading: boolean;
  metricCards: MetricCard[];
}) {
  if (compactDashboard) {
    return (
      <ScrollArea className="w-full whitespace-nowrap -mx-[var(--app-page-x)] px-[var(--app-page-x)]">
        <div className="flex gap-2.5 pb-2 min-[420px]:gap-3">
          {isLoading
            ? Array.from({ length: 4 }).map((_, idx) => (
                <Card key={idx} className="glass min-w-[164px] max-w-[220px] min-[420px]:min-w-[210px] min-[420px]:max-w-[250px]">
                  <CardContent className="p-3 min-[420px]:p-4">
                    <Skeleton className="h-16 w-full" />
                  </CardContent>
                </Card>
              ))
            : metricCards.map((item, idx) => (
                <Card 
                  key={item.label} 
                  className="glass glass-hover min-w-[170px] max-w-[220px] border-border/50 min-[420px]:min-w-[210px] min-[420px]:max-w-[250px] animate-card-in"
                  style={{ animationDelay: `${idx * 50}ms` }}
                >
                  <CardContent className="flex min-h-[140px] flex-col items-center justify-between gap-1.5 p-3.5 text-center min-[420px]:min-h-[150px] min-[420px]:p-4">
                    <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl shadow-sm border border-border/10", accentBg[item.accent])}>
                      <item.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-2xl font-extrabold tracking-tight leading-none mb-1">{item.value}</p>
                      <p className="line-clamp-1 text-2xs font-bold uppercase tracking-widest text-muted-foreground/70">{item.label}</p>
                    </div>
                    <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/60 font-medium">{item.help}</p>
                  </CardContent>
                </Card>
              ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    );
  }

  return (
    <div className="ds-card-grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-5">
      {isLoading
        ? Array.from({ length: 5 }).map((_, idx) => (
            <Card key={idx} className="glass">
              <CardContent className="p-3.5 sm:p-4">
                <Skeleton className="h-16 w-full" />
              </CardContent>
            </Card>
          ))
        : metricCards.map((item, idx) => (
            <Card 
              key={item.label} 
              className="glass glass-hover h-full animate-card-in border-border/50"
              style={{ animationDelay: `${idx * 75}ms` }}
            >
              <CardContent className="flex min-h-[160px] flex-col items-center justify-between gap-2 p-4 text-center">
                <div className={cn("h-11 w-11 shrink-0 rounded-2xl flex items-center justify-center shadow-sm border border-border/10", accentBg[item.accent])}>
                  <item.icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-3xl font-extrabold tracking-tighter leading-none mb-1">{item.value}</p>
                  <p className="line-clamp-1 text-2xs font-bold uppercase tracking-widest text-muted-foreground/70">{item.label}</p>
                </div>
                <p className="line-clamp-2 text-xs leading-snug text-muted-foreground/60 font-medium">{item.help}</p>
              </CardContent>
            </Card>
          ))}
    </div>
  );
}

export function DashboardUsageCard({
  chartData,
  compactDashboard,
  isLoading,
  usage7d,
}: {
  chartData: ChartRow[];
  compactDashboard: boolean;
  isLoading: boolean;
  usage7d: UsageSummary;
}) {
  return (
    <Card className="glass order-1 ring-1 ring-primary/20 shadow-sm lg:order-1 lg:col-span-4 flex flex-col">
      <CardHeader className="pb-2 shrink-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          Envios confirmados (7 dias)
        </CardTitle>
        {!isLoading && (
          <p className="text-xs text-muted-foreground">
            {ptCount(usage7d.totalEnvios, "envio", "envios")} • {ptCount(usage7d.automacoes, "automação", "automações")} • {ptCount(usage7d.rotas, "rota", "rotas")} • {ptCount(usage7d.agendamentos, "agendamento", "agendamentos")}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col min-h-0">
        {isLoading ? (
          <Skeleton className="min-h-[220px] w-full flex-1 sm:min-h-[280px]" />
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            <div className="flex-1 min-h-[220px] sm:min-h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                  <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" allowDecimals={false} />
                  <Tooltip
                    formatter={(value: number, key: string) => {
                      const labels: Record<string, string> = {
                        totalEnvios: "Envios totais",
                        automacoes: "Automações",
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
                      padding: "8px 12px",
                      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
                    }}
                    itemStyle={{
                      padding: "2px 0",
                    }}
                    cursor={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1, strokeDasharray: "4 4" }}
                  />
                  <Line type="monotone" dataKey="totalEnvios" stroke="hsl(var(--primary))" strokeWidth={3} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: "hsl(var(--background))" }} />
                  {!compactDashboard && (
                    <>
                      <Line type="monotone" dataKey="automacoes" stroke="hsl(var(--success))" strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 1, stroke: "hsl(var(--background))" }} />
                      <Line type="monotone" dataKey="rotas" stroke="hsl(var(--info))" strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 1, stroke: "hsl(var(--background))" }} />
                      <Line type="monotone" dataKey="agendamentos" stroke="hsl(var(--warning))" strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 1, stroke: "hsl(var(--background))" }} />
                    </>
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            {compactDashboard ? (
              <div className="mt-3 text-center text-xs text-muted-foreground">
                Foco em envios totais no celular.
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" />Envios totais</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" />Automações</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-info" />Rotas</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" />Agendamentos</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardHealthCards({
  isHealthLoading,
  isLoading,
  visibleHealthCards,
}: {
  isHealthLoading: boolean;
  isLoading: boolean;
  visibleHealthCards: HealthCardViewModel[];
}) {
  const onlineCount = visibleHealthCards.filter((card) => card.statusTone === "success").length;
  const attentionCount = visibleHealthCards.filter((card) => card.statusTone === "warning" || card.statusTone === "destructive").length;

  return (
    <Card className="glass order-2 ring-1 ring-border/70 lg:order-2 lg:col-span-2 lg:self-stretch">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-primary" />
            Saúde dos serviços
          </span>
        </CardTitle>
        {!isLoading && !isHealthLoading && (
          <p className="text-xs text-muted-foreground">
            {onlineCount}/{visibleHealthCards.length} online
            {attentionCount > 0 ? ` • ${attentionCount} com atenção` : " • sem alertas"}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-2.5">
        {isLoading || isHealthLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          visibleHealthCards.map((card) => (
            <div key={card.id} className="flex items-center gap-2.5 rounded-xl border border-border/40 bg-secondary/40 p-2.5 sm:gap-3 sm:p-3">
              <div className={cn("h-9 w-9 rounded-lg flex items-center justify-center", card.iconBgClass)}>
                <card.icon className={cn("h-4 w-4", card.iconColorClass)} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold">{card.title}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{card.details}</p>
              </div>
              <Badge variant="outline" className={cn("shrink-0 text-xs", statusByTone[card.statusTone])}>
                {card.statusText}
              </Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardQuickActions({
  isLoading,
  quickActions,
}: {
  isLoading: boolean;
  quickActions: QuickActionCard[];
}) {
  return (
    <Card className="glass lg:col-span-5 h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          Ações rápidas
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2 flex-1">
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="grid grid-cols-1 gap-2.5 h-full auto-rows-fr min-[430px]:grid-cols-2 lg:grid-cols-4">
            {quickActions.map((action) => (
              <Link key={action.label} to={action.href} className="group">
                <div
                  className={cn(
                    "relative flex flex-col h-full min-h-[104px] rounded-xl border p-3.5 transition-all duration-200 overflow-hidden",
                    action.locked
                      ? "border-warning/40 bg-warning/5 hover:bg-warning/10"
                      : "border-border/40 bg-secondary/40 hover:border-border/60 hover:bg-secondary/70 hover:shadow-sm",
                  )}
                >
                  <div className="mb-3 flex items-start justify-between">
                    <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105", accentBg[action.accent])}>
                      <action.icon className="h-5 w-5" />
                    </div>
                    {action.locked ? (
                      <Badge variant="outline" className="border-warning/50 text-warning">
                        <Lock className="mr-1 h-3 w-3" />
                        Plano
                      </Badge>
                    ) : (
                      <ChevronRight className="mt-0.5 h-3.5 w-3.5 text-muted-foreground/30 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-muted-foreground/60" />
                    )}
                  </div>
                  <div className="mt-auto">
                    <p className="text-sm font-semibold leading-tight">{action.label}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">{action.desc}</p>
                    {action.locked && (
                      <p className="mt-1 text-xs font-medium text-warning">{action.ctaLabel || "Ver planos e liberar"}</p>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardRiskAlerts({
  isLoading,
  alerts,
}: {
  isLoading: boolean;
  alerts: RiskAlertItem[];
}) {
  const sortedAlerts = [...alerts].sort((a, b) => {
    const score = (accent: Accent) => {
      if (accent === "destructive") return 3;
      if (accent === "warning") return 2;
      return 1;
    };
    return score(b.accent) - score(a.accent);
  });

  const primaryAlert = sortedAlerts[0] || null;
  const secondaryAlerts = sortedAlerts.slice(1);
  const criticalCount = sortedAlerts.filter((alert) => alert.accent === "destructive").length;

  const alertTone = (accent: Accent): "destructive" | "warning" | "muted" => {
    if (accent === "destructive") return "destructive";
    if (accent === "warning") return "warning";
    return "muted";
  };

  const alertLabel = (accent: Accent) => {
    if (accent === "destructive") return "Crítico";
    if (accent === "warning") return "Atenção";
    return "Monitorar";
  };

  return (
    <Card className="glass lg:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          Alertas de risco
        </CardTitle>
        {!isLoading && (
          <p className="text-xs text-muted-foreground">
            {sortedAlerts.length > 0
              ? `${ptCount(sortedAlerts.length, "alerta ativo", "alertas ativos")}${criticalCount > 0 ? ` • ${ptCount(criticalCount, "crítico", "críticos")}` : ""}`
              : "Operação sem riscos ativos"}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-2.5">
        {isLoading ? (
          <div className="space-y-2.5">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : alerts.length === 0 ? (
          <div className="rounded-xl border border-success/30 bg-success/5 p-3">
            <p className="text-xs font-semibold text-success">Operação estável</p>
            <p className="mt-1 text-xs text-muted-foreground">Sem alertas críticos no momento.</p>
          </div>
        ) : (
          <>
            {primaryAlert && (
              <div
                className={cn(
                  "rounded-xl border p-3.5",
                  primaryAlert.accent === "destructive"
                    ? "border-destructive/35 bg-destructive/5"
                    : primaryAlert.accent === "warning"
                      ? "border-warning/35 bg-warning/5"
                      : "border-border/40 bg-secondary/35",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Prioridade máxima</p>
                    <p className="mt-1 text-sm font-semibold leading-tight">{primaryAlert.title}</p>
                  </div>
                  <Badge variant="outline" className={cn("text-xs", statusByTone[alertTone(primaryAlert.accent)])}>
                    {alertLabel(primaryAlert.accent)}
                  </Badge>
                </div>

                <p className="mt-2 text-xs text-muted-foreground">{primaryAlert.description}</p>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="text-[11px]">
                    Impacto: {primaryAlert.impact}
                  </Badge>
                  <Badge variant="outline" className="text-[11px]">
                    Ação: {primaryAlert.actionWindow}
                  </Badge>
                </div>

                <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs" asChild>
                  <Link to={primaryAlert.href}>
                    {primaryAlert.cta}
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Link>
                </Button>
              </div>
            )}

            {secondaryAlerts.length > 0 && (
              <div className="space-y-2">
                <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Em acompanhamento</p>
                {secondaryAlerts.map((alert) => (
                  <div key={alert.id} className="rounded-xl border border-border/40 bg-secondary/35 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold leading-tight">{alert.title}</p>
                      <Badge variant="outline" className={cn("text-[10px]", statusByTone[alertTone(alert.accent)])}>
                        {alertLabel(alert.accent)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{alert.impact} • {alert.actionWindow}</p>
                    <Button variant="ghost" size="sm" className="mt-1.5 h-6 px-1.5 text-xs" asChild>
                      <Link to={alert.href}>
                        {alert.cta}
                        <ArrowRight className="ml-1 h-3 w-3" />
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardRecentActivity({
  dueNext24h,
  histLoading,
  recentActivity,
}: {
  dueNext24h: number;
  histLoading: boolean;
  recentActivity: RecentActivityItem[];
}) {
  return (
    <Card className="glass lg:col-span-3 h-full flex flex-col">
      <CardHeader className="pb-2 gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Atividade recente
        </CardTitle>
        <Button variant="ghost" size="sm" className="h-9 justify-start px-2 text-xs sm:h-8 sm:justify-center" asChild>
          <Link to={ROUTES.app.history}>
            Ver tudo
            <ChevronRight className="h-3 w-3 ml-0.5" />
          </Link>
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
              <div key={`${item.text}-${idx}`} className="flex items-center gap-2.5 rounded-xl p-2.5 transition-colors hover:bg-secondary/70 sm:gap-3">
                <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-secondary/80", item.color)}>
                  <item.Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="line-clamp-2 text-[13px] font-medium leading-tight sm:line-clamp-1">{item.text}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-muted-foreground/80 font-medium">
                      {item.time === "agora" || item.time === "-" ? item.time : `${item.time} atrás`}
                    </span>
                    {item.status === "success" && <Badge variant="outline" className="text-[10px] h-4 px-1.5 py-0 font-bold bg-success/5 text-success border-success/20">OK</Badge>}
                    {item.status === "error" && <Badge variant="outline" className="text-[10px] h-4 px-1.5 py-0 font-bold bg-destructive/5 text-destructive border-destructive/20">Erro</Badge>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-1.5 pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>{ptCount(dueNext24h, "agendamento sai nas próximas 24h", "agendamentos saem nas próximas 24h")}</span>
          <Link to={ROUTES.app.schedules} className="inline-flex items-center hover:text-foreground transition-colors">
            Abrir agenda
            <ArrowRight className="h-3 w-3 ml-1" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
