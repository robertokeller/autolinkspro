import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { useAuth } from "@/contexts/AuthContext";

interface DispatchResult {
  ok?: boolean;
  runMode?: "user" | "scheduler";
  source?: string;
  scanned?: number;
  processed?: number;
  sent?: number;
  failed?: number;
  skipped?: number;
  historyLogged?: number;
  errors?: string[];
}

interface DispatchOptions {
  silent?: boolean;
  limit?: number;
  source?: string;
}

export function useDispatchMessages() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const runningRef = useRef(false);
  const [isDispatching, setIsDispatching] = useState(false);

  const dispatchMessages = useCallback(async (options?: DispatchOptions) => {
    if (!user || runningRef.current) return null;

    runningRef.current = true;
    setIsDispatching(true);

    try {
      const result = await invokeBackendRpc<DispatchResult>("dispatch-messages", {
        body: {
          limit: options?.limit ?? 20,
          source: options?.source ?? "frontend",
        },
      });

      queryClient.invalidateQueries({ queryKey: ["scheduled_posts"] });
      queryClient.invalidateQueries({ queryKey: ["history_entries"] });

      if (!options?.silent) {
        const processed = result.processed || 0;
        const sent = result.sent || 0;
        const failed = result.failed || 0;

        if (processed === 0) {
          toast.info("Nenhum agendamento pendente para processar.");
        } else if (failed > 0) {
          toast.warning(`Processado: ${sent} envio(s) com sucesso e ${failed} falha(s).`);
        } else {
          toast.success(`Processado com sucesso: ${sent} envio(s) realizados.`);
        }
      }

      return result;
    } catch (err) {
      if (!options?.silent) {
        toast.error("Erro ao processar agendamentos.");
      }
      console.error("dispatchMessages error:", err);
      return null;
    } finally {
      runningRef.current = false;
      setIsDispatching(false);
    }
  }, [queryClient, user]);

  return {
    dispatchMessages,
    isDispatching,
  };
}
