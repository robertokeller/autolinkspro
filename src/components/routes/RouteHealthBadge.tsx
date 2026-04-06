import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import type { AppRoute, Group, MasterGroup } from "@/lib/types";
import type { MeliSession } from "@/hooks/useMercadoLivreSessions";

export type RouteHealthLevel = "healthy" | "partial" | "error";

interface HealthStep {
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

interface PipelineIssue {
  label: string;
  status: "warn" | "error";
  detail: string;
  stepNumber: number;
}

interface RouteHealthBadgeProps {
  route: AppRoute;
  groupsById: Map<string, Group>;
  sessionsById: Map<string, { id: string; label: string; status: string; platform: string }>;
  masterGroupsById: Map<string, MasterGroup>;
  meliSessionsById: Map<string, MeliSession>;
  templatesById: Map<string, { id: string; name: string }>;
  whatsappOnline: boolean | null;
  telegramOnline: boolean | null;
  shopeeOnline: boolean | null;
  meliOnline: boolean | null;
}

function getPlatformServiceOnline(
  platform: string,
  whatsappOnline: boolean | null,
  telegramOnline: boolean | null,
): boolean | null {
  if (platform === "whatsapp") return whatsappOnline;
  if (platform === "telegram") return telegramOnline;
  return null;
}

function normalizeConnectionState(status: string): "online" | "pending" | "offline" {
  if (status === "online") return "online";
  if (
    status === "connecting"
    || status === "warning"
    || status === "awaiting_code"
    || status === "awaiting_password"
    || status === "qr_code"
    || status === "pairing_code"
  ) {
    return "pending";
  }
  return "offline";
}

function parseClockToMinutes(value: unknown, fallback: number): number {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return fallback;

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return fallback;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return (hh * 60) + mm;
}

function isInsideQuietHours(startTime: unknown, endTime: unknown, now = new Date()): boolean {
  const nowMinutes = (now.getHours() * 60) + now.getMinutes();
  const startMinutes = parseClockToMinutes(startTime, 22 * 60);
  const endMinutes = parseClockToMinutes(endTime, 8 * 60);

  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function computeHealth(props: RouteHealthBadgeProps): { level: RouteHealthLevel; steps: HealthStep[]; issues: PipelineIssue[] } {
  const {
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
  } = props;
  const steps: HealthStep[] = [];

  // --- Etapa 1: Estado geral da rota ---
  if (route.status !== "active") {
    const statusLabel = route.status === "paused" ? "pausada" : route.status;
    steps.push({
      label: "Estado da rota",
      status: "error",
      detail: `Rota ${statusLabel} - o fluxo não encaminha mensagens enquanto não estiver ativa`,
    });
  } else {
    steps.push({ label: "Estado da rota", status: "ok", detail: "Rota ativa e pronta para processar mensagens" });
  }

  // --- Etapa 2: Captura (sessão + grupo de origem) ---
  const sourceGroup = groupsById.get(route.sourceGroupId);
  if (!sourceGroup) {
    steps.push({ label: "Captura", status: "error", detail: "Grupo de origem não encontrado" });
  } else {
    const sourceSession = sessionsById.get(sourceGroup.sessionId);
    if (!sourceSession) {
      steps.push({ label: "Captura", status: "error", detail: `Grupo "${sourceGroup.name}" — sessão não encontrada` });
    } else if (normalizeConnectionState(sourceSession.status) === "offline") {
      const statusLabel = sourceSession.status === "offline" ? "offline" : "desconectada";
      steps.push({ label: "Captura", status: "error", detail: `Sessão "${sourceSession.label}" está ${statusLabel}` });
    } else if (normalizeConnectionState(sourceSession.status) === "pending") {
      steps.push({ label: "Captura", status: "warn", detail: `Sessão "${sourceSession.label}" está conectando` });
    } else if (getPlatformServiceOnline(sourceSession.platform, whatsappOnline, telegramOnline) === false) {
      steps.push({ label: "Captura", status: "warn", detail: `Sessão online, mas canal ${sourceSession.platform} reporta instabilidade` });
    } else if (getPlatformServiceOnline(sourceSession.platform, whatsappOnline, telegramOnline) === null) {
      steps.push({ label: "Captura", status: "warn", detail: `Sem telemetria em tempo real do canal ${sourceSession.platform}` });
    } else {
      steps.push({ label: "Captura", status: "ok", detail: `"${sourceGroup.name}" via ${sourceSession.label}` });
    }
  }

  // --- Etapa 3: Conversão Shopee (opcional) ---
  if (route.rules.autoConvertShopee) {
    if (shopeeOnline === null) {
      steps.push({ label: "Conversão Shopee", status: "warn", detail: "Verificando serviço…" });
    } else if (!shopeeOnline) {
      steps.push({ label: "Conversão Shopee", status: "warn", detail: "Serviço Shopee está offline" });
    } else {
      steps.push({ label: "Conversão Shopee", status: "ok", detail: "Serviço online" });
    }
  }

  // --- Etapa 4: Conversão Mercado Livre (opcional) ---
  if (route.rules.autoConvertMercadoLivre) {
    if (meliOnline === null) {
      steps.push({ label: "Conversão ML", status: "warn", detail: "Verificando serviço…" });
    } else if (!meliOnline) {
      steps.push({ label: "Conversão ML", status: "warn", detail: "Serviço Mercado Livre está offline" });
    } else {
      const meliSessions = Array.from(meliSessionsById.values());
      if (meliSessions.length === 0) {
        steps.push({ label: "Conversão ML", status: "warn", detail: "Nenhuma sessão ML disponível" });
      } else {
        const preferred = meliSessions.find((session) => session.status === "active")
          || meliSessions.find((session) => session.status === "untested")
          || meliSessions[0];

        if (preferred.status === "active") {
          steps.push({ label: "Conversão ML", status: "ok", detail: `Sessão "${preferred.name}" ativa` });
        } else if (preferred.status === "untested") {
          steps.push({ label: "Conversão ML", status: "warn", detail: `Sessão "${preferred.name}" não testada` });
        } else {
          const statusLabels: Record<string, string> = {
            expired: "expirada",
            not_found: "não encontrada no serviço",
            no_affiliate: "sem acesso a afiliados",
            error: "com erro",
          };
          const label = statusLabels[preferred.status] ?? preferred.status;
          steps.push({ label: "Conversão ML", status: "error", detail: `Sessão "${preferred.name}" ${label}` });
        }
      }
    }
  }

  // --- Etapa 5: Conversão Amazon (opcional) ---
  if (route.rules.autoConvertAmazon) {
    steps.push({ label: "Conversão Amazon", status: "ok", detail: "Conversão local com tag de afiliado" });
  }

  // --- Etapa 6: Template (opcional) ---
  if (route.rules.templateId) {
    const template = templatesById.get(route.rules.templateId);
    if (!template) {
      steps.push({ label: "Template", status: "warn", detail: "Template não encontrado — usando formato padrão" });
    } else {
      steps.push({ label: "Template", status: "ok", detail: `"${template.name}"` });
    }
  }

  if (route.rules.amazonTemplateId) {
    const amazonTemplate = templatesById.get(route.rules.amazonTemplateId);
    if (!amazonTemplate) {
      steps.push({ label: "Template Amazon", status: "warn", detail: "Template não encontrado — usando mensagem original" });
    } else {
      steps.push({ label: "Template Amazon", status: "ok", detail: `"${amazonTemplate.name}"` });
    }
  }

  // --- Etapa 7: Janela de funcionamento (opcional) ---
  if (route.rules.quietHoursEnabled === true) {
    const startTime = route.rules.quietHoursStart || "22:00";
    const endTime = route.rules.quietHoursEnd || "08:00";
    const blockedNow = isInsideQuietHours(startTime, endTime);
    if (blockedNow) {
      steps.push({
        label: "Janela de funcionamento",
        status: "warn",
        detail: `No momento está em silêncio (${startTime}-${endTime}) - mensagens entram na fila`,
      });
    } else {
      steps.push({
        label: "Janela de funcionamento",
        status: "ok",
        detail: `Fora da janela de silêncio (${startTime}-${endTime}) - envio liberado`,
      });
    }
  }

  // --- Etapa 8: Envio (sessão + grupos de destino) ---
  const destSessionId = route.rules.sessionId;
  if (!destSessionId) {
    steps.push({ label: "Envio", status: "error", detail: "Sessão de envio não configurada" });
  } else {
    const destSession = sessionsById.get(destSessionId);
    if (!destSession) {
      steps.push({ label: "Envio", status: "error", detail: "Sessão de envio não encontrada" });
    } else if (normalizeConnectionState(destSession.status) === "offline") {
      const statusLabel = destSession.status === "offline" ? "offline" : "desconectada";
      steps.push({ label: "Envio", status: "error", detail: `Sessão "${destSession.label}" está ${statusLabel}` });
    } else if (normalizeConnectionState(destSession.status) === "pending") {
      steps.push({ label: "Envio", status: "warn", detail: `Sessão "${destSession.label}" está conectando` });
    } else if (getPlatformServiceOnline(destSession.platform, whatsappOnline, telegramOnline) === false) {
      steps.push({ label: "Envio", status: "warn", detail: `Sessão online, mas canal ${destSession.platform} reporta instabilidade` });
    } else if (getPlatformServiceOnline(destSession.platform, whatsappOnline, telegramOnline) === null) {
      steps.push({ label: "Envio", status: "warn", detail: `Sem telemetria em tempo real do canal ${destSession.platform}` });
    } else {
      const masterGroupIds = route.rules.masterGroupIds || (route.masterGroupId ? [route.masterGroupId] : []);
      if (masterGroupIds.length > 0) {
        const notFound = masterGroupIds.filter((id) => !masterGroupsById.get(id));
        if (notFound.length === masterGroupIds.length) {
          steps.push({ label: "Envio", status: "error", detail: "Grupos mestre de destino não encontrados" });
        } else if (notFound.length > 0) {
          steps.push({ label: "Envio", status: "warn", detail: `${notFound.length} grupo(s) mestre não encontrado(s)` });
        } else {
          steps.push({ label: "Envio", status: "ok", detail: `${masterGroupIds.length} grupo(s) mestre via ${destSession.label}` });
        }
      } else {
        const found = route.destinationGroupIds.filter((id) => groupsById.has(id));
        if (route.destinationGroupIds.length === 0) {
          steps.push({ label: "Envio", status: "warn", detail: "Nenhum grupo de destino configurado" });
        } else if (found.length === 0) {
          steps.push({ label: "Envio", status: "warn", detail: "Grupos de destino ainda não sincronizados" });
        } else if (found.length < route.destinationGroupIds.length) {
          steps.push({ label: "Envio", status: "warn", detail: `${found.length}/${route.destinationGroupIds.length} grupos ativos` });
        } else {
          steps.push({ label: "Envio", status: "ok", detail: `${found.length} grupo(s) via ${destSession.label}` });
        }
      }
    }
  }

  const hasError = steps.some((s) => s.status === "error");
  const hasWarn = steps.some((s) => s.status === "warn");
  const level: RouteHealthLevel = hasError ? "error" : hasWarn ? "partial" : "healthy";

  const issues = steps
    .map((step, index) => ({
      label: step.label,
      status: step.status,
      detail: step.detail,
      stepNumber: index + 1,
    }))
    .filter((step): step is PipelineIssue => step.status === "warn" || step.status === "error");

  return { level, steps, issues };
}

const levelConfig: Record<
  RouteHealthLevel,
  { label: string; shortLabel: string; dotClass: string; textClass: string; borderClass: string; pingClass: string }
> = {
  healthy: {
    label: "Funcionando",
    shortLabel: "Funcionando",
    dotClass: "bg-success",
    textClass: "text-success",
    borderClass: "border-success/30 bg-success/10",
    pingClass: "animate-ping",
  },
  partial: {
    label: "Funcionando com alertas",
    shortLabel: "Com alertas",
    dotClass: "bg-warning",
    textClass: "text-warning",
    borderClass: "border-warning/30 bg-warning/10",
    pingClass: "animate-pulse",
  },
  error: {
    label: "Não funcionando",
    shortLabel: "Não funcionando",
    dotClass: "bg-destructive",
    textClass: "text-destructive",
    borderClass: "border-destructive/30 bg-destructive/10",
    pingClass: "",
  },
};

const stepStatusIcon = {
  ok: <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />,
  warn: <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />,
  error: <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />,
};

export function RouteHealthBadge(props: RouteHealthBadgeProps) {
  const { level, steps, issues } = computeHealth(props);
  const config = levelConfig[level];
  const primaryIssue = issues[0] || null;
  const hasMultipleIssues = issues.length > 1;
  const triggerLabel = primaryIssue
    ? `${config.shortLabel} · Problema na etapa ${primaryIssue.stepNumber}`
    : config.shortLabel;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex max-w-[280px] cursor-default select-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
              config.borderClass,
              config.textClass,
            )}
            title={triggerLabel}
          >
            <span className="relative flex h-1.5 w-1.5">
              {level !== "error" && (
                <span
                  className={cn(
                    "absolute inline-flex h-full w-full rounded-full opacity-60",
                    config.dotClass,
                    config.pingClass,
                  )}
                />
              )}
              <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", config.dotClass)} />
            </span>
            <span className="truncate">{triggerLabel}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="w-[min(92vw,560px)] max-w-[min(92vw,560px)] max-h-[70vh] overflow-y-auto p-3 whitespace-normal break-words">
          <p className="mb-1 text-xs font-semibold text-foreground">Monitor de Saúde da Rota</p>
          <p className={cn("mb-2 text-xs font-medium", config.textClass)}>
            Status atual: {config.label}
          </p>
            {primaryIssue && (
              <div className="mb-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs">
                <p className="font-medium text-foreground">
                  Parte exata com problema: Etapa {primaryIssue.stepNumber} - {primaryIssue.label}
                </p>
                <p className={cn(primaryIssue.status === "error" ? "text-destructive" : "text-warning")}>
                  {primaryIssue.detail}
                </p>
                {hasMultipleIssues && (
                  <p className="mt-1 text-muted-foreground">
                    +{issues.length - 1} ponto(s) adicional(is) no fluxo
                  </p>
                )}
              </div>
            )}
          <ul className="space-y-1.5">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                {stepStatusIcon[step.status]}
                <div className="min-w-0">
                    <span className="font-medium text-foreground">Etapa {i + 1} - {step.label}:</span>{" "}
                  <span
                    className={cn(
                      step.status === "ok"
                        ? "text-muted-foreground"
                        : step.status === "warn"
                          ? "text-warning"
                          : "text-destructive",
                    )}
                  >
                    {step.detail}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
