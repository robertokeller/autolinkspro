import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SessoesTelegram } from "@/components/conexoes/SessoesTelegram";
import { GruposPorPlataforma } from "@/components/conexoes/GruposPorPlataforma";
import { ConexoesCanalLayout } from "@/components/conexoes/ConexoesCanalLayout";
import { useTelegramSessions } from "@/hooks/useTelegramSessions";
import { useGrupos } from "@/hooks/useGrupos";
import { useAuth } from "@/contexts/AuthContext";
import { getAllChannelHealth } from "@/lib/channel-central";

export default function ConexoesTelegram() {
  const { user } = useAuth();
  const [subTab, setSubTab] = useState("sessions");
  const {
    sessions,
    isLoading,
    createSession,
    sendCode,
    verifyCode,
    verifyPassword,
    disconnectSession,
    syncSessionGroups,
    renameSession,
    deleteSession,
    isCreating,
    isSendingCode,
    isVerifyingCode,
    isVerifyingPassword,
    isDisconnecting,
    isSyncingGroups,
    isRenaming,
    isDeleting,
    isRefreshing,
    refresh,
  } = useTelegramSessions();
  const { syncedGroups, isLoading: isLoadingGroups, refreshGroups } = useGrupos();
  const { refetch: refetchHealth } = useQuery({
    queryKey: ["channel-health", user?.id, "connections-telegram"],
    queryFn: getAllChannelHealth,
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  const telegramGroups = useMemo(
    () => syncedGroups.filter((group) => group.platform === "telegram"),
    [syncedGroups],
  );

  const handleRefreshGroups = useCallback((options?: { silent?: boolean }) => {
    refreshGroups();
    refresh(options);
  }, [refreshGroups, refresh]);

  const handleRefreshSessions = useCallback((options?: { silent?: boolean }) => {
    refresh(options);
    void refetchHealth();
  }, [refresh, refetchHealth]);

  return (
    <ConexoesCanalLayout
      title="Telegram"
      description="Conecte e veja suas contas do Telegram"
      headerActions={null}
      activeTab={subTab}
      onTabChange={setSubTab}
      sessionsContent={
        <SessoesTelegram
          sessions={sessions}
          isLoading={isLoading}
          isCreating={isCreating}
          isSendingCode={isSendingCode}
          isVerifyingCode={isVerifyingCode}
          isVerifyingPassword={isVerifyingPassword}
          isDisconnecting={isDisconnecting}
          isRefreshing={isRefreshing}
          isUpdatingName={isRenaming}
          isDeleting={isDeleting}
          onCreateSession={createSession}
          onConnect={sendCode}
          onVerifyCode={verifyCode}
          onVerifyPassword={verifyPassword}
          onDisconnect={disconnectSession}
          onUpdateName={(sessionId, name) => renameSession({ sessionId, name })}
          onDeleteSession={deleteSession}
          onRefresh={handleRefreshSessions}
        />
      }
      groupsContent={
        <GruposPorPlataforma
          platform="telegram"
          sessions={sessions.map((session) => ({
            id: session.id,
            name: session.name,
            status: session.status,
          }))}
          groups={telegramGroups}
          isLoading={isLoadingGroups}
          isSyncing={isSyncingGroups}
          onSyncSession={syncSessionGroups}
          onRefresh={handleRefreshGroups}
        />
      }
    />
  );
}

