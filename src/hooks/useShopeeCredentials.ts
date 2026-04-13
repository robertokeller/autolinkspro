import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { useAuth } from "@/contexts/AuthContext";
import { useCallback, useState, useEffect } from "react";
import { logHistorico } from "@/lib/log-historico";

type ShopeeConnectionStatus = "unknown" | "testing" | "connected" | "error";

export interface ShopeeConnectionInfo {
  status: ShopeeConnectionStatus;
  lastTestedAt: string | null;
  errorMessage: string | null;
  region: string;
}

export function useShopeeCredentials() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [connectionInfo, setConnectionInfo] = useState<ShopeeConnectionInfo>({
    status: "unknown",
    lastTestedAt: null,
    errorMessage: null,
    region: "BR",
  });

  const updateConnectionInfo = useCallback((updater: (prev: ShopeeConnectionInfo) => ShopeeConnectionInfo) => {
    setConnectionInfo((prev) => updater(prev));
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["shopee_credentials", user?.id],
    queryFn: async () => {
      const { data, error } = await backend
        .from("api_credentials")
        .select("id, app_id, provider, region, user_id")
        .eq("provider", "shopee")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const appId = data?.app_id || "";
  const isConfigured = !!data?.app_id;
  const hasSecret = isConfigured; // If app_id exists, secret was saved too

  const save = useCallback(async (input: { appId: string; secret: string; region?: string }) => {
    const { data: { session } } = await backend.auth.getSession();
    const currentUser = session?.user ?? user;
    if (!currentUser) throw new Error("Usuário não autenticado. Faça login novamente.");
    const regionVal = input.region || "BR";
    const { data: existing } = await backend
      .from("api_credentials")
      .select("id")
      .eq("provider", "shopee")
      .eq("user_id", currentUser.id)
      .maybeSingle();
    if (existing) {
      const { error } = await backend
        .from("api_credentials")
        .update({ app_id: input.appId, secret_key: input.secret, region: regionVal })
        .eq("id", existing.id)
        .eq("user_id", currentUser.id);
      if (error) throw error;
    } else {
      const { error } = await backend.from("api_credentials").insert({ user_id: currentUser.id, provider: "shopee", app_id: input.appId, secret_key: input.secret, region: regionVal });
      if (error) throw error;
    }
    qc.invalidateQueries({ queryKey: ["shopee_credentials"] });
    await logHistorico(currentUser.id, "session_event", "Shopee API", regionVal, "success", `Credenciais Shopee ${existing ? "atualizadas" : "configuradas"}`);
  }, [user, qc]);

  const testConnection = useCallback(async (): Promise<boolean> => {
    updateConnectionInfo((prev) => ({ ...prev, status: "testing", errorMessage: null }));
    try {
      const { data: { session } } = await backend.auth.getSession();
      if (!session) {
        updateConnectionInfo((prev) => ({ ...prev, status: "error", errorMessage: "Sessão expirada" }));
        return false;
      }
      const res = await invokeBackendRpc<{
        success?: boolean;
        connected?: boolean;
        reason?: string;
        error?: string;
        message?: string;
        region?: string;
      }>("shopee-test-connection");
      const now = new Date().toISOString();
      const isConnected = res.success === true || res.connected === true;
      if (isConnected) {
        const info: ShopeeConnectionInfo = { status: "connected", lastTestedAt: now, errorMessage: null, region: res.region || "BR" };
        setConnectionInfo(info);
        return true;
      } else {
        const errMsg = res.reason || res.error || res.message || "Falha na conexão";
        updateConnectionInfo(() => ({
          status: "error",
          lastTestedAt: now,
          errorMessage: errMsg,
          region: res.region || "BR",
        }));
        return false;
      }
    } catch (error) {
      updateConnectionInfo((prev) => ({
        ...prev,
        status: "error",
        lastTestedAt: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : "Erro ao testar conexão",
      }));
      return false;
    }
  }, [updateConnectionInfo]);

  // Auto-test connection when credentials are configured (first load)
  useEffect(() => {
    if (isConfigured && !isLoading && connectionInfo.status === "unknown") {
      testConnection();
    }
  }, [isConfigured, isLoading, connectionInfo.status, testConnection]);

  return {
    appId,
    isConfigured,
    isLoading,
    hasSecret,
    connectionInfo,
    save,
    testConnection,
  };
}
