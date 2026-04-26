import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import type { Tables } from "@/integrations/backend/types";
import { useAuth } from "@/contexts/AuthContext";

interface HistoricoFilters {
  timeRange: "24h" | "7d" | "30d" | "all";
  status: "all" | "success" | "warning" | "error";
  mechanism: "all" | "route" | "schedule" | "automation";
  page?: number;
  pageSize?: number;
}

interface HistoricoTargetSummary {
  total: number;
  sent: number;
  failed: number;
  blocked: number;
  processed: number;
  skipped: number;
}

export interface SendHistoryEntry {
  id: string;
  automationId: string;
  automationName: string;
  destination: string;
  status: string;
  title: string;
  message: string;
  date: string;
  timeAgo: string;
  processingStatus: string;
  blockReason: string;
  errorStep: string;
  rawErrorMessage: string;
  errorSummary: string;
  type: string;
  messageType: string;
  details: Record<string, unknown>;
  hasTargets: boolean;
  targetSummary: HistoricoTargetSummary;
}

export interface SendHistoryTarget {
  id: string;
  historyEntryId: string;
  destination: string;
  destinationGroupId: string;
  platform: string;
  status: string;
  processingStatus: string;
  blockReason: string;
  errorStep: string;
  rawErrorMessage: string;
  errorSummary: string;
  messageType: string;
  sendOrder: number;
  createdAt: string;
  title: string;
  message: string;
  providerMessageId: string;
  deliveryStatus: string;
  deliveryUpdatedAt: string;
  deliveryError: string;
  deliveryConfirmed: boolean;
  details: Record<string, unknown>;
}

type HistoryEntryRow = Tables<"history_entries">;
type HistoryEntryTargetRow = Tables<"history_entry_targets">;

const LIST_DEFAULT_PAGE_SIZE = 20;
const HISTORY_SEND_TYPES = ["route_forward", "schedule_sent", "automation_run"] as const;

const DEFAULT_HISTORICO_FILTERS: Pick<HistoricoFilters, "timeRange" | "status" | "mechanism"> = {
  timeRange: "all",
  status: "all",
  mechanism: "all",
};

const NOISE_BLOCK_REASONS = new Set([
  "source_group_not_found",
  "no_routes_configured",
  "no_active_routes",
  "all_routes_inactive",
  "missing_runtime_connection",
  "route_session_offline",
  "network_abort",
]);

const NOISE_MESSAGE_PATTERN = /(response ended prematurely|terminated unexpectedly|network.*abort|session.*offline)/i;

function normalizeReasonKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) return text;
  }
  return "";
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toIsoString(value: unknown): string {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return new Date(0).toISOString();
}

function toUtcMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function formatTimeAgo(dateIso: string): string {
  const diffMs = Date.now() - toUtcMs(dateIso);
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "Agora";
  if (diffMinutes < 60) return `${diffMinutes}m atrás`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h atrás`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d atrás`;
}

function summarizeError(rawMessage: string, fallback = "Falha ao processar este envio."): string {
  const normalized = rawMessage.trim();
  if (!normalized) return fallback;

  const lower = normalized.toLowerCase();
  const normalizedKey = lower.replace(/[\s-]+/g, "_");
  const mappedByKey: Record<string, string> = {
    inbound_duplicate: "Mensagem duplicada recebida; bloqueamos para evitar reenvio repetido.",
    marketplace_not_enabled: "Marketplace não habilitado para esta rota.",
    partner_link_required: "A rota exige um link de afiliado válido na mensagem.",
    positive_keyword_missing: "A mensagem não contém a palavra-chave obrigatória desta rota.",
    negative_keyword: "A mensagem foi bloqueada por palavra-chave negativa da rota.",
    destination_not_found: "Grupo de destino não encontrado para esta rota.",
    destination_session_offline: "A sessão do grupo de destino está offline.",
    destination_send_failed: "Falha ao enviar a mensagem para o destino.",
    missing_text_required: "A rota exige texto e esta mensagem não possui conteúdo textual.",
    missing_image_required: "A rota exige imagem e ela não foi encontrada na mensagem.",
    unsupported_media_type: "Tipo de mídia não suportado para roteamento.",
    plan_expired: "Seu plano expirou e o envio foi bloqueado.",
    conversion_required: "Não foi possível converter os links obrigatórios desta rota.",
    route_processing_error: "Erro interno ao processar a rota.",
    quiet_hours_queued: "Mensagem enfileirada por horário de silêncio configurado.",
    quiet_hours_queue_failed: "Falha ao enfileirar a mensagem no horário de silêncio.",
    activity_budget_queued: "Envio pesado: destinos restantes foram colocados em fila dinâmica para reduzir pico.",
    activity_budget_exceeded: "Tempo máximo seguro da atividade foi excedido antes de concluir todos os destinos.",
  };

  if (mappedByKey[normalizedKey]) {
    return mappedByKey[normalizedKey];
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Tempo limite excedido ao falar com o serviço de envio.";
  }
  if (lower.includes("offline") || lower.includes("not connected") || lower.includes("desconect")) {
    return "A sessão de envio está offline no momento.";
  }
  if (lower.includes("invalid_destination") || lower.includes("external_id") || lower.includes("destino")) {
    return "Destino inválido ou incompleto para envio.";
  }
  if (lower.includes("missing_image") || lower.includes("imagem")) {
    return "A imagem obrigatória não está disponível para este envio.";
  }
  if (lower.includes("affiliate") || lower.includes("convers")) {
    return "Não foi possível preparar o link afiliado da oferta.";
  }

  const firstSentence = normalized.split(/(?<=[.!?])\s+/)[0] || normalized;
  return firstSentence.slice(0, 160);
}

function mapProcessingTitle(status: string): string {
  if (status === "sent") return "Enviado";
  if (status === "blocked") return "Bloqueado";
  if (status === "failed" || status === "error") return "Falhou";
  return "Processado";
}

function normalizeTargetSummary(details: Record<string, unknown>): HistoricoTargetSummary {
  const summaryObj = asObject(details.targetSummary);
  return {
    total: Math.max(0, Math.floor(toNumber(summaryObj.total, 0))),
    sent: Math.max(0, Math.floor(toNumber(summaryObj.sent, 0))),
    failed: Math.max(0, Math.floor(toNumber(summaryObj.failed, 0))),
    blocked: Math.max(0, Math.floor(toNumber(summaryObj.blocked, 0))),
    processed: Math.max(0, Math.floor(toNumber(summaryObj.processed, 0))),
    skipped: Math.max(0, Math.floor(toNumber(summaryObj.skipped, 0))),
  };
}

function mapHistoryEntry(row: HistoryEntryRow): SendHistoryEntry {
  const details = asObject(row.details);
  const createdAt = toIsoString(row.created_at);
  const targetSummary = normalizeTargetSummary(details);

  const rawErrorMessage = firstText(
    details.error,
    details.mediaError,
    details.failure,
    row.block_reason,
  );

  const message = firstText(
    details.message,
    details.text,
    details.summary,
  );

  const destination = firstText(
    row.destination,
    details.destination,
    details.target,
    row.source,
    "Destino",
  );

  const errorSummary = summarizeError(rawErrorMessage, "Falha ao processar este envio.");

  return {
    id: row.id,
    automationId: firstText(details.automationId, details.automation_id),
    automationName: firstText(row.source, details.automationName, details.automation_name),
    destination,
    status: row.processing_status || "processed",
    title: mapProcessingTitle(row.processing_status || "processed"),
    message,
    date: createdAt,
    timeAgo: formatTimeAgo(createdAt),
    processingStatus: row.processing_status || "processed",
    blockReason: row.block_reason || "",
    errorStep: row.error_step || "",
    rawErrorMessage,
    errorSummary,
    type: row.type || "",
    messageType: row.message_type || "text",
    details,
    hasTargets: targetSummary.total > 0 || details.hasTargets === true,
    targetSummary,
  };
}

function mapHistoryEntryTarget(row: HistoryEntryTargetRow): SendHistoryTarget {
  const details = asObject(row.details);
  const createdAt = toIsoString(row.created_at);
  const providerMessageId = firstText(row.provider_message_id, details.providerMessageId, details.messageId);
  const deliveryStatus = firstText(row.delivery_status, details.deliveryStatus).toLowerCase();
  const deliveryUpdatedAt = firstText(row.delivery_updated_at, details.deliveryUpdatedAt, createdAt);
  const deliveryError = firstText(row.delivery_error, details.deliveryError);
  const deliveryConfirmed = deliveryStatus === "delivered" || deliveryStatus === "read" || deliveryStatus === "played";

  const rawErrorMessage = firstText(details.error, details.mediaError, row.block_reason, deliveryError);
  const message = firstText(details.message, details.text);

  return {
    id: row.id,
    historyEntryId: row.history_entry_id,
    destination: firstText(row.destination, details.destination, "Destino"),
    destinationGroupId: row.destination_group_id || "",
    platform: row.platform || "",
    status: row.processing_status || "processed",
    processingStatus: row.processing_status || "processed",
    blockReason: row.block_reason || "",
    errorStep: row.error_step || "",
    rawErrorMessage,
    errorSummary: summarizeError(rawErrorMessage),
    messageType: row.message_type || "text",
    sendOrder: Math.max(0, Math.floor(toNumber(row.send_order, 0))),
    createdAt,
    title: mapProcessingTitle(row.processing_status || "processed"),
    message,
    providerMessageId,
    deliveryStatus,
    deliveryUpdatedAt,
    deliveryError,
    deliveryConfirmed,
    details,
  };
}

type HistoryQueryChain = {
  gte(column: string, value: string): HistoryQueryChain;
  eq(column: string, value: string): HistoryQueryChain;
  in(column: string, values: string[]): HistoryQueryChain;
};

function applyTimeRangeFilter<T extends HistoryQueryChain>(query: T, timeRange: HistoricoFilters["timeRange"]): T {
  if (timeRange === "all") return query;
  const now = Date.now();
  const rangeMs = timeRange === "24h"
    ? 24 * 60 * 60 * 1000
    : timeRange === "7d"
      ? 7 * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
  return query.gte("created_at", new Date(now - rangeMs).toISOString()) as T;
}

function applyMechanismFilter<T extends HistoryQueryChain>(query: T, mechanism: HistoricoFilters["mechanism"]): T {
  if (mechanism === "route") return query.eq("type", "route_forward") as T;
  if (mechanism === "schedule") return query.eq("type", "schedule_sent") as T;
  if (mechanism === "automation") return query.eq("type", "automation_run") as T;
  return query.in("type", [...HISTORY_SEND_TYPES]) as T;
}

function applyStatusFilter<T extends HistoryQueryChain>(query: T, status: HistoricoFilters["status"]): T {
  if (status === "success") return query.in("processing_status", ["sent"]) as T;
  if (status === "warning") return query.in("processing_status", ["blocked"]) as T;
  if (status === "error") return query.in("processing_status", ["failed", "error"]) as T;
  return query.in("processing_status", ["sent", "blocked", "failed", "error", "processed", "skipped"]) as T;
}

function shouldKeepEntry(entry: SendHistoryEntry): boolean {
  const details = asObject(entry.details);
  const reasonCandidates = [
    entry.blockReason,
    entry.rawErrorMessage,
    details.reason,
    details.error,
    details.failure,
    details.blockReason,
    details.block_reason,
  ];

  for (const candidate of reasonCandidates) {
    const reason = normalizeReasonKey(candidate);
    if (reason && NOISE_BLOCK_REASONS.has(reason)) return false;
  }

  const haystack = `${entry.rawErrorMessage} ${entry.message}`.toLowerCase();
  return !NOISE_MESSAGE_PATTERN.test(haystack);
}

function isMissingRelationError(error: unknown, relationName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const payload = error as { code?: unknown; message?: unknown };
  const code = String(payload.code || "").trim().toUpperCase();
  if (code === "42P01") return true;
  const message = typeof payload.message === "string" ? payload.message.toLowerCase() : "";
  return message.includes(relationName.toLowerCase()) && message.includes("does not exist");
}

function isMissingColumnError(error: unknown, relationName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const payload = error as { code?: unknown; message?: unknown };
  const code = String(payload.code || "").trim().toUpperCase();
  if (code === "42703") return true;
  const message = typeof payload.message === "string" ? payload.message.toLowerCase() : "";
  return (
    message.includes(relationName.toLowerCase())
    && message.includes("column")
    && message.includes("does not exist")
  );
}

function isInvalidUuidError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const payload = error as { code?: unknown; message?: unknown };
  const code = String(payload.code || "").trim().toUpperCase();
  if (code === "22P02") return true;
  const message = typeof payload.message === "string" ? payload.message.toLowerCase() : "";
  return message.includes("uuid") && message.includes("invalid input syntax");
}

function isUuid(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
}

function extractBackendErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const payload = error as { message?: unknown };
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  return message || fallback;
}

export function useHistorico(filters: Partial<HistoricoFilters> = {}) {
  const { user } = useAuth();

  const resolvedFilters = {
    ...DEFAULT_HISTORICO_FILTERS,
    ...filters,
  };

  const timeRange = resolvedFilters.timeRange;
  const status = resolvedFilters.status;
  const mechanism = resolvedFilters.mechanism;
  const pageSize = Math.min(200, Math.max(1, Math.floor(resolvedFilters.pageSize ?? LIST_DEFAULT_PAGE_SIZE)));
  const page = Math.max(1, Math.floor(resolvedFilters.page ?? 1));

  const listQuery = useQuery({
    queryKey: ["history_entries_page", user?.id, timeRange, status, mechanism, page, pageSize],
    enabled: Boolean(user),
    refetchInterval: () => (document.visibilityState === "visible" ? 30000 : false),
    queryFn: async () => {
      const offset = (page - 1) * pageSize;
      let query = backend
        .from("history_entries")
        .select("id,type,source,destination,message_type,created_at,processing_status,block_reason,error_step,details")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(pageSize)
        .offset(offset);

      query = applyTimeRangeFilter(query, timeRange);
      query = applyMechanismFilter(query, mechanism);
      query = applyStatusFilter(query, status);
      query = query.nin("block_reason", Array.from(NOISE_BLOCK_REASONS));

      const { data, error } = await query;
      if (error) throw error;

      const rawRows = (data || []) as HistoryEntryRow[];
      const rows = rawRows.map(mapHistoryEntry).filter(shouldKeepEntry);

      return {
        rows,
        hadNoiseFiltered: rows.length !== rawRows.length,
      };
    },
  });

  const filteredCountQuery = useQuery({
    queryKey: ["history_entries_filtered_total", user?.id, timeRange, status, mechanism],
    enabled: Boolean(user),
    refetchInterval: 30000,
    queryFn: async () => {
      let query = backend
        .from("history_entries")
        .select("id", { count: "exact", head: true })
        .nin("block_reason", Array.from(NOISE_BLOCK_REASONS));

      query = applyTimeRangeFilter(query, timeRange);
      query = applyMechanismFilter(query, mechanism);
      query = applyStatusFilter(query, status);

      const { count, error } = await query;
      if (error) throw error;
      return Math.max(0, count || 0);
    },
  });

  const countsQuery = useQuery({
    queryKey: ["history_entries_counts", user?.id, timeRange, mechanism],
    enabled: Boolean(user),
    refetchInterval: 30000,
    queryFn: async () => {
      const statuses = [
        { key: "success" as const, value: "sent" },
        { key: "warning" as const, value: "blocked" },
        { key: "error" as const, value: ["failed", "error"] as const },
      ];

      const results = await Promise.all(
        statuses.map(async ({ key, value }) => {
          let query = backend
            .from("history_entries")
            .select("id", { count: "exact", head: true })
            .nin("block_reason", Array.from(NOISE_BLOCK_REASONS));

          if (Array.isArray(value)) {
            query = query.in("processing_status", [...value]);
          } else {
            query = query.eq("processing_status", value);
          }

          query = applyTimeRangeFilter(query, timeRange);
          query = applyMechanismFilter(query, mechanism);

          const { count, error } = await query;
          if (error) throw error;

          return [key, Math.max(0, count || 0)] as const;
        }),
      );

      const summary = {
        total: 0,
        success: 0,
        warning: 0,
        error: 0,
      };

      for (const [key, value] of results) {
        summary[key] = value;
      }

      summary.total = summary.success + summary.warning + summary.error;
      return summary;
    },
  });

  const entries = listQuery.data?.rows || [];
  const totalEntries = filteredCountQuery.data || 0;
  const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));

  const serverCounts = useMemo(() => countsQuery.data || {
    total: 0,
    success: 0,
    warning: 0,
    error: 0,
  }, [countsQuery.data]);

  const fetchEntryTargets = async (historyEntryId: string): Promise<SendHistoryTarget[]> => {
    const normalizedEntryId = historyEntryId.trim();
    if (!normalizedEntryId) return [];
    if (!isUuid(normalizedEntryId)) return [];

    const runTargetsQuery = async (withCreatedAtOrder: boolean) => {
      let query = backend
        .from("history_entry_targets")
        .select("*")
        .eq("history_entry_id", normalizedEntryId);

      if (withCreatedAtOrder) {
        query = query.order("created_at", { ascending: true });
      }

      return query;
    };

    let result = await runTargetsQuery(true);

    if (result.error && isMissingColumnError(result.error, "history_entry_targets")) {
      result = await runTargetsQuery(false);
    }

    if (result.error) {
      if (isMissingRelationError(result.error, "history_entry_targets")) return [];
      if (isInvalidUuidError(result.error)) return [];
      throw new Error(extractBackendErrorMessage(result.error, "Falha ao carregar destinos do evento."));
    }

    const mappedTargets = ((result.data || []) as HistoryEntryTargetRow[]).map(mapHistoryEntryTarget);
    mappedTargets.sort((left, right) => {
      const orderDiff = left.sendOrder - right.sendOrder;
      if (orderDiff !== 0) return orderDiff;
      return toUtcMs(left.createdAt) - toUtcMs(right.createdAt);
    });

    return mappedTargets;
  };

  return {
    entries,
    isLoading: listQuery.isLoading,
    isFetching: listQuery.isFetching,
    error: listQuery.error || countsQuery.error || filteredCountQuery.error,
    refetch: listQuery.refetch,
    totalEntries,
    totalPages,
    page,
    pageSize,
    serverCounts,
    hasClientNoiseFiltered: listQuery.data?.hadNoiseFiltered || false,
    fetchEntryTargets,
  };
}
