import type { Json } from "@/integrations/backend/types";

const AUTOMATION_SESSION_CONFIG_KEY = "deliverySessionId";

export function readAutomationSessionId(config: unknown, legacySessionId?: string | null): string {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const configSessionId = String(source[AUTOMATION_SESSION_CONFIG_KEY] || "").trim();
  if (configSessionId) return configSessionId;
  return String(legacySessionId || "").trim();
}

export function mergeAutomationSessionConfig(config: unknown, sessionId?: string | null): Json {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
  const normalizedSessionId = String(sessionId || "").trim();
  if (normalizedSessionId) source[AUTOMATION_SESSION_CONFIG_KEY] = normalizedSessionId;
  else delete source[AUTOMATION_SESSION_CONFIG_KEY];
  return source as Json;
}