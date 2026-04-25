import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { invokeTelegramAction, invokeWhatsAppAction, syncChannelGroups } from "@/lib/channel-central";
import { useAuth } from "@/contexts/AuthContext";
import type { Group, MasterGroup, DistributionMode } from "@/lib/types";
import type { Tables } from "@/integrations/backend/types";
import { toast } from "sonner";
import { logHistorico } from "@/lib/log-historico";

type GroupRow = Tables<"groups">;
type MasterGroupRow = Tables<"master_groups">;
type MasterGroupLinkRow = Tables<"master_group_links">;

function normalizeDistributionMode(raw: unknown): DistributionMode {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "random") return "random";
  if (value === "balanced") return "balanced";
  // Legacy rows may still carry "sequential". Keep runtime behavior equivalent to balanced.
  return "balanced";
}

function ptCount(value: number, singular: string, plural: string): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe} ${safe === 1 ? singular : plural}`;
}

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

interface ValidSessionIdsByPlatform {
  whatsapp: Set<string>;
  telegram: Set<string>;
}

function mapIdRowsToSet(rows: Array<{ id: string | null }> | null | undefined): Set<string> {
  return new Set((rows || []).map((row) => String(row.id || "").trim()).filter(Boolean));
}

async function loadValidSessionIdsByPlatform(userId: string): Promise<ValidSessionIdsByPlatform> {
  const [waResult, tgResult] = await Promise.all([
    backend
      .from("whatsapp_sessions")
      .select("id")
      .eq("user_id", userId),
    backend
      .from("telegram_sessions")
      .select("id")
      .eq("user_id", userId),
  ]);

  if (waResult.error) throw waResult.error;
  if (tgResult.error) throw tgResult.error;

  return {
    whatsapp: mapIdRowsToSet(waResult.data as Array<{ id: string | null }> | null),
    telegram: mapIdRowsToSet(tgResult.data as Array<{ id: string | null }> | null),
  };
}

function hasValidGroupSession(row: GroupRow, validSessionIds: ValidSessionIdsByPlatform): boolean {
  const sessionId = String(row.session_id || "").trim();
  if (!sessionId) return false;
  if (row.platform === "whatsapp") return validSessionIds.whatsapp.has(sessionId);
  if (row.platform === "telegram") return validSessionIds.telegram.has(sessionId);
  return false;
}

function extractOnlineRuntimeSessionIds(payload: unknown): Set<string> {
  if (!payload || typeof payload !== "object") return new Set<string>();

  const rawSessions = (payload as Record<string, unknown>).sessions;
  const sessions = Array.isArray(rawSessions) ? rawSessions : [];
  const ids = new Set<string>();

  for (const item of sessions) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const sessionId = String(row.sessionId ?? row.id ?? "").trim();
    const status = String(row.status ?? "").trim().toLowerCase();
    if (sessionId && status === "online") ids.add(sessionId);
  }

  return ids;
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
    distribution: normalizeDistributionMode(row.distribution),
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
      const [groupsResult, validSessions] = await Promise.all([
        backend.from("groups").select("*").eq("user_id", user!.id).order("name"),
        loadValidSessionIdsByPlatform(user!.id),
      ]);
      if (groupsResult.error) throw groupsResult.error;
      // Exclude soft-deleted groups (session deleted) — they are invisible in the UI but
      // kept in the DB for 3 days so routes can be restored on session recreation.
      return (groupsResult.data || [])
        .filter((row) => !row.deleted_at && hasValidGroupSession(row, validSessions))
        .map(mapGroupRow);
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
      const validSessions = await loadValidSessionIdsByPlatform(user!.id);

      const linkedGroupsMap = new Map<string, GroupRow>();
      if (linkedGroupIds.length > 0) {
        const groupRes = await backend
          .from("groups")
          .select("*")
          .eq("user_id", user!.id)
          .in("id", linkedGroupIds);
        if (groupRes.error) throw groupRes.error;
        for (const groupRow of groupRes.data || []) {
          if (!groupRow.deleted_at && hasValidGroupSession(groupRow, validSessions)) {
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
      const [waResult, tgResult, waHealthResult, tgHealthResult] = await Promise.allSettled([
        backend
          .from("whatsapp_sessions")
          .select("id, name, status")
          .eq("user_id", user.id),
        backend
          .from("telegram_sessions")
          .select("id, name, status")
          .eq("user_id", user.id),
        invokeWhatsAppAction<Record<string, unknown>>("health"),
        invokeTelegramAction<Record<string, unknown>>("health"),
      ]);

      if (waResult.status !== "fulfilled") throw waResult.reason;
      if (tgResult.status !== "fulfilled") throw tgResult.reason;
      if (waResult.value.error) throw waResult.value.error;
      if (tgResult.value.error) throw tgResult.value.error;

      const onlineWaIdsFromRuntime = waHealthResult.status === "fulfilled"
        ? extractOnlineRuntimeSessionIds(waHealthResult.value)
        : null;
      const onlineTgIdsFromRuntime = tgHealthResult.status === "fulfilled"
        ? extractOnlineRuntimeSessionIds(tgHealthResult.value)
        : null;

      const onlineWaSessions = (waResult.value.data || []).filter((session) => {
        const sessionId = String(session.id || "").trim();
        if (!sessionId) return false;
        if (onlineWaIdsFromRuntime) return onlineWaIdsFromRuntime.has(sessionId);
        return String(session.status || "").trim().toLowerCase() === "online";
      });
      const onlineTgSessions = (tgResult.value.data || []).filter((session) => {
        const sessionId = String(session.id || "").trim();
        if (!sessionId) return false;
        if (onlineTgIdsFromRuntime) return onlineTgIdsFromRuntime.has(sessionId);
        return String(session.status || "").trim().toLowerCase() === "online";
      });

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
      qc.invalidateQueries({ queryKey: ["analytics-admin-groups"] });

      if (successCount > 0 && errorCount === 0) {
        toast.success(`Sincronização iniciada para ${ptCount(successCount, "sessão online", "sessões online")}.`);
      } else if (successCount > 0 && errorCount > 0) {
        toast.warning(
          `Sincronização parcial: ${ptCount(successCount, "sessão sincronizada", "sessões sincronizadas")} e ${ptCount(errorCount, "sessão com falha", "sessões com falha")}.`,
        );
      } else {
        toast.error("Falha ao sincronizar grupos em todas as sessões.");
      }
    } catch (err) {
      console.error("syncGroups error:", err);
      toast.error("Não foi possível sincronizar os grupos.");
    } finally {
      setSyncing(false);
    }
  }, [user, qc]);

  const createMasterGroup = useCallback(async (name: string, distribution: DistributionMode, memberLimit: number, _alertMargin: number) => {
    if (!user) return null;
    if (!name.trim()) {
      toast.error("Informe o nome do grupo mestre.");
      return null;
    }

    const slug = slugifyMasterGroupName(name) || `grupo-mestre-${Date.now()}`;

    const { data, error } = await backend.from("master_groups").insert({
      user_id: user.id,
      name: name.trim(),
      slug,
      distribution: normalizeDistributionMode(distribution),
      member_limit: Math.max(0, Number(memberLimit || 0)),
    }).select().single();

    if (error) {
      toast.error("Não foi possível criar o grupo mestre.");
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
      payload.distribution = normalizeDistributionMode(updates.distribution);
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
      toast.error("Não foi possível atualizar o grupo mestre.");
      return false;
    }

    qc.invalidateQueries({ queryKey: ["master_groups"] });
    return true;
  }, [user, qc]);

  const setMasterGroupGroups = useCallback(async (masterGroupId: string, nextGroupIds: string[]) => {
    if (!user) return false;
    let activeGroups: Array<{ id: string; platform: string; deleted_at: string | null; session_id: string | null; external_id: string | null; invite_link: string | null }> = [];

    const uniqueIds = [...new Set(nextGroupIds.map((item) => String(item || "").trim()).filter(Boolean))];
    if (uniqueIds.length > 0) {
      const groupsRes = await backend
        .from("groups")
        .select("id, platform, deleted_at, session_id, external_id, invite_link")
        .eq("user_id", user.id)
        .in("id", uniqueIds);
      if (groupsRes.error) {
        toast.error("Não foi possível validar os grupos vinculados.");
        return false;
      }

      activeGroups = (groupsRes.data || []).filter((row) => !row.deleted_at);
      if (activeGroups.length !== uniqueIds.length) {
        toast.error("Um ou mais grupos não existem ou não estão ativos.");
        return false;
      }

      const platformSet = new Set(activeGroups.map((row) => row.platform));
      if (platformSet.size > 1) {
        toast.error("Um grupo mestre só pode conter grupos da mesma rede.");
        return false;
      }
    }

    const currentLinksRes = await backend
      .from("master_group_links")
      .select("group_id")
      .eq("master_group_id", masterGroupId);
    if (currentLinksRes.error) {
      toast.error("Não foi possível carregar os vínculos atuais.");
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
        toast.error(insertError.message || "Não foi possível vincular os grupos.");
        return false;
      }

      const addedGroups = activeGroups.filter((row) => toAdd.includes(row.id));
      const whatsappMissingInvite = addedGroups.filter((row) => row.platform === "whatsapp" && !String(row.invite_link || "").trim());

      if (whatsappMissingInvite.length > 0) {
        const updates: Array<{ id: string; inviteLink: string }> = [];
        let failedCount = 0;

        for (const groupRow of whatsappMissingInvite) {
          const sessionId = String(groupRow.session_id || "").trim();
          const groupId = String(groupRow.external_id || "").trim();
          if (!sessionId || !groupId) {
            failedCount += 1;
            continue;
          }

          try {
            const result = await invokeWhatsAppAction<{ inviteLink?: string }>("group_invite", { sessionId, groupId });
            const inviteLink = String(result?.inviteLink || "").trim();
            if (!inviteLink) {
              failedCount += 1;
              continue;
            }
            updates.push({ id: groupRow.id, inviteLink });
          } catch {
            failedCount += 1;
          }
        }

        if (updates.length > 0) {
          await Promise.all(updates.map((item) => backend
            .from("groups")
            .update({ invite_link: item.inviteLink, updated_at: new Date().toISOString() })
            .eq("id", item.id)
            .eq("user_id", user.id)));
        }

        if (failedCount > 0) {
          toast.warning("Alguns convites não puderam ser coletados automaticamente (verifique permissão de admin no grupo).");
        }
      }
    }

    if (toRemove.length > 0) {
      const { error: deleteError } = await backend
        .from("master_group_links")
        .delete()
        .eq("master_group_id", masterGroupId)
        .in("group_id", toRemove);
      if (deleteError) {
        toast.error("Não foi possível desvincular os grupos.");
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
    toast.success("Grupo mestre removido com sucesso!");

    await logHistorico(user.id, "session_event", mg?.name || id, "Grupo Mestre", "warning", "Grupo mestre removido");
  }, [qc, user, masterGroups]);

  const linkGroupToMaster = useCallback(async (masterGroupId: string, group: Group) => {
    const current = masterGroups.find((item) => item.id === masterGroupId);
    const nextGroupIds = [...new Set([...(current?.groupIds || []), group.id])];
    const success = await setMasterGroupGroups(masterGroupId, nextGroupIds);
    if (success) {
      toast.success(`Grupo "${group.name}" vinculado com sucesso!`);
    }
  }, [masterGroups, setMasterGroupGroups]);

  const unlinkGroup = useCallback(async (masterGroupId: string, groupId: string) => {
    const current = masterGroups.find((item) => item.id === masterGroupId);
    const nextGroupIds = (current?.groupIds || []).filter((id) => id !== groupId);
    const success = await setMasterGroupGroups(masterGroupId, nextGroupIds);
    if (success) {
      toast.success("Grupo desvinculado com sucesso!");
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
      toast.error("Não foi possível salvar o link de convite do grupo.");
      return false;
    }

    qc.invalidateQueries({ queryKey: ["groups"] });
    qc.invalidateQueries({ queryKey: ["master_groups"] });
    toast.success("Link de convite atualizado com sucesso!");
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
