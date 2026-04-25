import type { AppRoute, Group, MasterGroup, Template } from "@/lib/types";
import type { MeliSession } from "@/hooks/useMercadoLivreSessions";

export type RouteHealthLevel = "healthy" | "partial" | "error";

export interface HealthStep {
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

export interface PipelineIssue {
  label: string;
  status: "warn" | "error";
  detail: string;
  stepNumber: number;
}

export interface RouteHealthInput {
  route: AppRoute;
  groupsById: Map<string, Group>;
  sessionsById: Map<string, { id: string; label: string; status: string; platform: string }>;
  masterGroupsById: Map<string, MasterGroup>;
  meliSessionsById: Map<string, MeliSession>;
  templatesById: Map<string, Template | { id: string; name: string }>;
  whatsappOnline: boolean | null;
  telegramOnline: boolean | null;
  shopeeOnline: boolean | null;
  meliOnline: boolean | null;
  amazonOnline: boolean | null;
  shopeeConfigured: boolean | null;
  amazonTagConfigured: boolean | null;
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

function meliStatusLabel(status: string): string {
  const statusLabels: Record<string, string> = {
    expired: "expirada",
    not_found: "não encontrada no serviço",
    no_affiliate: "sem acesso a afiliados",
    error: "com erro",
  };
  return statusLabels[status] ?? status;
}

function ptCount(value: number, singular: string, plural: string): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe} ${safe === 1 ? singular : plural}`;
}

export function computeRouteHealth(input: RouteHealthInput): {
  level: RouteHealthLevel;
  steps: HealthStep[];
  issues: PipelineIssue[];
  primaryIssue: PipelineIssue | null;
} {
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
    amazonOnline,
    shopeeConfigured,
    amazonTagConfigured,
  } = input;

  const steps: HealthStep[] = [];

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

  const sourceGroup = groupsById.get(route.sourceGroupId);
  if (!sourceGroup) {
    steps.push({ label: "Captura", status: "error", detail: "Grupo de origem não encontrado" });
  } else {
    const sourceSession = sessionsById.get(sourceGroup.sessionId);
    if (!sourceSession) {
      steps.push({ label: "Captura", status: "error", detail: `Grupo "${sourceGroup.name}" - sessão não encontrada` });
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

  if (route.rules.autoConvertShopee) {
    if (shopeeConfigured === false) {
      steps.push({ label: "Conversão Shopee", status: "error", detail: "Credenciais Shopee não configuradas" });
    } else if (shopeeConfigured === null) {
      steps.push({ label: "Conversão Shopee", status: "warn", detail: "Validando credenciais Shopee..." });
    } else if (shopeeOnline === null) {
      steps.push({ label: "Conversão Shopee", status: "warn", detail: "Verificando serviço Shopee..." });
    } else if (!shopeeOnline) {
      steps.push({ label: "Conversão Shopee", status: "error", detail: "Serviço Shopee está offline" });
    } else {
      steps.push({ label: "Conversão Shopee", status: "ok", detail: "Serviço online e credenciais presentes" });
    }
  }

  if (route.rules.autoConvertMercadoLivre) {
    if (meliOnline === null) {
      steps.push({ label: "Conversão ML", status: "warn", detail: "Verificando serviço Mercado Livre..." });
    } else if (!meliOnline) {
      steps.push({ label: "Conversão ML", status: "error", detail: "Serviço Mercado Livre está offline" });
    } else {
      const meliSessions = Array.from(meliSessionsById.values());
      if (meliSessions.length === 0) {
        steps.push({ label: "Conversão ML", status: "error", detail: "Nenhuma sessão ML disponível" });
      } else {
        const preferred = meliSessions.find((session) => session.status === "active")
          || meliSessions.find((session) => session.status === "untested")
          || meliSessions[0];

        if (preferred.status === "active") {
          steps.push({ label: "Conversão ML", status: "ok", detail: `Sessão "${preferred.name}" ativa` });
        } else if (preferred.status === "untested") {
          steps.push({ label: "Conversão ML", status: "warn", detail: `Sessão "${preferred.name}" não testada` });
        } else {
          const detail = preferred.errorMessage
            ? `Sessão "${preferred.name}" ${meliStatusLabel(preferred.status)} (${preferred.errorMessage})`
            : `Sessão "${preferred.name}" ${meliStatusLabel(preferred.status)}`;
          steps.push({ label: "Conversão ML", status: "error", detail });
        }
      }
    }
  }

  if (route.rules.autoConvertAmazon) {
    if (amazonTagConfigured === false) {
      steps.push({ label: "Conversão Amazon", status: "error", detail: "Tag de afiliado Amazon não configurada" });
    } else if (amazonTagConfigured === null) {
      steps.push({ label: "Conversão Amazon", status: "warn", detail: "Validando tag de afiliado Amazon..." });
    } else if (amazonOnline === null) {
      steps.push({ label: "Conversão Amazon", status: "warn", detail: "Verificando serviço Amazon..." });
    } else if (!amazonOnline) {
      steps.push({ label: "Conversão Amazon", status: "error", detail: "Serviço Amazon está offline" });
    } else {
      steps.push({ label: "Conversão Amazon", status: "ok", detail: "Serviço online e tag configurada" });
    }
  }

  if (route.rules.templateId) {
    const template = templatesById.get(route.rules.templateId);
    if (!template) {
      steps.push({ label: "Template", status: "warn", detail: "Template não encontrado - usando formato padrão" });
    } else {
      steps.push({ label: "Template", status: "ok", detail: `"${template.name}"` });
    }
  }

  if (route.rules.meliTemplateId) {
    const meliTemplate = templatesById.get(route.rules.meliTemplateId);
    if (!meliTemplate) {
      steps.push({ label: "Template ML", status: "warn", detail: "Template não encontrado - usando mensagem original" });
    } else {
      steps.push({ label: "Template ML", status: "ok", detail: `"${meliTemplate.name}"` });
    }
  }

  if (route.rules.amazonTemplateId) {
    const amazonTemplate = templatesById.get(route.rules.amazonTemplateId);
    if (!amazonTemplate) {
      steps.push({ label: "Template Amazon", status: "warn", detail: "Template não encontrado - usando mensagem original" });
    } else {
      steps.push({ label: "Template Amazon", status: "ok", detail: `"${amazonTemplate.name}"` });
    }
  }

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
          steps.push({
            label: "Envio",
            status: "warn",
            detail: ptCount(notFound.length, "grupo mestre não encontrado", "grupos mestre não encontrados"),
          });
        } else {
          steps.push({
            label: "Envio",
            status: "ok",
            detail: `${ptCount(masterGroupIds.length, "grupo mestre", "grupos mestre")} via ${destSession.label}`,
          });
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
          steps.push({
            label: "Envio",
            status: "ok",
            detail: `${ptCount(found.length, "grupo", "grupos")} via ${destSession.label}`,
          });
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

  return {
    level,
    steps,
    issues,
    primaryIssue: issues[0] || null,
  };
}
