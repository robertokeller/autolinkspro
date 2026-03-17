import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { getAllChannelHealth, pollAllChannelEvents, type ChannelHealth } from "@/lib/channel-central";

interface ChannelHealthState {
  whatsapp: ChannelHealth;
  telegram: ChannelHealth;
}

const CHANNEL_HEALTH_KEY = ["channel-health"];
const CHANNEL_HEALTH_INTERVAL_MS = 5 * 60 * 1000;

interface UseChannelRuntimeOptions {
  enabled?: boolean;
}

export function useChannelRuntime(options: UseChannelRuntimeOptions = {}) {
  const { enabled = true } = options;
  const { user, isLoading } = useAuth();
  const qc = useQueryClient();
  const userId = user?.id;
  const previousHealthRef = useRef<{ whatsapp: boolean; telegram: boolean } | null>(null);

  const healthQuery = useQuery<ChannelHealthState>({
    queryKey: [...CHANNEL_HEALTH_KEY, userId],
    queryFn: getAllChannelHealth,
    enabled: !!userId && enabled,
    refetchInterval: () => (document.visibilityState === "visible" ? CHANNEL_HEALTH_INTERVAL_MS : false),
    staleTime: CHANNEL_HEALTH_INTERVAL_MS,
  });

  useEffect(() => {
    if (isLoading || !userId || !enabled) return;

    const runPolling = () => {
      if (document.visibilityState !== "visible") return;
      void pollAllChannelEvents()
        .catch(() => undefined)
        .finally(() => {
          qc.invalidateQueries({ queryKey: ["groups"] });
        });
    };

    runPolling();
    const interval = window.setInterval(runPolling, 7_500);

    return () => {
      window.clearInterval(interval);
    };
  }, [enabled, isLoading, userId, qc]);

  useEffect(() => {
    if (!healthQuery.data) return;

    const current = {
      whatsapp: healthQuery.data.whatsapp.online,
      telegram: healthQuery.data.telegram.online,
    };

    const previous = previousHealthRef.current;
    if (previous) {
      if (previous.whatsapp && !current.whatsapp) {
        toast.warning("Serviço WhatsApp ficou indisponível. Verifique o Baileys.");
      }
      if (!previous.whatsapp && current.whatsapp) {
        toast.success("Serviço WhatsApp voltou a ficar online.");
      }

      if (previous.telegram && !current.telegram) {
        toast.warning("Serviço Telegram ficou indisponível. Verifique o Telegraph.");
      }
      if (!previous.telegram && current.telegram) {
        toast.success("Serviço Telegram voltou a ficar online.");
      }
    }

    previousHealthRef.current = current;
  }, [healthQuery.data]);

  const refreshHealth = () => {
    qc.invalidateQueries({ queryKey: CHANNEL_HEALTH_KEY });
  };

  return {
    health: healthQuery.data || null,
    isHealthLoading: healthQuery.isLoading,
    refreshHealth,
  };
}
