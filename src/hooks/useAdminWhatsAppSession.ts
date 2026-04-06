import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { backend } from "@/integrations/backend/client";
import type { Tables } from "@/integrations/backend/types";
import { invokeWhatsAppAction } from "@/lib/channel-central";
import type { SessionStatus, WhatsAppSession } from "@/lib/types";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeSessionStatus } from "@/lib/session-status";

type WhatsAppSessionRow = Tables<"whatsapp_sessions">;

function mapRowToSession(row: WhatsAppSessionRow): WhatsAppSession {
  const status = normalizeSessionStatus(row.status);
  const qrOrPairing = row.qr_code?.trim() ? row.qr_code : null;
  const qrCode = status === "qr_code" && qrOrPairing ? qrOrPairing : null;

  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone || "",
    status,
    isDefault: row.is_default,
    authMethod: "qr",
    qrCode,
    pairingCode: null,
    errorMessage: row.error_message?.trim() ? row.error_message : null,
    connectedAt: row.connected_at,
  };
}

async function invokeWhatsappConnect(sessionId: string, action: "connect" | "disconnect") {
  return invokeWhatsAppAction<Record<string, unknown>>(action, { sessionId });
}

function toFriendlyRuntimeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message;
  if (/localhost|127\.|::1/.test(msg)) return fallback;
  return msg || fallback;
}

interface RefreshOptions {
  silent?: boolean;
}

/**
 * Hook for the admin system WhatsApp session.
 * Limited to a single session (the system/manager WhatsApp).
 * No plan limit checks — admin has unrestricted access.
 */
export function useAdminWhatsAppSession() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: session = null, isLoading } = useQuery({
    queryKey: ["admin-whatsapp-session", user?.id],
    queryFn: async () => {
      const { data, error } = await backend
        .from("whatsapp_sessions")
        .select("*")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: true })
        .limit(1);

      if (error) throw error;
      const row = (data as WhatsAppSessionRow[] | null)?.[0];
      return row ? mapRowToSession(row) : null;
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 5_000 : false),
    staleTime: 3_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-whatsapp-session"] });
  };

  const refreshMutation = useMutation({
    mutationFn: async (options?: RefreshOptions) => {
      await invokeWhatsAppAction<Record<string, unknown>>("poll_events_all");
      await qc.invalidateQueries({ queryKey: ["admin-whatsapp-session"] });
      return { silent: options?.silent === true };
    },
    onSuccess: ({ silent }) => {
      if (!silent) toast.success("Status do WhatsApp atualizado.");
    },
    onError: (err, options) => {
      if (options?.silent) return;
      toast.error(toFriendlyRuntimeError(err, "Não foi possível atualizar o WhatsApp agora."));
    },
  });

  const refreshSessionMutation = useMutation({
    mutationFn: async ({ sessionId, silent }: RefreshOptions & { sessionId: string }) => {
      await invokeWhatsAppAction<Record<string, unknown>>("poll_events", { sessionId });
      await qc.invalidateQueries({ queryKey: ["admin-whatsapp-session"] });
      return { silent: silent === true };
    },
    onSuccess: ({ silent }) => {
      if (!silent) toast.success("Status da sessão atualizado.");
    },
    onError: (err, variables) => {
      if (variables?.silent) return;
      toast.error(toFriendlyRuntimeError(err, "Não foi possível atualizar essa sessão agora."));
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Usuário não autenticado");

      const { data: created, error } = await backend
        .from("whatsapp_sessions")
        .insert({
          user_id: user.id,
          name: "WhatsApp Admin",
          phone: "",
          status: "offline",
          auth_method: "qr",
          is_default: true,
          qr_code: "",
          error_message: "",
        })
        .select("*")
        .single();

      if (error) throw error;
      if (!created || typeof created !== "object" || !("id" in created)) {
        throw new Error("Falha ao criar sessão WhatsApp");
      }
      return String(created.id);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Sessão do sistema criada");
    },
    onError: (err: unknown) => {
      toast.error(toFriendlyRuntimeError(err, "Erro ao criar sessão"));
    },
  });

  const connectMutation = useMutation({
    mutationFn: (sessionId: string) => invokeWhatsappConnect(sessionId, "connect"),
    onSuccess: () => {
      invalidate();
      toast.success("Conexão iniciada");
    },
    onError: (err: unknown) => {
      toast.error(toFriendlyRuntimeError(err, "Erro ao conectar sessão"));
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (sessionId: string) => invokeWhatsappConnect(sessionId, "disconnect"),
    onSuccess: () => {
      invalidate();
      toast.success("Sessão desconectada");
    },
    onError: (err: unknown) => {
      toast.error(toFriendlyRuntimeError(err, "Erro ao desconectar sessão"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      if (!user) throw new Error("Usuário não autenticado");

      await invokeWhatsappConnect(sessionId, "disconnect").catch(() => undefined);

      const { error } = await backend
        .from("whatsapp_sessions")
        .delete()
        .eq("id", sessionId)
        .eq("user_id", user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Sessão removida");
    },
    onError: (err: unknown) => {
      toast.error(toFriendlyRuntimeError(err, "Erro ao remover sessão"));
    },
  });

  return {
    session,
    isLoading,
    createSession: createMutation.mutateAsync,
    connectSession: connectMutation.mutateAsync,
    disconnectSession: disconnectMutation.mutateAsync,
    deleteSession: deleteMutation.mutateAsync,
    refresh: (options?: RefreshOptions) => void refreshMutation.mutateAsync(options),
    refreshSession: (sessionId: string, options?: RefreshOptions) =>
      void refreshSessionMutation.mutateAsync({ sessionId, silent: options?.silent }),
    isCreating: createMutation.isPending,
    isConnecting: connectMutation.isPending,
    isDisconnecting: disconnectMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isRefreshing: refreshMutation.isPending || refreshSessionMutation.isPending,
  };
}
