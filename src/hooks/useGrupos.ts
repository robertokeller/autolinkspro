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

function resolveGroupInviteLink(row: GroupRow): string | null {
  const explicit = String(row.invite_link || "").trim();
  if (/^https?:\/\//i.test(explicit)) {
    return explicit;
  }

  const external = String(row.external_id || "").trim();
  if (!external) return null;
  if (/^https?:\/\//i.test(external)) return external;

  if (row.platform === "telegram") {
    if (/^@[A-Za-z0-9_]{3,}$/i.test(external)) {
      return `https://t.me/${external.slice(1)}`;
    }
    if (/^[A-Za-z0-9_]{3,}$/i.test(external)) {
      return `https://t.me/${external}`;
    }
  }

  if (row.platform === "whatsapp") {
    if (/^chat\.whatsapp\.com\/[A-Za-z0-9]+$/i.test(external)) {
      return `https://${external}`;
    }
    if (/^[A-Za-z0-9]{20,32}$/.test(external)) {
      return `https://chat.whatsapp.com/${external}`;
    }
  }

  return null;
}

function mapGroupRow(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as Group["platform"],
    memberCount: row.member_count,
    sessionId: row.session_id || "",
    tags: [],
    externalId: row.external_id || null,
    inviteLink: resolveGroupInviteLink(row),
    whatsappSessionId: row.platform === "whatsapp" ? row.session_id : null,
    telegramSessionId: row.platform === "telegram" ? row.session_id : null,
  };
}

function mapMasterGroupRow(
  row: MasterGroupRow,
  links: MasterGroupLinkRow[],
  linkedGroupsById: Map<string, GroupRow>,
): MasterGroup {
  const linksForMaster = links.filter((l) => l.master_group_id === row.id && l.is_active !== false);
  const groupIds = linksForMaster
    .map((l) => l.group_id)
    .filter((groupId) => linkedGroupsById.has(groupId));

  const platforms = new Set(
    groupIds
      .map((groupId) => linkedGroupsById.get(groupId)?.platform)
      .filter((platform): platform is "whatsapp" | "telegram" => platform === "whatsapp" || platform === "telegram"),
  );
  const platform = platforms.size === 1
    ? [...platforms][0]
    : platforms.size > 1
      ? "mixed"
      : "unknown";

  return {
    id: row.id,
    name: row.name,
    slug: row.slug || "",
    platform,
    groupIds,
    distribution: row.distribution as DistributionMode,
    memberLimit: row.member_limit,
    alertMargin: 90,
    linkedGroups: linksForMaster
      .filter((l) => linkedGroupsById.has(l.group_id))
      .map((l) => {
        const group = linkedGroupsById.get(l.group_id)!;
        return {
          masterGroupId: row.id,
          groupId: l.group_id,
          inviteLink: resolveGroupInviteLink(group),
          memberCount: group.member_count,
          isActive: l.is_active,
        };
      }),
  };
}

function slugifyMasterGroupName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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

      const links = linksRes.data || [];
      const linkedGroupIds = [...new Set(links.map((l) => l.group_id))];

      const linkedGroupsMap = new Map<string, GroupRow>();
      if (linkedGroupIds.length > 0) {
        const groupRes = await backend
          .from("groups")
          .select("*")
          .eq("user_id", user!.id)
          .in("id", linkedGroupIds);
        if (groupRes.error) throw groupRes.error;
        for (const groupRow of groupRes.data || []) {
          if (!groupRow.deleted_at) {
            linkedGroupsMap.set(groupRow.id, groupRow);
          }
        }
      }

      return mgRows.map((row) => mapMasterGroupRow(row, links, linkedGroupsMap));
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
      qc.invalidateQueries({ queryKey: ["master_groups"] });

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
    if (!user) return null;
    if (!name.trim()) {
      toast.error("Informe o nome do grupo mestre");
      return null;
    }

    const slug = slugifyMasterGroupName(name) || `grupo-mestre-${Date.now()}`;

    const { data, error } = await backend.from("master_groups").insert({
      user_id: user.id,
      name: name.trim(),
      slug,
      distribution,
      member_limit: Math.max(0, Number(memberLimit || 0)),
    }).select().single();

    if (error) {
      toast.error("Erro ao criar grupo mestre");
      return null;
    }

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    toast.success("Grupo mestre criado!");
    await logHistorico(user.id, "session_event", name.trim(), "Grupo Mestre", "success", `Grupo mestre "${name.trim()}" criado`);

    return data.id as string;
  }, [user, qc]);

  const updateMasterGroup = useCallback(async (
    id: string,
    updates: { name?: string; distribution?: DistributionMode; memberLimit?: number; slug?: string },
  ) => {
    if (!user) return false;
    const payload: Record<string, unknown> = {};
    if (typeof updates.name === "string" && updates.name.trim()) {
      payload.name = updates.name.trim();
    }
    if (typeof updates.distribution === "string") {
      payload.distribution = updates.distribution;
    }
    if (typeof updates.memberLimit === "number" && Number.isFinite(updates.memberLimit)) {
      payload.member_limit = Math.max(0, Math.trunc(updates.memberLimit));
    }
    if (typeof updates.slug === "string") {
      payload.slug = slugifyMasterGroupName(updates.slug);
    }
    if (Object.keys(payload).length === 0) return true;

    const { error } = await backend
      .from("master_groups")
      .update(payload)
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) {
      toast.error("Erro ao atualizar grupo mestre");
      return false;
    }

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    return true;
  }, [user, qc]);

  const setMasterGroupGroups = useCallback(async (masterGroupId: string, nextGroupIds: string[]) => {
    if (!user) return false;

    const uniqueIds = [...new Set(nextGroupIds.map((item) => String(item || "").trim()).filter(Boolean))];
    if (uniqueIds.length > 0) {
      const groupsRes = await backend
        .from("groups")
        .select("id, platform, deleted_at")
        .eq("user_id", user.id)
        .in("id", uniqueIds);
      if (groupsRes.error) {
        toast.error("Erro ao validar grupos vinculados");
        return false;
      }

      const activeGroups = (groupsRes.data || []).filter((row) => !row.deleted_at);
      if (activeGroups.length !== uniqueIds.length) {
        toast.error("Um ou mais grupos não existem ou não estão ativos");
        return false;
      }

      const platformSet = new Set(activeGroups.map((row) => row.platform));
      if (platformSet.size > 1) {
        toast.error("Grupo mestre só pode conter grupos da mesma rede");
        return false;
      }
    }

    const currentLinksRes = await backend
      .from("master_group_links")
      .select("group_id")
      .eq("master_group_id", masterGroupId);
    if (currentLinksRes.error) {
      toast.error("Erro ao carregar vínculos atuais");
      return false;
    }
    const currentIds = (currentLinksRes.data || []).map((row) => row.group_id);

    const toAdd = uniqueIds.filter((groupId) => !currentIds.includes(groupId));
    const toRemove = currentIds.filter((groupId) => !uniqueIds.includes(groupId));

    if (toAdd.length > 0) {
      const { error: insertError } = await backend
        .from("master_group_links")
        .insert(toAdd.map((groupId) => ({ master_group_id: masterGroupId, group_id: groupId, is_active: true })));
      if (insertError) {
        toast.error(insertError.message || "Erro ao vincular grupos");
        return false;
      }
    }

    if (toRemove.length > 0) {
      const { error: deleteError } = await backend
        .from("master_group_links")
        .delete()
        .eq("master_group_id", masterGroupId)
        .in("group_id", toRemove);
      if (deleteError) {
        toast.error("Erro ao desvincular grupos");
        return false;
      }
    }

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    return true;
  }, [user, qc]);

  const removeMasterGroup = useCallback(async (id: string) => {
    if (!user) return;
    const mg = masterGroups.find((m) => m.id === id);

    await backend.from("master_group_links").delete().eq("master_group_id", id);
    await backend.from("master_groups").delete().eq("id", id).eq("user_id", user.id);

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    toast.success("Grupo mestre removido");

    await logHistorico(user.id, "session_event", mg?.name || id, "Grupo Mestre", "warning", "Grupo mestre removido");
  }, [qc, user, masterGroups]);

  const linkGroupToMaster = useCallback(async (masterGroupId: string, group: Group) => {
    const current = masterGroups.find((item) => item.id === masterGroupId);
    const nextGroupIds = [...new Set([...(current?.groupIds || []), group.id])];
    const success = await setMasterGroupGroups(masterGroupId, nextGroupIds);
    if (success) {
      toast.success(`${group.name} vinculado!`);
    }
  }, [masterGroups, setMasterGroupGroups]);

  const unlinkGroup = useCallback(async (masterGroupId: string, groupId: string) => {
    const current = masterGroups.find((item) => item.id === masterGroupId);
    const nextGroupIds = (current?.groupIds || []).filter((id) => id !== groupId);
    const success = await setMasterGroupGroups(masterGroupId, nextGroupIds);
    if (success) {
      toast.success("Grupo desvinculado");
    }
  }, [masterGroups, setMasterGroupGroups]);

  const upsertGroupInviteLink = useCallback(async (groupId: string, inviteLink: string) => {
    if (!user) return false;
    const normalized = String(inviteLink || "").trim();
    const { error } = await backend
      .from("groups")
      .update({
        invite_link: normalized,
        updated_at: new Date().toISOString(),
      })
      .eq("id", groupId)
      .eq("user_id", user.id);

    if (error) {
      toast.error("Erro ao salvar link de convite do grupo");
      return false;
    }

    qc.invalidateQueries({ queryKey: ["groups"] });
    qc.invalidateQueries({ queryKey: ["master_groups"] });
    toast.success("Link de convite atualizado");
    return true;
  }, [user, qc]);

  const getGroupById = useCallback((id: string) => syncedGroups.find((g) => g.id === id), [syncedGroups]);
  const refreshGroups = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["groups"] });
    qc.invalidateQueries({ queryKey: ["master_groups"] });
  }, [qc]);

  return {
    syncedGroups,
    masterGroups,
    syncing,
    isLoading: groupsLoading || mgLoading,
    syncGroups,
    createMasterGroup,
    updateMasterGroup,
    setMasterGroupGroups,
    removeMasterGroup,
    linkGroupToMaster,
    unlinkGroup,
    upsertGroupInviteLink,
    getGroupById,
    refreshGroups,
  };
}

