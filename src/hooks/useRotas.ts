import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { AppRoute, RouteStatus } from "@/lib/types";
import type { Tables, Json } from "@/integrations/backend/types";
import { toast } from "sonner";
import { useCallback } from "react";
import { logHistorico } from "@/lib/log-historico";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";

const ROUTE_DESTINATIONS_TABLE_WARNING = "Não foi possível carregar os destinos das rotas. As rotas foram exibidas sem os grupos vinculados.";

type RouteRow = Tables<"routes">;
type RouteDestRow = Tables<"route_destinations">;

interface RulesJson {
  masterGroupId?: string | null;
   masterGroupIds?: string[];
  autoConvertShopee?: boolean;
  autoConvertMercadoLivre?: boolean;
  meliSessionId?: string | null;
  resolvePartnerLinks?: boolean;
  requirePartnerLink?: boolean;
  partnerMarketplaces?: string[];
  filterWords?: string[]; negativeKeywords?: string[]; positiveKeywords?: string[];
  templateId?: string | null; groupType?: string;
  sessionId?: string | null;
  messagesForwarded?: number;
}

function parseRules(raw: Json): RulesJson {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as unknown as RulesJson;
  return {};
}

function mapRow(row: RouteRow, destinations: RouteDestRow[]): AppRoute {
  const dests = destinations.filter((d) => d.route_id === row.id);
  const rules = parseRules(row.rules);
   const normalizedMasterGroupIds = Array.isArray(rules.masterGroupIds)
     ? rules.masterGroupIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
     : (rules.masterGroupId ? [rules.masterGroupId] : []);
  return {
    id: row.id, name: row.name, sourceGroupId: row.source_group_id || "",
    destinationGroupIds: dests.map((d) => d.group_id),
    masterGroupId: rules.masterGroupId || null,
    status: row.status as RouteStatus,
    rules: {
      autoConvertShopee: rules.autoConvertShopee ?? false,
      autoConvertMercadoLivre: rules.autoConvertMercadoLivre ?? false,
      meliSessionId: rules.meliSessionId || null,
      resolvePartnerLinks: rules.resolvePartnerLinks ?? true,
      requirePartnerLink: rules.requirePartnerLink ?? true,
      partnerMarketplaces: Array.isArray(rules.partnerMarketplaces) && rules.partnerMarketplaces.length > 0
        ? rules.partnerMarketplaces
        : ["shopee", "mercadolivre"],
      filterWords: rules.filterWords || [], negativeKeywords: rules.negativeKeywords || [],
      positiveKeywords: rules.positiveKeywords || [], templateId: rules.templateId || null,
      groupType: "ofertas" as const,
      sessionId: rules.sessionId || null,
      masterGroupIds: normalizedMasterGroupIds,
    },
    messagesForwarded: rules.messagesForwarded || 0, createdAt: row.created_at,
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
      return routeRows.map((row) => mapRow(row, destsRes.data || []));
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
        .maybeSingle();
      if (profileError) {
        toast.error("Não foi possível validar o limite de rotas");
        return null;
      }

      const limits = resolveEffectiveLimitsByPlanId(profile?.plan_id || "plan-starter");
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
        toast.warning("Rota criada, mas não foi possível vincular os grupos de destino.");
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

  const setAllRoutesStatus = useCallback(async (status: Exclude<RouteStatus, "error">) => {
    if (!user?.id) return false;
    const { error } = await backend.from("routes").update({ status });
    if (error) {
      toast.error("Não foi possível atualizar as rotas em massa");
      return false;
    }
    qc.invalidateQueries({ queryKey: ["routes"] });
    toast.success(status === "active" ? "Todas as rotas foram retomadas" : "Todas as rotas foram pausadas");
    await logHistorico(user.id, "route_forward", "Rotas", "-", "info", `Ação em massa: ${status === "active" ? "retomar" : "pausar"} todas`);
    return true;
  }, [qc, user]);

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
        .maybeSingle();
      if (!profileError) {
        const limits = resolveEffectiveLimitsByPlanId(profile?.plan_id || "plan-starter");
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
    }

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
    // Sync destinations: delete old, insert new
    const deleteDestinations = await backend
      .from("route_destinations")
      .delete()
      .eq("route_id", id);

    if (deleteDestinations.error) {
      toast.error(`Falha ao limpar destinos antigos da rota: ${deleteDestinations.error.message}`);
      return null;
    }

    if (route.destinationGroupIds.length > 0) {
      const insertDestinations = await backend
        .from("route_destinations")
        .insert(route.destinationGroupIds.map((gid) => ({ route_id: id, group_id: gid })));

      if (insertDestinations.error) {
        toast.error(`Falha ao salvar grupos de destino da rota: ${insertDestinations.error.message}`);
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
      name: `Copia de ${route.name}`,
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
