import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3, ShoppingBag, ShoppingCart, Route, Users, AlertTriangle, Play, RotateCcw,
  RefreshCw, Loader2, Copy, Power, Server, Activity, Cpu,
  HardDrive, Clock, Circle, ShieldCheck, Eye, Edit2,
  TrendingUp, Wifi, WifiOff, DollarSign,
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import { loadAdminSystemObservability, type ObservabilityAnomaly, type UserObservabilityRow } from "@/lib/system-observability";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";

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
  if (id === "telegram")  return <TelegramIcon className={className} />;
  if (id === "shopee")    return <ShoppingBag className={className} />;
  return <ShoppingCart className={className} />; // meli
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

type ServiceOperation = "start" | "stop" | "restart";
type BulkOperation = ServiceOperation;
type SystemOperation = "start" | "restart" | "shutdown";

const SERVICE_OPERATION_LABEL: Record<ServiceOperation, string> = {
  start: "Iniciar",
  stop: "Desligar",
  restart: "Reiniciar",
};

const SYSTEM_OPERATION_LABEL: Record<SystemOperation, string> = {
  start: "Iniciar Sistema",
  restart: "Reiniciar Sistema",
  shutdown: "Desligar Sistema",
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
  if (!normalized) return "Sem info";
  if (normalized === "online-local") return "Ativo (Local)";
  if (normalized === "starting-local") return "Iniciando (Local)";
  if (normalized === "offline-local") return "Parado (Local)";
  if (normalized === "online") return "Ativo (PM2)";
  if (normalized === "stopped" || normalized === "stop") return "Parado (PM2)";
  if (normalized === "degraded") return "Ativo, app sem resposta";
  if (normalized === "port-conflict") return "Porta ocupada sem processo PM2";
  if (normalized === "ops-indisponivel") return "Ops fora do ar";
  if (normalized === "unknown" || normalized === "desconhecido") return "Sem info";
  return normalized.replace(/[-_]/g, " ");
}

function formatComponentStatusLabel(componentOnline: boolean, componentError: string | null) {
  if (componentOnline) return "App respondendo";
  if (componentError) return "App sem resposta";
  return "App fora do ar";
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
    title: "Monitor de Operações",
    detail: "Aqui vai aparecer o que tá rolando com o sistema",
  });
  const [processQueues, setProcessQueues] = useState<ProcessQueueSnapshot | null>(null);
  const [topUserUsage, setTopUserUsage] = useState<UserObservabilityRow[]>([]);
  const [allObsUsers, setAllObsUsers] = useState<UserObservabilityRow[]>([]);
  const [anomalies, setAnomalies] = useState<ObservabilityAnomaly[]>([]);
  const { state: controlPlane } = useAdminControlPlane();
  const [nextRefreshIn, setNextRefreshIn] = useState(AUTO_HEALTH_INTERVAL_MS / 1000);
  const lastRefreshTsRef = useRef(Date.now());
  
  // Port edit modal state
  const [editPortService, setEditPortService] = useState<RuntimeServiceView["key"] | null>(null);
  const [editPortValue, setEditPortValue] = useState<string>("");
  const [editPortBusy, setEditPortBusy] = useState(false);

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
    setAllObsUsers(users);
  }, []);

  const refreshAllHealth = useCallback(async () => {
    setIsRefreshingHealth(true);
    try {
      await refreshSystemObservability();
      setLastHealthCheckAt(new Date().toISOString());
      lastRefreshTsRef.current = Date.now();
      setNextRefreshIn(AUTO_HEALTH_INTERVAL_MS / 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra checar os serviços");
    } finally {
      setIsRefreshingHealth(false);
    }
  }, [refreshSystemObservability]);

  const controlService = async (
    service: RuntimeServiceView["key"],
    operation: ServiceOperation,
    options?: { silent?: boolean; refreshAfter?: boolean },
  ) => {
    setServiceActionBusy((prev) => ({ ...prev, [`${service}:${operation}`]: true }));
    try {
      const serviceName = SERVICE_META[service]?.label || service;
      setCommandStatus({
        phase: "running",
        title: `Controlando ${serviceName}`,
        detail: `${SERVICE_OPERATION_LABEL[operation]} em andamento...`,
      });

      const res = await invokeBackendRpc<OpsControlResponse>("ops-service-control", {
        body: { service, operation },
      });

      if (res?.ok === false) {
        throw new Error(String(res.error || `Não deu pra ${SERVICE_OPERATION_LABEL[operation]} ${serviceName}`));
      }

      if (options?.refreshAfter !== false) {
        await refreshAllHealth();
      }

      setCommandStatus({
        phase: "success",
        title: `${serviceName} pronto`,
        detail: `${SERVICE_OPERATION_LABEL[operation]} feito!`,
      });

      if (!options?.silent) {
        toast.success(`${serviceName} — ${SERVICE_OPERATION_LABEL[operation]} feito!`);
      }
    } catch (error) {
      const serviceName = SERVICE_META[service]?.label || service;
      const errorMsg = error instanceof Error ? error.message : `Não deu pra ${SERVICE_OPERATION_LABEL[operation]}`;
      setCommandStatus({
        phase: "error",
        title: `${serviceName} — erro`,
        detail: errorMsg,
      });
      if (!options?.silent) {
        toast.error(errorMsg);
      }
      throw error;
    } finally {
      setServiceActionBusy((prev) => ({ ...prev, [`${service}:${operation}`]: false }));
    }
  };

  const controlAllServices = async (operation: BulkOperation, options?: { silent?: boolean; throwOnFailure?: boolean }) => {
    const operationLabel = SERVICE_OPERATION_LABEL[operation];
    const allSuccessMessage = `Todos os serviços — ${operationLabel} feito!`;
    const reportBulkFailure = (detail: string) => {
      setCommandStatus({
        phase: "error",
        title: `Erro ao ${operationLabel} serviços`,
        detail,
      });
      if (!options?.silent) toast.error(detail);
      if (options?.throwOnFailure) throw new Error(detail);
    };

    setAllServiceActionBusy((prev) => ({ ...prev, [operation]: true }));
    try {
      setCommandStatus({
        phase: "running",
        title: `Aplicando ${operationLabel} em todos`,
        detail: `Iniciando operação nos 4 serviços...`,
      });

      const response = await invokeBackendRpc<OpsControlResponse>("ops-service-control", {
        body: { service: "all", operation },
      });

      const initialFailures = Array.isArray(response.results)
        ? response.results.filter((item) => item?.ok === false && item?.service)
        : [];

      if (response?.ok === false || initialFailures.length > 0) {
        if (response?.ok === false && initialFailures.length === 0) {
          reportBulkFailure(String(response?.error || `Não deu pra ${operationLabel} todos os serviços`));
          return;
        }

        const retryTargets = initialFailures
          .map((item) => String(item.service || "").trim().toLowerCase())
          .filter((svc): svc is RuntimeServiceView["key"] => SERVICE_KEYS.includes(svc as RuntimeServiceView["key"]));

        const retryFailed: string[] = [];
        if (retryTargets.length > 0) {
          setCommandStatus({
            phase: "running",
            title: `Repetindo ${retryTargets.length} operação(ões)`,
            detail: `Tentando ${operationLabel} nos serviços com falha...`,
          });
          
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
          reportBulkFailure(`${retryFailed.length}/4 serviços falharam: ${retryFailed.join(", ")}`);
          return;
        }
      }

      await refreshAllHealth();
      setCommandStatus({
        phase: "success",
        title: `Todos os serviços — ${operationLabel} feito`,
        detail: `Operação completada em 4/4 serviços.`,
      });
      if (!options?.silent) toast.success(allSuccessMessage);
    } catch (error) {
      const failedServices: string[] = [];
      setCommandStatus({
        phase: "running",
        title: "Tentando recuperação",
        detail: `Tentando um por um...`,
      });
      
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
          ? `Ops fora do ar em ${opsHealth.url || "URL desconhecida"}. Inicie o serviço e tente de novo.`
          : `${failedServices.length}/4 serviços falharam: ${failedServices.join(", ")}`;
        reportBulkFailure(detail);
      } else {
        setCommandStatus({
          phase: "success",
          title: `Todos os serviços ${operationLabel}`,
          detail: `Recuperação automática feita em 4/4 serviços.`,
        });
        if (!options?.silent) toast.success(allSuccessMessage);
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
        maintenance_title: enabled ? "Sistema Pausado" : "Sistema Operacional",
        maintenance_message: enabled
          ? "Sistema pausado pelo admin."
          : "Sistema rodando normal.",
        allow_admin_bypass: true,
      },
    });
    setMaintenanceEnabled(enabled);
  }, []);

  const controlSystem = async (operation: SystemOperation) => {
    setSystemActionBusy((prev) => ({ ...prev, [operation]: true }));
    try {
      const operationLabel = SYSTEM_OPERATION_LABEL[operation];
      
      setCommandStatus({
        phase: "running",
        title: `Iniciando procedimento de ${operationLabel}`,
        detail: `Etapa 1 de 3: Verificando orquestrador...`,
      });

      // When starting/restarting, try to bring ops-control online automatically.
      // This unlocks the flow where a fresh dev machine has no services running yet.
      if ((operation === "start" || operation === "restart") && !opsHealth.online) {
        setCommandStatus({
          phase: "running",
          title: `${operationLabel} — inicializando orquestrador`,
          detail: `Etapa 1 de 3: Iniciando Ops Control...`,
        });
        await invokeBackendRpc("ops-bootstrap", { body: {} });
        await refreshAllHealth();
      }

      if (operation === "start") {
        setCommandStatus({
          phase: "running",
          title: `${operationLabel} — ativando sistema`,
          detail: `Etapa 2 de 3: Desativando modo manutenção...`,
        });
        await updateMaintenanceMode(false);
        
        setCommandStatus({
          phase: "running",
          title: `${operationLabel} — iniciando serviços`,
          detail: `Etapa 3 de 3: Iniciando todos os 4 serviços...`,
        });
        await controlAllServices("start", { silent: true, throwOnFailure: true });
      } else if (operation === "restart") {
        setCommandStatus({
          phase: "running",
          title: `${operationLabel} — reiniciando`,
          detail: `Etapa 2 de 3: Desativando modo manutenção...`,
        });
        await updateMaintenanceMode(false);
        
        setCommandStatus({
          phase: "running",
          title: `${operationLabel} — reiniciando serviços`,
          detail: `Etapa 3 de 3: Reiniciando todos os 4 serviços...`,
        });
        await controlAllServices("restart", { silent: true, throwOnFailure: true });
      } else {
        setCommandStatus({
          phase: "running",
          title: `${operationLabel} — em andamento`,
          detail: `Etapa 2 de 3: Ativando modo manutenção...`,
        });
        await updateMaintenanceMode(true);
        
        setCommandStatus({
          phase: "running",
          title: `${operationLabel} — parando serviços`,
          detail: `Etapa 3 de 3: Parando todos os 4 serviços...`,
        });
        await controlAllServices("stop", { silent: true, throwOnFailure: true });
      }

      await refreshAllHealth();
      setCommandStatus({
        phase: "success",
        title: `Sistema ${operation === "start" ? "iniciado" : operation === "restart" ? "reiniciado" : "encerrado"}`,
        detail: `${operationLabel} completado com sucesso.`,
      });
      toast.success(`${operationLabel} realizado com sucesso`);
    } catch (error) {
      const operationLabel = SYSTEM_OPERATION_LABEL[operation];
      const errorMsg = error instanceof Error ? error.message : `Não deu pra ${operationLabel}`;
      setCommandStatus({
        phase: "error",
        title: `${operationLabel} — falha`,
        detail: errorMsg,
      });
      toast.error(errorMsg);
      throw error;
    } finally {
      setSystemActionBusy((prev) => ({ ...prev, [operation]: false }));
    }
  };

  const handleChangeServicePort = async (serviceKey: RuntimeServiceView["key"], newPortStr: string) => {
    const newPort = parseInt(newPortStr, 10);
    
    // Validation
    if (isNaN(newPort) || newPort < 1 || newPort > 65535) {
      toast.error("Porta tem que ser entre 1 e 65535");
      return;
    }

    const currentPort = SERVICE_META[serviceKey]?.port;
    if (newPort === currentPort) {
      toast.info("Essa porta já é a atual");
      setEditPortService(null);
      return;
    }

    setEditPortBusy(true);
    try {
      const serviceName = SERVICE_META[serviceKey]?.label || serviceKey;
      
      setCommandStatus({
        phase: "running",
        title: `Alterando porta de ${serviceName}`,
        detail: `Mudando de porta ${currentPort} para ${newPort}...`,
      });

      const response = await invokeBackendRpc<OpsControlResponse>("ops-service-port", {
        body: { service: serviceKey, port: newPort },
      });

      if (!response?.ok) {
        const errorMsg = String(response?.error || `Não deu pra mudar a porta de ${serviceName}`);
        setCommandStatus({
          phase: "error",
          title: `Erro ao alterar porta`,
          detail: errorMsg,
        });
        toast.error(errorMsg);
        return;
      }

      // Update SERVICE_META locally for immediate UI feedback
      SERVICE_META[serviceKey].port = newPort;
      
      await refreshAllHealth();
      
      setCommandStatus({
        phase: "success",
        title: `Porta alterada com sucesso`,
        detail: `${serviceName} agora opera na porta ${newPort}.`,
      });
      toast.success(`${serviceName} — porta alterada para ${newPort}`);
      setEditPortService(null);
      setEditPortValue("");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Não deu pra mudar a porta";
      setCommandStatus({
        phase: "error",
        title: "Erro ao alterar porta",
        detail: errorMsg,
      });
      toast.error(errorMsg);
    } finally {
      setEditPortBusy(false);
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

  // ── Business metrics derived from observability snapshot ──────────────────
  const revenueMetrics = useMemo(() => {
    const planMap = new Map(controlPlane.plans.map((p) => [p.id, p]));
    const activeRegular = allObsUsers.filter((u) => u.account_status === "active" && u.role !== "admin");
    const now = Date.now();
    const days7ms = 7 * 24 * 60 * 60 * 1000;
    const days30ms = 30 * 24 * 60 * 60 * 1000;

    let mrr = 0;
    let paidCount = 0;
    let freeTierCount = 0;
    const byPlan: Record<string, { name: string; count: number; revenue: number }> = {};

    for (const user of activeRegular) {
      const plan = planMap.get(user.plan_id);
      if (!plan) continue;
      const monthlyPrice =
        plan.billingPeriod === "annual"
          ? (plan.monthlyEquivalentPrice || plan.price / 12)
          : plan.price;
      if (!byPlan[plan.id]) byPlan[plan.id] = { name: plan.name, count: 0, revenue: 0 };
      byPlan[plan.id].count++;
      byPlan[plan.id].revenue += monthlyPrice;
      if (plan.price > 0) { mrr += monthlyPrice; paidCount++; }
      else freeTierCount++;
    }

    const allRegular = allObsUsers.filter((u) => u.role !== "admin");
    const newUsers7d = allRegular.filter((u) => now - Date.parse(u.created_at) <= days7ms).length;
    const newUsers30d = allRegular.filter((u) => now - Date.parse(u.created_at) <= days30ms).length;
    const inactiveCount = allRegular.filter((u) => u.account_status === "inactive").length;
    const blockedCount = allRegular.filter((u) => u.account_status === "blocked").length;
    const archivedCount = allRegular.filter((u) => u.account_status === "archived").length;

    return {
      mrr,
      arr: mrr * 12,
      paidCount,
      freeTierCount,
      totalActive: activeRegular.length,
      totalUsers: allRegular.length,
      newUsers7d,
      newUsers30d,
      inactiveCount,
      blockedCount,
      archivedCount,
      byPlan: Object.values(byPlan).sort((a, b) => b.revenue - a.revenue),
    };
  }, [allObsUsers, controlPlane.plans]);

  // ── Session health derived from observability ──────────────────────────────
  const sessionHealth = useMemo(() => {
    const rows = allObsUsers
      .filter((u) => u.account_status === "active" && (u.usage.waSessionsTotal > 0 || u.usage.tgSessionsTotal > 0))
      .map((u) => ({
        user_id: u.user_id,
        name: u.name,
        email: u.email,
        waTotal: u.usage.waSessionsTotal,
        waOnline: u.usage.waSessionsOnline,
        tgTotal: u.usage.tgSessionsTotal,
        tgOnline: u.usage.tgSessionsOnline,
        hasIssue:
          (u.usage.waSessionsTotal > 0 && u.usage.waSessionsOnline === 0) ||
          (u.usage.tgSessionsTotal > 0 && u.usage.tgSessionsOnline === 0),
      }))
      .sort((a, b) => Number(b.hasIssue) - Number(a.hasIssue));
    const totalWa = rows.reduce((s, r) => s + r.waTotal, 0);
    const onlineWa = rows.reduce((s, r) => s + r.waOnline, 0);
    const totalTg = rows.reduce((s, r) => s + r.tgTotal, 0);
    const onlineTg = rows.reduce((s, r) => s + r.tgOnline, 0);
    return { rows, totalWa, onlineWa, totalTg, onlineTg };
  }, [allObsUsers]);

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
      return { variant: "destructive" as const, label: "Host Crítico" };
    }
    if (pressure === "warn") {
      return { variant: "secondary" as const, label: "Host em Alerta" };
    }
    return { variant: "default" as const, label: "Host Estável" };
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
    ;
  const anySystemActionBusy = systemActionBusy.start === true
    || systemActionBusy.restart === true
    || systemActionBusy.shutdown === true;
  const anyServiceBulkActionBusy = allServiceActionBusy.start === true
    || allServiceActionBusy.stop === true
    || allServiceActionBusy.restart === true
    ;

  const onlineCount = useMemo(() => services.filter((s) => s.online).length, [services]);
  const totalCount = services.length;
  const systemStatusLabel = useMemo(() => {
    if (opsConnecting) return { text: "Conectando...", variant: "secondary" as const };
    if (!opsHealth.online) return { text: "Ops Indisponível", variant: "destructive" as const };
    if (onlineCount === totalCount) return { text: "Tudo Operacional", variant: "default" as const };
    if (onlineCount === 0) return { text: "Tudo Parado", variant: "destructive" as const };
    return { text: `${onlineCount}/${totalCount} online`, variant: "secondary" as const };
  }, [opsConnecting, opsHealth.online, onlineCount, totalCount]);

  return (
    <TooltipProvider>
    <div className="admin-page max-w-[1320px] px-2 sm:px-4">
      <PageHeader title="Dashboard Admin" description="Painel de Controle">
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
        <CardHeader className="pb-2 border-b border-border/30">
          <div className="flex items-center justify-between">
            <CardTitle className="admin-card-title">Controle Operacional</CardTitle>
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Próx. check: {nextRefreshIn}s</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-4">
          <div className="space-y-3 rounded-lg border border-border/40 bg-muted/10 p-3">
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-border/40 bg-card/80 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-2xs uppercase font-semibold tracking-wider text-foreground">Controles do Sistema</p>
                  <Badge variant={maintenanceEnabled ? "secondary" : "default"} className="text-2xs">
                    {maintenanceEnabled ? "Sistema Pausado" : "Sistema Ativo"}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy}
                    onClick={() => void controlSystem("start")}
                  >
                    {systemActionBusy.start ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Iniciar Sistema
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy}
                    onClick={() => void controlSystem("restart")}
                  >
                    {systemActionBusy.restart ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Reiniciar Sistema
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy || !opsHealth.online}
                    onClick={() => void controlSystem("shutdown")}
                  >
                    {systemActionBusy.shutdown ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                    Desligar Sistema
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-border/40 bg-card/80 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-2xs uppercase font-semibold tracking-wider text-foreground">Controles dos Serviços</p>
                  <Badge variant={onlineCount === totalCount ? "default" : "secondary"} className="text-2xs">
                    {onlineCount}/{totalCount} online
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    disabled={allServiceActionBusy.start === true || !opsHealth.online || allServicesOnline || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("start")}
                  >
                    <Play className="h-3.5 w-3.5" />
                    Iniciar Serviços
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={allServiceActionBusy.restart === true || !opsHealth.online || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("restart")}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reiniciar Serviços
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={allServiceActionBusy.stop === true || !opsHealth.online || allServicesOffline || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("stop")}
                  >
                    <Power className="h-3.5 w-3.5" />
                    Desligar Serviços
                  </Button>
                </div>
              </div>
            </div>

            <div className={`rounded-lg border px-4 py-3 text-xs ${
              commandStatus.phase === "running"
                ? "border-blue-300/50 bg-blue-50/80 text-blue-900 dark:border-blue-700/50 dark:bg-blue-950/40 dark:text-blue-300"
                : commandStatus.phase === "error"
                  ? "border-red-300/50 bg-red-50/80 text-red-900 dark:border-red-700/50 dark:bg-red-950/40 dark:text-red-300"
                  : commandStatus.phase === "success"
                    ? "border-green-300/50 bg-green-50/80 text-green-900 dark:border-green-700/50 dark:bg-green-950/40 dark:text-green-300"
                    : "border-border/50 bg-muted/30 text-muted-foreground"
            }`}>
              <div className="flex items-center gap-2.5">
                {commandStatus.phase === "running" 
                  ? <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" /> 
                  : commandStatus.phase === "success"
                    ? <div className="h-4 w-4 rounded-full bg-green-500 flex-shrink-0" />
                    : commandStatus.phase === "error"
                      ? <div className="h-4 w-4 rounded-full bg-red-500 flex-shrink-0" />
                      : <Activity className="h-4 w-4 flex-shrink-0" />
                }
                <div className="flex-1">
                  <p className="font-semibold leading-tight">{commandStatus.title}</p>
                  {commandStatus.detail && <p className="mt-1 opacity-90">{commandStatus.detail}</p>}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={refreshAllHealth}
                disabled={isRefreshingHealth}
              >
                <RefreshCw className={`h-3 w-3 ${isRefreshingHealth ? "animate-spin" : ""}`} />
                Atualizar
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
            <Badge variant={opsHealth.online ? "default" : "secondary"} className="gap-1.5 text-2xs">
              <Circle className={`h-1.5 w-1.5 fill-current ${opsHealth.online ? "text-green-500" : "text-red-500"}`} />
              {opsHealth.online ? "Ops Online" : "Ops Offline"}
            </Badge>
            <span className="text-2xs">{opsHealth.url || "-"}</span>
            <span className="text-2xs">Último: {lastHealthCheckAt ? new Date(lastHealthCheckAt).toLocaleTimeString("pt-BR") : "-"}</span>
          </div>
          {opsHealth.system && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="admin-kpi space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-2xs uppercase tracking-wider text-muted-foreground">Memória</span>
                  </div>
                  <span className="text-xs font-medium">
                    {Number.isFinite(opsHealth.system.memory?.usedPercent)
                      ? `${Number(opsHealth.system.memory?.usedPercent || 0).toFixed(1)}%`
                      : "-"}
                  </span>
                </div>
                <Progress value={Number(opsHealth.system.memory?.usedPercent || 0)} className="h-2" />
                <p className="text-2xs text-muted-foreground">
                  Alerta: {Number.isFinite(opsHealth.system.memory?.warnPercent) ? `${Number(opsHealth.system.memory?.warnPercent || 0).toFixed(0)}%` : "-"}
                  {" · "}
                  Crítico: {Number.isFinite(opsHealth.system.memory?.criticalPercent) ? `${Number(opsHealth.system.memory?.criticalPercent || 0).toFixed(0)}%` : "-"}
                </p>
              </div>
              <div className="admin-kpi space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-2xs uppercase tracking-wider text-muted-foreground">CPU / núcleo (1m)</span>
                  </div>
                  <span className="text-xs font-medium">
                    {Number.isFinite(opsHealth.system.cpu?.loadPerCpu1m)
                      ? Number(opsHealth.system.cpu?.loadPerCpu1m || 0).toFixed(2)
                      : "-"}
                  </span>
                </div>
                <Progress value={Math.min(Number(opsHealth.system.cpu?.loadPerCpu1m || 0) * 50, 100)} className="h-2" />
                <p className="text-2xs text-muted-foreground">
                  Alerta: {Number.isFinite(opsHealth.system.cpu?.warnPerCpu) ? Number(opsHealth.system.cpu?.warnPerCpu || 0).toFixed(2) : "-"}
                  {" · "}
                  Crítico: {Number.isFinite(opsHealth.system.cpu?.criticalPerCpu) ? Number(opsHealth.system.cpu?.criticalPerCpu || 0).toFixed(2) : "-"}
                </p>
              </div>
            </div>
          )}
          {processQueues && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="admin-kpi">
                <p className="text-2xs uppercase tracking-wider text-muted-foreground">Fila de Rotas</p>
                <p className="text-sm font-semibold mt-1.5">Ativo: {processQueues.route.active}</p>
                <p className="text-2xs text-muted-foreground">Pendente: {processQueues.route.pending} | Limite: {processQueues.route.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-2xs uppercase tracking-wider text-muted-foreground">Fila de Disparo</p>
                <p className="text-sm font-semibold mt-1.5">Ativo: {processQueues.dispatch.active}</p>
                <p className="text-2xs text-muted-foreground">Pendente: {processQueues.dispatch.pending} | Limite: {processQueues.dispatch.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-2xs uppercase tracking-wider text-muted-foreground">Fila de Automação</p>
                <p className="text-sm font-semibold mt-1.5">Ativo: {processQueues.automation.active}</p>
                <p className="text-2xs text-muted-foreground">Pendente: {processQueues.automation.pending} | Limite: {processQueues.automation.limit}</p>
              </div>
              <div className="admin-kpi">
                <p className="text-2xs uppercase tracking-wider text-muted-foreground">Fila de Conversão</p>
                <p className="text-sm font-semibold mt-1.5">Ativo: {processQueues.convert.active}</p>
                <p className="text-2xs text-muted-foreground">Pendente: {processQueues.convert.pending} | Limite: {processQueues.convert.limit}</p>
              </div>
            </div>
          )}
          <p className="text-2xs text-muted-foreground">Checagem automática a cada 30s</p>
          {opsHealth.error && <p className="text-xs text-destructive">{opsHealth.error}</p>}
          {!opsHealth.online && opsConnecting && (
            <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800 dark:bg-blue-950">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
              <p className="text-xs text-blue-700 dark:text-blue-300">
                Conectando ao Ops... aguarda aí que tá iniciando.
              </p>
            </div>
          )}
          {!opsHealth.online && !opsConnecting && (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                Ops fora do ar — inicie o serviço pra reativar os comandos.
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Em produção, reinicie o container <code>ops-control</code> no Coolify.
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                No ambiente local, rode no terminal:
              </p>
              <div className="flex items-center gap-2">
                <code className="rounded bg-amber-100 px-2 py-1 text-xs dark:bg-amber-900">npm run svc:ops:dev</code>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    navigator.clipboard.writeText("npm run svc:ops:dev").then(() => toast.success("Copiado!"));
                  }}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Os estados abaixo mostram a saúde de cada serviço.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="services" className="w-full space-y-4">
        <TabsList className="w-full flex-wrap justify-center gap-1 rounded-xl border border-border/50 bg-card/70 p-1.5">
          <TabsTrigger value="services" className="gap-1.5">
            <Server className="h-3.5 w-3.5" />
            Serviços
            <Badge variant={onlineCount === totalCount ? "default" : "secondary"} className="ml-1 px-1.5 py-0 text-2xs">
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
              <Badge variant="destructive" className="ml-1 px-1.5 py-0 text-2xs">{anomalies.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="business" className="gap-1.5">
            <TrendingUp className="h-3.5 w-3.5" />
            Negócio
          </TabsTrigger>
          <TabsTrigger value="sessions" className="gap-1.5">
            <Wifi className="h-3.5 w-3.5" />
            Sessões
            {sessionHealth.rows.filter((r) => r.hasIssue).length > 0 && (
              <Badge variant="destructive" className="ml-1 px-1.5 py-0 text-2xs">
                {sessionHealth.rows.filter((r) => r.hasIssue).length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="services">

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {services.map((service) => {
          const meta = SERVICE_META[service.key];
          return (
            <Card key={service.key} className={`admin-card flex h-full flex-col transition-all ${service.online ? "border-green-500/25 dark:border-green-700/25" : ""}`}>
              <CardHeader className="pb-2 border-b border-border/30">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 flex-1">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 ${service.online ? "bg-green-100 dark:bg-green-900/30" : "bg-muted"}`}>
                      <ServiceIcon id={service.key} className={`h-4 w-4 ${service.online ? (meta?.color || "text-foreground") : "text-muted-foreground"}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-sm font-semibold truncate">{service.label}</CardTitle>
                      <code className="text-2xs font-mono text-muted-foreground/70 bg-muted/50 rounded-sm px-1 py-px leading-relaxed">:{meta?.port ?? "?"}</code>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Circle className={`h-2 w-2 fill-current flex-shrink-0 ${service.online ? "text-green-500 animate-pulse" : "text-red-400"}`} />
                    <span className={`text-2xs font-semibold whitespace-nowrap ${service.online ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
                      {service.online ? "Online" : "Offline"}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3 text-xs pt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="admin-kpi">
                    <p className="text-2xs uppercase tracking-wider text-muted-foreground mb-1.5">Uptime</p>
                    <p className="text-sm font-semibold">{formatUptime(service.uptimeSec)}</p>
                  </div>
                  <div className="admin-kpi">
                    <p className="text-2xs uppercase tracking-wider text-muted-foreground mb-1.5">Processo</p>
                    <p className="text-2xs font-medium line-clamp-1">{formatProcessStatusLabel(service.processStatus)}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <ShieldCheck className={`h-3.5 w-3.5 flex-shrink-0 ${service.componentOnline ? "text-green-500" : "text-muted-foreground"}`} />
                    <span className="text-2xs truncate">Health Check</span>
                  </div>
                  <Badge variant={service.componentOnline ? "default" : "secondary"} className="text-2xs px-2 py-0.5 flex-shrink-0">
                    {service.componentOnline ? "OK" : "Falha"}
                  </Badge>
                </div>
                {service.error && <p className="line-clamp-2 text-destructive text-2xs bg-destructive/5 rounded-lg px-2 py-1.5 border border-destructive/20">{service.error}</p>}
                <div className="mt-auto grid grid-cols-4 gap-1 pt-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 w-full px-0 text-xs gap-1 justify-center"
                        disabled={serviceActionBusy[`${service.key}:start`] === true || !opsHealth.online || service.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "start")}
                      >
                        {serviceActionBusy[`${service.key}:start`] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        <span className="hidden sm:inline">Ligar</span>
                      </Button>
                    </TooltipTrigger>
                    {!opsHealth.online && <TooltipContent>Ops fora do ar: inicie o serviço primeiro</TooltipContent>}
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 w-full px-0 text-xs gap-1 justify-center"
                        disabled={serviceActionBusy[`${service.key}:restart`] === true || !opsHealth.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "restart")}
                      >
                        {serviceActionBusy[`${service.key}:restart`] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                        <span className="hidden sm:inline">Reiniciar</span>
                      </Button>
                    </TooltipTrigger>
                    {!opsHealth.online && <TooltipContent>Ops fora do ar: inicie o serviço primeiro</TooltipContent>}
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-8 w-full px-0 text-xs gap-1 justify-center"
                        disabled={serviceActionBusy[`${service.key}:stop`] === true || !opsHealth.online || !service.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "stop")}
                      >
                        {serviceActionBusy[`${service.key}:stop`] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                        <span className="hidden sm:inline">Desligar</span>
                      </Button>
                    </TooltipTrigger>
                    {!opsHealth.online && <TooltipContent>Ops fora do ar: inicie o serviço primeiro</TooltipContent>}
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 w-full px-0 text-xs gap-1 justify-center"
                        disabled={editPortBusy || !opsHealth.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => {
                          setEditPortService(service.key);
                          setEditPortValue(String(meta?.port ?? 3111));
                        }}
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Porta</span>
                      </Button>
                    </TooltipTrigger>
                    {!opsHealth.online && <TooltipContent>Ops fora do ar</TooltipContent>}
                  </Tooltip>
                </div>

              </CardContent>
            </Card>
          );
        })}
      </div>

        </TabsContent>

        <TabsContent value="metrics">
      <div className="ds-card-grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total de Usuários" value={String(counts.users)} icon={Users} />
        <StatCard title="Sessões WhatsApp" value={String(counts.waSessions)} icon={WhatsAppIcon} />
        <StatCard title="Sessões Telegram" value={String(counts.tgSessions)} icon={TelegramIcon} />
        <StatCard title="Grupos" value={String(counts.groups)} icon={Users} />
        <StatCard title="Rotas Ativas" value={String(counts.routes)} icon={Route} />
        <StatCard title="Automações Shopee" value={String(counts.automations)} icon={ShoppingBag} />
        <StatCard title="Registros 24h" value={String(counts.history)} icon={BarChart3} />
        <StatCard title="Erros 24h" value={String(counts.errors24h)} icon={AlertTriangle} />
      </div>
        </TabsContent>

        <TabsContent value="usage">
      <Card className="admin-card overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="admin-card-title">Uso por Usuário (Top 8)</CardTitle>
            <Badge variant="outline" className="text-2xs">{topUserUsage.length} usuários</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {topUserUsage.length === 0 && (
            <p className="text-xs text-muted-foreground">Sem dados ainda.</p>
          )}
          {topUserUsage.map((row) => (
            <div key={row.user_id} className="rounded-xl border border-border/70 px-3 py-2.5 text-xs transition-colors hover:bg-muted/30">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-2xs font-bold text-primary">
                    {String(row.name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="truncate font-medium">{row.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                  </div>
                </div>
                <Badge variant={row.account_status === "active" ? "default" : "secondary"} className="text-2xs">{row.account_status}</Badge>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
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
            <CardTitle className="admin-card-title">Alertas do Sistema</CardTitle>
            <Badge variant={anomalies.length > 0 ? "destructive" : "default"} className="text-2xs">
              {anomalies.length > 0 ? `${anomalies.length} alerta${anomalies.length > 1 ? "s" : ""}` : "Tudo limpo"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {anomalies.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <ShieldCheck className="h-8 w-8 text-green-500" />
              <p className="text-sm font-medium text-green-600 dark:text-green-400">Tudo certo, sem alertas</p>
              <p className="text-xs text-muted-foreground">Sistema rodando normal.</p>
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

        {/* ── Negócio tab ─────────────────────────────────────────── */}
        <TabsContent value="business" className="space-y-4">
          <div className="ds-card-grid grid-cols-2 sm:grid-cols-4">
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <DollarSign className="h-3.5 w-3.5" />
                <span className="text-2xs uppercase tracking-wider">MRR Estimado</span>
              </div>
              <p className="text-xl font-bold">
                {revenueMetrics.mrr.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
              </p>
              <p className="text-2xs text-muted-foreground">receita mensal recorrente</p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5" />
                <span className="text-2xs uppercase tracking-wider">ARR Estimado</span>
              </div>
              <p className="text-xl font-bold">
                {revenueMetrics.arr.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
              </p>
              <p className="text-2xs text-muted-foreground">receita anual projetada (×12)</p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                <span className="text-2xs uppercase tracking-wider">Pagantes</span>
              </div>
              <p className="text-xl font-bold">{revenueMetrics.paidCount}</p>
              <p className="text-2xs text-muted-foreground">de {revenueMetrics.totalActive} ativos</p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                <span className="text-2xs uppercase tracking-wider">Trial / Free</span>
              </div>
              <p className="text-xl font-bold">{revenueMetrics.freeTierCount}</p>
              <p className="text-2xs text-muted-foreground">usuários sem plano pago ativo</p>
            </div>
          </div>

          <div className="ds-card-grid grid-cols-2 sm:grid-cols-4">
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                <span className="text-2xs uppercase tracking-wider">Novos (7d)</span>
              </div>
              <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{revenueMetrics.newUsers7d}</p>
              <p className="text-2xs text-muted-foreground">cadastros na última semana</p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5 text-blue-500" />
                <span className="text-2xs uppercase tracking-wider">Novos (30d)</span>
              </div>
              <p className="text-xl font-bold">{revenueMetrics.newUsers30d}</p>
              <p className="text-2xs text-muted-foreground">cadastros no último mês</p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-2xs uppercase tracking-wider">Inativos</span>
              </div>
              <p className="text-xl font-bold text-amber-600 dark:text-amber-400">{revenueMetrics.inactiveCount}</p>
              <p className="text-2xs text-muted-foreground">
                {revenueMetrics.blockedCount > 0 ? `+ ${revenueMetrics.blockedCount} bloqueados` : "usuários sem acesso"}
              </p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-2xs uppercase tracking-wider">Total Cadastros</span>
              </div>
              <p className="text-xl font-bold">{revenueMetrics.totalUsers}</p>
              <p className="text-2xs text-muted-foreground">
                {revenueMetrics.archivedCount > 0 ? `${revenueMetrics.archivedCount} arquivados` : "todos os usuários"}
              </p>
            </div>
          </div>

          <Card className="admin-card overflow-hidden">
            <CardHeader className="pb-2 border-b border-border/30">
              <CardTitle className="admin-card-title">Distribuição por Plano</CardTitle>
            </CardHeader>
            <CardContent className="divide-y pt-0">
              {revenueMetrics.byPlan.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">Sem dados de usuários ativos</p>
              )}
              {revenueMetrics.byPlan.map((row) => {
                const pct = revenueMetrics.mrr > 0 ? (row.revenue / revenueMetrics.mrr) * 100 : 0;
                return (
                  <div key={row.name} className="flex items-center gap-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{row.name}</span>
                        <span className="text-xs text-muted-foreground">{row.count} usuário{row.count !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${Math.max(pct, row.revenue > 0 ? 2 : 0)}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-sm font-semibold tabular-nums w-28 text-right">
                      {row.revenue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}/mês
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <p className="text-2xs text-muted-foreground px-1">
            Valores estimados com base nos planos ativos. Planos anuais são divididos em equivalente mensal.
          </p>
        </TabsContent>

        {/* ── Sessões tab ─────────────────────────────────────────── */}
        <TabsContent value="sessions" className="space-y-4">
          <div className="ds-card-grid grid-cols-2 sm:grid-cols-4">
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Wifi className="h-3.5 w-3.5 text-green-500" />
                <span className="text-2xs uppercase tracking-wider">WA Online</span>
              </div>
              <p className="text-xl font-bold text-green-600 dark:text-green-400">{sessionHealth.onlineWa}</p>
              <p className="text-2xs text-muted-foreground">de {sessionHealth.totalWa} sessões WA</p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <WifiOff className="h-3.5 w-3.5 text-red-400" />
                <span className="text-2xs uppercase tracking-wider">WA Offline</span>
              </div>
              <p className="text-xl font-bold text-destructive">{sessionHealth.totalWa - sessionHealth.onlineWa}</p>
              <p className="text-2xs text-muted-foreground">sessões desconectadas</p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Wifi className="h-3.5 w-3.5 text-blue-500" />
                <span className="text-2xs uppercase tracking-wider">TG Online</span>
              </div>
              <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{sessionHealth.onlineTg}</p>
              <p className="text-2xs text-muted-foreground">de {sessionHealth.totalTg} sessões TG</p>
            </div>
            <div className="admin-card p-4 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-2xs uppercase tracking-wider">Com Problema</span>
              </div>
              <p className="text-xl font-bold text-amber-600 dark:text-amber-400">
                {sessionHealth.rows.filter((r) => r.hasIssue).length}
              </p>
              <p className="text-2xs text-muted-foreground">usuários com sessão offline</p>
            </div>
          </div>

          <Card className="admin-card overflow-hidden">
            <CardHeader className="pb-2 border-b border-border/30">
              <div className="flex items-center justify-between">
                <CardTitle className="admin-card-title">Saúde das Sessões por Usuário</CardTitle>
                <Badge variant="outline" className="text-2xs">{sessionHealth.rows.length} usuários</Badge>
              </div>
            </CardHeader>
            <CardContent className="divide-y pt-0">
              {sessionHealth.rows.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Wifi className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">Nenhum usuário com sessões cadastradas</p>
                </div>
              )}
              {sessionHealth.rows.map((row) => (
                <div key={row.user_id} className={`flex items-center gap-3 py-2.5 px-1 ${row.hasIssue ? "bg-destructive/5" : ""}`}>
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-2xs font-bold text-primary">
                    {String(row.name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{row.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{row.email}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    {row.waTotal > 0 && (
                      <div className="flex items-center gap-1">
                        {row.waOnline > 0
                          ? <Wifi className="h-3 w-3 text-green-500" />
                          : <WifiOff className="h-3 w-3 text-red-400" />}
                        <span className={row.waOnline === 0 ? "text-destructive font-medium" : "text-muted-foreground"}>
                          WA {row.waOnline}/{row.waTotal}
                        </span>
                      </div>
                    )}
                    {row.tgTotal > 0 && (
                      <div className="flex items-center gap-1">
                        {row.tgOnline > 0
                          ? <Wifi className="h-3 w-3 text-blue-500" />
                          : <WifiOff className="h-3 w-3 text-red-400" />}
                        <span className={row.tgOnline === 0 ? "text-destructive font-medium" : "text-muted-foreground"}>
                          TG {row.tgOnline}/{row.tgTotal}
                        </span>
                      </div>
                    )}
                  </div>
                  {row.hasIssue && (
                    <Badge variant="destructive" className="text-2xs px-1.5 py-0 shrink-0">Offline</Badge>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>

      {/* Port Edit Modal Dialog */}
      <Dialog open={editPortService !== null} onOpenChange={(open) => {
        if (!open) {
          setEditPortService(null);
          setEditPortValue("");
        }
      }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Mudar Porta</DialogTitle>
            <DialogDescription>
              Mude a porta do serviço {SERVICE_META[editPortService]?.label || editPortService}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="port-input" className="text-right">
                Porta
              </Label>
              <Input
                id="port-input"
                type="number"
                min="1"
                max="65535"
                value={editPortValue}
                onChange={(e) => setEditPortValue(e.target.value)}
                placeholder={String(SERVICE_META[editPortService]?.port ?? 3111)}
                disabled={editPortBusy}
                className="col-span-3"
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <p>Porta Atual: {SERVICE_META[editPortService]?.port ?? "?"}</p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditPortService(null);
                setEditPortValue("");
              }}
              disabled={editPortBusy}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              disabled={editPortBusy || !editPortValue}
              onClick={() => {
                if (editPortService) {
                  void handleChangeServicePort(editPortService, editPortValue);
                }
              }}
            >
              {editPortBusy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />}
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
