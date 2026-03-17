import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { backend } from "@/integrations/backend/client";
import type { Tables } from "@/integrations/backend/types";
import { invokeWhatsAppAction } from "@/lib/channel-central";
import type { AuthMethod, SessionStatus, WhatsAppSession } from "@/lib/types";
import { validatePhone } from "@/lib/phone-utils";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeSessionStatus } from "@/lib/session-status";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";

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

function mapRowToSession(row: WhatsAppSessionRow): WhatsAppSession {
  const status = normalizeSessionStatus(row.status);
  const qrOrPairing = row.qr_code?.trim() ? row.qr_code : null;

  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone || "",
    status,
    isDefault: row.is_default,
    authMethod: row.auth_method === "pairing" ? "pairing" : "qr",
    qrCode: status === "qr_code" ? qrOrPairing : null,
    pairingCode: status === "pairing_code" ? qrOrPairing : null,
    errorMessage: row.error_message?.trim() ? row.error_message : null,
    connectedAt: row.connected_at,
  };
}

async function invokeWhatsappConnect(sessionId: string, action: "connect" | "disconnect" | "sync_groups") {
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

  const { data: sessions = [], isLoading, error } = useQuery({
    queryKey: ["whatsapp-sessions", user?.id],
    queryFn: async () => {
      const { data, error: queryError } = await backend
        .from("whatsapp_sessions")
        .select("*")
        .order("created_at", { ascending: false });

      if (queryError) throw queryError;
      return (data || []).map(mapRowToSession);
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 5_000 : false),
    staleTime: 3_000,
  });

  const invalidateSessions = () => {
    qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
  };

  // Polls the microservice for the latest events (status, groups, etc.) and then
  // invalidates both sessions and groups queries so the UI reflects real state.
  const refresh = () => {
    void invokeWhatsAppAction("poll_events_all")
      .catch(() => undefined)
      .finally(() => {
        qc.invalidateQueries({ queryKey: ["whatsapp-sessions"] });
        qc.invalidateQueries({ queryKey: ["groups"] });
      });
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

        const limits = resolveEffectiveLimitsByPlanId(profile?.plan_id || "plan-starter");
        const maxSessions = limits?.whatsappSessions ?? 0;
        if (maxSessions !== -1 && sessions.length >= maxSessions) {
          throw new Error("Limite de sessões WhatsApp atingido para o seu nível de acesso.");
        }
      }

      const name = input.name.trim();
      if (!name) throw new Error("Informe o nome da sessão");

      const phoneValidation = input.phone
        ? validatePhone(input.phone)
        : { valid: true as const, normalized: "" };
      if (!phoneValidation.valid) {
        throw new Error((phoneValidation as { error?: string }).error || "Telefone inválido");
      }

      const shouldBeDefault = sessions.length === 0;

      const { data: created, error: insertError } = await backend
        .from("whatsapp_sessions")
        .insert({
          user_id: user.id,
          name,
          phone: phoneValidation.normalized,
          status: "offline",
          auth_method: input.authMethod,
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

      const blockedGroups = Number((data as Record<string, unknown> | undefined)?.blockedGroups || 0);
      if (blockedGroups > 0) {
        toast.warning(`Sincronização parcial: ${blockedGroups} grupo(s) excederam o limite de WhatsApp do seu plano.`);
      } else {
        toast.success("Sincronização de grupos solicitada");
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

      await invokeWhatsappConnect(sessionId, "disconnect").catch(() => undefined);

      // Soft-delete groups: preserve UUIDs (routes reference them) by nullifying session_id
      // and recording deleted_at. Groups disappear from the UI but the rows remain in the DB for
      // 3 days. upsertGroup's deadCrossMatch logic re-associates them when the same external_id
      // is synced under a new session, clearing deleted_at and restoring routes automatically.
      const { error: groupsError } = await backend
        .from("groups")
        .update({ session_id: null, deleted_at: new Date().toISOString() })
        .eq("platform", "whatsapp")
        .eq("session_id", sessionId)
        .eq("user_id", user.id);

      if (groupsError) throw groupsError;

      const { error: deleteError } = await backend
        .from("whatsapp_sessions")
        .delete()
        .eq("id", sessionId)
        .eq("user_id", user.id);

      if (deleteError) throw deleteError;
    },
    onSuccess: () => {
      invalidateSessions();
      qc.invalidateQueries({ queryKey: ["groups"] });
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
    renameSession: renameSessionMutation.mutateAsync,
    deleteSession: deleteSessionMutation.mutateAsync,
    isCreating: createSessionMutation.isPending,
    isConnecting: connectMutation.isPending,
    isDisconnecting: disconnectMutation.isPending,
    isSyncingGroups: syncGroupsMutation.isPending,
    isRenaming: renameSessionMutation.isPending,
    isDeleting: deleteSessionMutation.isPending,
    refresh,
  };
}

