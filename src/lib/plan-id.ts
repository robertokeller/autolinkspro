export const PLAN_SYNC_ERROR_MESSAGE = "Nao foi possivel validar seu plano atual. Atualize a pagina ou fale com o suporte.";

export function normalizePlanId(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }

  if (value == null) return null;

  const normalized = String(value).trim();
  return normalized || null;
}
