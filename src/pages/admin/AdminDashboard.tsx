import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3, ShoppingBag, ShoppingCart, Route, Users, AlertTriangle, Play, RotateCcw,
  RefreshCw, Loader2, Copy, Power, Server, Activity, Cpu,
  HardDrive, Clock, Circle, ShieldCheck, Eye, Edit2,
  TrendingUp, Wifi, WifiOff, DollarSign, Package,
} from "lucide-react";
import { cn } from "@/lib/utils";
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

const SERVICE_KEYS = ["whatsapp", "telegram", "shopee", "meli", "amazon"] as const;
const AUTO_HEALTH_INTERVAL_MS = 30 * 1000;

const SERVICE_META: Record<string, { label: string; port: number; color: string }> = {
  whatsapp: { label: "WhatsApp", port: 3111, color: "text-brand-whatsapp" },
  telegram: { label: "Telegram", port: 3112, color: "text-brand-telegram" },
  shopee: { label: "Shopee", port: 3113, color: "text-primary" },
  meli: { label: "Mercado Livre", port: 3114, color: "text-warning" },
  amazon: { label: "Amazon", port: 3117, color: "text-warning" },
};

function ServiceIcon({ id, className }: { id: string; className?: string }) {
  if (id === "whatsapp") return <WhatsAppIcon className={className} />;
  if (id === "telegram")  return <TelegramIcon className={className} />;
  if (id === "shopee")    return <ShoppingBag className={className} />;
  if (id === "amazon")    return <Package className={className} />;
  return <ShoppingCart className={className} />; // meli
}

interface RuntimeServiceView {
  key: "whatsapp" | "telegram" | "shopee" | "meli" | "amazon";
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
  const [amazonVitrine, setAmazonVitrine] = useState<{
    tabs: Array<{ key: string; label: string; activeCount: number }>;
    lastSyncAt: string | null;
    stale: boolean;
    total: number;
  } | null>(null);
  const [amazonSyncBusy, setAmazonSyncBusy] = useState(false);
  const { state: controlPlane } = useAdminControlPlane();
  const [nextRefreshIn, setNextRefreshIn] = useState(AUTO_HEALTH_INTERVAL_MS / 1000);
  const lastRefreshTsRef = useRef(Date.now());
  
  // Port edit modal state
  const [editPortService, setEditPortService] = useState<RuntimeServiceView["key"] | null>(null);
  const [editPortValue, setEditPortValue] = useState<string>("");
  const [editPortBusy, setEditPortBusy] = useState(false);

  // --- UI Handlers ---
  const handleToggleMaintenance = async () => {
    const action = maintenanceEnabled ? "disable" : "enable";
    try {
      setCommandStatus({ phase: "running", title: "Alterando Modo", detail: "Aguarde..." });
      const res = await invokeBackendRpc<{ ok: boolean }>("admin-maintenance", { body: { action } });
      if (res.ok) {
        setMaintenanceEnabled(!maintenanceEnabled);
        toast.success(`Modo manutenção ${maintenanceEnabled ? "desativado" : "ativado"}`);
      }
    } catch (err) {
      toast.error("Erro ao mudar modo");
    } finally {
      setCommandStatus({ phase: "idle", title: "Monitor", detail: "Pronto" });
    }
  };

  const syncAmazonVitrine = async () => {
    setAmazonSyncBusy(true);
    try {
      const res = await invokeBackendRpc<{ ok: boolean }>("amazon-vitrine-sync");
      if (res.ok) toast.success("Sincronizado!");
    } finally {
      setAmazonSyncBusy(false);
      refreshSystemObservability();
    }
  };

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

  const refreshAmazonVitrine = useCallback(async () => {
    try {
      const result = await invokeBackendRpc<{
        tabs: Array<{ key: string; label: string; activeCount: number }>;
        lastSyncAt: string | null;
        stale: boolean;
      }>("amazon-vitrine-list", { body: { tab: "destaques", page: 1, limit: 1 } });
      if (result) {
        const tabs = Array.isArray(result.tabs) ? result.tabs : [];
        setAmazonVitrine({
          tabs,
          lastSyncAt: result.lastSyncAt ?? null,
          stale: result.stale === true,
          total: tabs.reduce((s, t) => s + (t.activeCount || 0), 0),
        });
      }
    } catch {
      // vitrine é opcional — não bloqueia o health check principal
    }
  }, []);

  const refreshAllHealth = useCallback(async () => {
    setIsRefreshingHealth(true);
    try {
      await Promise.all([refreshSystemObservability(), refreshAmazonVitrine()]);
      setLastHealthCheckAt(new Date().toISOString());
      lastRefreshTsRef.current = Date.now();
      setNextRefreshIn(AUTO_HEALTH_INTERVAL_MS / 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra checar os serviços");
    } finally {
      setIsRefreshingHealth(false);
    }
  }, [refreshSystemObservability, refreshAmazonVitrine]);

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
        detail: `Iniciando operação nos ${SERVICE_KEYS.length} serviços...`,
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
          reportBulkFailure(`${retryFailed.length}/${SERVICE_KEYS.length} serviços falharam: ${retryFailed.join(", ")}`);
          return;
        }
      }

      await refreshAllHealth();
      setCommandStatus({
        phase: "success",
        title: `Todos os serviços — ${operationLabel} feito`,
        detail: `Operação completada em ${SERVICE_KEYS.length}/${SERVICE_KEYS.length} serviços.`,
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
          : `${failedServices.length}/${SERVICE_KEYS.length} serviços falharam: ${failedServices.join(", ")}`;
        reportBulkFailure(detail);
      } else {
        setCommandStatus({
          phase: "success",
          title: `Todos os serviços ${operationLabel}`,
          detail: `Recuperação automática feita em ${SERVICE_KEYS.length}/${SERVICE_KEYS.length} serviços.`,
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
          detail: `Etapa 3 de 3: Iniciando todos os ${SERVICE_KEYS.length} serviços...`,
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
          detail: `Etapa 3 de 3: Reiniciando todos os ${SERVICE_KEYS.length} serviços...`,
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
          detail: `Etapa 3 de 3: Parando todos os ${SERVICE_KEYS.length} serviços...`,
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

  const triggerAmazonVitrineSync = async () => {
    setAmazonSyncBusy(true);
    try {
      await invokeBackendRpc("amazon-vitrine-sync", { body: { force: true } });
      toast.success("Sincronização da vitrine Amazon iniciada");
      await refreshAmazonVitrine();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao sincronizar vitrine Amazon");
    } finally {
      setAmazonSyncBusy(false);
    }
  };

  useEffect(() => {
    // Startup retry: try connecting to ops-control at boot
    // (handles the race condition where vite loads faster than ops-control).
    // Retries at 0s, 3s, 10s — then switches to normal 30s polling.
    // Note: setOpsConnecting(false) is handled by the separate effect watching opsHealth.online.
    const startupDelays = [0, 3000, 10000];
    const startupTimers: number[] = [];

    for (const delay of startupDelays) {
      const id = window.setTimeout(() => { void refreshAllHealth(); }, delay);
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
  }, [refreshAllHealth]);

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
      amazon: "Amazon",
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
    <div className="admin-page">
      <div className="flex flex-col items-center text-center">
        <PageHeader title="Painel de Controle" description="Visão geral e monitoramento operacional do ecossistema Autolinks.">
          <div className="flex items-center justify-center gap-3 mt-4">
            <Badge variant={systemStatusLabel.variant} className="gap-2 px-3 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-lg shadow-sm">
              <Circle className={`h-3 w-3 fill-current ${onlineCount === totalCount && opsHealth.online ? "text-success" : onlineCount > 0 ? "text-warning" : "text-destructive"}`} />
              {systemStatusLabel.text}
            </Badge>
            <Badge variant={systemPressureBadge.variant} className="px-3 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-lg shadow-sm">
              {systemPressureBadge.label}
            </Badge>
            {isRefreshingHealth && <Loader2 className="h-4 w-4 animate-spin text-primary ml-1" />}
          </div>
        </PageHeader>
      </div>

      <div className="grid gap-6">
        <Card className="rounded-[2rem] border-border/80 shadow-2xl overflow-hidden bg-card/60 backdrop-blur-md">
          <CardHeader className="p-6 border-b border-border/40 bg-muted/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-primary/10 rounded-xl text-primary ring-1 ring-primary/20">
                  <Activity className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-xl font-black tracking-tight">Orquestrador de Sistema</CardTitle>
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-widest mt-0.5">Operações de Infraestrutura</p>
                </div>
              </div>
              <div className="hidden sm:flex items-center gap-2 bg-background/50 px-3 py-1.5 rounded-xl border border-border/50">
                <Clock className="h-3.5 w-3.5 text-primary" />
                <span className="text-[10px] font-black uppercase tracking-tighter text-muted-foreground">Check em {nextRefreshIn}s</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Controles do Sistema */}
              <div className="space-y-5 p-6 rounded-[1.5rem] border border-border/60 bg-background/40 relative group transition-all hover:border-primary/30">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-primary" />
                    <h3 className="text-xs font-black uppercase tracking-[0.15em] text-foreground/80">Gestão de Host</h3>
                  </div>
                  <Badge variant={maintenanceEnabled ? "secondary" : "default"} className="text-[9px] font-black uppercase px-2.5 py-0.5 rounded-md">
                    {maintenanceEnabled ? "Modo Manutenção" : "Modo Produção"}
                  </Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Button
                    variant="default"
                    className="h-12 rounded-xl font-bold text-xs uppercase tracking-widest shadow-xl shadow-primary/10 hover:scale-[1.02] transition-all"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy}
                    onClick={() => void controlSystem("start")}
                  >
                    {systemActionBusy.start ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                    Start
                  </Button>
                  <Button
                    variant="outline"
                    className="h-12 rounded-xl font-bold text-xs uppercase tracking-widest border-primary/20 hover:bg-primary/5 hover:text-primary transition-all"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy}
                    onClick={() => void controlSystem("restart")}
                  >
                    {systemActionBusy.restart ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                    Reloader
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-12 rounded-xl font-bold text-xs uppercase tracking-widest shadow-xl shadow-destructive/10 hover:scale-[1.02] transition-all"
                    disabled={anySystemActionBusy || anyServiceBulkActionBusy || !opsHealth.online}
                    onClick={() => void controlSystem("shutdown")}
                  >
                    {systemActionBusy.shutdown ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Power className="h-4 w-4 mr-2" />}
                    Kill
                  </Button>
                </div>
              </div>

              {/* Controles de Serviços */}
              <div className="space-y-5 p-6 rounded-[1.5rem] border border-border/60 bg-background/40 relative group transition-all hover:border-primary/30">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" />
                    <h3 className="text-xs font-black uppercase tracking-[0.15em] text-foreground/80">Microsserviços</h3>
                  </div>
                  <Badge variant={onlineCount === totalCount ? "default" : "secondary"} className="text-[9px] font-black uppercase px-2.5 py-0.5 rounded-md">
                    {onlineCount}/{totalCount} ATIVOS
                  </Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Button
                    variant="default"
                    className="h-12 rounded-xl font-bold text-xs uppercase tracking-widest shadow-xl shadow-primary/10 hover:scale-[1.02] transition-all"
                    disabled={allServiceActionBusy.start === true || !opsHealth.online || allServicesOnline || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("start")}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Up All
                  </Button>
                  <Button
                    variant="outline"
                    className="h-12 rounded-xl font-bold text-xs uppercase tracking-widest border-primary/20 hover:bg-primary/5 hover:text-primary transition-all"
                    disabled={allServiceActionBusy.restart === true || !opsHealth.online || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("restart")}
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Sync
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-12 rounded-xl font-bold text-xs uppercase tracking-widest shadow-xl shadow-destructive/10 hover:scale-[1.02] transition-all"
                    disabled={allServiceActionBusy.stop === true || !opsHealth.online || allServicesOffline || anyGlobalActionBusy || anySystemActionBusy}
                    onClick={() => void controlAllServices("stop")}
                  >
                    <Power className="h-4 w-4 mr-2" />
                    Down All
                  </Button>
                </div>
              </div>
            </div>

            {/* Status do Monitor */}
            <div className={cn(
              "rounded-2xl border p-6 transition-all duration-500 backdrop-blur-sm",
              commandStatus.phase === "running" ? "border-primary/30 bg-primary/[0.03]" :
              commandStatus.phase === "error" ? "border-destructive/30 bg-destructive/[0.03]" :
              commandStatus.phase === "success" ? "border-success/30 bg-success/[0.03]" :
              "border-border/60 bg-muted/20"
            )}>
              <div className="flex flex-col sm:flex-row items-center gap-6 text-center sm:text-left">
                <div className={cn(
                  "h-16 w-16 rounded-2xl flex items-center justify-center shadow-lg transition-all",
                  commandStatus.phase === "running" ? "bg-primary/10 text-primary animate-pulse" :
                  commandStatus.phase === "success" ? "bg-success/10 text-success" :
                  commandStatus.phase === "error" ? "bg-destructive/10 text-destructive" :
                  "bg-background text-muted-foreground"
                )}>
                  {commandStatus.phase === "running" ? <Loader2 className="h-8 w-8 animate-spin" /> : 
                   commandStatus.phase === "success" ? <ShieldCheck className="h-8 w-8" /> :
                   commandStatus.phase === "error" ? <AlertTriangle className="h-8 w-8" /> :
                   <Activity className="h-8 w-8" />}
                </div>
                <div className="flex-1 space-y-1">
                  <h4 className="text-lg font-black tracking-tight">{commandStatus.title}</h4>
                  <p className="text-sm font-medium opacity-70 italic">{commandStatus.detail}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-12 rounded-xl px-5 flex items-center gap-2 font-black uppercase tracking-widest hover:bg-background/80 transition-all border border-transparent hover:border-border/50"
                  onClick={refreshAllHealth}
                  disabled={isRefreshingHealth}
                >
                  <RefreshCw className={cn("h-4 w-4", isRefreshingHealth && "animate-spin")} />
                  Refresh
                </Button>
              </div>
            </div>

            {/* Métricas de Hardware */}
            {opsHealth.system && (
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="p-6 rounded-2xl border border-border/60 bg-background/40 space-y-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg text-primary">
                        <HardDrive className="h-5 w-5" />
                      </div>
                      <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Memória RAM</span>
                    </div>
                    <span className="text-xl font-black tabular-nums">
                      {Number.isFinite(opsHealth.system.memory?.usedPercent)
                        ? `${Number(opsHealth.system.memory?.usedPercent || 0).toFixed(1)}%`
                        : "—"}
                    </span>
                  </div>
                  <Progress value={Number(opsHealth.system.memory?.usedPercent || 0)} className="h-3 rounded-full bg-muted/50" />
                  <div className="flex justify-between text-[10px] font-bold uppercase tracking-tighter text-muted-foreground/60">
                    <span>Critical: {Number(opsHealth.system.memory?.criticalPercent || 0)}%</span>
                    <span>Warn: {Number(opsHealth.system.memory?.warnPercent || 0)}%</span>
                  </div>
                </div>

                <div className="p-6 rounded-2xl border border-border/60 bg-background/40 space-y-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg text-primary">
                        <Cpu className="h-5 w-5" />
                      </div>
                      <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Load Average</span>
                    </div>
                    <span className="text-xl font-black tabular-nums">
                      {Number.isFinite(opsHealth.system.cpu?.loadPerCpu1m)
                        ? Number(opsHealth.system.cpu?.loadPerCpu1m || 0).toFixed(2)
                        : "—"}
                    </span>
                  </div>
                  <Progress value={Math.min(Number(opsHealth.system.cpu?.loadPerCpu1m || 0) * 50, 100)} className="h-3 rounded-full bg-muted/50" />
                  <div className="flex justify-between text-[10px] font-bold uppercase tracking-tighter text-muted-foreground/60">
                    <span>Critical: {Number(opsHealth.system.cpu?.criticalPerCpu || 0).toFixed(2)}</span>
                    <span>Warn: {Number(opsHealth.system.cpu?.warnPerCpu || 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="services" className="w-full space-y-8">
        <TabsList className="w-full flex-wrap justify-center gap-3 rounded-[1.5rem] border border-border/80 bg-card/60 backdrop-blur-sm p-2 h-auto">
          {[
            { value: "services", icon: Server, label: "Serviços", badge: `${onlineCount}/${totalCount}` },
            { value: "metrics", icon: Activity, label: "Métricas", badge: null },
            { value: "usage", icon: Eye, label: "Uso", badge: null },
            { value: "alerts", icon: AlertTriangle, label: "Alertas", badge: anomalies.length > 0 ? anomalies.length : null, destructive: anomalies.length > 0 },
            { value: "business", icon: TrendingUp, label: "Negócio", badge: null },
            { value: "sessions", icon: Wifi, label: "Sessões", badge: sessionHealth.rows.filter(r => r.hasIssue).length || null, destructive: sessionHealth.rows.filter(r => r.hasIssue).length > 0 },
            { value: "amazon", icon: Package, label: "Amazon", badge: amazonVitrine?.stale ? "Stale" : null }
          ].map((tab) => (
            <TabsTrigger 
              key={tab.value} 
              value={tab.value} 
              className="flex items-center gap-2.5 px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-[0.15em] transition-all data-[state=active]:bg-background data-[state=active]:text-primary data-[state=active]:shadow-lg"
            >
              <tab.icon className="h-4 w-4" />
              <span>{tab.label}</span>
              {tab.badge && (
                <Badge variant={tab.destructive ? "destructive" : "secondary"} className="ml-1 px-1.5 py-0 min-w-[1.25rem] h-5 flex items-center justify-center text-[9px] font-black rounded-md">
                  {tab.badge}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="services" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {services.map((service) => {
              const meta = SERVICE_META[service.key];
              return (
                <Card key={service.key} className={cn(
                  "group relative flex flex-col overflow-hidden border-border/80 transition-all duration-300 hover:shadow-2xl hover:-translate-y-1.5",
                  service.online ? "border-success/20 ring-1 ring-success/5" : "border-destructive/20 grayscale-[0.5] hover:grayscale-0"
                )}>
                  <CardHeader className={cn(
                    "pb-4 border-b border-border/40 transition-colors",
                    service.online ? "bg-success/[0.03]" : "bg-destructive/[0.03]"
                  )}>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className={cn(
                          "flex h-10 w-10 items-center justify-center rounded-xl shadow-inner border transition-all group-hover:scale-110",
                          service.online ? "bg-background border-success/30 text-success" : "bg-background border-destructive/30 text-destructive"
                        )}>
                          <ServiceIcon id={service.key} className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-sm font-black tracking-tight truncate">{service.label}</CardTitle>
                          <div className="flex items-center gap-1.5">
                            <code className="text-[10px] font-bold text-muted-foreground/60">PORT:{meta?.port ?? "?"}</code>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Circle className={cn(
                          "h-2.5 w-2.5 fill-current",
                          service.online ? "text-success animate-pulse" : "text-destructive"
                        )} />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="p-5 flex flex-col flex-1 gap-5">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 rounded-2xl bg-muted/30 border border-border/40 text-center">
                        <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 mb-1">Uptime</p>
                        <p className="text-xs font-black tabular-nums">{formatUptime(service.uptimeSec)}</p>
                      </div>
                      <div className="p-3 rounded-2xl bg-muted/30 border border-border/40 text-center">
                        <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60 mb-1">Processo</p>
                        <p className="text-[10px] font-black uppercase tracking-tighter truncate">{formatProcessStatusLabel(service.processStatus)}</p>
                      </div>
                    </div>

                    <div className={cn(
                      "flex items-center justify-between rounded-xl border p-3.5 px-4 transition-all",
                      service.componentOnline ? "bg-success/5 border-success/20" : "bg-destructive/5 border-destructive/20"
                    )}>
                      <div className="flex items-center gap-3">
                        <ShieldCheck className={cn("h-4 w-4", service.componentOnline ? "text-success" : "text-destructive")} />
                        <span className="text-[11px] font-black uppercase tracking-widest opacity-80">Sync Health</span>
                      </div>
                      <Badge variant={service.componentOnline ? "default" : "destructive"} className="h-5 rounded-md px-1.5 text-[9px] font-black">
                        {service.componentOnline ? "PASS" : "FAIL"}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-auto">
                      <Button
                        variant="ghost"
                        className="h-10 rounded-xl text-[10px] font-black uppercase tracking-wider bg-background border border-border/50 hover:bg-success/5 hover:text-success hover:border-success/30 transition-all"
                        disabled={serviceActionBusy[`${service.key}:start`] === true || !opsHealth.online || service.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "start")}
                      >
                        {serviceActionBusy[`${service.key}:start`] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1" />}
                        Up
                      </Button>
                      <Button
                        variant="ghost"
                        className="h-10 rounded-xl text-[10px] font-black uppercase tracking-wider bg-background border border-border/50 hover:bg-primary/5 hover:text-primary hover:border-primary/30 transition-all"
                        disabled={serviceActionBusy[`${service.key}:restart`] === true || !opsHealth.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "restart")}
                      >
                        {serviceActionBusy[`${service.key}:restart`] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1" />}
                        Sync
                      </Button>
                      <Button
                        variant="ghost"
                        className="h-10 rounded-xl text-[10px] font-black uppercase tracking-wider bg-background border border-border/50 hover:bg-destructive/5 hover:text-destructive hover:border-destructive/30 transition-all"
                        disabled={serviceActionBusy[`${service.key}:stop`] === true || !opsHealth.online || !service.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => void controlService(service.key, "stop")}
                      >
                        {serviceActionBusy[`${service.key}:stop`] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5 mr-1" />}
                        Kill
                      </Button>
                      <Button
                        variant="ghost"
                        className="h-10 rounded-xl text-[10px] font-black uppercase tracking-wider bg-background border border-border/50 hover:bg-muted-foreground/5 transition-all"
                        disabled={editPortBusy || !opsHealth.online || anyGlobalActionBusy || anySystemActionBusy}
                        onClick={() => {
                          setEditPortService(service.key);
                          setEditPortValue(String(meta?.port ?? 3111));
                        }}
                      >
                        <Edit2 className="h-3.5 w-3.5 mr-1" />
                        PORT
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>
        <TabsContent value="metrics" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
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

        <TabsContent value="usage" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card className="rounded-[2.5rem] bg-card/60 backdrop-blur-md border-border/80 overflow-hidden shadow-2xl">
            <CardHeader className="p-8 pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Eye className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl font-black uppercase tracking-[0.2em]">Uso por Usuário</CardTitle>
                </div>
                <Badge variant="outline" className="text-[10px] font-black uppercase px-3 py-1 rounded-full border-primary/30 text-primary">
                  {topUserUsage.length} TOP USERS
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-8 pt-0 space-y-4">
              {topUserUsage.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-12 text-center">
                  <Users className="h-12 w-12 text-muted-foreground/20" />
                  <p className="text-sm font-bold text-muted-foreground/40 uppercase tracking-widest">Sem dados de uso disponíveis</p>
                </div>
              )}
              <div className="grid gap-6 md:grid-cols-2">
                {topUserUsage.map((row) => (
                  <div key={row.user_id} className="group flex flex-col p-5 rounded-[1.5rem] border border-border/60 bg-background/40 hover:border-primary/40 hover:bg-primary/[0.02] transition-all">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary font-black shadow-inner">
                          {String(row.name || "?").charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="font-black text-sm tracking-tight truncate">{row.name}</p>
                          <p className="text-[10px] font-bold text-muted-foreground/60 truncate uppercase tracking-tighter">{row.email}</p>
                        </div>
                      </div>
                      <Badge variant={row.account_status === "active" ? "default" : "secondary"} className="h-6 rounded-md px-2 text-[9px] font-black uppercase">
                        {row.account_status}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2 py-4 border-y border-border/40">
                      {[
                        { label: "Rotas", val: row.usage.routesTotal },
                        { label: "Autom.", val: row.usage.automationsTotal },
                        { label: "Grupos", val: row.usage.groupsTotal },
                        { label: "WA", val: row.usage.waSessionsTotal },
                        { label: "TG", val: row.usage.tgSessionsTotal },
                        { label: "Erros 24h", val: row.usage.errors24h, warn: Number(row.usage.errors24h) > 0 }
                      ].map((stat, idx) => (
                        <div key={idx} className="flex flex-col items-center">
                          <span className="text-[8px] font-black uppercase tracking-widest text-muted-foreground/60 mb-0.5">{stat.label}</span>
                          <span className={cn("text-sm font-black tabular-nums", stat.warn ? "text-destructive" : "text-foreground")}>{stat.val}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="alerts" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card className="rounded-[2.5rem] bg-card/60 backdrop-blur-md border-border/80 overflow-hidden shadow-2xl">
            <CardHeader className="p-8 pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl font-black uppercase tracking-[0.2em]">Sinalização de Crise</CardTitle>
                </div>
                <Badge variant={anomalies.length > 0 ? "destructive" : "default"} className="text-[10px] font-black uppercase px-3 py-1 rounded-full border-primary/30">
                  {anomalies.length > 0 ? `${anomalies.length} PENDÊNCIAS` : "ESTADO NOMINAL"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-8 pt-0 space-y-4">
              {anomalies.length === 0 && (
                <div className="flex flex-col items-center gap-4 py-16 text-center">
                  <div className="h-20 w-20 rounded-full bg-success/10 flex items-center justify-center border-4 border-success/5 shadow-2xl">
                    <ShieldCheck className="h-10 w-10 text-success" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-lg font-black uppercase tracking-widest text-success">Operação Saudável</p>
                    <p className="text-xs font-bold text-muted-foreground uppercase opacity-60">Nenhuma anomalia detectada nas últimas 24h</p>
                  </div>
                </div>
              )}
              <div className="grid gap-6">
                {anomalies.map((item) => (
                  <div key={item.id} className={cn(
                    "relative flex gap-4 p-5 rounded-2xl border transition-all",
                    item.severity === "critical" ? "border-destructive/30 bg-destructive/5" : "border-warning/30 bg-warning/5"
                  )}>
                    <div className={cn(
                      "h-10 w-10 shrink-0 rounded-xl flex items-center justify-center",
                      item.severity === "critical" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"
                    )}>
                      <AlertTriangle className="h-5 w-5" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-black uppercase tracking-tight">{item.title}</h4>
                        <Badge variant={item.severity === "critical" ? "destructive" : "secondary"} className="h-5 text-[9px] font-black uppercase px-2">
                          {item.severity}
                        </Badge>
                      </div>
                      <p className="text-xs font-medium text-muted-foreground leading-relaxed">{item.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="business" className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { label: "MRR Estimado", val: revenueMetrics.mrr.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }), icon: DollarSign, sub: "Receita Mensal Recorrente", color: "text-primary" },
              { label: "ARR Estimado", val: revenueMetrics.arr.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }), icon: TrendingUp, sub: "Receita Anual Projetada", color: "text-info" },
              { label: "Transacionais", val: revenueMetrics.paidCount, icon: Users, sub: `de ${revenueMetrics.totalActive} ativos`, color: "text-success" },
              { label: "Trial / Free", val: revenueMetrics.freeTierCount, icon: Package, sub: "Usuários sem plano pago", color: "text-muted-foreground" }
            ].map((stat, i) => (
              <div key={i} className="flex flex-col p-6 rounded-[2rem] border border-border/80 bg-card/60 backdrop-blur-md shadow-xl">
                <div className="flex items-center gap-2 mb-3">
                  <stat.icon className={cn("h-4 w-4", stat.color)} />
                  <span className="text-[10px] font-black uppercase tracking-[0.15em] text-muted-foreground">{stat.label}</span>
                </div>
                <p className="text-2xl font-black tracking-tighter mb-1">{stat.val}</p>
                <p className="text-[9px] font-bold uppercase tracking-tight text-muted-foreground/50">{stat.sub}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="rounded-[2.5rem] bg-card/60 backdrop-blur-md border-border/80 overflow-hidden shadow-2xl">
              <CardHeader className="p-8 pb-4 border-b border-border/40">
                <div className="flex items-center gap-3">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl font-black uppercase tracking-[0.2em]">Share de Planos</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-8 pt-6">
                <div className="space-y-6">
                  {revenueMetrics.byPlan.length === 0 && (
                    <p className="py-12 text-center text-sm font-bold opacity-30 uppercase tracking-widest">Sem base instalada</p>
                  )}
                  {revenueMetrics.byPlan.map((row) => {
                    const pct = revenueMetrics.mrr > 0 ? (row.revenue / revenueMetrics.mrr) * 100 : 0;
                    return (
                      <div key={row.name} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-black uppercase tracking-tight">{row.name}</span>
                            <Badge variant="outline" className="h-5 text-[9px] font-black px-1.5 border-primary/20 text-primary">{row.count} USERS</Badge>
                          </div>
                          <span className="text-sm font-black tabular-nums">
                            {row.revenue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                          </span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-muted/40 overflow-hidden border border-border/50">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-primary/80 to-primary transition-all duration-1000"
                            style={{ width: `${Math.max(pct, row.revenue > 0 ? 2 : 0)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { label: "New Users (7d)", val: revenueMetrics.newUsers7d, color: "text-success", icon: TrendingUp },
                { label: "Inativos", val: revenueMetrics.inactiveCount, color: "text-warning", icon: AlertTriangle },
                { label: "Bloqueados", val: revenueMetrics.blockedCount, color: "text-destructive", icon: Power },
                { label: "Cadastros Total", val: revenueMetrics.totalUsers, color: "text-primary", icon: Users }
              ].map((m, idx) => (
                <div key={idx} className="p-6 rounded-[1.5rem] border border-border/80 bg-background/50 flex flex-col justify-between hover:border-primary/30 transition-all">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">{m.label}</span>
                    <m.icon className={cn("h-4 w-4", m.color)} />
                  </div>
                  <p className={cn("text-3xl font-black tracking-tighter", m.color)}>{m.val}</p>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="sessions" className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="p-6 rounded-[2rem] border border-border/80 bg-card/60 backdrop-blur-md shadow-xl">
              <div className="flex items-center gap-2 mb-3">
                <WhatsAppIcon className="h-4 w-4 text-brand-whatsapp" />
                <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">WA Online</span>
              </div>
              <p className="text-2xl font-black text-success">{sessionHealth.onlineWa}</p>
              <p className="text-[9px] font-bold text-muted-foreground/50 uppercase">DE {sessionHealth.totalWa} TOTAL</p>
            </div>
            <div className="p-6 rounded-[2rem] border border-border/80 bg-card/60 backdrop-blur-md shadow-xl">
              <div className="flex items-center gap-2 mb-3">
                <WifiOff className="h-4 w-4 text-destructive/60" />
                <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">WA Offline</span>
              </div>
              <p className="text-2xl font-black text-destructive">{sessionHealth.totalWa - sessionHealth.onlineWa}</p>
              <p className="text-[9px] font-bold text-muted-foreground/50 uppercase">DESCONECTADOS</p>
            </div>
            <div className="p-6 rounded-[2rem] border border-border/80 bg-card/60 backdrop-blur-md shadow-xl">
              <div className="flex items-center gap-2 mb-3">
                <TelegramIcon className="h-4 w-4 text-brand-telegram" />
                <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">TG Online</span>
              </div>
              <p className="text-2xl font-black text-info font-black">{sessionHealth.onlineTg}</p>
              <p className="text-[9px] font-bold text-muted-foreground/50 uppercase">DE {sessionHealth.totalTg} TOTAL</p>
            </div>
            <div className="p-6 rounded-[2rem] border border-border/80 bg-card/60 backdrop-blur-md shadow-xl">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Issue Alert</span>
              </div>
              <p className="text-2xl font-black text-warning">{sessionHealth.rows.filter(r => r.hasIssue).length}</p>
              <p className="text-[9px] font-bold text-muted-foreground/50 uppercase">USUÁRIOS CRÍTICOS</p>
            </div>
          </div>

          <Card className="rounded-[2.5rem] bg-card/60 backdrop-blur-md border-border/80 overflow-hidden shadow-2xl">
            <CardHeader className="p-8 pb-4 border-b border-border/40">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Wifi className="h-5 w-5 text-primary" />
                  <CardTitle className="text-xl font-black uppercase tracking-[0.2em]">Painel de Connectivity</CardTitle>
                </div>
                <Badge variant="outline" className="text-[10px] font-black uppercase px-3 py-1 rounded-full border-primary/30 text-primary">
                  {sessionHealth.rows.length} MONITORADOS
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {sessionHealth.rows.length === 0 && (
                <div className="flex flex-col items-center gap-4 py-20 text-center">
                  <WifiOff className="h-12 w-12 text-muted-foreground/20" />
                  <p className="text-sm font-bold text-muted-foreground/40 uppercase tracking-widest">Nenhuma sessão ativa no grid</p>
                </div>
              )}
              <div className="divide-y divide-border/40">
                {sessionHealth.rows.map((row) => (
                  <div key={row.user_id} className={cn(
                    "group flex flex-col sm:flex-row sm:items-center gap-4 p-6 transition-all hover:bg-primary/[0.02]",
                    row.hasIssue && "bg-destructive/[0.03]"
                  )}>
                    <div className="flex items-center gap-4 flex-1">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-background border border-border/60 text-sm font-black shadow-sm group-hover:scale-110 transition-transform">
                        {String(row.name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-black tracking-tight truncate">{row.name}</p>
                        <p className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-tighter truncate">{row.email}</p>
                      </div>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-6">
                      <div className="flex items-center gap-4">
                        {row.waTotal > 0 && (
                          <div className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all",
                            row.waOnline === row.waTotal ? "bg-success/5 border-success/20 text-success" : "bg-destructive/5 border-destructive/20 text-destructive"
                          )}>
                            <WhatsAppIcon className="h-3.5 w-3.5" />
                            <span className="text-[10px] font-black tabular-nums">WA {row.waOnline}/{row.waTotal}</span>
                          </div>
                        )}
                        {row.tgTotal > 0 && (
                          <div className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all",
                            row.tgOnline === row.tgTotal ? "bg-info/5 border-info/20 text-info" : "bg-destructive/5 border-destructive/20 text-destructive"
                          )}>
                            <TelegramIcon className="h-3.5 w-3.5" />
                            <span className="text-[10px] font-black tabular-nums">TG {row.tgOnline}/{row.tgTotal}</span>
                          </div>
                        )}
                      </div>
                      {row.hasIssue && (
                        <Badge variant="destructive" className="animate-pulse h-6 px-2 text-[9px] font-black uppercase">CRITICAL FAILURE</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="amazon" className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
          <Card className="rounded-[2.5rem] bg-card/60 backdrop-blur-md border-border/80 overflow-hidden shadow-2xl">
            <CardHeader className="p-8 pb-4 border-b border-border/40">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Package className="h-5 w-5 text-warning" />
                  <CardTitle className="text-xl font-black uppercase tracking-[0.2em]">Vitrine Global Amazon</CardTitle>
                </div>
                <div className="flex items-center gap-3">
                  {amazonVitrine?.stale ? (
                    <Badge variant="destructive" className="text-[10px] font-black uppercase h-7 px-3 flex items-center gap-1.5">
                      <RotateCcw className="h-3 w-3 animate-reverse-spin" /> DESATUALIZADA
                    </Badge>
                  ) : amazonVitrine && (
                    <Badge variant="default" className="bg-success text-success-foreground text-[10px] font-black uppercase h-7 px-3">ATUALIZADA</Badge>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    className="h-9 px-5 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 hover:scale-105 transition-all"
                    disabled={amazonSyncBusy}
                    onClick={() => void triggerAmazonVitrineSync()}
                  >
                    {amazonSyncBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <RefreshCw className="h-3.5 w-3.5 mr-2" />}
                    FORCE SYNC
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-8">
              {!amazonVitrine ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <Loader2 className="h-10 w-10 animate-spin text-primary/40" />
                  <p className="text-xs font-black uppercase tracking-widest opacity-40">Mapeando catálogo global...</p>
                </div>
              ) : (
                <div className="space-y-8">
                  <div className="flex flex-wrap items-center gap-6 p-6 rounded-2xl bg-background/40 border border-border/60">
                    <div className="flex flex-col">
                      <span className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/60 mb-1">Última Sincronização</span>
                      <span className="text-sm font-black">
                        {amazonVitrine.lastSyncAt ? new Date(amazonVitrine.lastSyncAt).toLocaleString("pt-BR") : "NUNCA"}
                      </span>
                    </div>
                    <div className="h-8 w-px bg-border/60 hidden sm:block" />
                    <div className="flex flex-col">
                      <span className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/60 mb-1">SKU Count</span>
                      <span className="text-sm font-black tabular-nums">{amazonVitrine.total} PRODUTOS</span>
                    </div>
                  </div>

                  {amazonVitrine.tabs.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-12 text-center border-2 border-dashed border-border/40 rounded-[2rem]">
                      <Package className="h-12 w-12 text-muted-foreground/20" />
                      <p className="text-xs font-black uppercase tracking-widest text-muted-foreground/40">Vitrine deserta</p>
                    </div>
                  ) : (
                    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                      {amazonVitrine.tabs.map((tab) => (
                        <div key={tab.key} className="group p-6 rounded-[2rem] bg-gradient-to-br from-background/80 to-muted/20 border border-border/80 hover:border-warning/40 transition-all shadow-sm">
                          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/60 mb-2 truncate">{tab.label}</p>
                          <div className="flex items-end justify-between">
                            <p className="text-3xl font-black tracking-tighter group-hover:text-warning transition-colors">{tab.activeCount}</p>
                            <Badge variant="outline" className="text-[8px] font-black uppercase border-warning/30 text-warning px-1.5 h-4 mb-1">ACTV</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <StatCard title="Total Automações" value={String(counts.automations)} icon={Package} />
            <StatCard title="Rotas Ativas" value={String(counts.routes)} icon={Route} />
            <StatCard title="Histórico 24h" value={String(counts.history)} icon={BarChart3} />
          </div>
        </TabsContent>

      </Tabs>

      {/* Port Edit Modal Dialog */}
      <Dialog open={editPortService !== null} onOpenChange={(open) => {
        if (!open) {
          setEditPortService(null);
          setEditPortValue("");
        }
      }}>
        <DialogContent className="max-w-sm rounded-[2rem] border-none p-0 shadow-2xl bg-background/95 backdrop-blur-xl">
          <DialogHeader className="p-6 border-b border-border/40 bg-muted/20 rounded-t-[2rem]">
            <DialogTitle className="text-lg font-black">Mudar Porta</DialogTitle>
            <DialogDescription className="text-sm font-medium">
              Mude a porta do serviço {SERVICE_META[editPortService]?.label || editPortService}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 p-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="port-input" className="text-sm font-medium">
                Nova Porta
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
                className="h-10"
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg">
              <Clock className="h-3.5 w-3.5" />
              <p><strong>Porta Atual:</strong> {SERVICE_META[editPortService]?.port ?? "?"}</p>
            </div>
          </div>
          <DialogFooter className="gap-3 p-6 border-t border-border/40 bg-muted/10 rounded-b-[2rem]">
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
