import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { invokeBackendRpc } from "@/integrations/backend/rpc";

const SERVICE_HEALTH_INTERVAL_MS = 30 * 1000;

export type ServiceHealthStatus = {
  online: boolean;
  url: string;
  uptimeSec: number | null;
  error: string | null;
  service?: string;
  stats?: Record<string, unknown> | null;
};

export function useServiceHealth(service: "shopee" | "meli") {
  const { user } = useAuth();

  const rpcName = service === "shopee" ? "shopee-service-health" : "meli-service-health";
  const queryKey = ["service-health", service, user?.id];

  const query = useQuery<ServiceHealthStatus>({
    queryKey,
    queryFn: async () => {
      const data = await invokeBackendRpc<ServiceHealthStatus>(rpcName);
      return {
        online: data?.online === true,
        url: String(data?.url || ""),
        uptimeSec: typeof data?.uptimeSec === "number" ? data.uptimeSec : null,
        error: data?.error ? String(data.error) : null,
        service: data?.service ? String(data.service) : undefined,
        stats: data?.stats && typeof data.stats === "object" ? data.stats : null,
      };
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? SERVICE_HEALTH_INTERVAL_MS : false),
    staleTime: SERVICE_HEALTH_INTERVAL_MS,
  });

  const refresh = async () => {
    const result = await query.refetch();
    return result.data ?? null;
  };

  return {
    health: query.data || null,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching,
    refresh,
  };
}
