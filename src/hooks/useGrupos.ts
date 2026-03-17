import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { syncChannelGroups } from "@/lib/channel-central";
import { useAuth } from "@/contexts/AuthContext";
import type { Group, MasterGroup, DistributionMode } from "@/lib/types";
import type { Tables } from "@/integrations/backend/types";
import { toast } from "sonner";
import { logHistorico } from "@/lib/log-historico";

type GroupRow = Tables<"groups">;
type MasterGroupRow = Tables<"master_groups">;
type MasterGroupLinkRow = Tables<"master_group_links">;

function mapGroupRow(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as Group["platform"],
    memberCount: row.member_count,
    sessionId: row.session_id || "",
    tags: [],
    externalId: row.external_id,
    inviteLink: null,
    whatsappSessionId: row.platform === "whatsapp" ? row.session_id : null,
    telegramSessionId: row.platform === "telegram" ? row.session_id : null,
  };
}

function mapMasterGroupRow(row: MasterGroupRow, links: MasterGroupLinkRow[]): MasterGroup {
  const groupIds = links.filter((l) => l.master_group_id === row.id).map((l) => l.group_id);

  return {
    id: row.id,
    name: row.name,
    slug: row.slug || "",
    platform: "whatsapp",
    groupIds,
    distribution: row.distribution as DistributionMode,
    memberLimit: row.member_limit,
    alertMargin: 90,
    linkedGroups: links
      .filter((l) => l.master_group_id === row.id)
      .map((l) => ({
        masterGroupId: row.id,
        groupId: l.group_id,
        inviteLink: null,
        memberCount: 0,
        isActive: l.is_active,
      })),
  };
}

export function useGrupos() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: syncedGroups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ["groups", user?.id],
    queryFn: async () => {
      const { data, error } = await backend.from("groups").select("*").eq("user_id", user!.id).order("name");
      if (error) throw error;
      // Exclude soft-deleted groups (session deleted) — they are invisible in the UI but
      // kept in the DB for 3 days so routes can be restored on session recreation.
      return (data || []).filter((row) => !row.deleted_at).map(mapGroupRow);
    },
    enabled: !!user,
  });

  const { data: masterGroups = [], isLoading: mgLoading } = useQuery({
    queryKey: ["master_groups", user?.id],
    queryFn: async () => {
      const mgRes = await backend
        .from("master_groups")
        .select("*")
        .eq("user_id", user!.id)
        .order("created_at");
      if (mgRes.error) throw mgRes.error;

      const mgRows = mgRes.data || [];
      if (mgRows.length === 0) return [];

      // Fetch only links belonging to this user's master groups — not the entire table.
      const mgIds = mgRows.map((r) => r.id);
      const linksRes = await backend
        .from("master_group_links")
        .select("*")
        .in("master_group_id", mgIds);
      if (linksRes.error) throw linksRes.error;

      return mgRows.map((row) => mapMasterGroupRow(row, linksRes.data || []));
    },
    enabled: !!user,
  });

  const [syncing, setSyncing] = useState(false);

  const syncGroups = useCallback(async () => {
    if (!user) return;

    setSyncing(true);
    try {
      const [waResult, tgResult] = await Promise.all([
        backend
          .from("whatsapp_sessions")
          .select("id, name")
          .eq("user_id", user.id)
          .eq("status", "online"),
        backend
          .from("telegram_sessions")
          .select("id, name")
          .eq("user_id", user.id)
          .eq("status", "online"),
      ]);

      if (waResult.error) throw waResult.error;
      if (tgResult.error) throw tgResult.error;

      const onlineWaSessions = waResult.data || [];
      const onlineTgSessions = tgResult.data || [];

      if (onlineWaSessions.length === 0 && onlineTgSessions.length === 0) {
        toast.error("Nenhuma sessão online para sincronizar grupos.");
        return;
      }

      let waSuccess = 0;
      let waError = 0;
      let tgSuccess = 0;
      let tgError = 0;

      for (const session of onlineWaSessions) {
        try {
          await syncChannelGroups("whatsapp", session.id);
          waSuccess++;
        } catch (error) {
          waError++;
          console.error("syncGroups WhatsApp session error:", session.id, error);
        }
      }

      for (const session of onlineTgSessions) {
        try {
          await syncChannelGroups("telegram", session.id);
          tgSuccess++;
        } catch (error) {
          tgError++;
          console.error("syncGroups Telegram session error:", session.id, error);
        }
      }

      const successCount = waSuccess + tgSuccess;
      const errorCount = waError + tgError;

      qc.invalidateQueries({ queryKey: ["groups"] });

      if (successCount > 0 && errorCount === 0) {
        toast.success(`Sincronização iniciada para ${successCount} sessão(ões) online.`);
      } else if (successCount > 0 && errorCount > 0) {
        toast.warning(`Sincronização parcial: ${successCount} sucesso(s), ${errorCount} falha(s).`);
      } else {
        toast.error("Falha ao sincronizar grupos em todas as sessões.");
      }
    } catch (err) {
      console.error("syncGroups error:", err);
      toast.error("Erro ao sincronizar grupos");
    } finally {
      setSyncing(false);
    }
  }, [user, qc]);

  const createMasterGroup = useCallback(async (name: string, distribution: DistributionMode, memberLimit: number, _alertMargin: number) => {
    if (!name.trim()) {
      toast.error("Informe o nome do grupo mestre");
      return null;
    }

    const slug = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

    const { data, error } = await backend.from("master_groups").insert({
      user_id: user!.id,
      name: name.trim(),
      slug,
      distribution,
      member_limit: memberLimit,
    }).select().single();

    if (error) {
      toast.error("Erro ao criar grupo mestre");
      return null;
    }

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    toast.success("Grupo mestre criado!");
    await logHistorico(user!.id, "session_event", name.trim(), "Grupo Mestre", "success", `Grupo mestre "${name.trim()}" criado`);

    return mapMasterGroupRow(data, []);
  }, [user, qc]);

  const removeMasterGroup = useCallback(async (id: string) => {
    const mg = masterGroups.find((m) => m.id === id);

    await backend.from("master_group_links").delete().eq("master_group_id", id);
    await backend.from("master_groups").delete().eq("id", id).eq("user_id", user!.id);

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    toast.success("Grupo mestre removido");

    if (user) {
      await logHistorico(user.id, "session_event", mg?.name || id, "Grupo Mestre", "warning", "Grupo mestre removido");
    }
  }, [qc, user, masterGroups]);

  const linkGroupToMaster = useCallback(async (masterGroupId: string, group: Group) => {
    const { error } = await backend
      .from("master_group_links")
      .insert({ master_group_id: masterGroupId, group_id: group.id, is_active: true });

    if (error) {
      toast.error("Erro ao vincular grupo");
      return;
    }

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    toast.success(`${group.name} vinculado!`);
  }, [qc]);

  const unlinkGroup = useCallback(async (masterGroupId: string, groupId: string) => {
    await backend
      .from("master_group_links")
      .delete()
      .eq("master_group_id", masterGroupId)
      .eq("group_id", groupId);

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    toast.success("Grupo desvinculado");
  }, [qc]);

  const getGroupById = useCallback((id: string) => syncedGroups.find((g) => g.id === id), [syncedGroups]);
  const refreshGroups = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["groups"] });
  }, [qc]);

  return {
    syncedGroups,
    masterGroups,
    syncing,
    isLoading: groupsLoading || mgLoading,
    syncGroups,
    createMasterGroup,
    removeMasterGroup,
    linkGroupToMaster,
    unlinkGroup,
    getGroupById,
    refreshGroups,
  };
}

