import { backend } from "@/integrations/backend/client";

export type RuntimeService = "whatsapp" | "telegram" | "shopee" | "meli" | "ops";

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
  "shopee-automation-run": "shopee",
  "meli-service-health": "meli",
  "meli-list-sessions": "meli",
  "meli-save-session": "meli",
  "meli-test-session": "meli",
  "meli-delete-session": "meli",
  "ops-service-health": "ops",
  "ops-service-control": "ops",
  "ops-service-ports": "ops",
  "ops-service-port": "ops",
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
    emitRuntimeServiceError(name, message);
    throw new Error(toFriendlyRpcError(message));
  }

  if (data && typeof data === "object" && "error" in data && data.error) {
    const raw = data.error;
    // data.error may be a string or an object like { message: "..." } from proxy responses
    const message =
      raw !== null && typeof raw === "object" && "message" in (raw as object)
        ? String((raw as { message: unknown }).message)
        : String(raw);
    emitRuntimeServiceError(name, message);
    throw new Error(toFriendlyRpcError(message));
  }

  return data as T;
}
