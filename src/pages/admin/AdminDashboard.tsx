import { useEffect, useMemo, useState } from "react";
import { BarChart3, Flame, Route, Users, AlertTriangle, Play, Pause, RotateCcw, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { TelegramIcon, WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import { loadAdminSystemObservability, type ObservabilityAnomaly, type UserObservabilityRankingRow, type UserObservabilityRow } from "@/lib/system-observability";

const SERVICE_KEYS = ["whatsapp", "telegram", "shopee", "meli"] as const;
const AUTO_HEALTH_INTERVAL_MS = 30 * 1000;

interface RuntimeServiceView {
  key: "whatsapp" | "telegram" | "shopee" | "meli";
  label: string;
  online: boolean;
  uptimeSec: number | null;
  error: string | null;
  url: string;
  processStatus: string;
  processOnline: boolean;
  componentOnline: boolean;
}

interface OpsServiceRow {
  id: string;
  status: string;
  online: boolean;
  pid: number | null;
  uptimeSec: number | null;
  appName: string;
  processStatus: string;
  processOnline: boolean;
  componentOnline: boolean;
  componentError: string | null;
  healthUrl: string;
  port: number | null;
}

interface OpsSystemSnapshot {
  pressure: "ok" | "warn" | "critical" | string;
  memory: {
    usedPercent: number;
    warnPercent: number;
    criticalPercent: number;
  } | null;
  cpu: {
    loadPerCpu1m: number;
    warnPerCpu: number;
    criticalPerCpu: number;
  } | null;
}

interface ProcessQueueMetrics {
  active: number;
  pending: number;
  limit: number;
}

interface ProcessQueueSnapshot {
  route: ProcessQueueMetrics;
  dispatch: ProcessQueueMetrics;
  automation: ProcessQueueMetrics;
  convert: ProcessQueueMetrics;
}

type BulkOperation = "start" | "stop" | "restart";

function formatUptime(uptimeSec: number | null) {
  if (!Number.isFinite(uptimeSec) || uptimeSec == null || uptimeSec < 0) return "-";
  const total = Math.floor(uptimeSec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatProcessStatusLabel(processStatus: string) {
  const normalized = String(processStatus || "").trim().toLowerCase();
  if (!normalized) return "Sem telemetria";
  if (normalized === "online-local") return "Processo ativo (local)";
  if (normalized === "starting-local") return "Inicializando (local)";
  if (normalized === "offline-local") return "Processo parado (local)";
  if (normalized === "online") return "Processo ativo (PM2)";
  if (normalized === "stopped" || normalized === "stop") return "Processo parado (PM2)";
  if (normalized === "degraded") return "Processo ativo, componente sem resposta";
  if (normalized === "port-conflict") return "Porta ativa sem processo PM2";
  if (normalized === "ops-indisponivel") return "Ops indisponível";
  if (normalized === "unknown" || normalized === "desconhecido") return "Sem telemetria";
  return normalized.replace(/[-_]/g, " ");
}

export default function AdminDashboard() {
  const [counts, setCounts] = useState({
    users: 0,
    waSessions: 0,
    tgSessions: 0,
    groups: 0,
    routes: 0,
    automations: 0,
    history: 0,
    errors24h: 0,
  });
  const [isRefreshingHealth, setIsRefreshingHealth] = useState(false);
  const [opsHealth, setOpsHealth] = useState<{
    online: boolean;
    url: string;
    error: string | null;
    system: OpsSystemSnapshot | null;
    services: Record<string, OpsServiceRow>;
  }>({
    online: false,
    url: "",
    error: null,
    system: null,
    services: {},
  });
  const [serviceActionBusy, setServiceActionBusy] = useState<Record<string, boolean>>({});
  const [allServiceActionBusy, setAllServiceActionBusy] = useState<Record<string, boolean>>({});
  const [lastHealthCheckAt, setLastHealthCheckAt] = useState<string>("");
  const [processQueues, setProcessQueues] = useState<ProcessQueueSnapshot | null>(null);
  const [topUserUsage, setTopUserUsage] = useState<UserObservabilityRow[]>([]);
  const [anomalies, setAnomalies] = useState<ObservabilityAnomaly[]>([]);

  const refreshSystemObservability = async () => {
    const snapshot = await loadAdminSystemObservability();
    const global = snapshot?.global;

    if (global) {
      setCounts({
        users: Number(global.usersTotal || 0),
        waSessions: Number(global.waSessionsTotal || 0),
        tgSessions: Number(global.tgSessionsTotal || 0),
        groups: Number(global.groupsTotal || 0),
        routes: Number(global.routesTotal || 0),
        automations: Number(global.automationsTotal || 0),
        history: Number(global.history24h || 0),
        errors24h: Number(global.errors24h || 0),
      });
    }

    const ops = snapshot?.workers?.ops;
    if (ops) {
      const rows = Array.isArray(ops.services) ? ops.services : [];
      const byId: Record<string, OpsServiceRow> = {};
      for (const row of rows) {
        const id = String(row.id || "").trim();
        if (!id) continue;
        byId[id] = {
          id,
          status: String(row.status || "desconhecido"),
          online: row.online === true,
          pid: Number.isFinite(Number(row.pid)) ? Number(row.pid) : null,
          uptimeSec: Number.isFinite(Number(row.uptimeSec)) ? Number(row.uptimeSec) : null,
          appName: String(row.appName || ""),
          processStatus: String(row.processStatus || row.status || "desconhecido"),
          processOnline: row.processOnline === true,
          componentOnline: row.componentOnline === true,
          componentError: row.componentError ? String(row.componentError) : null,
          healthUrl: String(row.healthUrl || ""),
          port: Number.isFinite(Number(row.port)) ? Number(row.port) : null,
        };
      }

      const rawSystem = ops.system && typeof ops.system === "object" ? ops.system : null;
      const rawMemory = rawSystem?.memory && typeof rawSystem.memory === "object"
        ? rawSystem.memory as Record<string, unknown>
        : null;
      const rawCpu = rawSystem?.cpu && typeof rawSystem.cpu === "object"
        ? rawSystem.cpu as Record<string, unknown>
        : null;

      setOpsHealth({
        online: ops.online === true,
        url: String(ops.url || ""),
        error: ops.error ? String(ops.error) : null,
        system: rawSystem
          ? {
              pressure: String(rawSystem.pressure || "ok"),
              memory: rawMemory
                ? {
                    usedPercent: Number(rawMemory.usedPercent || 0),
                    warnPercent: Number(rawMemory.warnPercent || 0),
                    criticalPercent: Number(rawMemory.criticalPercent || 0),
                  }
                : null,
              cpu: rawCpu
                ? {
                    loadPerCpu1m: Number(rawCpu.loadPerCpu1m || 0),
                    warnPerCpu: Number(rawCpu.warnPerCpu || 0),
                    criticalPerCpu: Number(rawCpu.criticalPerCpu || 0),
                  }
                : null,
            }
          : null,
        services: byId,
      });
    }

    const queueRows = snapshot?.workers?.queues;
    if (queueRows && typeof queueRows === "object") {
      setProcessQueues({
        route: {
          active: Number(queueRows.route?.active || 0),
          pending: Number(queueRows.route?.pending || 0),
          limit: Number(queueRows.route?.limit || 0),
        },
        dispatch: {
          active: Number(queueRows.dispatch?.active || 0),
          pending: Number(queueRows.dispatch?.pending || 0),
          limit: Number(queueRows.dispatch?.limit || 0),
        },
        automation: {
          active: Number(queueRows.automation?.active || 0),
          pending: Number(queueRows.automation?.pending || 0),
          limit: Number(queueRows.automation?.limit || 0),
        },
        convert: {
          active: Number(queueRows.convert?.active || 0),
          pending: Number(queueRows.convert?.pending || 0),
          limit: Number(queueRows.convert?.limit || 0),
        },
      });
    }

    const users = Array.isArray(snapshot?.users) ? snapshot.users : [];
    const rankedByLoad = Array.isArray(snapshot?.rankings?.byLoad)
      ? snapshot.rankings.byLoad
      : [];
    const ranked = rankedByLoad
      .map((row) => users.find((user) => user.user_id === row.user_id))
      .filter((item): item is UserObservabilityRow => Boolean(item))
      .slice(0, 8);
    if (ranked.length === 0) {
      const fallback = [...users]
        .sort((a, b) => {
          const scoreA = Number(a.usage?.routesTotal || 0) + Number(a.usage?.automationsTotal || 0) + Number(a.usage?.groupsTotal || 0);
          const scoreB = Number(b.usage?.routesTotal || 0) + Number(b.usage?.automationsTotal || 0) + Number(b.usage?.groupsTotal || 0);
          return scoreB - scoreA;
        })
        .slice(0, 8);
      setTopUserUsage(fallback);
    } else {
      setTopUserUsage(ranked);
    }

    const anomalyRows = Array.isArray(snapshot?.anomalies)
      ? snapshot.anomalies
      : [];
    setAnomalies(anomalyRows.slice(0, 12));
  };

  const refreshAllHealth = async () => {
    setIsRefreshingHealth(true);
    try {
      await refreshSystemObservability();
      setLastHealthCheckAt(new Date().toISOString());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao consultar saúde dos serviços");
    } finally {
      setIsRefreshingHealth(false);
    }
  };

  const controlService = async (
    service: RuntimeServiceView["key"],
    operation: "start" | "stop" | "restart",
    options?: { silent?: boolean },
  ) => {
    setServiceActionBusy((prev) => ({ ...prev, [`${service}:${operation}`]: true }));
    try {
      const res = await invokeBackendRpc<{ ok?: boolean; status?: string }>("ops-service-control", {
        body: { service, operation },
      });

      await refreshAllHealth();
      if (!options?.silent) {
        toast.success(`${service.toUpperCase()} ${operation} concluído (${String(res.status || "ok")})`);
      }
    } catch (error) {
      if (!options?.silent) {
        toast.error(error instanceof Error ? error.message : "Falha ao controlar serviço");
      }
      throw error;
    } finally {
      setServiceActionBusy((prev) => ({ ...prev, [`${service}:${operation}`]: false }));
    }
  };

  const controlAllServices = async (operation: BulkOperation) => {
    setAllServiceActionBusy((prev) => ({ ...prev, [operation]: true }));
    try {
      await invokeBackendRpc<{ ok?: boolean }>("ops-service-control", {
        body: { service: "all", operation },
      });
      await refreshAllHealth();
      toast.success(`Ação em massa concluída: ${operation} em todos os serviços`);
    } catch {
      const failedServices: string[] = [];
      const successServices: string[] = [];
      await Promise.all(
        SERVICE_KEYS.map(async (service) => {
          try {
            await controlService(service, operation, { silent: true });
            successServices.push(service);
          } catch {
            failedServices.push(service);
          }
        }),
      );
      await refreshAllHealth();
      if (failedServices.length > 0) {
        if (failedServices.length === SERVICE_KEYS.length && !opsHealth.online) {
          toast.error(
            `Ops Control indisponível em ${opsHealth.url || "URL desconhecida"}. Inicie o microsserviço e tente novamente.`,
          );
        } else {
          toast.error(`Falha parcial na ação em massa. Serviços com erro: ${failedServices.join(", ")}`);
        }
      } else {
        toast.success(`Ação em massa concluída: ${operation} em todos os serviços`);
      }
    } finally {
      setAllServiceActionBusy((prev) => ({ ...prev, [operation]: false }));
    }
  };

  useEffect(() => {
    void refreshAllHealth();

    // Retry quickly after initial mount to handle the startup race condition
    // where vite loads faster than ops-control starts listening on :3115
    const retryId1 = setTimeout(() => void refreshAllHealth(), 3000);
    const retryId2 = setTimeout(() => void refreshAllHealth(), 8000);

    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshAllHealth();
    }, AUTO_HEALTH_INTERVAL_MS);

    const unsubscribeDb = subscribeLocalDbChanges(() => {
      void refreshAllHealth();
    });

    return () => {
      window.clearInterval(interval);
      clearTimeout(retryId1);
      clearTimeout(retryId2);
      unsubscribeDb();
    };
  }, []);

  const services = useMemo<RuntimeServiceView[]>(() => {
    const fallbackProcessStatus = opsHealth.online ? "desconhecido" : "ops-indisponivel";
    const serviceLabels: Record<RuntimeServiceView["key"], string> = {
      whatsapp: "WhatsApp",
      telegram: "Telegram",
      shopee: "Shopee",
      meli: "Mercado Livre",
    };

    return SERVICE_KEYS.map((key) => {
      const row = opsHealth.services[key] || null;
      return {
        key,
        label: serviceLabels[key],
        online: row?.online === true,
        uptimeSec: row?.uptimeSec ?? null,
        error: row?.componentError ?? null,
        url: row?.healthUrl || "",
        processStatus: row?.processStatus || row?.status || fallbackProcessStatus,
        processOnline: row?.processOnline === true,
        componentOnline: row?.componentOnline === true,
      };
    });
  }, [opsHealth.online, opsHealth.services]);

  const systemPressureBadge = useMemo(() => {
    const pressure = String(opsHealth.system?.pressure || "ok").toLowerCase();
    if (pressure === "critical") {
      return { variant: "destructive" as const, label: "Host crítico" };
    }
    if (pressure === "warn") {
      return { variant: "secondary" as const, label: "Host em alerta" };
    }
    return { variant: "default" as const, label: "Host estável" };
  }, [opsHealth.system?.pressure]);

  const allServicesOnline = useMemo(
    () => services.length > 0 && services.every((service) => service.online),
    [services],
  );

  const allServicesOffline = useMemo(
    () => services.length > 0 && services.every((service) => !service.online),
    [services],
  );

  const anyGlobalActionBusy = allServiceActionBusy.start === true || allServiceActionBusy.stop === true || allServiceActionBusy.restart === true;

  return (
    <div className="admin-page">
      <PageHeader title="Dashboard admin" description="Métricas globais e central operacional do sistema" />

      <Card className="admin-card">
        <CardHeader className="pb-2">
          <CardTitle className="admin-card-title">Controle operacional global</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 rounded-lg border p-2.5">
            <p className="text-[11px] font-semibold text-muted-foreground">Comandos globais de execução</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="default"
                size="sm"
                disabled={allServiceActionBusy.start === true || !opsHealth.online || allServicesOnline || anyGlobalActionBusy}
                onClick={() => void controlAllServices("start")}
              >
                <Play className="h-3.5 w-3.5" />
                Ligar todos
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={allServiceActionBusy.stop === true || !opsHealth.online || allServicesOffline || anyGlobalActionBusy}
                onClick={() => void controlAllServices("stop")}
              >
                <Pause className="h-3.5 w-3.5" />
                Desligar todos
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={allServiceActionBusy.restart === true || !opsHealth.online || allServicesOffline || anyGlobalActionBusy}
                onClick={() => void controlAllServices("restart")}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reiniciar todos
              </Button>
              <Button variant="outline" size="sm" onClick={refreshAllHealth} disabled={isRefreshingHealth}>
                <RefreshCw className="h-3.5 w-3.5" />
                Atualizar saúde
              </Button>
            </div>
          </div>
          <div className="admin-toolbar border-dashed text-xs text-muted-foreground">
            <span>Ops:</span>
            <Badge variant={opsHealth.online ? "default" : "secondary"}>{opsHealth.online ? "Ops online" : "Ops indisponível"}</Badge>
            <Badge variant={systemPressureBadge.variant}>{systemPressureBadge.label}</Badge>
            <span className="line-clamp-1">{opsHealth.url || "URL do Ops não configurada"}</span>
            <span>Última checagem: {lastHealthCheckAt ? new Date(lastHealthCheckAt).toLocaleTimeString("pt-BR") : "-"}</span>
          </div>
          {opsHealth.system && (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="admin-kpi">
                <p className="text-[11px] text-muted-foreground">Memória usada</p>
                <p className="font-medium">
                  {Number.isFinite(opsHealth.system.memory?.usedPercent)
                    ? `${Number(opsHealth.system.memory?.usedPercent || 0).toFixed(1)}%`
                    : "-"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  alerta: {Number.isFinite(opsHealth.system.memory?.warnPercent) ? Number(opsHealth.system.memory?.warnPercent || 0).toFixed(0) : "-"}%
                  {" | "}
                  crítico: {Number.isFinite(opsHealth.system.memory?.criticalPercent) ? Number(opsHealth.system.memory?.criticalPercent || 0).toFixed(0) : "-"}%
                </p>
              </div>
              <div className="admin-kpi">
                <p className="text-[11px] text-muted-foreground">Carga CPU por núcleo (1m)</p>
                <p className="font-medium">
                  {Number.isFinite(opsHealth.system.cpu?.loadPerCpu1m)
                    ? Number(opsHealth.system.cpu?.loadPerCpu1m || 0).toFixed(2)
                    : "-"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  alerta: {Number.isFinite(opsHealth.system.cpu?.warnPerCpu) ? Number(opsHealth.system.cpu?.warnPerCpu || 0).toFixed(2) : "-"}
                  {" | "}
                  crítico: {Number.isFinite(opsHealth.system.cpu?.criticalPerCpu) ? Number(opsHealth.system.cpu?.criticalPerCpu || 0).toFixed(2) : "-"}
                </p>
              </div>
            </div>
          )}
          {processQueues && (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="admin-kpi">
                <p className="text-[11px] text-muted-foreground">Fila de rotas</p>
                <p className="font-medium">ativo: {processQueues.route.active}</p>
                <p className="text-[11px] text-muted-foreground">pendente: {processQueues.route.pending} | limite: {processQueues.route.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-[11px] text-muted-foreground">Fila de disparo</p>
                <p className="font-medium">ativo: {processQueues.dispatch.active}</p>
                <p className="text-[11px] text-muted-foreground">pendente: {processQueues.dispatch.pending} | limite: {processQueues.dispatch.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-[11px] text-muted-foreground">Fila de automação</p>
                <p className="font-medium">ativo: {processQueues.automation.active}</p>
                <p className="text-[11px] text-muted-foreground">pendente: {processQueues.automation.pending} | limite: {processQueues.automation.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-[11px] text-muted-foreground">Fila de conversão</p>
                <p className="font-medium">ativo: {processQueues.convert.active}</p>
                <p className="text-[11px] text-muted-foreground">pendente: {processQueues.convert.pending} | limite: {processQueues.convert.limit}</p>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Checagem automática de saúde real a cada 30 segundos (componente e processo PM2).</p>
          <p className="text-xs text-muted-foreground">
            Métricas de memória e CPU são coletadas do hardware do host onde o Ops Control está rodando.
          </p>
          {opsHealth.error && <p className="text-xs text-destructive">{opsHealth.error}</p>}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {services.map((service) => (
          <Card key={service.key} className="admin-card">
            <CardHeader className="pb-1">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">{service.label}</CardTitle>
                <Badge variant={service.online ? "default" : "secondary"}>{service.online ? "Online" : "Offline"}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="admin-kpi">
                <p className="text-[11px] text-muted-foreground">Uptime</p>
                <p className="font-medium">{formatUptime(service.uptimeSec)}</p>
              </div>
              <div className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
                <span>Saúde do componente</span>
                <Badge variant={service.componentOnline ? "default" : "secondary"}>{service.componentOnline ? "Respondendo" : "Sem resposta"}</Badge>
              </div>
              <div className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
                <span>Processo PM2</span>
                <Badge variant={service.processOnline ? "default" : "secondary"}>{formatProcessStatusLabel(service.processStatus)}</Badge>
              </div>
              <p className="line-clamp-1 text-muted-foreground">{service.url || "URL de health não configurada"}</p>
              {service.error && <p className="line-clamp-2 text-destructive">{service.error}</p>}
              <div className="flex flex-wrap items-center justify-end gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={serviceActionBusy[`${service.key}:start`] === true || !opsHealth.online || service.online || anyGlobalActionBusy}
                  onClick={() => void controlService(service.key, "start")}
                >
                  <Play className="h-3.5 w-3.5" />
                  Ligar
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={serviceActionBusy[`${service.key}:stop`] === true || !opsHealth.online || !service.online || anyGlobalActionBusy}
                  onClick={() => void controlService(service.key, "stop")}
                >
                  <Pause className="h-3.5 w-3.5" />
                  Desligar
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={serviceActionBusy[`${service.key}:restart`] === true || !opsHealth.online || !service.online || anyGlobalActionBusy}
                  onClick={() => void controlService(service.key, "restart")}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reiniciar
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="ds-card-grid sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total de usuários" value={String(counts.users)} icon={Users} />
        <StatCard title="Sessões WhatsApp" value={String(counts.waSessions)} icon={WhatsAppIcon} />
        <StatCard title="Sessões Telegram" value={String(counts.tgSessions)} icon={TelegramIcon} />
        <StatCard title="Grupos" value={String(counts.groups)} icon={Users} />
        <StatCard title="Rotas ativas" value={String(counts.routes)} icon={Route} />
        <StatCard title="Automações Shopee" value={String(counts.automations)} icon={Flame} />
        <StatCard title="Registros do histórico" value={String(counts.history)} icon={BarChart3} />
        <StatCard title="Erros nas últimas 24h" value={String(counts.errors24h)} icon={AlertTriangle} />
      </div>

      <Card className="admin-card">
        <CardHeader className="pb-2">
          <CardTitle className="admin-card-title">Uso real por usuário (top 8)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {topUserUsage.length === 0 && (
            <p className="text-xs text-muted-foreground">Sem dados de uso disponíveis.</p>
          )}
          {topUserUsage.map((row) => (
            <div key={row.user_id} className="rounded-md border px-2 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">{row.name}</p>
                <Badge variant={row.account_status === "active" ? "default" : "secondary"}>{row.account_status}</Badge>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">{row.email}</p>
              <p className="text-[11px] text-muted-foreground">
                rotas: {row.usage.routesTotal} | automações: {row.usage.automationsTotal} | grupos: {row.usage.groupsTotal}
              </p>
              <p className="text-[11px] text-muted-foreground">
                WA: {row.usage.waSessionsTotal} | TG: {row.usage.tgSessionsTotal} | erros 24h: {row.usage.errors24h}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="admin-card">
        <CardHeader className="pb-2">
          <CardTitle className="admin-card-title">Alertas automáticos do sistema</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {anomalies.length === 0 && (
            <p className="text-xs text-muted-foreground">Nenhuma anomalia detectada no momento.</p>
          )}
          {anomalies.map((item) => (
            <div key={item.id} className="rounded-md border px-2 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">{item.title}</p>
                <Badge variant={item.severity === "critical" ? "destructive" : item.severity === "warning" ? "secondary" : "outline"}>
                  {item.severity}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">{item.message}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

