import { backend } from "@/integrations/backend/client";

export type RuntimeService = "whatsapp" | "telegram" | "shopee" | "meli" | "amazon" | "ops";

export const SERVICE_RUNTIME_ERROR_EVENT = "autolinks:service-runtime-error";

export interface ServiceRuntimeErrorDetail {
  service: RuntimeService;
  rpcName: string;
  message: string;
  checkedAt: string;
}

const SERVICE_RPC_NAMES: Record<string, RuntimeService> = {
  "whatsapp-connect": "whatsapp",
  "telegram-connect": "telegram",
  "shopee-service-health": "shopee",
  "shopee-test-connection": "shopee",
  "shopee-convert-link": "shopee",
  "shopee-convert-links": "shopee",
  "shopee-batch": "shopee",
  "shopee-automation-run": "shopee",
  "meli-service-health": "meli",
  "amazon-service-health": "amazon",
  "meli-vitrine-list": "meli",
  "meli-vitrine-sync": "meli",
  "meli-list-sessions": "meli",
  "meli-save-session": "meli",
  "meli-test-session": "meli",
  "meli-delete-session": "meli",
  "meli-convert-link": "meli",
  "meli-convert-links": "meli",
  "meli-product-snapshot": "meli",
  "meli-automation-run": "meli",
  "amazon-automation-run": "amazon",
  "amazon-vitrine-list": "amazon",
  "amazon-vitrine-sync": "amazon",
  "amazon-convert-link": "amazon",
  "amazon-convert-links": "amazon",
  "amazon-product-snapshot": "amazon",
  "poll-channel-events": "whatsapp",
  "ops-service-health": "ops",
  "ops-service-control": "ops",
  "ops-service-ports": "ops",
  "ops-service-port": "ops",
  "ops-bootstrap": "ops",
  "process-queue-health": "ops",
  "admin-system-observability": "ops",
};

function inferRuntimeService(name: string): RuntimeService | null {
  return SERVICE_RPC_NAMES[name] ?? null;
}

function sanitizeServiceMessage(raw: string): string {
  return raw.replace(/https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|::1)(?::\d+)?[^\s,.]*/gi, "[serviço]");
}

function toFriendlyRpcError(message: string): string {
  if (/localhost|127\.|::1/.test(message)) {
    return "Serviço temporariamente indisponível. Tente novamente em instantes.";
  }
  return sanitizeServiceMessage(message);
}

function shouldEmitRuntimeServiceError(
  name: string,
  message: string,
  options?: { body?: Record<string, unknown>; headers?: Record<string, string> },
): boolean {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) return false;

  // API-wide overload/rate-limit/offline errors are transient infra conditions;
  // broadcasting them as per-service runtime faults creates refetch feedback loops.
  if (
    normalized.includes("api_overloaded")
    || normalized.includes("temporariamente sobrecarregado")
    || normalized.includes("serviço api offline")
    || normalized.includes("servico api offline")
    || normalized.includes("servidor indisponível (timeout)")
    || normalized.includes("servidor indisponivel (timeout)")
    || normalized.includes("http 429")
    || normalized.includes("http 503")
    || normalized.includes("too many requests")
    || normalized.includes("limite de chamadas")
    || normalized.includes("muitas tentativas")
  ) {
    return false;
  }

  const action = String(options?.body?.action || "").toLowerCase();
  if (
    (name === "whatsapp-connect" || name === "telegram-connect")
    && (action === "poll_events" || action === "poll_events_all" || action === "health")
  ) {
    return false;
  }

  return true;
}

function emitRuntimeServiceError(name: string, message: string) {
  const service = inferRuntimeService(name);
  if (!service) return;
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;

  const detail: ServiceRuntimeErrorDetail = {
    service,
    rpcName: name,
    message,
    checkedAt: new Date().toISOString(),
  };

  window.dispatchEvent(new CustomEvent<ServiceRuntimeErrorDetail>(SERVICE_RUNTIME_ERROR_EVENT, { detail }));
}

export async function invokeBackendRpc<T = Record<string, unknown>>(
  name: string,
  options?: { body?: Record<string, unknown>; headers?: Record<string, string> },
) {
  const { data, error } = await backend.functions.invoke(name, options);

  if (error) {
    const message = error.message || `Falha ao chamar função ${name}`;
    if (shouldEmitRuntimeServiceError(name, message, options)) {
      emitRuntimeServiceError(name, message);
    }
    throw new Error(toFriendlyRpcError(message));
  }

  if (data && typeof data === "object" && "error" in data && data.error) {
    const raw = data.error;
    // data.error may be a string or an object like { message: "..." } from proxy responses
    const message =
      raw !== null && typeof raw === "object" && "message" in (raw as object)
        ? String((raw as { message: unknown }).message)
        : String(raw);
    if (shouldEmitRuntimeServiceError(name, message, options)) {
      emitRuntimeServiceError(name, message);
    }
    throw new Error(toFriendlyRpcError(message));
  }

  return data as T;
}
