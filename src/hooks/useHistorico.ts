import { useInfiniteQuery } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/backend/types";

export interface SendHistoryEntry {
  id: string;
  type: string;
  typeLabel: string;
  title: string;
  source: string;
  destination: string;
  status: string;
  details: string;
  message: string;
  errorMessage: string;
  processingStatus: string;
  processingStatusLabel: string;
  routeId: string;
  routeName: string;
  mechanism: string;
  mechanismLabel: string;
  connection: string;
  connectionLabel: string;
  capturedAt: string;
  isMessageFlow: boolean;
  isFinalOutcome: boolean;
  createdAt: string;
  traceId: string;
  traceStep: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function pickText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = pickText(value).trim();
    if (text) return text;
  }
  return "";
}

function humanizeErrorMessage(value: string): string {
  const key = String(value || "").trim();
  if (!key) return "";

  const map: Record<string, string> = {
    source_group_not_found: "Grupo de origem nao encontrado no sistema",
    no_active_routes: "Nenhuma rota ativa para esta origem",
    no_routes_configured: "Grupo de origem sem nenhuma rota configurada",
    all_routes_inactive: "Rota existe mas esta inativa - ative a rota nas configuracoes",
    negative_keyword: "Bloqueada por palavra-chave negativa",
    positive_keyword_missing: "Bloqueada: ausencia de palavra-chave obrigatoria",
    partner_link_required: "Bloqueada: mensagem sem link de afiliado obrigatorio",
    marketplace_not_enabled: "Bloqueada: marketplace nao habilitado para esta rota",
    from_me_ignored: "Bloqueada: mensagem de eco/origem propria foi ignorada para evitar loop",
    no_destination_groups: "Rota sem grupos de destino configurados",
    destination_not_found: "Grupo de destino nao encontrado",
    destination_session_offline: "Sessao do grupo de destino esta offline",
    unsupported_media_type: "Bloqueada: midia recebida nao e suportada para roteamento",
    missing_image_required: "Bloqueada: rota exige imagem obrigatoria",
    image_ingestion_failed: "Bloqueada: midia recebida, mas nao foi possivel processar",
    missing_text_required: "Bloqueada: rota exige texto obrigatorio",
    meli_session_missing: "Bloqueada: sessao do Mercado Livre nao configurada",
    meli_conversion_failed: "Bloqueada: falha ao converter link Mercado Livre",
    shopee_conversion_failed: "Bloqueada: falha ao converter link Shopee",
    conversion_required: "Bloqueada: nao foi possivel converter os links obrigatorios",
  };

  if (map[key]) return map[key];
  if (/^[a-z0-9_:-]+$/.test(key)) return key.replace(/_/g, " ");
  return key;
}

function mapTypeLabel(type: string): string {
  switch (type) {
    case "session_event":
      return "Captura";
    case "message_sent":
      return "Envio";
    case "route_forward":
      return "Roteamento";
    case "schedule_sent":
      return "Agendamento";
    case "automation_run":
      return "Automação";
    case "automation_trace":
      return "Rastro automação";
    default:
      return type.replace(/_/g, " ");
  }
}

function mapProcessingLabel(status: string): string {
  switch (status) {
    case "received":
      return "Mensagem capturada";
    case "sent":
      return "Enviada ao destino";
    case "failed":
      return "Falha ao enviar";
    case "blocked":
      return "Bloqueada por regra";
    default:
      return "Processada";
  }
}

function normalizeMechanism(type: string, source: string): { key: string; label: string } {
  if (type === "route_forward" || type === "route_dispatch") return { key: "automatic_routes", label: "Rotas automáticas" };
  if (type === "schedule_sent" || source === "Agendamento") return { key: "schedule", label: "Agendamento" };
  if (type === "automation_run") return { key: "smart_automation", label: "Automações criadas" };
  if (type === "automation_trace") return { key: "smart_automation", label: "Automações criadas" };
  return { key: "other", label: "Outro" };
}

function normalizeConnection(row: Tables<"history_entries">, detailsObj: Record<string, unknown>): { key: string; label: string } {
  const detailPlatform = firstText(detailsObj.platform).toLowerCase();
  const source = String(row.source || "").toLowerCase();
  const destination = String(row.destination || "").toLowerCase();

  if (detailPlatform === "whatsapp" || source.includes("whatsapp")) {
    return { key: "whatsapp", label: "WhatsApp" };
  }
  if (detailPlatform === "telegram" || source.includes("telegram")) {
    return { key: "telegram", label: "Telegram" };
  }
  if (destination.includes("whatsapp")) return { key: "whatsapp", label: "WhatsApp" };
  if (destination.includes("telegram")) return { key: "telegram", label: "Telegram" };
  return { key: "other", label: "Outro" };
}

function isFinalOutcome(processingStatus: string): boolean {
  return ["sent", "failed", "blocked"].includes(processingStatus);
}

function isMessageFlow(row: Tables<"history_entries">): boolean {
  const processing = String(row.processing_status || "");
  if (["received", "sent", "failed", "blocked"].includes(processing)) return true;
  if (["route_forward", "route_dispatch", "message_sent", "schedule_sent", "automation_run", "automation_trace"].includes(String(row.type || ""))) return true;
  return ["inbound", "outbound"].includes(String(row.direction || ""));
}

function shouldTreatAsFinalOutcome(row: Tables<"history_entries">): boolean {
  if (row.type === "automation_trace") return true;
  return isFinalOutcome(String(row.processing_status || ""));
}

function mapRow(row: Tables<"history_entries">): SendHistoryEntry {
  const raw = row.details;
  const detailsObj = asObject(raw);
  const message = firstText(detailsObj.message, detailsObj.text, raw);
  const routeId = firstText(detailsObj.routeId);
  const routeName = firstText(detailsObj.routeName);
  const capturedAt = firstText(detailsObj.capturedAt) || row.created_at;
  const processingStatus = String(row.processing_status || "processed");
  const rawErrorMessage = firstText(detailsObj.error, detailsObj.reason, row.block_reason);
  let errorMessage = humanizeErrorMessage(rawErrorMessage);
  if (rawErrorMessage === "all_routes_inactive") {
    const names = detailsObj.inactiveRouteNames;
    if (Array.isArray(names) && names.length > 0) {
      const nameList = names.map((n: unknown) => String(n)).filter(Boolean).join(", ");
      errorMessage = `${errorMessage}: ${nameList}`;
    }
  }
  const mechanism = normalizeMechanism(row.type, row.source);
  const connection = normalizeConnection(row, detailsObj);
  const traceId = firstText(detailsObj.traceId);
  const traceStep = firstText(detailsObj.step);
  let details: string;
  if (typeof raw === "string") {
    details = raw;
  } else if (raw && typeof raw === "object" && "message" in raw) {
    details = String((raw as Record<string, unknown>).message);
  } else {
    details = raw == null ? "" : JSON.stringify(raw);
  }

  const processingStatusLabel = mapProcessingLabel(processingStatus);
  const title = errorMessage ? `${processingStatusLabel}: ${errorMessage}` : processingStatusLabel;

  return {
    id: row.id,
    type: row.type,
    typeLabel: mapTypeLabel(row.type),
    title,
    source: row.source,
    destination: row.destination,
    status: row.status,
    details,
    message,
    errorMessage,
    processingStatus,
    processingStatusLabel,
    routeId,
    routeName,
    mechanism: mechanism.key,
    mechanismLabel: mechanism.label,
    connection: connection.key,
    connectionLabel: connection.label,
    capturedAt,
    isMessageFlow: isMessageFlow(row),
    isFinalOutcome: shouldTreatAsFinalOutcome(row),
    createdAt: row.created_at,
    traceId,
    traceStep,
  };
}

const PAGE_SIZE = 50;

export function useHistorico() {
  const { user } = useAuth();

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: ["history_entries", user?.id],
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam as { created_at: string; id: string } | undefined;
      const q = backend
        .from("history_entries")
        .select("id, type, source, destination, status, details, processing_status, block_reason, direction, created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGE_SIZE);

      if (cursor) q.cursor(cursor);

      const { data: rows, error, next_cursor } = await q;
      if (error) throw error;
      return { rows: (rows || []).map(mapRow), next_cursor: next_cursor ?? null };
    },
    initialPageParam: undefined as { created_at: string; id: string } | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.next_cursor ?? undefined,
    enabled: !!user,
    staleTime: 60_000,
    refetchInterval: () => (document.visibilityState === "visible" ? 30_000 : false),
  });

  const entries = data?.pages.flatMap((p) => p.rows) ?? [];

  return { entries, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch };
}
