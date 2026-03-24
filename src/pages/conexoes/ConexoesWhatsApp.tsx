import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SessoesWhatsApp } from "@/components/conexoes/SessoesWhatsApp";
import { GruposPorPlataforma } from "@/components/conexoes/GruposPorPlataforma";
import { ConexoesCanalLayout } from "@/components/conexoes/ConexoesCanalLayout";
import { useWhatsAppSessions } from "@/hooks/useWhatsAppSessions";
import { useGrupos } from "@/hooks/useGrupos";
import { useAuth } from "@/contexts/AuthContext";
import { getAllChannelHealth } from "@/lib/channel-central";

export default function ConexoesWhatsApp() {
  const { user } = useAuth();
  const [subTab, setSubTab] = useState("sessions");
  const { refetch: refetchHealth } = useQuery({
    queryKey: ["channel-health", user?.id, "connections-whatsapp"],
    queryFn: getAllChannelHealth,
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });
  const {
    sessions,
    isLoading,
    createSession,
    connectSession,
    disconnectSession,
    syncSessionGroups,
    renameSession,
    deleteSession,
    isCreating,
    isConnecting,
    isDisconnecting,
    isSyncingGroups,
    isRenaming,
    isDeleting,
    isRefreshing,
    refresh,
  } = useWhatsAppSessions();
  const { syncedGroups, isLoading: isLoadingGroups, refreshGroups } = useGrupos();

  const whatsappGroups = useMemo(
    () => syncedGroups.filter((group) => group.platform === "whatsapp"),
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
      title="WhatsApp"
      description="Conecte e veja suas contas do WhatsApp"
      centered
      headerActions={null}
      activeTab={subTab}
      onTabChange={setSubTab}
      sessionsContent={
        <SessoesWhatsApp
          sessions={sessions}
          isLoading={isLoading}
          isCreating={isCreating}
          isConnecting={isConnecting}
          isDisconnecting={isDisconnecting}
          isRefreshing={isRefreshing}
          isUpdatingName={isRenaming}
          isDeleting={isDeleting}
          onCreateSession={createSession}
          onConnect={async (sessionId) => { await connectSession(sessionId); }}
          onDisconnect={async (sessionId) => { await disconnectSession(sessionId); }}
          onUpdateName={async (sessionId, name) => { await renameSession({ sessionId, name }); }}
          onDeleteSession={deleteSession}
          onRefresh={handleRefreshSessions}
        />
      }
      groupsContent={
        <GruposPorPlataforma
          platform="whatsapp"
          sessions={sessions.map((session) => ({
            id: session.id,
            name: session.name,
            status: session.status,
          }))}
          groups={whatsappGroups}
          isLoading={isLoadingGroups}
          isSyncing={isSyncingGroups}
          onSyncSession={syncSessionGroups}
          onRefresh={handleRefreshGroups}
        />
      }
    />
  );
}
