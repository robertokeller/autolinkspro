import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import { logHistorico } from "@/lib/log-historico";
import { toast } from "sonner";
import type { Tables } from "@/integrations/backend/types";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import { normalizePlanId, PLAN_SYNC_ERROR_MESSAGE } from "@/lib/plan-id";
import {
  mergeAutomationOfferSourceConfig,
  mergeAutomationKeywordFilters,
  normalizeKeywordList,
  readAutomationOfferSourceConfig,
  readAutomationKeywordFilters,
} from "@/lib/automation-keywords";
import { mergeAutomationSessionConfig, readAutomationSessionId } from "@/lib/automation-session";
import { mergeAutomationShopeeSubIdConfig, readAutomationShopeeSubId } from "@/lib/automation-shopee-subid";

export type ShopeeAutomationRow = Tables<"shopee_automations">;

type AutomationSnapshotRow = Pick<ShopeeAutomationRow, "id" | "destination_group_ids" | "master_group_ids" | "config">;

function countAutomationDestinationSlots(row: Pick<ShopeeAutomationRow, "destination_group_ids" | "master_group_ids">): number {
  return ((row.destination_group_ids as unknown[]) || []).length + ((row.master_group_ids as unknown[]) || []).length;
}

export interface CreateAutomationInput {
  name: string;
  intervalMinutes: number;
  minDiscount: number;
  minCommission: number;
  minPrice: number;
  maxPrice: number;
  categories?: string[];
  destinationGroupIds?: string[];
  masterGroupIds?: string[];
  templateId?: string;
  sessionId?: string;
  activeHoursStart?: string;
  activeHoursEnd?: string;
  positiveKeywords?: string[];
  negativeKeywords?: string[];
  offerSourceMode?: "search" | "vitrine";
  vitrineTabs?: string[];
  shopeeSubId?: string;
}

function isShopeeAutomationRow(row: ShopeeAutomationRow): boolean {
  const config = row.config && typeof row.config === "object" && !Array.isArray(row.config)
    ? row.config as Record<string, unknown>
    : null;
  const marketplace = String(config?.marketplace || "").trim().toLowerCase();
  return marketplace !== "meli" && marketplace !== "amazon";
}

type BackendErrorLike = { message?: unknown } | null | undefined;

function extractBackendErrorMessage(error: BackendErrorLike, fallback: string): string {
  const raw = typeof error?.message === "string" ? error.message.trim() : "";
  return raw || fallback;
}

function throwIfBackendError(error: BackendErrorLike, fallback: string): void {
  if (!error) return;
  throw new Error(extractBackendErrorMessage(error, fallback));
}

export function useShopeeAutomacoes() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();

  const loadAutomationSnapshots = async (): Promise<{
    allAutomations: AutomationSnapshotRow[];
    shopeeAutomations: AutomationSnapshotRow[];
  }> => {
    const { data, error } = await backend
      .from("shopee_automations")
      .select("id, destination_group_ids, master_group_ids, config");
      throwIfBackendError(error, "Falha ao validar limites de automações");

    const rows = ((data ?? []) as AutomationSnapshotRow[])
      .filter((row) => !!String(row.id || "").trim());

    return {
      allAutomations: rows,
      shopeeAutomations: rows.filter((row) => isShopeeAutomationRow(row as ShopeeAutomationRow)),
    };
  };

  const automationQuery = useQuery<ShopeeAutomationRow[]>({
    queryKey: ["shopee_automations", user?.id],
    queryFn: async () => {
      const { data, error } = await backend
        .from("shopee_automations")
        .select("*")
        .order("created_at", { ascending: false });
        throwIfBackendError(error, "Falha ao listar automações Shopee");
      const rows = (data ?? []) as ShopeeAutomationRow[];
      return rows.filter((row) => isShopeeAutomationRow(row));
    },
    enabled: !!user,
  });
  const automations: ShopeeAutomationRow[] = automationQuery.data ?? [];
  const { isLoading } = automationQuery;

  const createMutation = useMutation({
    mutationFn: async (input: CreateAutomationInput) => {
      if (!user) throw new Error("Not authenticated");

      if (!isAdmin) {
        const { data: profile, error: profileError } = await backend
          .from("profiles")
          .select("plan_id")
          .eq("user_id", user.id)
          .maybeSingle();
        if (profileError) throw profileError;

        const planId = normalizePlanId(profile?.plan_id);
        if (!planId) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const limits = resolveEffectiveLimitsByPlanId(planId);
        if (!limits) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const { allAutomations, shopeeAutomations } = await loadAutomationSnapshots();

        const maxAutomations = limits?.automations ?? 0;
        if (maxAutomations !== -1 && shopeeAutomations.length >= maxAutomations) {
          throw new Error("Limite de automações Shopee atingido para o seu nível de acesso.");
        }

        const maxGroupSlots = limits?.groupsPerAutomation ?? 0;
        if (maxGroupSlots !== -1) {
          const slotsUsed = allAutomations.reduce(
            (sum, a) => sum + countAutomationDestinationSlots(a),
            0,
          );
          const slotsNew = (input.destinationGroupIds || []).length + (input.masterGroupIds || []).length;
          if (slotsUsed + slotsNew > maxGroupSlots) {
            throw new Error(
              `Limite de grupos atingido. Seu plano permite ${maxGroupSlots} grupo(s) no total entre todas as automações. Você já usa ${slotsUsed} e tentou adicionar mais ${slotsNew}.`,
            );
          }
        }
      }

      const positiveKeywords = normalizeKeywordList(input.positiveKeywords || []);
      const negativeKeywords = normalizeKeywordList(input.negativeKeywords || []);
      let config = mergeAutomationKeywordFilters({}, { positiveKeywords, negativeKeywords });
      config = mergeAutomationOfferSourceConfig(config, {
        offerSourceMode: input.offerSourceMode,
        vitrineTabs: input.vitrineTabs,
      });
      config = mergeAutomationSessionConfig(config, input.sessionId);
      config = mergeAutomationShopeeSubIdConfig(config, input.shopeeSubId);
      const { error } = await backend.from("shopee_automations").insert({
        name: input.name,
        interval_minutes: input.intervalMinutes,
        min_discount: input.minDiscount,
        min_commission: input.minCommission,
        min_price: input.minPrice,
        max_price: input.maxPrice,
        categories: input.categories || [],
        destination_group_ids: input.destinationGroupIds || [],
        master_group_ids: input.masterGroupIds || [],
        template_id: input.templateId || null,
        session_id: null,
        active_hours_start: input.activeHoursStart || "08:00",
        active_hours_end: input.activeHoursEnd || "20:00",
        config,
      });
      throwIfBackendError(error, "Falha ao criar automação Shopee");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
      toast.success("Automação criada!");
      if (user) logHistorico(user.id, "automation_run", "Shopee", "", "success", "Automação Shopee criada");
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Erro ao criar automação"),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...input }: Partial<CreateAutomationInput> & { id: string }) => {
      if (!user) throw new Error("Not authenticated");
      const currentAutomation = automations.find((item) => item.id === id);

      if (!isAdmin && (input.destinationGroupIds !== undefined || input.masterGroupIds !== undefined)) {
        const { data: profile, error: profileError } = await backend
          .from("profiles")
          .select("plan_id")
          .eq("user_id", user.id)
          .maybeSingle();
        if (profileError) throw profileError;

        const planId = normalizePlanId(profile?.plan_id);
        if (!planId) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const limits = resolveEffectiveLimitsByPlanId(planId);
        if (!limits) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const { allAutomations } = await loadAutomationSnapshots();

        const maxGroupSlots = limits?.groupsPerAutomation ?? 0;
        if (maxGroupSlots !== -1) {
          const slotsUsedByOthers = allAutomations
            .filter((a) => a.id !== id)
            .reduce((sum, a) => sum + countAutomationDestinationSlots(a), 0);
          const nextSlots = (input.destinationGroupIds ?? ((currentAutomation?.destination_group_ids as string[]) || [])).length
            + (input.masterGroupIds ?? ((currentAutomation?.master_group_ids as string[]) || [])).length;
          if (slotsUsedByOthers + nextSlots > maxGroupSlots) {
            throw new Error(
              `Limite de grupos atingido. Seu plano permite ${maxGroupSlots} grupo(s) no total entre todas as automações. As outras automações já usam ${slotsUsedByOthers}.`,
            );
          }
        }
      }

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.intervalMinutes !== undefined) updates.interval_minutes = input.intervalMinutes;
      if (input.minDiscount !== undefined) updates.min_discount = input.minDiscount;
      if (input.minCommission !== undefined) updates.min_commission = input.minCommission;
      if (input.minPrice !== undefined) updates.min_price = input.minPrice;
      if (input.maxPrice !== undefined) updates.max_price = input.maxPrice;
      if (input.categories !== undefined) updates.categories = input.categories;
      if (input.destinationGroupIds !== undefined) updates.destination_group_ids = input.destinationGroupIds;
      if (input.masterGroupIds !== undefined) updates.master_group_ids = input.masterGroupIds;
      if (input.templateId !== undefined) updates.template_id = input.templateId || null;
      if (input.sessionId !== undefined) updates.session_id = null;
      if (input.activeHoursStart !== undefined) updates.active_hours_start = input.activeHoursStart;
      if (input.activeHoursEnd !== undefined) updates.active_hours_end = input.activeHoursEnd;
      if (
        input.sessionId !== undefined
        || input.positiveKeywords !== undefined
        || input.negativeKeywords !== undefined
        || input.offerSourceMode !== undefined
        || input.vitrineTabs !== undefined
        || input.shopeeSubId !== undefined
      ) {
        const currentFilters = readAutomationKeywordFilters(currentAutomation?.config);
        const currentSource = readAutomationOfferSourceConfig(currentAutomation?.config);
        const currentShopeeSubId = readAutomationShopeeSubId(currentAutomation?.config);
        const positiveKeywords = input.positiveKeywords !== undefined
          ? normalizeKeywordList(input.positiveKeywords)
          : currentFilters.positiveKeywords;
        const negativeKeywords = input.negativeKeywords !== undefined
          ? normalizeKeywordList(input.negativeKeywords)
          : currentFilters.negativeKeywords;
        const offerSourceMode = input.offerSourceMode !== undefined
          ? input.offerSourceMode
          : currentSource.offerSourceMode;
        const vitrineTabs = input.vitrineTabs !== undefined
          ? input.vitrineTabs
          : currentSource.vitrineTabs;
        const shopeeSubId = input.shopeeSubId !== undefined
          ? input.shopeeSubId
          : currentShopeeSubId;
        const effectiveSessionId = input.sessionId !== undefined
          ? input.sessionId
          : readAutomationSessionId(currentAutomation?.config, currentAutomation?.session_id);
        let config = mergeAutomationKeywordFilters(currentAutomation?.config, { positiveKeywords, negativeKeywords });
        config = mergeAutomationOfferSourceConfig(config, { offerSourceMode, vitrineTabs });
        config = mergeAutomationSessionConfig(config, effectiveSessionId);
        config = mergeAutomationShopeeSubIdConfig(config, shopeeSubId);
        updates.config = config;
      }

      const { error } = await backend
        .from("shopee_automations")
        .update(updates)
        .eq("id", id);
      throwIfBackendError(error, "Falha ao atualizar automação Shopee");
    },
    onSuccess: async (_, variables) => {
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
      toast.success("Automação atualizada!");
      if (user) {
        await logHistorico(user.id, "automation_run", "Shopee", variables.id, "info", "Automação Shopee atualizada");
      }
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Erro ao atualizar automação"),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await backend
        .from("shopee_automations")
        .update({ is_active: !isActive })
        .eq("id", id);
      throwIfBackendError(error, "Falha ao alterar status da automação Shopee");
    },
    onSuccess: async (_, variables) => {
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
      if (user) {
        const nextState = variables.isActive ? "pausada" : "retomada";
        await logHistorico(user.id, "automation_run", "Shopee", variables.id, "info", `Automação Shopee ${nextState}`);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await backend.from("shopee_automations").delete().eq("id", id);
      throwIfBackendError(error, "Falha ao excluir automação Shopee");
    },
    onSuccess: async (_, deletedId) => {
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
      toast.success("Automação excluída");
      if (user) {
        await logHistorico(user.id, "automation_run", "Shopee", deletedId, "warning", "Automação Shopee removida");
      }
    },
  });

  const duplicateAutomation = async (auto: ShopeeAutomationRow) => {
    if (!user) return;
    const filters = readAutomationKeywordFilters(auto.config);
    const sourceConfig = readAutomationOfferSourceConfig(auto.config);
    await createMutation.mutateAsync({
      name: `Cópia de ${auto.name}`,
      intervalMinutes: auto.interval_minutes,
      minDiscount: auto.min_discount,
      minCommission: auto.min_commission,
      minPrice: Number(auto.min_price),
      maxPrice: Number(auto.max_price),
      categories: (auto.categories || []) as string[],
      destinationGroupIds: (auto.destination_group_ids || []) as string[],
      masterGroupIds: (auto.master_group_ids as string[]) || [],
      templateId: auto.template_id || undefined,
      sessionId: readAutomationSessionId(auto.config, auto.session_id) || undefined,
      activeHoursStart: auto.active_hours_start,
      activeHoursEnd: auto.active_hours_end,
      positiveKeywords: filters.positiveKeywords,
      negativeKeywords: filters.negativeKeywords,
      offerSourceMode: sourceConfig.offerSourceMode,
      vitrineTabs: sourceConfig.vitrineTabs,
      shopeeSubId: readAutomationShopeeSubId(auto.config) || undefined,
    });
  };

  const automationIds = automations.map((item) => item.id);

  const pauseAllMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");
      if (automationIds.length === 0) return;
      const { error } = await backend
        .from("shopee_automations")
        .update({ is_active: false })
        .in("id", automationIds)
        .eq("is_active", true);
      if (error) throw error;
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
      toast.success("Todas as automações foram pausadas");
      if (user) {
        await logHistorico(user.id, "automation_run", "Shopee", "-", "info", "Ação em massa: pausar todas automações Shopee");
      }
    },
    onError: () => toast.error("Erro ao pausar automações"),
  });

  const resumeAllMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");
      if (automationIds.length === 0) return;
      const { error } = await backend
        .from("shopee_automations")
        .update({ is_active: true })
        .in("id", automationIds)
        .eq("is_active", false);
      if (error) throw error;
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
      toast.success("Todas as automações foram retomadas");
      if (user) {
        await logHistorico(user.id, "automation_run", "Shopee", "-", "info", "Ação em massa: retomar todas automações Shopee");
      }
    },
    onError: () => toast.error("Erro ao retomar automações"),
  });

  const refreshAllMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");
      if (automations.length === 0) return { refreshed: false };

      // Refresh only currently active automations so paused ones stay paused.
      const activeAutomationIds = automations
        .filter((automation) => automation.is_active)
        .map((automation) => automation.id);

      if (activeAutomationIds.length === 0) return { refreshed: false };

      const pauseResult = await backend
        .from("shopee_automations")
        .update({ is_active: false })
        .in("id", activeAutomationIds);

      if (pauseResult.error) {
        throw new Error(extractBackendErrorMessage(pauseResult.error, "pause_failed"));
      }

      const resumeResult = await backend
        .from("shopee_automations")
        .update({ is_active: true })
        .in("id", activeAutomationIds);

      if (resumeResult.error) {
        throw new Error(extractBackendErrorMessage(resumeResult.error, "resume_failed"));
      }

      return { refreshed: true };
    },
    onSuccess: async (result) => {
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
      if (!result?.refreshed) {
        toast.info("Não há automações ativas para atualizar");
        return;
      }
      toast.success("Automações atualizadas: pausadas e retomadas");
      if (user) {
        await logHistorico(user.id, "automation_run", "Shopee", "-", "info", "Ação em massa: atualizar automações (pausar e retomar)");
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "unknown_error";
      if (message === "pause_failed") {
        toast.error("Não foi possível pausar todas as automações");
      } else if (message === "resume_failed") {
        toast.error("As automações foram pausadas, mas não foi possível retomar todas");
      } else {
        toast.error("Erro ao atualizar automações");
      }
      qc.invalidateQueries({ queryKey: ["shopee_automations"] });
    },
  });

  return {
    automations,
    isLoading,
    createAutomation: createMutation.mutateAsync,
    updateAutomation: updateMutation.mutateAsync,
    toggleAutomation: (id: string, isActive: boolean) => toggleMutation.mutateAsync({ id, isActive }),
    deleteAutomation: deleteMutation.mutateAsync,
    duplicateAutomation,
    pauseAllAutomations: pauseAllMutation.mutateAsync,
    resumeAllAutomations: resumeAllMutation.mutateAsync,
    refreshAllAutomations: refreshAllMutation.mutateAsync,
    isTogglingAutomation: toggleMutation.isPending,
    isPausingAll: pauseAllMutation.isPending,
    isResumingAll: resumeAllMutation.isPending,
    isRefreshingAll: refreshAllMutation.isPending,
  };
}
