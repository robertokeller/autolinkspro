import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { backend } from "@/integrations/backend/client";
import type { Tables } from "@/integrations/backend/types";
import { invokeTelegramAction } from "@/lib/channel-central";
import type { TelegramSession } from "@/lib/types";
import { validatePhone } from "@/lib/phone-utils";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeSessionStatus } from "@/lib/session-status";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import { normalizePlanId, PLAN_SYNC_ERROR_MESSAGE } from "@/lib/plan-id";

type TelegramSessionRow = Tables<"telegram_sessions">;
type TelegramConnectAction = "send_code" | "verify_code" | "verify_password" | "disconnect" | "sync_groups";

interface CreateSessionInput {
  name: string;
  phone: string;
}

interface VerifyCodeInput {
  sessionId: string;
  code: string;
}

interface VerifyPasswordInput {
  sessionId: string;
  password: string;
}

interface RenameSessionInput {
  sessionId: string;
  name: string;
}

interface RefreshOptions {
  silent?: boolean;
}

function mapRowToSession(row: TelegramSessionRow, runtimeStatus?: ReturnType<typeof normalizeSessionStatus>): TelegramSession {
  const status = runtimeStatus ?? normalizeSessionStatus(row.status);
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone || "",
    status,
    connectedAt: row.connected_at,
    errorMessage: status === "online" ? null : row.error_message?.trim() ? row.error_message : null,
  };
}

async function invokeTelegramConnect(
  sessionId: string,
  action: TelegramConnectAction,
  payload: Record<string, unknown> = {},
) {
  return invokeTelegramAction<Record<string, unknown>>(action, { sessionId, ...payload });
}

function toFriendlyRuntimeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message;
  if (/localhost|127\.|::1/.test(msg)) return fallback;
  return msg || fallback;
}

export function useTelegramSessions() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();

  const { data: sessionRows = [], isLoading, error } = useQuery({
    queryKey: ["telegram-sessions", user?.id],
    queryFn: async () => {
      const { data, error: queryError } = await backend
        .from("telegram_sessions")
        .select("*")
        .order("created_at", { ascending: false });

      if (queryError) throw queryError;
      return data || [];
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 5_000 : false),
    staleTime: 3_000,
  });

  const { data: runtimeStatusBySession = new Map<string, ReturnType<typeof normalizeSessionStatus>>() } = useQuery({
    queryKey: ["telegram-runtime-health", user?.id],
    queryFn: async () => {
      const payload = await invokeTelegramAction<Record<string, unknown>>("health");
      const runtimeSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      const statusMap = new Map<string, ReturnType<typeof normalizeSessionStatus>>();

      for (const item of runtimeSessions) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const sessionId = String(row.sessionId ?? row.id ?? "").trim();
        if (!sessionId) continue;
        statusMap.set(sessionId, normalizeSessionStatus(String(row.status ?? "")));
      }

      return statusMap;
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 5_000 : false),
    staleTime: 3_000,
  });

  const sessions = useMemo(
    () => sessionRows.map((row) => mapRowToSession(row, runtimeStatusBySession.get(String(row.id)))),
    [sessionRows, runtimeStatusBySession],
  );

  const invalidateSessions = () => {
    qc.invalidateQueries({ queryKey: ["telegram-sessions"] });
  };

  const refreshMutation = useMutation({
    mutationFn: async (options?: RefreshOptions) => {
      const payload = await invokeTelegramAction<Record<string, unknown>>("refresh_status");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["telegram-sessions"] }),
        qc.invalidateQueries({ queryKey: ["groups"] }),
        qc.invalidateQueries({ queryKey: ["master_groups"] }),
      ]);
      return { payload, silent: options?.silent === true };
    },
    onSuccess: ({ silent }) => {
      if (silent) return;
      toast.success("Atualização do Telegram concluída.");
    },
    onError: (err, options) => {
      if (options?.silent) return;
      const msg = toFriendlyRuntimeError(err, "Não foi possível atualizar o Telegram agora.");
      toast.error(msg);
    },
  });

  // Polls the Telegram microservice for the latest events (status, groups, etc.) and then
  // invalidates sessions/groups queries so the UI reflects the runtime state.
  const refresh = async (options?: RefreshOptions) => {
    await refreshMutation.mutateAsync(options);
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

        const maxSessions = limits?.telegramSessions ?? 0;
        if (maxSessions !== -1 && sessions.length >= maxSessions) {
          throw new Error("Limite de sessões Telegram atingido para o seu nível de acesso.");
        }
      }

      const name = input.name.trim();
      if (!name) throw new Error("Informe o nome da sessão");

      const phoneValidation = validatePhone(input.phone);
      if (!phoneValidation.valid) {
        throw new Error(phoneValidation.error || "Telefone inválido");
      }

      const { data: created, error: insertError } = await backend
        .from("telegram_sessions")
        .insert({
          user_id: user.id,
          name,
          phone: phoneValidation.normalized,
          status: "offline",
          error_message: "",
          phone_code_hash: "",
          session_string: "",
        })
        .select("*")
        .single();

      if (insertError) throw insertError;
      if (!created || typeof created !== "object" || !("id" in created)) {
        throw new Error("Falha ao criar sessão Telegram");
      }
      return String(created.id);
    },
    onSuccess: () => {
      invalidateSessions();
      toast.success("Sessão Telegram criada");
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao criar sessão Telegram");
      toast.error(msg);
    },
  });

  const sendCodeMutation = useMutation({
    mutationFn: (sessionId: string) => invokeTelegramConnect(sessionId, "send_code"),
    onSuccess: (data) => {
      invalidateSessions();
      if (data?.status === "awaiting_code") {
        toast.info("Código enviado. Informe o código recebido no Telegram.");
      } else {
        toast.success("Conexão Telegram iniciada");
      }
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao iniciar conexão Telegram");
      toast.error(msg);
    },
  });

  const verifyCodeMutation = useMutation({
    mutationFn: (input: VerifyCodeInput) =>
      invokeTelegramConnect(input.sessionId, "verify_code", { code: input.code }),
    onSuccess: (data) => {
      invalidateSessions();
      if (data?.status === "awaiting_password") {
        toast.info("Conta com 2FA. Informe a senha para concluir.");
      } else if (data?.status === "online") {
        toast.success("Telegram conectado");
      } else {
        toast.success("Código enviado para verificação");
      }
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao verificar codigo");
      toast.error(msg);
    },
  });

  const verifyPasswordMutation = useMutation({
    mutationFn: (input: VerifyPasswordInput) =>
      invokeTelegramConnect(input.sessionId, "verify_password", { password: input.password }),
    onSuccess: (data) => {
      invalidateSessions();
      if (data?.status === "online") {
        toast.success("Telegram conectado");
      } else {
        toast.success("Senha enviada para verificação");
      }
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao verificar senha 2FA");
      toast.error(msg);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (sessionId: string) => invokeTelegramConnect(sessionId, "disconnect"),
    onSuccess: () => {
      invalidateSessions();
      toast.success("Sessão Telegram desconectada");
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao desconectar sessão Telegram");
      toast.error(msg);
    },
  });

  const syncGroupsMutation = useMutation({
    mutationFn: (sessionId: string) => invokeTelegramConnect(sessionId, "sync_groups"),
    onSuccess: (data) => {
      invalidateSessions();
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["master_groups"] });

      const blockedGroups = Number((data as Record<string, unknown> | undefined)?.blockedGroups || 0);
      if (blockedGroups > 0) {
        toast.warning(`Sincronização parcial: ${blockedGroups} grupo(s) excederam o limite de Telegram do seu plano.`);
      } else {
        toast.success("Sincronização de grupos Telegram solicitada");
      }
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao sincronizar grupos Telegram");
      toast.error(msg);
    },
  });

  const renameSessionMutation = useMutation({
    mutationFn: async (input: RenameSessionInput) => {
      if (!user) throw new Error("Usuário não autenticado");

      const name = input.name.trim();
      if (!name) throw new Error("Informe um nome válido para a sessão");

      const { error: updateError } = await backend
        .from("telegram_sessions")
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

      await invokeTelegramConnect(sessionId, "disconnect", { clearSession: true }).catch(() => undefined);

      // Soft-delete groups: preserve UUIDs (routes reference them) by nullifying session_id
      // and recording deleted_at. Groups disappear from the UI but the rows remain in the DB for
      // 3 days. upsertGroup's deadCrossMatch logic re-associates them when the same external_id
      // is synced under a new session, clearing deleted_at and restoring routes automatically.
      const { error: groupsError } = await backend
        .from("groups")
        .update({ session_id: null, deleted_at: new Date().toISOString() })
        .eq("platform", "telegram")
        .eq("session_id", sessionId)
        .eq("user_id", user.id);

      if (groupsError) throw groupsError;

      const { error: deleteError } = await backend
        .from("telegram_sessions")
        .delete()
        .eq("id", sessionId)
        .eq("user_id", user.id);

      if (deleteError) throw deleteError;
    },
    onSuccess: () => {
      invalidateSessions();
      qc.invalidateQueries({ queryKey: ["groups"] });
      toast.success("Sessão Telegram removida");
    },
    onError: (err: unknown) => {
      const msg = toFriendlyRuntimeError(err, "Erro ao remover sessão Telegram");
      toast.error(msg);
    },
  });

  return {
    sessions,
    isLoading,
    error: error as Error | null,
    createSession: createSessionMutation.mutateAsync,
    sendCode: sendCodeMutation.mutateAsync,
    verifyCode: verifyCodeMutation.mutateAsync,
    verifyPassword: verifyPasswordMutation.mutateAsync,
    disconnectSession: disconnectMutation.mutateAsync,
    syncSessionGroups: syncGroupsMutation.mutateAsync,
    renameSession: renameSessionMutation.mutateAsync,
    deleteSession: deleteSessionMutation.mutateAsync,
    isCreating: createSessionMutation.isPending,
    isSendingCode: sendCodeMutation.isPending,
    isVerifyingCode: verifyCodeMutation.isPending,
    isVerifyingPassword: verifyPasswordMutation.isPending,
    isDisconnecting: disconnectMutation.isPending,
    isSyncingGroups: syncGroupsMutation.isPending,
    isRenaming: renameSessionMutation.isPending,
    isDeleting: deleteSessionMutation.isPending,
    isRefreshing: refreshMutation.isPending,
    refresh,
  };
}
