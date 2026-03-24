import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invokeBackendRpc } from "@/integrations/backend/rpc";

/* ── types ─────────────────────────────────────────────────────────────────── */

export interface BroadcastRecipient {
  user_id: string;
  name: string;
  email: string;
  phone: string;
  plan_id: string;
}

export interface BroadcastRecord {
  id: string;
  admin_user_id: string;
  message: string;
  filter_plan: string[];
  filter_status: string;
  filter_user_ids: string[];
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  status: string;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_details: Array<{ phone: string; error: string }> | null;
  created_at: string;
  updated_at: string;
}

export interface BroadcastFilters {
  filterPlan: string[];
  filterStatus: string; // "all" | "active_plan" | "expired_plan"
  filterUserIds: string[];
}

/* ── hook ──────────────────────────────────────────────────────────────────── */

export function useAdminBroadcast() {
  const qc = useQueryClient();

  // List broadcast history
  const { data: broadcasts = [], isLoading: isLoadingHistory, refetch: refetchHistory } = useQuery({
    queryKey: ["admin-wa-broadcasts"],
    queryFn: async () => {
      const res = await invokeBackendRpc<{ broadcasts: BroadcastRecord[] }>("admin-wa-broadcast", {
        body: { action: "list" },
      });
      return res?.broadcasts ?? [];
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Preview recipients
  const previewMutation = useMutation({
    mutationFn: async (filters: BroadcastFilters) => {
      return invokeBackendRpc<{ count: number; users: BroadcastRecipient[] }>("admin-wa-broadcast", {
        body: { action: "preview", ...filters },
      });
    },
  });

  // Send broadcast now
  const sendMutation = useMutation({
    mutationFn: async (params: BroadcastFilters & { message: string }) => {
      return invokeBackendRpc<{
        broadcast_id: string;
        total: number;
        sent: number;
        failed: number;
        status: string;
      }>("admin-wa-broadcast", {
        body: { action: "send", ...params },
      });
    },
    onSuccess: (data) => {
      if (data?.status === "sent") {
        toast.success(`Broadcast enviado! ${data.sent}/${data.total} mensagens entregues.`);
      } else if (data?.status === "partial") {
        toast.warning(`Broadcast parcial: ${data.sent} enviadas, ${data.failed} falharam.`);
      } else {
        toast.error("Broadcast falhou.");
      }
      qc.invalidateQueries({ queryKey: ["admin-wa-broadcasts"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Erro ao enviar broadcast");
    },
  });

  // Schedule broadcast
  const scheduleMutation = useMutation({
    mutationFn: async (params: BroadcastFilters & { message: string; scheduledAt: string }) => {
      return invokeBackendRpc<{
        broadcast_id: string;
        scheduled_at: string;
        recipients: number;
      }>("admin-wa-broadcast", {
        body: { action: "schedule", ...params },
      });
    },
    onSuccess: (data) => {
      toast.success(`Broadcast agendado para ${new Date(data!.scheduled_at).toLocaleString("pt-BR")} — ${data!.recipients} destinatários.`);
      qc.invalidateQueries({ queryKey: ["admin-wa-broadcasts"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Erro ao agendar broadcast");
    },
  });

  // Cancel scheduled broadcast
  const cancelMutation = useMutation({
    mutationFn: async (broadcastId: string) => {
      return invokeBackendRpc("admin-wa-broadcast", {
        body: { action: "cancel", broadcastId },
      });
    },
    onSuccess: () => {
      toast.success("Broadcast cancelado.");
      qc.invalidateQueries({ queryKey: ["admin-wa-broadcasts"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Erro ao cancelar broadcast");
    },
  });

  return {
    broadcasts,
    isLoadingHistory,
    refetchHistory,
    previewRecipients: previewMutation.mutateAsync,
    isPreviewing: previewMutation.isPending,
    previewData: previewMutation.data,
    sendBroadcast: sendMutation.mutateAsync,
    isSending: sendMutation.isPending,
    scheduleBroadcast: scheduleMutation.mutateAsync,
    isScheduling: scheduleMutation.isPending,
    cancelBroadcast: cancelMutation.mutateAsync,
    isCancelling: cancelMutation.isPending,
  };
}
