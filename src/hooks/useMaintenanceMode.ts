import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";

export interface MaintenanceModeState {
  maintenance_enabled: boolean;
  maintenance_title: string;
  maintenance_message: string;
  maintenance_eta: string | null;
  allow_admin_bypass: boolean;
  updated_by_user_id: string;
}

const MAINTENANCE_QUERY_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

const DEFAULT_STATE: MaintenanceModeState = {
  maintenance_enabled: false,
  maintenance_title: "Sistema em manutencao",
  maintenance_message: "Estamos realizando melhorias. Tente novamente em alguns minutos.",
  maintenance_eta: null,
  allow_admin_bypass: true,
  updated_by_user_id: "system",
};

function toMaintenanceState(value: unknown): MaintenanceModeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_STATE;
  const source = value as Record<string, unknown>;
  return {
    maintenance_enabled: source.maintenance_enabled === true,
    maintenance_title: typeof source.maintenance_title === "string" && source.maintenance_title.trim()
      ? source.maintenance_title.trim()
      : DEFAULT_STATE.maintenance_title,
    maintenance_message: typeof source.maintenance_message === "string" && source.maintenance_message.trim()
      ? source.maintenance_message.trim()
      : DEFAULT_STATE.maintenance_message,
    maintenance_eta: typeof source.maintenance_eta === "string" && source.maintenance_eta.trim()
      ? source.maintenance_eta.trim()
      : null,
    allow_admin_bypass: source.allow_admin_bypass !== false,
    updated_by_user_id: typeof source.updated_by_user_id === "string" ? source.updated_by_user_id : "system",
  };
}

export function useMaintenanceMode() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["app-maintenance-mode"],
    retry: false, // sem retentativas — evita delay quando API está offline
    queryFn: async () => {
      const { data, error } = await withTimeout(
        backend
          .from("app_runtime_flags")
          .select("maintenance_enabled, maintenance_title, maintenance_message, maintenance_eta, allow_admin_bypass, updated_by_user_id")
          .eq("id", "global")
          .maybeSingle(),
        MAINTENANCE_QUERY_TIMEOUT_MS,
        "Timeout ao carregar status de manutenção",
      );

      // Quando API está offline, retorna estado padrão (sem manutenção) silenciosamente
      if (error) return DEFAULT_STATE;
      return toMaintenanceState(data);
    },
  });

  useEffect(() => {
    return subscribeLocalDbChanges(() => {
      queryClient.invalidateQueries({ queryKey: ["app-maintenance-mode"] });
    });
  }, [queryClient]);

  return {
    state: query.data || DEFAULT_STATE,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
