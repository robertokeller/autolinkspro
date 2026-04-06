import { useCallback, useMemo } from "react";
import { useTelegramSessions } from "./useTelegramSessions";
import { useWhatsAppSessions } from "./useWhatsAppSessions";

interface RefreshSessionsOptions {
  silent?: boolean;
}

export function useSessoes() {
  const { sessions: waSessions, isLoading: waLoading, refresh: refreshWa } = useWhatsAppSessions();
  const { sessions: tgSessions, isLoading: tgLoading, refresh: refreshTg } = useTelegramSessions();

  const refreshSessions = useCallback(async (options?: RefreshSessionsOptions) => {
    await Promise.all([
      refreshWa(options),
      refreshTg(options),
    ]);
  }, [refreshWa, refreshTg]);

  const allSessions = useMemo(
    () => [
      ...waSessions.map((session) => ({
        id: session.id,
        label: `WhatsApp - ${session.name}`,
        platform: "whatsapp" as const,
        status: session.status,
      })),
      ...tgSessions.map((session) => ({
        id: session.id,
        label: `Telegram - ${session.name}`,
        platform: "telegram" as const,
        status: session.status,
      })),
    ],
    [waSessions, tgSessions],
  );

  return {
    waSessions,
    tgSessions,
    allSessions,
    isLoading: waLoading || tgLoading,
    refreshSessions,
  };
}
