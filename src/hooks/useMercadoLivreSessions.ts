import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export type MeliSessionStatus = "active" | "expired" | "error" | "untested" | "not_found" | "no_affiliate";

export interface MeliSession {
  id: string;
  name: string;
  accountName: string;
  mlUserId: string;
  status: MeliSessionStatus;
  lastCheckedAt: string | null;
  errorMessage: string;
  createdAt: string;
}

interface SaveSessionInput {
  sessionId: string;
  name?: string;
  cookies: string | object;
}

interface SaveSessionResult {
  success: boolean;
  accountName?: string;
  mlUserId?: string;
  logs?: unknown[];
}

interface TestSessionResult {
  status: MeliSessionStatus;
  accountName?: string;
  errorMessage?: string;
  logs?: unknown[];
}

interface TestSessionOptions {
  silent?: boolean;
  skipInvalidate?: boolean;
}

interface UseMercadoLivreSessionsOptions {
  enableAutoMonitor?: boolean;
}

const DISCONNECTED_STATUSES = new Set<MeliSessionStatus>(["expired", "error", "not_found"]);

function mapStatusToMessage(status: MeliSessionStatus): string {
  if (status === "expired") return "Sessão expirada. Reimporte cookies atualizados.";
  if (status === "not_found") return "Sessão não encontrada no serviço RPA.";
  if (status === "no_affiliate") return "Conta sem acesso ao programa de afiliados.";
  if (status === "error") return "Falha ao validar sessão no serviço Mercado Livre.";
  return "Status de sessão não reconhecido.";
}

function mapRowToSession(row: Record<string, unknown>): MeliSession {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    accountName: String(row.account_name || ""),
    mlUserId: String(row.ml_user_id || ""),
    status: (row.status as MeliSessionStatus) || "untested",
    lastCheckedAt: typeof row.last_checked_at === "string" ? row.last_checked_at : null,
    errorMessage: String(row.error_message || ""),
    createdAt: String(row.created_at || ""),
  };
}

export function useMercadoLivreSessions(options: UseMercadoLivreSessionsOptions = {}) {
  const { enableAutoMonitor = true } = options;
  const { user } = useAuth();
  const qc = useQueryClient();
  const statusMapRef = useRef<Record<string, MeliSessionStatus>>({});
  const sessionsRef = useRef<MeliSession[]>([]);
  const isAutoCheckingRef = useRef(false);

  const { data: sessions = [], isLoading, error } = useQuery({
    queryKey: ["meli-sessions", user?.id],
    queryFn: async () => {
      const res = await invokeBackendRpc<{ sessions?: Record<string, unknown>[] }>("meli-list-sessions", {});
      return (res.sessions || []).map(mapRowToSession);
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 30_000 : false),
    staleTime: 15_000,
  });

  const refreshSessions = useCallback(async () => {
    await qc.refetchQueries({ queryKey: ["meli-sessions", user?.id], type: "active" });
  }, [qc, user?.id]);

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["meli-sessions"] });
  }, [qc]);

  const saveSession = useCallback(async (input: SaveSessionInput): Promise<SaveSessionResult> => {
    const result = await invokeBackendRpc<SaveSessionResult>("meli-save-session", {
      body: { sessionId: input.sessionId, sessionName: input.name || "", cookies: input.cookies },
    });
    invalidate();
    return result;
  }, [invalidate]);

  const runSessionTest = useCallback(async (
    sessionId: string,
    options: TestSessionOptions = {},
  ): Promise<TestSessionResult> => {
    const previousStatus = statusMapRef.current[sessionId];
    const sessionName = sessionsRef.current.find((session) => session.id === sessionId)?.name || sessionId;

    try {
      const result = await invokeBackendRpc<TestSessionResult>("meli-test-session", {
        body: { sessionId },
      });

      statusMapRef.current[sessionId] = result.status;
      if (!options.skipInvalidate) invalidate();

      if (!options.silent) {
        if (result.status === "active") {
          toast.success("Sessão ativa!", { description: result.accountName || sessionName });
        } else if (DISCONNECTED_STATUSES.has(result.status)) {
          toast.warning("Sessão expirada ou desconectada", {
            description: `${sessionName}: ${result.errorMessage || mapStatusToMessage(result.status)}`,
          });
        } else if (result.status === "no_affiliate") {
          toast.warning("Conta sem programa de afiliados", { description: sessionName });
        } else {
          toast.error("Erro ao testar sessão", {
            description: `${sessionName}: ${result.errorMessage || mapStatusToMessage(result.status)}`,
          });
        }
      } else {
        const isDisconnected = DISCONNECTED_STATUSES.has(result.status);
        const statusChanged = !!previousStatus && previousStatus !== result.status;
        if (statusChanged && isDisconnected) {
          toast.warning("Sessão Mercado Livre desconectada", {
            description: `${sessionName}: ${result.errorMessage || mapStatusToMessage(result.status)}`,
          });
        }
        if (previousStatus && previousStatus !== "active" && result.status === "active") {
          toast.success("Sessão Mercado Livre reconectada", { description: sessionName });
        }
      }

      return result;
    } catch (error) {
      if (!options.silent) {
        toast.error("Erro ao testar sessão", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }, [invalidate]);

  const testAllSessions = useCallback(async (options: TestSessionOptions = {}): Promise<TestSessionResult[]> => {
    const results: TestSessionResult[] = [];
    for (const session of sessions) {
      const result = await runSessionTest(session.id, options);
      results.push(result);
    }
    return results;
  }, [runSessionTest, sessions]);

  useEffect(() => {
    sessionsRef.current = sessions;
    for (const session of sessions) {
      statusMapRef.current[session.id] = session.status;
    }
  }, [sessions]);

  useEffect(() => {
    if (!enableAutoMonitor || !user?.id) return;

    let cancelled = false;

    const runAutoValidation = async () => {
      if (cancelled) return;
      if (isAutoCheckingRef.current) return;

      const monitoredSessions = sessionsRef.current;
      if (monitoredSessions.length === 0) return;

      isAutoCheckingRef.current = true;
      let checkedAny = false;
      try {
        for (const session of monitoredSessions) {
          try {
            checkedAny = true;
            await runSessionTest(session.id, { silent: true, skipInvalidate: true });
          } catch {
            // Keep auto-monitor running even if one session check fails.
          }
        }
      } finally {
        isAutoCheckingRef.current = false;
        if (checkedAny && !cancelled) {
          invalidate();
        }
      }
    };

    const startLoop = () => {
      const intervalId = window.setInterval(() => {
        void runAutoValidation();
      }, 5 * 60 * 1000);

      void runAutoValidation();

      return () => {
        window.clearInterval(intervalId);
      };
    };

    if (typeof navigator?.locks?.request !== "function") {
      const cleanup = startLoop();
      return () => {
        cancelled = true;
        cleanup();
      };
    }

    void navigator.locks.request(
      `autolinks:meli-session-monitor:${user.id}`,
      async () => {
        if (cancelled) return;
        const cleanup = startLoop();
        await new Promise<void>((resolve) => {
          const guard = window.setInterval(() => {
            if (cancelled) {
              window.clearInterval(guard);
              cleanup();
              resolve();
            }
          }, 500);
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [enableAutoMonitor, invalidate, runSessionTest, user?.id]);

  const deleteSession = useCallback(async (sessionId: string) => {
    await invokeBackendRpc("meli-delete-session", { body: { sessionId } });
    invalidate();
    toast.success("Sessão removida");
  }, [invalidate]);

  return {
    sessions,
    isLoading,
    error,
    saveSession,
    testAllSessions,
    deleteSession,
    invalidate,
    refreshSessions,
  };
}
