import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useChannelRuntime } from "@/hooks/useChannelRuntime";
import { useDispatchMessages } from "@/hooks/useDispatchMessages";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import { SERVICE_RUNTIME_ERROR_EVENT, invokeBackendRpc } from "@/integrations/backend/rpc";
import { subscribeAdminControlPlane } from "@/lib/admin-control-plane";
import { loadSystemRuntimeControlState, subscribeSystemRuntimeControl } from "@/lib/system-runtime-control";

/**
 * Keeps all runtime automations and health loops active for authenticated users,
 * regardless of the current route in the SPA.
 */
export function SystemRuntime() {
  const { user, isLoading } = useAuth();
  const queryClient = useQueryClient();
  const [runtimeEnabled, setRuntimeEnabled] = useState(() => loadSystemRuntimeControlState().enabled);
  const runtimeErrorInvalidateUntilRef = useRef(0);
  const userId = user?.id;
  const { dispatchMessages } = useDispatchMessages();

  useChannelRuntime({ enabled: runtimeEnabled });
  useMercadoLivreSessions({ enableAutoMonitor: runtimeEnabled });

  useEffect(() => {
    setRuntimeEnabled(loadSystemRuntimeControlState().enabled);
    return subscribeSystemRuntimeControl(() => {
      setRuntimeEnabled(loadSystemRuntimeControlState().enabled);
    });
  }, []);

  useEffect(() => {
    const RUNTIME_ERROR_INVALIDATE_COOLDOWN_MS = 15_000;

    const onServiceRuntimeError = () => {
      if (!runtimeEnabled || !userId) return;
      const now = Date.now();
      if (now < runtimeErrorInvalidateUntilRef.current) return;
      runtimeErrorInvalidateUntilRef.current = now + RUNTIME_ERROR_INVALIDATE_COOLDOWN_MS;

      queryClient.invalidateQueries({ queryKey: ["channel-health"] });
      queryClient.invalidateQueries({ queryKey: ["service-health"] });
    };

    window.addEventListener(SERVICE_RUNTIME_ERROR_EVENT, onServiceRuntimeError);
    return () => {
      window.removeEventListener(SERVICE_RUNTIME_ERROR_EVENT, onServiceRuntimeError);
    };
  }, [queryClient, runtimeEnabled, userId]);

  useEffect(() => {
    // Invalidate only the queries that are actually affected by DB/control-plane changes.
    // A blanket invalidateQueries() (no queryKey) refires every active query simultaneously,
    // which causes 12+ concurrent requests on the Dashboard and stalls low-end devices.
    const syncQueries = () => {
      queryClient.invalidateQueries({ queryKey: ["profile-plan"] });
      queryClient.invalidateQueries({ queryKey: ["app-maintenance-mode"] });
      queryClient.invalidateQueries({ queryKey: ["channel-health"] });
    };

    const unsubDb = subscribeLocalDbChanges(syncQueries);
    const unsubControlPlane = subscribeAdminControlPlane(syncQueries);

    return () => {
      unsubDb();
      unsubControlPlane();
    };
  }, [queryClient]);

  useEffect(() => {
    if (isLoading || !userId || !runtimeEnabled) return;

    let cancelled = false;

    const runDispatch = () => {
      void dispatchMessages({
        silent: true,
        source: "global-runtime",
        limit: 25,
      });
    };

    const runShopeeAutomations = () => {
      void invokeBackendRpc("shopee-automation-run", {
        body: { source: "global-runtime" },
      }).catch(() => undefined);
    };

    const runMeliAutomations = () => {
      void invokeBackendRpc("meli-automation-run", {
        body: { source: "global-runtime" },
      }).catch(() => undefined);
    };

    // Web Locks API-based leader election: only one tab per user runs automations at a time.
    // The lock is released automatically when the tab closes or when this component unmounts,
    // at which point the next queued tab seamlessly becomes the leader — no storage required.
    const startIntervals = () => {
      const startTimeout = window.setTimeout(() => {
        if (!cancelled) {
          runDispatch();
          runShopeeAutomations();
          runMeliAutomations();
        }
      }, 2000);

      const dispatchInterval = window.setInterval(() => { if (!cancelled) runDispatch(); }, 45_000);
      const shopeeInterval = window.setInterval(() => { if (!cancelled) runShopeeAutomations(); }, 60_000);
      const meliInterval = window.setInterval(() => { if (!cancelled) runMeliAutomations(); }, 60_000);

      return () => {
        window.clearTimeout(startTimeout);
        window.clearInterval(dispatchInterval);
        window.clearInterval(shopeeInterval);
        window.clearInterval(meliInterval);
      };
    };

    if (typeof navigator?.locks?.request !== "function") {
      // Fallback for environments without Web Locks (very old browsers): run without coordination.
      const cleanup = startIntervals();
      return () => { cancelled = true; cleanup(); };
    }

    void navigator.locks.request(
      `autolinks:runtime:leader:${userId}`,
      async () => {
        if (cancelled) return;
        const cleanup = startIntervals();
        // Hold the lock (and the leader role) until this component unmounts.
        await new Promise<void>((resolve) => {
          const guard = window.setInterval(() => {
            if (cancelled) { window.clearInterval(guard); cleanup(); resolve(); }
          }, 500);
        });
      },
    );

    return () => { cancelled = true; };
  }, [dispatchMessages, isLoading, runtimeEnabled, userId]);

  return null;
}
