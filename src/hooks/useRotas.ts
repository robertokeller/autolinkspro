import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { AppRoute, RouteStatus } from "@/lib/types";
import type { Tables, Json } from "@/integrations/backend/types";
import { toast } from "sonner";
import { useCallback } from "react";
import { logHistorico } from "@/lib/log-historico";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import { normalizePlanId, PLAN_SYNC_ERROR_MESSAGE } from "@/lib/plan-id";

const ROUTE_DESTINATIONS_TABLE_WARNING = "Não foi possível carregar os destinos das rotas. As rotas foram exibidas sem os grupos vinculados.";
const ROUTE_COUNTERS_HISTORY_WARNING = "Não foi possível carregar o histórico de envios das rotas. O contador pode ficar desatualizado temporariamente.";

type RouteRow = Tables<"routes">;
type RouteDestRow = Tables<"route_destinations">;

interface RulesJson {
  masterGroupId?: string | null;
  masterGroupIds?: string[];
  autoConvertShopee?: boolean;
  autoConvertMercadoLivre?: boolean;
  autoConvertAmazon?: boolean;
  resolvePartnerLinks?: boolean;
  requirePartnerLink?: boolean;
  partnerMarketplaces?: string[];
  filterWords?: string[]; negativeKeywords?: string[]; positiveKeywords?: string[];
  templateId?: string | null; groupType?: string;
  amazonTemplateId?: string | null;
  sessionId?: string | null;
  messagesForwarded?: number;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

function parseRules(raw: Json): RulesJson {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as unknown as RulesJson;
  return {};
}

function normalizeClockTime(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return fallback;

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return fallback;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function mapRow(row: RouteRow, destinations: RouteDestRow[]): AppRoute {
  const dests = destinations.filter((d) => d.route_id === row.id);
  const rules = parseRules(row.rules);
  const messagesForwardedRaw = Number(rules.messagesForwarded);
  const messagesForwarded = Number.isFinite(messagesForwardedRaw) && messagesForwardedRaw >= 0
    ? Math.floor(messagesForwardedRaw)
    : 0;
  const normalizedMasterGroupIds = Array.isArray(rules.masterGroupIds)
    ? rules.masterGroupIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : (rules.masterGroupId ? [rules.masterGroupId] : []);
  const quietHoursStart = normalizeClockTime(rules.quietHoursStart, "22:00");
  const quietHoursEnd = normalizeClockTime(rules.quietHoursEnd, "08:00");
  return {
    id: row.id, name: row.name, sourceGroupId: row.source_group_id || "",
    destinationGroupIds: dests.map((d) => d.group_id),
    masterGroupId: rules.masterGroupId || null,
    status: row.status as RouteStatus,
    rules: {
      autoConvertShopee: rules.autoConvertShopee ?? false,
      autoConvertMercadoLivre: rules.autoConvertMercadoLivre ?? false,
      autoConvertAmazon: rules.autoConvertAmazon ?? false,
      resolvePartnerLinks: rules.resolvePartnerLinks ?? true,
      requirePartnerLink: rules.requirePartnerLink ?? true,
      partnerMarketplaces: Array.isArray(rules.partnerMarketplaces) && rules.partnerMarketplaces.length > 0
        ? rules.partnerMarketplaces
        : ["shopee", "mercadolivre", "amazon"],
      filterWords: rules.filterWords || [], negativeKeywords: rules.negativeKeywords || [],
      positiveKeywords: rules.positiveKeywords || [], templateId: rules.templateId || null,
      amazonTemplateId: rules.amazonTemplateId || null,
      groupType: "ofertas" as const,
      sessionId: rules.sessionId || null,
      masterGroupIds: normalizedMasterGroupIds,
      quietHoursEnabled: rules.quietHoursEnabled === true,
      quietHoursStart,
      quietHoursEnd,
    },
    messagesForwarded, createdAt: row.created_at,
  };
}

export function useRotas() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();

  const { data: routes = [], isLoading } = useQuery({
    queryKey: ["routes", user?.id],
    queryFn: async () => {
      const routesRes = await backend
        .from("routes")
        .select("*")
        .order("created_at", { ascending: false });

      if (routesRes.error) throw routesRes.error;

      const routeRows = routesRes.data || [];
      if (routeRows.length === 0) return [];

      const routeIds = routeRows.map((row) => row.id);
      const destsRes = await backend
        .from("route_destinations")
        .select("*")
        .in("route_id", routeIds);

      if (destsRes.error) {
        console.warn("[useRotas]", ROUTE_DESTINATIONS_TABLE_WARNING, destsRes.error.message);
        return routeRows.map((row) => mapRow(row, []));
      }
      const mappedRoutes = routeRows.map((row) => mapRow(row, destsRes.data || []));
      const hasAnyForwardCount = mappedRoutes.some((route) => route.messagesForwarded > 0);
      if (hasAnyForwardCount) return mappedRoutes;

      const routeIdSet = new Set(routeRows.map((row) => row.id));
      const historyRes = await backend
        .from("history_entries")
        .select("details")
        .eq("type", "route_forward")
        .eq("processing_status", "sent")
        .limit(10000);

      if (historyRes.error) {
        console.warn("[useRotas]", ROUTE_COUNTERS_HISTORY_WARNING, historyRes.error.message);
        return mappedRoutes;
      }

      const countsByRoute = new Map<string, number>();
      for (const row of historyRes.data || []) {
        const details = row.details && typeof row.details === "object" && !Array.isArray(row.details)
          ? row.details as Record<string, unknown>
          : null;
        const routeId = details ? String(details.routeId || "").trim() : "";
        if (!routeId || !routeIdSet.has(routeId)) continue;
        countsByRoute.set(routeId, (countsByRoute.get(routeId) || 0) + 1);
      }

      if (countsByRoute.size === 0) return mappedRoutes;
      return mappedRoutes.map((route) => ({
        ...route,
        messagesForwarded: Math.max(route.messagesForwarded, countsByRoute.get(route.id) || 0),
      }));
    },
    enabled: !!user,
  });

  const createRoute = useCallback(async (route: {
    name: string; sourceGroupId: string; destinationGroupIds: string[];
    masterGroupId?: string; masterGroupIds?: string[]; rules: Record<string, unknown>;
  }) => {
    if (!user?.id) return null;
    if (!route.name || !route.sourceGroupId) { toast.error("Preencha nome e origem"); return null; }

    if (!isAdmin) {
      const { data: profile, error: profileError } = await backend
        .from("profiles")
        .select("plan_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profileError) {
        toast.error("Não foi possível validar o limite de rotas");
        return null;
      }

      const planId = normalizePlanId(profile?.plan_id);
      if (!planId) {
        toast.error(PLAN_SYNC_ERROR_MESSAGE);
        return null;
      }

      const limits = resolveEffectiveLimitsByPlanId(planId);
      if (!limits) {
        toast.error(PLAN_SYNC_ERROR_MESSAGE);
        return null;
      }

      const maxRoutes = limits?.routes ?? 0;
      if (maxRoutes !== -1 && routes.length >= maxRoutes) {
        toast.error("Limite de rotas atingido para o seu nível de acesso.");
        return null;
      }

      const maxGroupSlots = limits?.groupsPerRoute ?? 0;
      if (maxGroupSlots !== -1) {
        const slotsUsed = routes.reduce((sum, r) => sum + r.destinationGroupIds.length, 0);
        const slotsNew = route.destinationGroupIds.length;
        if (slotsUsed + slotsNew > maxGroupSlots) {
          toast.error(
            `Limite de grupos atingido. Seu plano permite ${maxGroupSlots} grupo(s) no total entre todas as rotas. Você já usa ${slotsUsed} e tentou adicionar mais ${slotsNew}.`,
          );
          return null;
        }
      }
    }

    const normalizedMasterGroupIds = Array.isArray(route.masterGroupIds)
      ? route.masterGroupIds.filter((id) => typeof id === "string" && id.trim().length > 0)
      : [];
    const { data, error } = await backend.from("routes").insert({
      name: route.name, source_group_id: route.sourceGroupId,
      status: "active",
      rules: {
        ...route.rules,
        masterGroupIds: normalizedMasterGroupIds,
        masterGroupId: normalizedMasterGroupIds[0] || route.masterGroupId || null,
      },
    }).select().single();
    if (error) { toast.error("Erro ao criar rota"); return null; }
    if (route.destinationGroupIds.length > 0) {
      const destinationsInsert = await backend
        .from("route_destinations")
        .insert(route.destinationGroupIds.map((gid) => ({ route_id: data.id, group_id: gid })));

      if (destinationsInsert.error) {
        // Compensating action: avoid leaving a partially created route without destinations.
        const rollback = await backend
          .from("routes")
          .delete()
          .eq("id", data.id);
        if (rollback.error) {
          toast.error("Falha ao vincular destinos e não foi possível reverter a rota criada.");
        } else {
          toast.error("Falha ao vincular os destinos. A criação da rota foi revertida.");
        }
        return null;
      }
    }
    qc.invalidateQueries({ queryKey: ["routes"] });
    toast.success("Rota criada!");
    await logHistorico(user.id, "route_forward", route.name, `${route.destinationGroupIds.length} grupo(s)`, "success", `Rota "${route.name}" criada`);
    return data;
  }, [isAdmin, qc, routes, user]);

  const setRouteStatus = useCallback(async (
    id: string,
    status: RouteStatus,
    options?: { silent?: boolean },
  ) => {
    const route = routes.find((r) => r.id === id);
    const { error } = await backend.from("routes").update({ status }).eq("id", id);
    if (error) {
      if (!options?.silent) toast.error("Não foi possível atualizar o status da rota");
      return false;
    }

    qc.invalidateQueries({ queryKey: ["routes"] });
    if (!options?.silent) {
      toast.success(`Rota ${status === "active" ? "ativada" : status === "paused" ? "pausada" : "atualizada"}`);
    }
    if (user) {
      await logHistorico(user.id, "route_forward", route?.name || id, "-", "info", `Rota ${status === "active" ? "ativada" : "pausada"}`);
    }
    return true;
  }, [qc, routes, user]);

  const toggleRoute = useCallback(async (id: string, currentStatus: RouteStatus) => {
    const newStatus: RouteStatus = currentStatus === "active" ? "paused" : "active";
    return setRouteStatus(id, newStatus);
  }, [setRouteStatus]);

  const setAllRoutesStatus = useCallback(async (status: Exclude<RouteStatus, "error" | "inactive">) => {
    if (!user?.id || routes.length === 0) return false;
    const routeIds = routes.map((r) => r.id);
    const { error } = await backend.from("routes").update({ status }).in("id", routeIds);
    if (error) {
      toast.error("Não foi possível atualizar as rotas em massa");
      return false;
    }
    qc.invalidateQueries({ queryKey: ["routes"] });
    toast.success(status === "active" ? "Todas as rotas foram retomadas" : "Todas as rotas foram pausadas");
    await logHistorico(user.id, "route_forward", "Rotas", "-", "info", `Ação em massa: ${status === "active" ? "retomar" : "pausar"} todas`);
    return true;
  }, [qc, user, routes]);

  const refreshAllRoutes = useCallback(async () => {
    if (!user?.id || routes.length === 0) return false;

    // Refresh only routes that are currently active so paused routes stay paused.
    const activeRouteIds = routes
      .filter((route) => route.status === "active")
      .map((route) => route.id);

    if (activeRouteIds.length === 0) {
      toast.info("Não há rotas ativas para atualizar");
      return true;
    }

    const pauseResult = await backend
      .from("routes")
      .update({ status: "paused" })
      .in("id", activeRouteIds);

    if (pauseResult.error) {
      toast.error("Não foi possível pausar todas as rotas");
      qc.invalidateQueries({ queryKey: ["routes"] });
      return false;
    }

    const resumeResult = await backend
      .from("routes")
      .update({ status: "active" })
      .in("id", activeRouteIds);

    if (resumeResult.error) {
      toast.error("As rotas foram pausadas, mas não foi possível retomar todas");
      qc.invalidateQueries({ queryKey: ["routes"] });
      return false;
    }

    qc.invalidateQueries({ queryKey: ["routes"] });
    toast.success("Rotas atualizadas: pausadas e retomadas");
    await logHistorico(user.id, "route_forward", "Rotas", "-", "info", "Ação em massa: atualizar rotas (pausar e retomar)");
    return true;
  }, [qc, routes, user]);

  const deleteRoute = useCallback(async (id: string) => {
    const route = routes.find((r) => r.id === id);
    const deleteRouteResult = await backend
      .from("routes")
      .delete()
      .eq("id", id);

    if (deleteRouteResult.error) {
      toast.error("Não foi possível remover a rota");
      return;
    }

    qc.invalidateQueries({ queryKey: ["routes"] });
    toast.success("Rota removida");
    if (user) await logHistorico(user.id, "route_forward", route?.name || id, "-", "warning", `Rota removida`);
  }, [qc, user, routes]);

  const updateRoute = useCallback(async (id: string, route: {
    name: string; sourceGroupId: string; destinationGroupIds: string[];
    masterGroupId?: string; masterGroupIds?: string[]; rules: Record<string, unknown>;
  }) => {
    if (!route.name || !route.sourceGroupId) { toast.error("Preencha nome e origem"); return null; }

    if (!isAdmin) {
      const { data: profile, error: profileError } = await backend
        .from("profiles")
        .select("plan_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profileError) {
        toast.error("Não foi possível validar o limite de rotas");
        return null;
      }

      const planId = normalizePlanId(profile?.plan_id);
      if (!planId) {
        toast.error(PLAN_SYNC_ERROR_MESSAGE);
        return null;
      }

      const limits = resolveEffectiveLimitsByPlanId(planId);
      if (!limits) {
        toast.error(PLAN_SYNC_ERROR_MESSAGE);
        return null;
      }

      const maxGroupSlots = limits?.groupsPerRoute ?? 0;
      if (maxGroupSlots !== -1) {
        const slotsUsedByOthers = routes
          .filter((r) => r.id !== id)
          .reduce((sum, r) => sum + r.destinationGroupIds.length, 0);
        if (slotsUsedByOthers + route.destinationGroupIds.length > maxGroupSlots) {
          toast.error(
            `Limite de grupos atingido. Seu plano permite ${maxGroupSlots} grupo(s) no total entre todas as rotas. As outras rotas já usam ${slotsUsedByOthers}.`,
          );
          return null;
        }
      }
    }

    const previousRouteRes = await backend
      .from("routes")
      .select("name, source_group_id, rules")
      .eq("id", id)
      .single();

    if (previousRouteRes.error || !previousRouteRes.data) {
      toast.error("Não foi possível carregar o estado atual da rota para edição segura.");
      return null;
    }

    const previousDestinationsRes = await backend
      .from("route_destinations")
      .select("group_id")
      .eq("route_id", id);

    if (previousDestinationsRes.error) {
      toast.error(`Falha ao carregar destinos atuais da rota: ${previousDestinationsRes.error.message}`);
      return null;
    }

    const previousDestinationGroupIds = Array.from(
      new Set((previousDestinationsRes.data || []).map((row) => String(row.group_id || "").trim()).filter(Boolean)),
    );
    const nextDestinationGroupIds = Array.from(
      new Set(route.destinationGroupIds.map((value) => String(value || "").trim()).filter(Boolean)),
    );

    const rollbackRouteAndDestinations = async () => {
      const restoreRoute = await backend
        .from("routes")
        .update({
          name: previousRouteRes.data.name,
          source_group_id: previousRouteRes.data.source_group_id,
          rules: previousRouteRes.data.rules,
        })
        .eq("id", id);

      const clearDestinations = await backend
        .from("route_destinations")
        .delete()
        .eq("route_id", id);

      // Use upsert with ignoreDuplicates so that if clearDestinations partially failed
      // (leaving some old rows), the restore still succeeds without unique-constraint errors.
      const restoreDestinations = previousDestinationGroupIds.length > 0
        ? await backend
          .from("route_destinations")
          .upsert(
            previousDestinationGroupIds.map((groupId) => ({ route_id: id, group_id: groupId })),
            { onConflict: "route_id,group_id", ignoreDuplicates: true },
          )
        : { error: null as unknown as { message?: string } | null };

      if (restoreRoute.error || clearDestinations.error || restoreDestinations.error) {
        return false;
      }
      return true;
    };

    const normalizedMasterGroupIds = Array.isArray(route.masterGroupIds)
      ? route.masterGroupIds.filter((item) => typeof item === "string" && item.trim().length > 0)
      : [];
    const { error } = await backend.from("routes").update({
      name: route.name, source_group_id: route.sourceGroupId,
      rules: {
        ...route.rules,
        masterGroupIds: normalizedMasterGroupIds,
        masterGroupId: normalizedMasterGroupIds[0] || route.masterGroupId || null,
      },
    }).eq("id", id);
    if (error) { toast.error("Erro ao atualizar rota"); return null; }

    const currentSet = new Set(previousDestinationGroupIds);
    const nextSet = new Set(nextDestinationGroupIds);

    const toInsert = nextDestinationGroupIds.filter((gid) => !currentSet.has(gid));
    const toDelete = previousDestinationGroupIds.filter((gid) => !nextSet.has(gid));

    if (toInsert.length > 0) {
      // Use upsert with ignoreDuplicates to be resilient against race conditions where
      // a concurrent operation may have already inserted the same (route_id, group_id) pair.
      const insertDestinations = await backend
        .from("route_destinations")
        .upsert(
          toInsert.map((gid) => ({ route_id: id, group_id: gid })),
          { onConflict: "route_id,group_id", ignoreDuplicates: true },
        );

      if (insertDestinations.error) {
        const rollbackOk = await rollbackRouteAndDestinations();
        toast.error(
          rollbackOk
            ? `Falha ao salvar grupos de destino da rota: ${insertDestinations.error.message}. Alterações revertidas.`
            : "Falha ao salvar destinos e não foi possível reverter totalmente a rota.",
        );
        return null;
      }
    }

    if (toDelete.length > 0) {
      const deleteDestinations = await backend
        .from("route_destinations")
        .delete()
        .eq("route_id", id)
        .in("group_id", toDelete);

      if (deleteDestinations.error) {
        const rollbackOk = await rollbackRouteAndDestinations();
        toast.error(
          rollbackOk
            ? `Falha ao remover destinos antigos da rota: ${deleteDestinations.error.message}. Alterações revertidas.`
            : "Falha ao atualizar destinos e não foi possível reverter totalmente a rota.",
        );
        return null;
      }
    }
    qc.invalidateQueries({ queryKey: ["routes"] });
    toast.success("Rota atualizada!");
    if (user) await logHistorico(user.id, "route_forward", route.name, "-", "info", `Rota "${route.name}" editada`);
    return true;
  }, [isAdmin, qc, routes, user]);

  const duplicateRoute = useCallback(async (id: string) => {
    const route = routes.find((r) => r.id === id);
    if (!route) return;
    await createRoute({
      name: `Cópia de ${route.name}`,
      sourceGroupId: route.sourceGroupId,
      destinationGroupIds: [...route.destinationGroupIds],
      masterGroupIds: route.rules.masterGroupIds || (route.masterGroupId ? [route.masterGroupId] : []),
      masterGroupId: route.masterGroupId || undefined,
      rules: { ...route.rules },
    });
  }, [routes, createRoute]);

  return {
    routes,
    isLoading,
    createRoute,
    updateRoute,
    toggleRoute,
    setAllRoutesStatus,
    refreshAllRoutes,
    deleteRoute,
    duplicateRoute,
  };
}
