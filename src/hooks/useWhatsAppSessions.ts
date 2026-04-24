import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { backend } from "@/integrations/backend/client";
import type { Tables } from "@/integrations/backend/types";
import { invokeWhatsAppAction } from "@/lib/channel-central";
import type { AuthMethod, SessionStatus, WhatsAppSession } from "@/lib/types";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeSessionStatus } from "@/lib/session-status";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import { normalizePlanId, PLAN_SYNC_ERROR_MESSAGE } from "@/lib/plan-id";
import { syncAllWhatsAppGroups } from "@/integrations/analytics-client";

type WhatsAppSessionRow = Tables<"whatsapp_sessions">;

interface CreateSessionInput {
  name: string;
  phone?: string;
  authMethod: AuthMethod;
}

interface RenameSessionInput {
  sessionId: string;
  name: string;
}

interface RefreshOptions {
  silent?: boolean;
}

interface RefreshSessionInput extends RefreshOptions {
  sessionId: string;
}

interface RuntimeHealthSnapshot {
  statusBySession: Map<string, SessionStatus>;
  sessionsSeen: Set<string>;
  hasSessionDetails: boolean;
}

const RUNTIME_CONNECT_GRACE_MS = 25_000;

function isWithinRuntimeConnectGrace(row: WhatsAppSessionRow, status: SessionStatus): boolean {
  if (!(status === "connecting" || status === "qr_code" || status === "pairing_code")) {
    return false;
  }

  const updatedAt = String(row.updated_at ?? "").trim();
  if (!updatedAt) return false;

  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;

  return Date.now() - updatedAtMs <= RUNTIME_CONNECT_GRACE_MS;
}

function mapRowToSession(
  row: WhatsAppSessionRow,
  runtime: RuntimeHealthSnapshot,
): WhatsAppSession {
  const dbStatus = normalizeSessionStatus(row.status);
  const sessionId = String(row.id || "").trim();
  const runtimeStatus = sessionId ? runtime.statusBySession.get(sessionId) : undefined;
  const runtimeKnowsSession = sessionId ? runtime.sessionsSeen.has(sessionId) : false;
  const dbLooksConnected = dbStatus === "online" || dbStatus === "connecting" || dbStatus === "qr_code" || dbStatus === "pairing_code";
  const missingInRuntime = runtime.hasSessionDetails && !runtimeKnowsSession;
  const withinRuntimeGrace = missingInRuntime && isWithinRuntimeConnectGrace(row, dbStatus);
  const shouldWarnMissingRuntime = missingInRuntime && dbLooksConnected && !withinRuntimeGrace;
  const status = runtimeStatus ?? (shouldWarnMissingRuntime ? "warning" : dbStatus);
  const qrOrPairing = row.qr_code?.trim() ? row.qr_code : null;
  const qrCode = status === "qr_code" && qrOrPairing ? qrOrPairing : null;
  const runtimeMissingMessage = "Sessão não está ativa no runtime atual. Refaça a conexão.";
  const errorMessage = status === "online"
    ? null
    : shouldWarnMissingRuntime
      ? runtimeMissingMessage
      : row.error_message?.trim()
        ? row.error_message
        : null;

  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone || "",
    status,
    isDefault: row.is_default,
    authMethod: "qr",
    qrCode,
    pairingCode: null,
    errorMessage,
    connectedAt: row.connected_at,
  };
}

async function invokeWhatsappConnect(sessionId: string, action: "connect" | "disconnect" | "delete" | "sync_groups") {
  return invokeWhatsAppAction<Record<string, unknown>>(action, { sessionId });
}

function toFriendlyRuntimeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message;
  if (/localhost|127\.|::1/.test(msg)) return fallback;
  return msg || fallback;
}

export function useWhatsAppSessions() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();

  const { data: sessionRows = [], isLoading, error } = useQuery({
    queryKey: ["whatsapp-sessions", user?.id],
    queryFn: async () => {
      const { data, error: queryError } = await backend
        .from("whatsapp_sessions")
        .select("*")
        .order("created_at", { ascending: false });

      if (queryError) throw queryError;
      return data || [];
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 10_000 : false),
    staleTime: 5_000,
  });

  const emptyRuntimeSnapshot: RuntimeHealthSnapshot = {
    statusBySession: new Map<string, SessionStatus>(),
    sessionsSeen: new Set<string>(),
    hasSessionDetails: false,
  };

  const { data: runtimeSnapshot = emptyRuntimeSnapshot } = useQuery({
    queryKey: ["whatsapp-runtime-health", user?.id],
    queryFn: async () => {
      const payload = await invokeWhatsAppAction<Record<string, unknown>>("health");
      const runtimeSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      const statusBySession = new Map<string, SessionStatus>();
      const sessionsSeen = new Set<string>();

      for (const item of runtimeSessions) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const sessionId = String(row.sessionId ?? row.id ?? "").trim();
        if (!sessionId) continue;
        sessionsSeen.add(sessionId);
        statusBySession.set(sessionId, normalizeSessionStatus(String(row.status ?? "")));
      }

      return {
        statusBySession,
        sessionsSeen,
        hasSessionDetails: Array.isArray(payload.sessions),
      } satisfies RuntimeHealthSnapshot;
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 10_000 : false),
    staleTime: 5_000,
  });

  const sessions = useMemo(
    () => sessionRows.map((row) => mapRowToSession(row, runtimeSnapshot)),
    [sessionRows, runtimeSnapshot],
  );

  const invalidateSessions = () => {
    qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
    qc.invalidateQueries({ queryKey: ["whatsapp-runtime-health"] });
  };

  const refreshMutation = useMutation({
    mutationFn: async (options?: RefreshOptions) => {
      const payload = await invokeWhatsAppAction<Record<string, unknown>>("poll_events_all");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] }),
        qc.invalidateQueries({ queryKey: ["whatsapp-runtime-health"] }),
        qc.invalidateQueries({ queryKey: ["groups"] }),
        qc.invalidateQueries({ queryKey: ["master_groups"] }),
      ]);
      return { payload, silent: options?.silent === true };
    },
    onSuccess: ({ silent }) => {
      if (silent) return;
      toast.success("Atualização do WhatsApp concluída.");
    },
    onError: (err, options) => {
      if (options?.silent) return;
      const msg = toFriendlyRuntimeError(err, "Não foi possível atualizar o WhatsApp agora.");
      toast.error(msg);
    },
  });

  const refreshSessionMutation = useMutation({
    mutationFn: async ({ sessionId, silent }: RefreshSessionInput) => {
      const payload = await invokeWhatsAppAction<Record<string, unknown>>("poll_events", { sessionId });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] }),
        qc.invalidateQueries({ queryKey: ["whatsapp-runtime-health"] }),
        qc.invalidateQueries({ queryKey: ["groups"] }),
        qc.invalidateQueries({ queryKey: ["master_groups"] }),
      ]);
      return { payload, silent: silent === true };
    },
    onSuccess: ({ silent }) => {
      if (silent) return;
      toast.success("Sessão do WhatsApp atualizada.");
    },
    onError: (err, variables) => {
      if (variables?.silent) return;
      const msg = toFriendlyRuntimeError(err, "Não foi possível atualizar essa sessão agora.");
      toast.error(msg);
    },
  });

  // Polls the microservice for the latest events (status, groups, etc.) and then
  // invalidates both sessions and groups queries so the UI reflects real state.
  const refresh = async (options?: RefreshOptions) => {
    await refreshMutation.mutateAsync(options);
  };

  const refreshSession = async (sessionId: string, options?: RefreshOptions) => {
    await refreshSessionMutation.mutateAsync({ sessionId, silent: options?.silent });
  };

  const createSessionMutation = useMutation({
    mutationFn: async (input: CreateSessionInput) => {
      if (!user) throw new Error("Usuário não autenticado");

      if (!isAdmin) {
        const { data: profile, error: profileError } = await backend
          .from("profiles")
          .select("plan_id")
          .eq("user_id", user.id)
          .maybeSingle();
        if (profileError) throw profileError;

        const planId = normalizePlanId(profile?.plan_id);
        if (!planId) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const limits = resolveEffectiveLimitsByPlanId(planId);
        if (!limits) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const maxSessions = limits?.whatsappSessions ?? 0;
        if (maxSessions !== -1 && sessions.length >= maxSessions) {
          throw new Error("Limite de sessões WhatsApp atingido para o seu nível de acesso.");
        }
      }

      const name = input.name.trim();
      if (!name) throw new Error("Informe o nome da sessão");

      const authMethod: AuthMethod = "qr";
      const phoneValidation = { valid: true as const, normalized: "" };

      const shouldBeDefault = sessions.length === 0;

      const { data: created, error: insertError } = await backend
        .from("whatsapp_sessions")
        .insert({
          user_id: user.id,
          name,
          phone: phoneValidation.normalized,
          status: "offline",
          auth_method: authMethod,
          is_default: shouldBeDefault,
          qr_code: "",
          error_message: "",
        })
        .select("*")
        .single();

      if (insertError) throw insertError;
      if (!created || typeof created !== "object" || !("id" in created)) {
        throw new Error("Falha ao criar sessão WhatsApp");
      }
      return String(created.id);
    },
    onSuccess: () => {
      invalidateSessions();
      toast.success("Sessão criada");
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao criar sessão");
      toast.error(msg);
    },
  });

  const connectMutation = useMutation({
    mutationFn: (sessionId: string) => invokeWhatsappConnect(sessionId, "connect"),
    onSuccess: (data) => {
      invalidateSessions();
      if (data?.waiting_webhook) {
        toast.info("Conexão iniciada. Aguardando webhook do microserviço.");
      } else {
        toast.success("Conexão iniciada");
      }
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao conectar sessão");
      toast.error(msg);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (sessionId: string) => invokeWhatsappConnect(sessionId, "disconnect"),
    onSuccess: () => {
      invalidateSessions();
      toast.success("Sessão desconectada");
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao desconectar sessão");
      toast.error(msg);
    },
  });

  const syncGroupsMutation = useMutation({
    mutationFn: (sessionId: string) => invokeWhatsappConnect(sessionId, "sync_groups"),
    onSuccess: (data) => {
      invalidateSessions();
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["master_groups"] });
      qc.invalidateQueries({ queryKey: ["analytics-admin-groups"] });

      const blockedGroups = Number((data as Record<string, unknown> | undefined)?.blockedGroups || 0);
      const syncedGroups = Number((data as Record<string, unknown> | undefined)?.count || 0);
      if (blockedGroups > 0) {
        toast.warning(`Sincronização parcial: ${blockedGroups} grupo(s) excederam o limite de WhatsApp do seu plano.`);
      } else {
        toast.success(syncedGroups > 0
          ? `Sincronização concluída: ${syncedGroups} grupo(s) atualizados.`
          : "Sincronização concluída.");
      }
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao sincronizar grupos");
      toast.error(msg);
    },
  });

  const syncAllGroupsMutation = useMutation({
    mutationFn: async () => syncAllWhatsAppGroups(),
    onSuccess: (result) => {
      invalidateSessions();
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["master_groups"] });
      qc.invalidateQueries({ queryKey: ["analytics-admin-groups"] });
      qc.invalidateQueries({ queryKey: ["routes"] });
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
      qc.invalidateQueries({ queryKey: ["marketplace_automations"] });

      if (result.sessionsSynced > 0) {
        toast.success(`Sincronização concluída: ${result.sessionsSynced} sessão(ões), ${result.totalGroups} grupos.`);
      } else {
        toast.warning("Nenhuma sessão online foi sincronizada. Grupos existentes foram carregados do banco.");
      }

      if (result.errors.length > 0) {
        const preview = result.errors.slice(0, 2).join(" | ");
        toast.warning(`Ocorreram ${result.errors.length} erro(s) na sincronização. ${preview}`);
      }
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao sincronizar grupos");
      toast.error(msg);
    },
  });

  const renameSessionMutation = useMutation({
    mutationFn: async (input: RenameSessionInput) => {
      if (!user) throw new Error("Usuário não autenticado");

      const name = input.name.trim();
      if (!name) throw new Error("Informe um nome válido para a sessão");

      const { error: updateError } = await backend
        .from("whatsapp_sessions")
        .update({ name, updated_at: new Date().toISOString() })
        .eq("id", input.sessionId)
        .eq("user_id", user.id);

      if (updateError) throw updateError;
    },
    onSuccess: () => {
      invalidateSessions();
      toast.success("Nome da sessão atualizado");
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao atualizar sessão");
      toast.error(msg);
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      if (!user) throw new Error("Usuário não autenticado");
      await invokeWhatsappConnect(sessionId, "delete");
    },
    onSuccess: () => {
      invalidateSessions();
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["master_groups"] });
      toast.success("Sessão removida");
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao remover sessão");
      toast.error(msg);
    },
  });

  return {
    sessions,
    isLoading,
    error: error as Error | null,
    createSession: createSessionMutation.mutateAsync,
    connectSession: connectMutation.mutateAsync,
    disconnectSession: disconnectMutation.mutateAsync,
    syncSessionGroups: syncGroupsMutation.mutateAsync,
    syncAllSessionGroups: syncAllGroupsMutation.mutateAsync,
    renameSession: renameSessionMutation.mutateAsync,
    deleteSession: deleteSessionMutation.mutateAsync,
    isCreating: createSessionMutation.isPending,
    isConnecting: connectMutation.isPending,
    isDisconnecting: disconnectMutation.isPending,
    isSyncingGroups: syncGroupsMutation.isPending || syncAllGroupsMutation.isPending,
    isRenaming: renameSessionMutation.isPending,
    isDeleting: deleteSessionMutation.isPending,
    isRefreshing: refreshMutation.isPending || refreshSessionMutation.isPending,
    refresh,
    refreshSession,
  };
}
