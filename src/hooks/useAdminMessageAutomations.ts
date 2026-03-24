import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invokeBackendRpc } from "@/integrations/backend/rpc";

export type AutomationTriggerType =
  | "plan_expiring"
  | "plan_expired"
  | "signup_welcome"
  | "remarketing"
  | "cron";

export interface MessageAutomation {
  id: string;
  admin_user_id: string;
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  message_template: string;
  filter_plan: string[];
  is_active: boolean;
  last_run_at: string | null;
  run_count: number;
  last_run_sent: number;
  last_run_failed: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationFormData {
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  message_template: string;
  filter_plan: string[];
}

const RPC = "admin-message-automations";
const QK = ["admin-message-automations"] as const;

export function useAdminMessageAutomations() {
  const qc = useQueryClient();

  const { data: automations = [], isLoading, refetch } = useQuery({
    queryKey: QK,
    queryFn: async () => {
      const res = await invokeBackendRpc<{ automations: MessageAutomation[] }>(RPC, {
        body: { action: "list" },
      });
      return res?.automations ?? [];
    },
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (data: AutomationFormData) =>
      invokeBackendRpc<{ automation_id: string }>(RPC, { body: { action: "create", ...data } }),
    onSuccess: () => {
      toast.success("Automação criada com sucesso.");
      qc.invalidateQueries({ queryKey: QK });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao criar automação"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ automation_id, ...data }: AutomationFormData & { automation_id: string }) =>
      invokeBackendRpc(RPC, { body: { action: "update", automation_id, ...data } }),
    onSuccess: () => {
      toast.success("Automação atualizada.");
      qc.invalidateQueries({ queryKey: QK });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao atualizar automação"),
  });

  const toggleMutation = useMutation({
    mutationFn: (automation_id: string) =>
      invokeBackendRpc<{ is_active: boolean }>(RPC, { body: { action: "toggle", automation_id } }),
    onSuccess: (data) => {
      toast.success(data?.is_active ? "Automação ativada." : "Automação pausada.");
      qc.invalidateQueries({ queryKey: QK });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao alterar automação"),
  });

  const deleteMutation = useMutation({
    mutationFn: (automation_id: string) =>
      invokeBackendRpc(RPC, { body: { action: "delete", automation_id } }),
    onSuccess: () => {
      toast.success("Automação excluída.");
      qc.invalidateQueries({ queryKey: QK });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao excluir automação"),
  });

  const previewMutation = useMutation({
    mutationFn: (data: Pick<AutomationFormData, "trigger_type" | "trigger_config" | "filter_plan">) =>
      invokeBackendRpc<{ count: number }>(RPC, { body: { action: "preview", ...data } }),
  });

  const runNowMutation = useMutation({
    mutationFn: (automation_id: string) =>
      invokeBackendRpc<{ sent: number; failed: number; total: number }>(RPC, {
        body: { action: "run_now", automation_id },
      }),
    onSuccess: (data) => {
      if (!data) return;
      if (data.total === 0) {
        toast.info("Nenhum destinatário correspondeu aos critérios agora.");
      } else if (data.failed === 0) {
        toast.success(`Automação executada! ${data.sent} mensagens enviadas.`);
      } else {
        toast.warning(`Execução parcial: ${data.sent} enviadas, ${data.failed} falharam.`);
      }
      qc.invalidateQueries({ queryKey: QK });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao executar automação"),
  });

  return {
    automations,
    isLoading,
    refetch,
    createAutomation: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    updateAutomation: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
    toggleAutomation: toggleMutation.mutateAsync,
    isToggling: toggleMutation.isPending,
    deleteAutomation: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
    previewAutomation: previewMutation.mutateAsync,
    isPreviewing: previewMutation.isPending,
    previewCount: previewMutation.data?.count ?? null,
    runNow: runNowMutation.mutateAsync,
    isRunning: runNowMutation.isPending,
  };
}
