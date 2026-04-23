import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { endOfDay, startOfDay, subDays } from "date-fns";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/backend/types";

export interface HistoricoFilters {
  timeRange: string;  // "today" | "yesterday" | "last_3_days" | "last_7_days" | "all"
  status: string;     // "all" | "sent" | "failed" | "blocked"
  mechanism: string;  // "all" | "automatic_routes" | "schedule" | "smart_automation"
}

export interface HistoricoServerCounts {
  sent: number;
  failed: number;
  blocked: number;
  total: number;
}

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
  createdAt: string;
  traceId: string;
  traceStep: string;
}

const ALL_TRACKED_TYPES = ["route_forward", "schedule_sent", "automation_run"];

const MECHANISM_TO_TYPES: Record<string, string[]> = {
  automatic_routes: ["route_forward"],
  schedule:         ["schedule_sent"],
  smart_automation: ["automation_run"],
};

// Block reasons that represent "no route found" or system noise — not relevant to the user
const NOISE_BLOCK_REASONS = [
  "source_group_not_found",
  "no_routes_configured",
  "no_active_routes",
  "all_routes_inactive",
  "from_me_ignored",
  "unsupported_media_type",
];

const NOISE_BLOCK_REASON_SET = new Set(NOISE_BLOCK_REASONS.map((value) => String(value).trim().toLowerCase()));

function normalizeReasonKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeErrorAliasKey(value: unknown): string {
  return normalizeReasonKey(value).replace(/[\s-]+/g, "_");
}

function hasNoiseBlockReason(row: Tables<"history_entries">): boolean {
  const rowReason = normalizeReasonKey(row.block_reason);
  if (rowReason && NOISE_BLOCK_REASON_SET.has(rowReason)) return true;

  const detailsObj = asObject(row.details);
  const candidates = [
    detailsObj.reason,
    detailsObj.error,
    detailsObj.blockReason,
    detailsObj.block_reason,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeReasonKey(candidate);
    if (normalized && NOISE_BLOCK_REASON_SET.has(normalized)) return true;
  }

  return false;
}

function getDateBounds(timeRange: string): { gte?: string; lte?: string } {
  const now = new Date();
  if (timeRange === "today")
    return { gte: startOfDay(now).toISOString() };
  if (timeRange === "yesterday") {
    const d = subDays(now, 1);
    return { gte: startOfDay(d).toISOString(), lte: endOfDay(d).toISOString() };
  }
  if (timeRange === "last_3_days")
    return { gte: startOfDay(subDays(now, 2)).toISOString() };
  if (timeRange === "last_7_days")
    return { gte: startOfDay(subDays(now, 6)).toISOString() };
  return {};
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
  const aliasKey = normalizeErrorAliasKey(key);

  const map: Record<string, string> = {
    source_group_not_found: "Grupo de origem não encontrado no sistema",
    no_active_routes: "Nenhuma rota ativa para esta origem",
    no_routes_configured: "Grupo de origem sem nenhuma rota configurada",
    all_routes_inactive: "Rota existe mas está inativa - ative a rota nas configurações",
    negative_keyword: "Bloqueada por palavra-chave negativa",
    positive_keyword_missing: "Bloqueada: ausência de palavra-chave obrigatória",
    partner_link_required: "Bloqueada: mensagem sem link de afiliado obrigatório",
    marketplace_not_enabled: "Bloqueada: marketplace não habilitado para esta rota",
    from_me_ignored: "Bloqueada: mensagem de eco/origem própria foi ignorada para evitar loop",
    no_destination_groups: "Rota sem grupos de destino configurados",
    no_destination_groups_for_session: "Rota sem grupos de destino configurados para esta sessão",
    destination_not_found: "Grupo de destino não encontrado",
    destination_session_offline: "Sessão do grupo de destino está offline",
    destination_send_failed: "Falha ao enviar a mensagem para o destino",
    invalid_destination: "Grupo de destino inválido ou incompleto (sessão/identificador ausente)",
    unsupported_media_type: "Bloqueada: mídia recebida não é suportada para roteamento",
    missing_image_required: "Bloqueada: rota exige imagem obrigatória",
    image_ingestion_failed: "Bloqueada: mídia recebida, mas não foi possível processar",
    missing_text_required: "Bloqueada: rota exige texto obrigatório",
    meli_session_missing: "Bloqueada: sessão do Mercado Livre não configurada",
    missing_meli_session: "Bloqueada: sessão do Mercado Livre não configurada",
    meli_conversion_failed: "Bloqueada: falha ao converter link Mercado Livre",
    meli_service_unavailable: "Bloqueada: serviço Mercado Livre temporariamente indisponível",
    shopee_conversion_failed: "Bloqueada: falha ao converter link Shopee",
    shopee_service_unavailable: "Bloqueada: serviço Shopee temporariamente indisponível",
    shopee_credentials_missing: "Bloqueada: credenciais do Shopee não configuradas",
    missing_credentials: "Credenciais Shopee ausentes para executar a automação",
    offer_lookup_failed: "Não foi possível buscar ofertas no Shopee. Revise as credenciais da integração e tente novamente",
    no_eligible_offer: "Nenhuma oferta disponível agora dentro dos filtros configurados",
    offer_duplicate_blocked: "Sem oferta nova agora: as opções encontradas já foram enviadas recentemente",
    missing_affiliate_link: "Oferta encontrada sem link de afiliado válido",
    amazon_conversion_failed: "Bloqueada: falha ao converter link Amazon",
    conversion_required: "Bloqueada: não foi possível converter os links obrigatórios",
    plan_expired: "Plano expirado — renove o plano para reativar o envio",
    route_processing_error: "Erro interno ao processar a rota",
    quiet_hours_queued: "Mensagem aguardando: período de silêncio ativo",
    quiet_hours_queue_failed: "Falha ao enfileirar mensagem no período de silêncio",
  };

  if (map[key]) return map[key];
  if (map[aliasKey]) return map[aliasKey];

  const timeoutMatch = key.match(/^Microservice timeout\s*\((\d+)s\)$/i);
  if (timeoutMatch) return `Tempo limite excedido ao comunicar com o serviço (${timeoutMatch[1]}s)`;

  if (/^Invalid JSON from microservice$/i.test(key)) {
    return "Resposta inválida recebida do serviço externo";
  }

  const microserviceStatusMatch = key.match(/^Microservice error\s*(\d{3})$/i);
  if (microserviceStatusMatch) {
    return `Serviço externo indisponível no momento (erro ${microserviceStatusMatch[1]})`;
  }

  if (/credenciais\s+shopee\s+inv[aá]lidas/i.test(key)) {
    return "Credenciais Shopee inválidas (appId/secret). Revise as credenciais da integração";
  }

  if (/^[a-z0-9_:-]+$/.test(key)) return key.replace(/_/g, " ");
  if (/^[a-z0-9_:-]+$/.test(aliasKey)) return aliasKey.replace(/_/g, " ");
  return key;
}

function mapTypeLabel(type: string): string {
  switch (type) {
    case "session_event":   return "Captura";
    case "message_sent":    return "Envio";
    case "route_forward":   return "Roteamento";
    case "schedule_sent":   return "Agendamento";
    case "automation_run":  return "Automação";
    case "automation_trace":return "Rastro automação";
    default:                return type.replace(/_/g, " ");
  }
}

function mapProcessingLabel(status: string, rowType: string, destination: string): string {
  const isAutomationDiagnostic = rowType === "automation_run"
    && String(destination || "").trim().toLowerCase() === "automation:diagnostic";

  switch (status) {
    case "received": return "Mensagem capturada";
    case "sent":     return "Enviada ao destino";
    case "failed":   return isAutomationDiagnostic ? "Falha na automação" : "Falha ao enviar";
    case "error":    return isAutomationDiagnostic ? "Falha na automação" : "Falha ao enviar";
    case "blocked":  return isAutomationDiagnostic ? "Bloqueada por regra da automação" : "Bloqueada por regra";
    default:         return "Processada";
  }
}

function normalizeMechanism(type: string, source: string): { key: string; label: string } {
  if (type === "route_forward" || type === "route_dispatch") return { key: "automatic_routes", label: "Rotas automáticas" };
  if (type === "schedule_sent" || source === "Agendamento")  return { key: "schedule", label: "Agendamento" };
  if (type === "automation_run")   return { key: "smart_automation", label: "Automações criadas" };
  if (type === "automation_trace") return { key: "smart_automation", label: "Automações criadas" };
  return { key: "other", label: "Outro" };
}

function normalizeConnection(row: Tables<"history_entries">, detailsObj: Record<string, unknown>): { key: string; label: string } {
  const detailPlatform = firstText(detailsObj.platform).toLowerCase();
  const source = String(row.source || "").toLowerCase();
  const destination = String(row.destination || "").toLowerCase();

  if (detailPlatform === "whatsapp" || source.includes("whatsapp")) return { key: "whatsapp", label: "WhatsApp" };
  if (detailPlatform === "telegram" || source.includes("telegram")) return { key: "telegram", label: "Telegram" };
  if (destination.includes("whatsapp")) return { key: "whatsapp", label: "WhatsApp" };
  if (destination.includes("telegram")) return { key: "telegram", label: "Telegram" };
  return { key: "other", label: "Outro" };
}

function mapRow(row: Tables<"history_entries">): SendHistoryEntry {
  const raw = row.details;
  const detailsObj = asObject(raw);
  const isAutomationDiagnostic = String(row.destination || "").trim().toLowerCase() === "automation:diagnostic";
  const message = firstText(detailsObj.message, detailsObj.text, raw);
  const routeId = firstText(detailsObj.routeId);
  const routeName = firstText(detailsObj.routeName);
  const capturedAt = firstText(detailsObj.capturedAt) || row.created_at;
  const processingStatus = String(row.processing_status || "processed");
  const rawErrorMessage = isAutomationDiagnostic
    ? firstText(detailsObj.error, detailsObj.message, detailsObj.reason, row.block_reason)
    : firstText(detailsObj.error, detailsObj.reason, row.block_reason);
  let errorMessage = humanizeErrorMessage(rawErrorMessage);
  if (!errorMessage && !isAutomationDiagnostic) {
    errorMessage = humanizeErrorMessage(firstText(detailsObj.reason, row.block_reason));
  }
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

  const processingStatusLabel = mapProcessingLabel(processingStatus, row.type, row.destination);
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
    createdAt: row.created_at,
    traceId,
    traceStep,
  };
}

const PAGE_SIZE = 50;

const DEFAULT_FILTERS: HistoricoFilters = {
  timeRange: "all",
  status: "all",
  mechanism: "all",
};

export function useHistorico(filters: HistoricoFilters = DEFAULT_FILTERS) {
  const { user } = useAuth();

  const types = MECHANISM_TO_TYPES[filters.mechanism] ?? ALL_TRACKED_TYPES;
  const processingStatuses = filters.status !== "all"
    ? [filters.status === "failed" ? "error" : filters.status]
    : ["sent", "error", "blocked"];
  const dateBounds = getDateBounds(filters.timeRange);

  // Paginated list query
  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: ["history_entries", user?.id, filters.timeRange, filters.status, filters.mechanism],
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam as { created_at: string; id: string } | undefined;
      let q = backend
        .from("history_entries")
        .select("id, type, source, destination, status, details, processing_status, block_reason, direction, created_at")
        .in("type", types)
        .in("processing_status", processingStatuses)
        .nin("block_reason", NOISE_BLOCK_REASONS)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGE_SIZE);
      if (dateBounds.gte) q = q.gte("created_at", dateBounds.gte);
      if (dateBounds.lte) q = q.lte("created_at", dateBounds.lte);
      if (cursor) q = q.cursor(cursor);

      const { data: rows, error, next_cursor } = await q;
      if (error) throw error;
      const safeRows = (rows || []).filter((row) => !hasNoiseBlockReason(row));
      const hiddenNoiseCount = (rows || []).length - safeRows.length;
      return {
        rows: safeRows.map(mapRow),
        next_cursor: next_cursor ?? null,
        hadNoiseFiltered: hiddenNoiseCount > 0,
        hiddenNoiseCount,
      };
    },
    initialPageParam: undefined as { created_at: string; id: string } | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: !!user,
    staleTime: 60_000,
    refetchInterval: () => (document.visibilityState === "visible" ? 30_000 : false),
  });

  // Period counts — NOT filtered by status so the pills always show the full breakdown.
  // Uses only mechanism + timeRange + noise filter, same as the list query minus status.
  const countBounds = dateBounds;
  const countTypes = types;

  const { data: serverCounts, isLoading: isLoadingCounts } = useQuery({
    queryKey: ["history_entries_count", user?.id, filters.timeRange, filters.mechanism],
    queryFn: async (): Promise<HistoricoServerCounts> => {
      const countFor = async (status: string): Promise<number> => {
        let q = backend
          .from("history_entries")
          .select("", { head: true } as { head: true })
          .in("type", countTypes)
          .eq("processing_status", status)
          .nin("block_reason", NOISE_BLOCK_REASONS);
        if (countBounds.gte) q = q.gte("created_at", countBounds.gte);
        if (countBounds.lte) q = q.lte("created_at", countBounds.lte);
        const r = await q;
        return (r as unknown as { count: number | null }).count ?? 0;
      };

      const [sent, failed, blocked] = await Promise.all([
        countFor("sent"),
        countFor("error"),
        countFor("blocked"),
      ]);
      return { sent, failed, blocked, total: sent + failed + blocked };
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  const entries = data?.pages.flatMap((p) => p.rows) ?? [];
  const hasClientNoiseFiltered = data?.pages.some((p) => p.hadNoiseFiltered) ?? false;
  const clientNoiseFilteredCount = data?.pages.reduce((total, page) => total + (page.hiddenNoiseCount ?? 0), 0) ?? 0;

  return {
    entries,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
    serverCounts,
    isLoadingCounts,
    hasClientNoiseFiltered,
    clientNoiseFilteredCount,
  };
}
