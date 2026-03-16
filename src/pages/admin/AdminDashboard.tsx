import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3, Flame, Route, Users, AlertTriangle, Play, Square, RotateCcw,
  RefreshCw, Loader2, Copy, Power, Server, Activity, Cpu,
  HardDrive, Clock, Circle, ShieldCheck, Eye,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { TelegramIcon, WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import { loadAdminSystemObservability, type ObservabilityAnomaly, type UserObservabilityRow } from "@/lib/system-observability";

const SERVICE_KEYS = ["whatsapp", "telegram", "shopee", "meli"] as const;
const AUTO_HEALTH_INTERVAL_MS = 30 * 1000;

const SERVICE_META: Record<string, { label: string; port: number; color: string }> = {
  whatsapp: { label: "WhatsApp", port: 3111, color: "text-green-500" },
  telegram: { label: "Telegram", port: 3112, color: "text-blue-500" },
  shopee: { label: "Shopee", port: 3113, color: "text-orange-500" },
  meli: { label: "Mercado Livre", port: 3114, color: "text-yellow-500" },
};

function ServiceIcon({ id, className }: { id: string; className?: string }) {
  if (id === "whatsapp") return <WhatsAppIcon className={className} />;
  if (id === "telegram") return <TelegramIcon className={className} />;
  if (id === "shopee") return <Flame className={className} />;
  return <BarChart3 className={className} />;
}

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

interface OpsControlResultItem {
  ok?: boolean;
  service?: string;
  status?: string;
  error?: string;
}

interface OpsControlResponse {
  ok?: boolean;
  status?: string;
  error?: string;
  results?: OpsControlResultItem[];
}

interface CommandStatus {
  phase: "idle" | "running" | "success" | "error";
  title: string;
  detail: string;
}

type ServiceOperation = "start" | "stop" | "restart" | "pause";
type BulkOperation = ServiceOperation;
type SystemOperation = "start" | "restart" | "pause" | "shutdown";

const SERVICE_OPERATION_LABEL: Record<ServiceOperation, string> = {
  start: "iniciar",
  stop: "desligar",
  restart: "reiniciar",
  pause: "pausar",
};

const SYSTEM_OPERATION_LABEL: Record<SystemOperation, string> = {
  start: "iniciar sistema",
  restart: "reiniciar sistema",
  pause: "pausar sistema",
  shutdown: "desligar sistema",
};

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

function formatComponentStatusLabel(componentOnline: boolean, componentError: string | null) {
  if (componentOnline) return "Componente respondendo";
  if (componentError) return "Componente sem resposta";
  return "Componente indisponível";
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
  const [systemActionBusy, setSystemActionBusy] = useState<Record<string, boolean>>({});
  const [lastHealthCheckAt, setLastHealthCheckAt] = useState<string>("");
  const [opsConnecting, setOpsConnecting] = useState(true);
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [commandStatus, setCommandStatus] = useState<CommandStatus>({
    phase: "idle",
    title: "Sem comando em execução",
    detail: "",
  });
  const [processQueues, setProcessQueues] = useState<ProcessQueueSnapshot | null>(null);
  const [topUserUsage, setTopUserUsage] = useState<UserObservabilityRow[]>([]);
  const [anomalies, setAnomalies] = useState<ObservabilityAnomaly[]>([]);
  const [nextRefreshIn, setNextRefreshIn] = useState(AUTO_HEALTH_INTERVAL_MS / 1000);
  const lastRefreshTsRef = useRef(Date.now());

  const refreshSystemObservability = useCallback(async () => {
    const [snapshot, maintenance] = await Promise.all([
      loadAdminSystemObservability(),
      invokeBackendRpc<{ maintenance_enabled?: boolean }>("admin-maintenance", { body: { action: "get" } }).catch(() => ({ maintenance_enabled: false })),
    ]);
    setMaintenanceEnabled(maintenance?.maintenance_enabled === true);
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
  }, []);

  const refreshAllHealth = useCallback(async () => {
    setIsRefreshingHealth(true);
    try {
      await refreshSystemObservability();
      setLastHealthCheckAt(new Date().toISOString());
      lastRefreshTsRef.current = Date.now();
      setNextRefreshIn(AUTO_HEALTH_INTERVAL_MS / 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao consultar saúde dos serviços");
    } finally {
      setIsRefreshingHealth(false);
    }
  }, [refreshSystemObservability]);

  const controlService = async (
    service: RuntimeServiceView["key"],
    operation: ServiceOperation,
    options?: { silent?: boolean; refreshAfter?: boolean },
  ) => {
    const backendOperation = operation === "pause" ? "stop" : operation;
    setServiceActionBusy((prev) => ({ ...prev, [`${service}:${operation}`]: true }));
    try {
      setCommandStatus({
        phase: "running",
        title: `${service.toUpperCase()} em execução`,
        detail: `${SERVICE_OPERATION_LABEL[operation]} em andamento...`,
      });

      const res = await invokeBackendRpc<OpsControlResponse>("ops-service-control", {
        body: { service, operation: backendOperation },
      });

      if (res?.ok === false) {
        throw new Error(String(res.error || `Falha ao ${SERVICE_OPERATION_LABEL[operation]} ${service}`));
      }

      if (options?.refreshAfter !== false) {
        await refreshAllHealth();
      }

      setCommandStatus({
        phase: "success",
        title: `${service.toUpperCase()} concluído`,
        detail: `${SERVICE_OPERATION_LABEL[operation]} executado com sucesso.`,
      });

      if (!options?.silent) {
        toast.success(`${service.toUpperCase()} ${SERVICE_OPERATION_LABEL[operation]}: ${String(res.status || "ok")}`);
      }
    } catch (error) {
      setCommandStatus({
        phase: "error",
        title: `${service.toUpperCase()} falhou`,
        detail: error instanceof Error ? error.message : "Falha ao controlar serviço",
      });
      if (!options?.silent) {
        toast.error(error instanceof Error ? error.message : "Falha ao controlar serviço");
      }
      throw error;
    } finally {
      setServiceActionBusy((prev) => ({ ...prev, [`${service}:${operation}`]: false }));
    }
  };

  const controlAllServices = async (operation: BulkOperation, options?: { silent?: boolean; throwOnFailure?: boolean }) => {
    const backendOperation = operation === "pause" ? "stop" : operation;
    const allSuccessMessage = `Serviços: ${SERVICE_OPERATION_LABEL[operation]} concluído em todos`;
    const reportBulkFailure = (detail: string) => {
      setCommandStatus({
        phase: "error",
        title: "Falha em comando em massa",
        detail,
      });
      if (!options?.silent) toast.error(detail);
      if (options?.throwOnFailure) throw new Error(detail);
    };

    setAllServiceActionBusy((prev) => ({ ...prev, [operation]: true }));
    try {
      setCommandStatus({
        phase: "running",
        title: "Comando em massa em execução",
        detail: `Tentando ${SERVICE_OPERATION_LABEL[operation]} todos os serviços...`,
      });

      const response = await invokeBackendRpc<OpsControlResponse>("ops-service-control", {
        body: { service: "all", operation: backendOperation },
      });

      const initialFailures = Array.isArray(response.results)
        ? response.results.filter((item) => item?.ok === false && item?.service)
        : [];

      if (response?.ok === false || initialFailures.length > 0) {
        if (response?.ok === false && initialFailures.length === 0) {
          reportBulkFailure(String(response?.error || `Falha ao ${SERVICE_OPERATION_LABEL[operation]} todos os serviços`));
          return;
        }

        const retryTargets = initialFailures
          .map((item) => String(item.service || "").trim().toLowerCase())
          .filter((svc): svc is RuntimeServiceView["key"] => SERVICE_KEYS.includes(svc as RuntimeServiceView["key"]));

        const retryFailed: string[] = [];
        if (retryTargets.length > 0) {
          await Promise.all(
            retryTargets.map(async (svc) => {
              try {
                await controlService(svc, operation, { silent: true, refreshAfter: false });
              } catch {
                retryFailed.push(svc);
              }
            }),
          );
        }

        await refreshAllHealth();

        if (retryFailed.length > 0) {
          reportBulkFailure(`Falha em massa ao ${SERVICE_OPERATION_LABEL[operation]}: ${retryFailed.join(", ")}`);
          return;
        }
      }

      await refreshAllHealth();
      setCommandStatus({
        phase: "success",
        title: "Comando em massa concluído",
        detail: `Serviços: ${SERVICE_OPERATION_LABEL[operation]} concluído em todos.`,
      });
      if (!options?.silent) toast.success(allSuccessMessage);
    } catch (error) {
      const failedServices: string[] = [];
      await Promise.all(
        SERVICE_KEYS.map(async (service) => {
          try {
            await controlService(service, operation, { silent: true, refreshAfter: false });
          } catch {
            failedServices.push(service);
          }
        }),
      );
      await refreshAllHealth();
      if (failedServices.length > 0) {
        const detail = failedServices.length === SERVICE_KEYS.length && !opsHealth.online
          ? `Ops Control indisponível em ${opsHealth.url || "URL desconhecida"}. Inicie o microsserviço e tente novamente.`
          : `Falha parcial na ação em massa. Serviços com erro: ${failedServices.join(", ")}`;
        reportBulkFailure(detail);
      } else {
        setCommandStatus({
          phase: "success",
          title: "Recuperação automática concluída",
          detail: `Serviços: ${SERVICE_OPERATION_LABEL[operation]} concluído após retentativa.`,
        });
        if (!options?.silent) toast.success(allSuccessMessage);
      }

      if (error instanceof Error) {
        console.warn("[admin-dashboard] fallback de controle em massa acionado:", error.message);
      }
      if (options?.throwOnFailure && error instanceof Error) {
        throw error;
      }
    } finally {
      setAllServiceActionBusy((prev) => ({ ...prev, [operation]: false }));
    }
  };

  const updateMaintenanceMode = useCallback(async (enabled: boolean) => {
    await invokeBackendRpc("admin-maintenance", {
      body: {
        action: "set",
        maintenance_enabled: enabled,
        maintenance_title: enabled ? "Sistema pausado" : "Sistema operacional",
        maintenance_message: enabled
          ? "Operação pausada temporariamente pelo painel admin."
          : "Sistema operando normalmente.",
        allow_admin_bypass: true,
      },
    });
    setMaintenanceEnabled(enabled);
  }, []);

  const controlSystem = async (operation: SystemOperation) => {
    setSystemActionBusy((prev) => ({ ...prev, [operation]: true }));
    try {
      setCommandStatus({
        phase: "running",
        title: "Comando de sistema em execução",
        detail: `${SYSTEM_OPERATION_LABEL[operation]} em andamento...`,
      });

      // When starting/restarting, try to bring ops-control online automatically.
      // This unlocks the flow where a fresh dev machine has no services running yet.
      if ((operation === "start" || operation === "restart") && !opsHealth.online) {
        setCommandStatus({
          phase: "running",
          title: "Inicializando orquestrador",
          detail: "Tentando iniciar o Ops Control...",
        });
        await invokeBackendRpc("ops-bootstrap", { body: {} });
        await refreshAllHealth();
      }

      if (operation === "start") {
        await updateMaintenanceMode(false);
        await controlAllServices("start", { silent: true, throwOnFailure: true });
      } else if (operation === "restart") {
        await updateMaintenanceMode(false);
        await controlAllServices("restart", { silent: true, throwOnFailure: true });
      } else if (operation === "pause") {
        await updateMaintenanceMode(true);
        await controlAllServices("pause", { silent: true, throwOnFailure: true });
      } else {
        await updateMaintenanceMode(true);
        await controlAllServices("stop", { silent: true, throwOnFailure: true });
      }

      await refreshAllHealth();
      setCommandStatus({
        phase: "success",
        title: "Comando de sistema concluído",
        detail: `${SYSTEM_OPERATION_LABEL[operation]} executado com sucesso.`,
      });
      toast.success(`Comando concluído: ${SYSTEM_OPERATION_LABEL[operation]}`);
    } catch (error) {
      setCommandStatus({
        phase: "error",
        title: "Comando de sistema falhou",
        detail: error instanceof Error ? error.message : `Falha ao ${SYSTEM_OPERATION_LABEL[operation]}`,
      });
      toast.error(error instanceof Error ? error.message : `Falha ao ${SYSTEM_OPERATION_LABEL[operation]}`);
      throw error;
    } finally {
      setSystemActionBusy((prev) => ({ ...prev, [operation]: false }));
    }
  };

  useEffect(() => {
    // Startup retry: try connecting to ops-control at boot
    // (handles the race condition where vite loads faster than ops-control).
    // Retries at 0s, 3s, 10s — then switches to normal 30s polling.
    const startupDelays = [0, 3000, 10000];
    const startupTimers: number[] = [];
    let startupDone = false;

    for (const delay of startupDelays) {
      const id = window.setTimeout(async () => {
        await refreshAllHealth();
        if (opsHealth.online && !startupDone) {
          startupDone = true;
          setOpsConnecting(false);
        }
      }, delay);
      startupTimers.push(id);
    }

    // After 12s of retries, mark connecting as done regardless
    const connectingTimeout = window.setTimeout(() => setOpsConnecting(false), 12000);

    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshAllHealth();
    }, AUTO_HEALTH_INTERVAL_MS);

    let dbChangeTimer: number | undefined;
    const unsubscribeDb = subscribeLocalDbChanges(() => {
      // Debounce: avoid cascading refreshes from rapid DB change events
      window.clearTimeout(dbChangeTimer);
      dbChangeTimer = window.setTimeout(() => void refreshAllHealth(), 5000);
    });

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(dbChangeTimer);
      for (const id of startupTimers) window.clearTimeout(id);
      window.clearTimeout(connectingTimeout);
      unsubscribeDb();
    };
  }, [refreshAllHealth]); // eslint-disable-line react-hooks/exhaustive-deps

  // When ops comes online, stop the connecting indicator
  useEffect(() => {
    if (opsHealth.online) setOpsConnecting(false);
  }, [opsHealth.online]);

  // Countdown timer for next auto-refresh
  useEffect(() => {
    const tick = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastRefreshTsRef.current) / 1000);
      const remaining = Math.max(AUTO_HEALTH_INTERVAL_MS / 1000 - elapsed, 0);
      setNextRefreshIn(remaining);
    }, 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (commandStatus.phase !== "running") return;
    const fastSync = window.setInterval(() => {
      void refreshAllHealth();
    }, 2000);
    return () => window.clearInterval(fastSync);
  }, [commandStatus.phase, refreshAllHealth]);

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

  const anyGlobalActionBusy = allServiceActionBusy.start === true
    || allServiceActionBusy.stop === true
    || allServiceActionBusy.restart === true
    || allServiceActionBusy.pause === true
    ;
  const anySystemActionBusy = systemActionBusy.start === true
    || systemActionBusy.restart === true
    || systemActionBusy.pause === true
    || systemActionBusy.shutdown === true;
  const anyServiceBulkActionBusy = allServiceActionBusy.start === true
    || allServiceActionBusy.stop === true
    || allServiceActionBusy.restart === true
    || allServiceActionBusy.pause === true;

  const onlineCount = useMemo(() => services.filter((s) => s.online).length, [services]);
  const totalCount = services.length;
  const systemStatusLabel = useMemo(() => {
    if (opsConnecting) return { text: "Conectando...", variant: "secondary" as const };
    if (!opsHealth.online) return { text: "Ops indisponível", variant: "destructive" as const };
    if (onlineCount === totalCount) return { text: "Tudo operacional", variant: "default" as const };
    if (onlineCount === 0) return { text: "Tudo parado", variant: "destructive" as const };
    return { text: `${onlineCount}/${totalCount} online`, variant: "secondary" as const };
  }, [opsConnecting, opsHealth.online, onlineCount, totalCount]);

  return (
    <TooltipProvider>
    <div className="admin-page max-w-[1320px] px-1 sm:px-2 lg:px-3">
      <PageHeader title="Dashboard admin" description="Central operacional do sistema">
        <div className="flex items-center gap-2">
          <Badge variant={systemStatusLabel.variant} className="gap-1.5">
            <Circle className={`h-2 w-2 fill-current ${onlineCount === totalCount && opsHealth.online ? "text-green-500" : onlineCount > 0 ? "text-yellow-500" : "text-red-500"}`} />
            {systemStatusLabel.text}
          </Badge>
          <Badge variant={systemPressureBadge.variant}>{systemPressureBadge.label}</Badge>
          {isRefreshingHealth && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      </PageHeader>

      <Card className="admin-card overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="admin-card-title">Controle operacional</CardTitle>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Próx. check: {nextRefreshIn}s</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-3 sm:p-4">
            <div className="grid gap-2 lg:grid-cols-2">
              <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold">Controles do sistema</p>
                  <Badge variant={maintenanceEnabled ? "secondary" : "default"} className="text-[10px]">
                    {maintenanceEnabled ? "Sistema pausado" : "Sistema ativo"}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy}
                    onClick={() => void controlSystem("start")}
                  >
                    {systemActionBusy.start ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Iniciar sistema
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy}
                    onClick={() => void controlSystem("restart")}
                  >
                    {systemActionBusy.restart ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Reiniciar sistema
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy || !opsHealth.online}
                    onClick={() => void controlSystem("pause")}
                  >
                    {systemActionBusy.pause ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                    Pausar sistema
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy || !opsHealth.online}
                    onClick={() => void controlSystem("shutdown")}
                  >
                    {systemActionBusy.shutdown ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                    Desligar sistema
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold">Controles dos serviços</p>
                  <Badge variant={onlineCount === totalCount ? "default" : "secondary"} className="text-[10px]">
                    {onlineCount}/{totalCount} online
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    disabled={allServiceActionBusy.start === true || !opsHealth.online || allServicesOnline || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("start")}
                  >
                    <Play className="h-3.5 w-3.5" />
                    Iniciar serviços
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={allServiceActionBusy.restart === true || !opsHealth.online || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("restart")}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reiniciar serviços
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={allServiceActionBusy.pause === true || !opsHealth.online || allServicesOffline || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("pause")}
                  >
                    <Square className="h-3.5 w-3.5" />
                    Pausar serviços
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={allServiceActionBusy.stop === true || !opsHealth.online || allServicesOffline || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("stop")}
                  >
                    <Power className="h-3.5 w-3.5" />
                    Desligar serviços
                  </Button>
                </div>
              </div>
            </div>

            <div className={`rounded-md border px-3 py-2 text-xs ${
              commandStatus.phase === "running"
                ? "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                : commandStatus.phase === "error"
                  ? "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
                  : commandStatus.phase === "success"
                    ? "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200"
                    : "border-border/60 bg-muted/20 text-muted-foreground"
            }`}>
              <div className="flex items-center gap-2">
                {commandStatus.phase === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
                <p className="font-semibold">{commandStatus.title}</p>
              </div>
              {commandStatus.detail && <p className="mt-1 opacity-90">{commandStatus.detail}</p>}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={refreshAllHealth}
                disabled={isRefreshingHealth}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Atualizar saúde
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={opsHealth.online ? "default" : "secondary"} className="gap-1.5">
              <Circle className={`h-1.5 w-1.5 fill-current ${opsHealth.online ? "text-green-500" : "text-red-500"}`} />
              {opsHealth.online ? "Ops online" : "Ops offline"}
            </Badge>
            <span className="text-[11px]">{opsHealth.url || "-"}</span>
            <span className="text-[11px]">Último: {lastHealthCheckAt ? new Date(lastHealthCheckAt).toLocaleTimeString("pt-BR") : "-"}</span>
          </div>
          {opsHealth.system && (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="admin-kpi space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <HardDrive className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Memória</span>
                  </div>
                  <span className="text-xs font-semibold">
                    {Number.isFinite(opsHealth.system.memory?.usedPercent)
                      ? `${Number(opsHealth.system.memory?.usedPercent || 0).toFixed(1)}%`
                      : "-"}
                  </span>
                </div>
                <Progress value={Number(opsHealth.system.memory?.usedPercent || 0)} className="h-2" />
                <p className="text-[11px] text-muted-foreground">
                  alerta: {Number.isFinite(opsHealth.system.memory?.warnPercent) ? `${Number(opsHealth.system.memory?.warnPercent || 0).toFixed(0)}%` : "-"}
                  {" · "}
                  crítico: {Number.isFinite(opsHealth.system.memory?.criticalPercent) ? `${Number(opsHealth.system.memory?.criticalPercent || 0).toFixed(0)}%` : "-"}
                </p>
              </div>
              <div className="admin-kpi space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Cpu className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">CPU / núcleo (1m)</span>
                  </div>
                  <span className="text-xs font-semibold">
                    {Number.isFinite(opsHealth.system.cpu?.loadPerCpu1m)
                      ? Number(opsHealth.system.cpu?.loadPerCpu1m || 0).toFixed(2)
                      : "-"}
                  </span>
                </div>
                <Progress value={Math.min(Number(opsHealth.system.cpu?.loadPerCpu1m || 0) * 50, 100)} className="h-2" />
                <p className="text-[11px] text-muted-foreground">
                  alerta: {Number.isFinite(opsHealth.system.cpu?.warnPerCpu) ? Number(opsHealth.system.cpu?.warnPerCpu || 0).toFixed(2) : "-"}
                  {" · "}
                  crítico: {Number.isFinite(opsHealth.system.cpu?.criticalPerCpu) ? Number(opsHealth.system.cpu?.criticalPerCpu || 0).toFixed(2) : "-"}
                </p>
              </div>
            </div>
          )}
          {processQueues && (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="admin-kpi">
                <p className="text-xs text-muted-foreground">Fila de rotas</p>
                <p className="font-medium">ativo: {processQueues.route.active}</p>
                <p className="text-xs text-muted-foreground">pendente: {processQueues.route.pending} | limite: {processQueues.route.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-xs text-muted-foreground">Fila de disparo</p>
                <p className="font-medium">ativo: {processQueues.dispatch.active}</p>
                <p className="text-xs text-muted-foreground">pendente: {processQueues.dispatch.pending} | limite: {processQueues.dispatch.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-xs text-muted-foreground">Fila de automação</p>
                <p className="font-medium">ativo: {processQueues.automation.active}</p>
                <p className="text-xs text-muted-foreground">pendente: {processQueues.automation.pending} | limite: {processQueues.automation.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-xs text-muted-foreground">Fila de conversão</p>
                <p className="font-medium">ativo: {processQueues.convert.active}</p>
                <p className="text-xs text-muted-foreground">pendente: {processQueues.convert.pending} | limite: {processQueues.convert.limit}</p>
              </div>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Auto-checagem a cada 30s. Status combina processo + endpoint de saúde.</p>
          {opsHealth.error && <p className="text-xs text-destructive">{opsHealth.error}</p>}
          {!opsHealth.online && opsConnecting && (
            <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800 dark:bg-blue-950">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
              <p className="text-xs text-blue-700 dark:text-blue-300">
                Conectando ao Ops Control... aguarde enquanto o serviço inicializa.
              </p>
            </div>
          )}
          {!opsHealth.online && !opsConnecting && (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                Ops Control indisponível — inicie o serviço de orquestração para reativar os comandos.
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Se o Ops Control não iniciar automaticamente, execute no terminal:
              </p>
              <div className="flex items-center gap-2">
                <code className="rounded bg-amber-100 px-2 py-1 text-xs dark:bg-amber-900">npm run svc:ops:dev</code>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    navigator.clipboard.writeText("npm run svc:ops:dev").then(() => toast.success("Comando copiado!"));
                  }}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Os estados abaixo refletem checagem direta de saúde de cada serviço.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="services" className="w-full space-y-4">
        <TabsList className="w-full flex-wrap justify-start gap-1 rounded-xl border border-border/70 bg-card/60 p-1">
          <TabsTrigger value="services" className="gap-1.5">
            <Server className="h-3.5 w-3.5" />
            Serviços
            <Badge variant={onlineCount === totalCount ? "default" : "secondary"} className="ml-1 px-1.5 py-0 text-[10px]">
              {onlineCount}/{totalCount}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="metrics" className="gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            Métricas
          </TabsTrigger>
          <TabsTrigger value="usage" className="gap-1.5">
            <Eye className="h-3.5 w-3.5" />
            Uso
          </TabsTrigger>
          <TabsTrigger value="alerts" className="gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            Alertas
            {anomalies.length > 0 && (
              <Badge variant="destructive" className="ml-1 px-1.5 py-0 text-[10px]">{anomalies.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="services">

      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {services.map((service) => {
          const meta = SERVICE_META[service.key];
          return (
            <Card key={service.key} className={`admin-card flex h-full min-h-[260px] flex-col transition-all ${service.online ? "border-green-500/20 dark:border-green-700/20" : ""}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${service.online ? "bg-green-100 dark:bg-green-900/30" : "bg-muted"}`}>
                      <ServiceIcon id={service.key} className={`h-3.5 w-3.5 ${service.online ? (meta?.color || "text-foreground") : "text-muted-foreground"}`} />
                    </div>
                    <div>
                      <CardTitle className="text-sm font-semibold">{service.label}</CardTitle>
                      <p className="text-[11px] text-muted-foreground">:{meta?.port ?? "?"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Circle className={`h-2 w-2 fill-current ${service.online ? "text-green-500" : "text-red-400"}`} />
                    <span className={`text-xs font-medium ${service.online ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
                      {service.online ? "Online" : "Offline"}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-2 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div className="admin-kpi">
                    <p className="text-[11px] text-muted-foreground">Uptime</p>
                    <p className="font-semibold">{formatUptime(service.uptimeSec)}</p>
                  </div>
                  <div className="admin-kpi">
                    <p className="text-[11px] text-muted-foreground">Processo</p>
                    <p className="font-semibold text-[11px]">{formatProcessStatusLabel(service.processStatus)}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-1 rounded-lg border border-border/50 px-2 py-1">
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className={`h-3 w-3 ${service.componentOnline ? "text-green-500" : "text-muted-foreground"}`} />
                    <span className="text-[11px]">Health check</span>
                  </div>
                  <Badge variant={service.componentOnline ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                    {service.componentOnline ? "OK" : "Falha"}
                  </Badge>
                </div>
                {service.error && <p className="line-clamp-2 text-destructive text-[11px]">{service.error}</p>}
                <div className="mt-auto flex flex-wrap items-center justify-end gap-1 pt-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={serviceActionBusy[`${service.key}:start`] === true || !opsHealth.online || service.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "start")}
                      >
                        {serviceActionBusy[`${service.key}:start`] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                        Ligar
                      </Button>
                    </TooltipTrigger>
                    {!opsHealth.online && <TooltipContent>Ops indisponível: inicie o serviço de orquestração primeiro</TooltipContent>}
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={serviceActionBusy[`${service.key}:pause`] === true || !opsHealth.online || !service.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "pause")}
                      >
                        {serviceActionBusy[`${service.key}:pause`] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                        Pausar
                      </Button>
                    </TooltipTrigger>
                    {!opsHealth.online && <TooltipContent>Ops indisponível: inicie o serviço de orquestração primeiro</TooltipContent>}
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={serviceActionBusy[`${service.key}:restart`] === true || !opsHealth.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "restart")}
                      >
                        {serviceActionBusy[`${service.key}:restart`] ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                        Reiniciar
                      </Button>
                    </TooltipTrigger>
                    {!opsHealth.online && <TooltipContent>Ops indisponível: inicie o serviço de orquestração primeiro</TooltipContent>}
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={serviceActionBusy[`${service.key}:stop`] === true || !opsHealth.online || !service.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "stop")}
                      >
                        {serviceActionBusy[`${service.key}:stop`] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
                        Desligar
                      </Button>
                    </TooltipTrigger>
                    {!opsHealth.online && <TooltipContent>Ops indisponível: inicie o serviço de orquestração primeiro</TooltipContent>}
                  </Tooltip>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Processo: {formatProcessStatusLabel(service.processStatus)} · {formatComponentStatusLabel(service.componentOnline, service.error)}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

        </TabsContent>

        <TabsContent value="metrics">
      <div className="ds-card-grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total de usuários" value={String(counts.users)} icon={Users} />
        <StatCard title="Sessões WhatsApp" value={String(counts.waSessions)} icon={WhatsAppIcon} />
        <StatCard title="Sessões Telegram" value={String(counts.tgSessions)} icon={TelegramIcon} />
        <StatCard title="Grupos" value={String(counts.groups)} icon={Users} />
        <StatCard title="Rotas ativas" value={String(counts.routes)} icon={Route} />
        <StatCard title="Automações Shopee" value={String(counts.automations)} icon={Flame} />
        <StatCard title="Registros 24h" value={String(counts.history)} icon={BarChart3} />
        <StatCard title="Erros 24h" value={String(counts.errors24h)} icon={AlertTriangle} />
      </div>
        </TabsContent>

        <TabsContent value="usage">
      <Card className="admin-card overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="admin-card-title">Uso por usuário (top 8)</CardTitle>
            <Badge variant="outline" className="text-[10px]">{topUserUsage.length} usuários</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {topUserUsage.length === 0 && (
            <p className="text-xs text-muted-foreground">Sem dados de uso disponíveis.</p>
          )}
          {topUserUsage.map((row) => (
            <div key={row.user_id} className="rounded-xl border border-border/70 px-3 py-2.5 text-xs transition-colors hover:bg-muted/30">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                    {String(row.name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="truncate font-medium">{row.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{row.email}</p>
                  </div>
                </div>
                <Badge variant={row.account_status === "active" ? "default" : "secondary"} className="text-[10px]">{row.account_status}</Badge>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                <span>Rotas: <strong className="text-foreground">{row.usage.routesTotal}</strong></span>
                <span>Automações: <strong className="text-foreground">{row.usage.automationsTotal}</strong></span>
                <span>Grupos: <strong className="text-foreground">{row.usage.groupsTotal}</strong></span>
                <span>WA: <strong className="text-foreground">{row.usage.waSessionsTotal}</strong></span>
                <span>TG: <strong className="text-foreground">{row.usage.tgSessionsTotal}</strong></span>
                <span>Erros 24h: <strong className={`${Number(row.usage.errors24h) > 0 ? "text-destructive" : "text-foreground"}`}>{row.usage.errors24h}</strong></span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="alerts">
      <Card className="admin-card overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="admin-card-title">Alertas do sistema</CardTitle>
            <Badge variant={anomalies.length > 0 ? "destructive" : "default"} className="text-[10px]">
              {anomalies.length > 0 ? `${anomalies.length} alerta${anomalies.length > 1 ? "s" : ""}` : "Tudo limpo"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {anomalies.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <ShieldCheck className="h-8 w-8 text-green-500" />
              <p className="text-sm font-medium text-green-600 dark:text-green-400">Nenhuma anomalia detectada</p>
              <p className="text-xs text-muted-foreground">O sistema está operando normalmente.</p>
            </div>
          )}
          {anomalies.map((item) => (
            <div key={item.id} className={`rounded-xl border px-3 py-2.5 text-xs ${item.severity === "critical" ? "border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/30" : item.severity === "warning" ? "border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/30" : "border-border/70"}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className={`h-3.5 w-3.5 ${item.severity === "critical" ? "text-red-500" : item.severity === "warning" ? "text-amber-500" : "text-muted-foreground"}`} />
                  <p className="truncate font-medium">{item.title}</p>
                </div>
                <Badge variant={item.severity === "critical" ? "destructive" : item.severity === "warning" ? "secondary" : "outline"}>
                  {item.severity}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{item.message}</p>
            </div>
          ))}
        </CardContent>
      </Card>
        </TabsContent>

      </Tabs>
    </div>
    </TooltipProvider>
  );
}
