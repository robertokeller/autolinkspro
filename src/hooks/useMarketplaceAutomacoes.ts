import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import { logHistorico } from "@/lib/log-historico";
import { toast } from "sonner";
import type { Tables } from "@/integrations/backend/types";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import { normalizePlanId, PLAN_SYNC_ERROR_MESSAGE } from "@/lib/plan-id";
import {
  mergeAutomationKeywordFilters,
  normalizeKeywordList,
  readAutomationKeywordFilters,
} from "@/lib/automation-keywords";
import {
  isMarketplaceAutomationConfig,
  mergeMarketplaceAutomationConfig,
  readMarketplaceAutomationConfig,
  type MarketplaceAutomationKind,
} from "@/lib/marketplace-automation-config";
import { mergeAutomationSessionConfig, readAutomationSessionId } from "@/lib/automation-session";

export type MarketplaceAutomationRow = Tables<"shopee_automations">;

export interface CreateMarketplaceAutomationInput {
  name: string;
  intervalMinutes: number;
  minPrice: number;
  maxPrice: number;
  vitrineTabs: string[];
  destinationGroupIds?: string[];
  masterGroupIds?: string[];
  templateId?: string;
  sessionId?: string;
  activeHoursStart?: string;
  activeHoursEnd?: string;
  positiveKeywords?: string[];
  negativeKeywords?: string[];
}

type BackendErrorLike = { message?: unknown } | null | undefined;

function extractBackendErrorMessage(error: BackendErrorLike, fallback: string): string {
  const raw = typeof error?.message === "string" ? error.message.trim() : "";
  if (!raw) return fallback;
  if (/^n[aã]o autenticado$/i.test(raw) || /^not authenticated$/i.test(raw)) {
    return "Sessao expirada. Faca login novamente.";
  }
  if (/origem da requisi[cç][aã]o n[aã]o autorizada/i.test(raw)) {
    return "Origem da requisicao nao autorizada. Abra app e API no mesmo host (localhost ou 127.0.0.1).";
  }
  return raw;
}

function throwIfBackendError(error: BackendErrorLike, fallback: string): void {
  if (!error) return;
  throw new Error(extractBackendErrorMessage(error, fallback));
}

function filterMarketplaceAutomations(
  rows: MarketplaceAutomationRow[],
  marketplace: MarketplaceAutomationKind,
): MarketplaceAutomationRow[] {
  return rows.filter((row) => {
    if (!row || !isMarketplaceAutomationConfig(row.config, marketplace)) return false;
    const config = row.config && typeof row.config === "object" && !Array.isArray(row.config)
      ? row.config as Record<string, unknown>
      : null;
    const tag = String(config?.marketplace || "").trim().toLowerCase();
    return tag === marketplace;
  });
}

function getMarketplaceLabel(marketplace: MarketplaceAutomationKind): string {
  return marketplace === "amazon" ? "Amazon" : "Mercado Livre";
}

function getMarketplaceShortLabel(marketplace: MarketplaceAutomationKind): string {
  return marketplace === "amazon" ? "Amazon" : "ML";
}

export function useMarketplaceAutomacoes(marketplace: MarketplaceAutomationKind) {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const marketplaceLabel = getMarketplaceLabel(marketplace);
  const marketplaceShortLabel = getMarketplaceShortLabel(marketplace);
  const queryKey = ["marketplace_automations", marketplace, user?.id] as const;

  const { data: automations = [], isLoading } = useQuery<MarketplaceAutomationRow[]>({
    queryKey,
    queryFn: async () => {
      const { data, error } = await backend
        .from("shopee_automations")
        .select("*")
        .order("created_at", { ascending: false });
      throwIfBackendError(error, "Falha ao listar automacoes");
      return filterMarketplaceAutomations((data ?? []) as MarketplaceAutomationRow[], marketplace);
    },
    enabled: !!user,
  });

  const createMutation = useMutation({
    mutationFn: async (input: CreateMarketplaceAutomationInput) => {
      if (!user) throw new Error("Not authenticated");

      if (!isAdmin) {
        const { data: profile, error: profileError } = await backend
          .from("profiles")
          .select("plan_id")
          .eq("user_id", user.id)
          .maybeSingle();
        throwIfBackendError(profileError, "Falha ao validar plano do usuario");

        const planId = normalizePlanId(profile?.plan_id);
        if (!planId) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const limits = resolveEffectiveLimitsByPlanId(planId);
        if (!limits) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const maxAutomations = limits?.automations ?? 0;
        if (maxAutomations !== -1 && automations.length >= maxAutomations) {
          throw new Error(`Limite de automacoes ${marketplaceLabel} atingido para o seu nivel de acesso.`);
        }

        const maxGroupSlots = limits?.groupsPerAutomation ?? 0;
        if (maxGroupSlots !== -1) {
          const slotsUsed = automations.reduce(
            (sum, item) => sum + ((item.destination_group_ids as unknown[]) || []).length,
            0,
          );
          const slotsNew = (input.destinationGroupIds || []).length;
          if (slotsUsed + slotsNew > maxGroupSlots) {
            throw new Error(
              `Limite de grupos atingido. Seu plano permite ${maxGroupSlots} grupo(s) no total entre todas as automacoes. Voce ja usa ${slotsUsed} e tentou adicionar mais ${slotsNew}.`,
            );
          }
        }
      }

      const positiveKeywords = normalizeKeywordList(input.positiveKeywords || []);
      const negativeKeywords = normalizeKeywordList(input.negativeKeywords || []);
      let config = mergeAutomationKeywordFilters({}, { positiveKeywords, negativeKeywords });
      config = mergeMarketplaceAutomationConfig(config, {
        marketplace,
        vitrineTabs: input.vitrineTabs,
      });
      config = mergeAutomationSessionConfig(config, input.sessionId);

      const { error } = await backend.from("shopee_automations").insert({
        name: input.name,
        interval_minutes: input.intervalMinutes,
        min_discount: 0,
        min_commission: 0,
        min_price: input.minPrice,
        max_price: input.maxPrice,
        categories: input.vitrineTabs,
        destination_group_ids: input.destinationGroupIds || [],
        master_group_ids: input.masterGroupIds || [],
        template_id: input.templateId || null,
        session_id: null,
        active_hours_start: input.activeHoursStart || "08:00",
        active_hours_end: input.activeHoursEnd || "20:00",
        config,
      });
      throwIfBackendError(error, "Falha ao criar automacao");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
      toast.success("Automacao criada!");
      if (user) logHistorico(user.id, "automation_run", marketplaceLabel, "", "success", `Automacao ${marketplaceShortLabel} criada`);
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Erro ao criar automacao"),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...input }: Partial<CreateMarketplaceAutomationInput> & { id: string }) => {
      if (!user) throw new Error("Not authenticated");
      const currentAutomation = automations.find((item) => item.id === id);

      if (!isAdmin && input.destinationGroupIds !== undefined) {
        const { data: profile, error: profileError } = await backend
          .from("profiles")
          .select("plan_id")
          .eq("user_id", user.id)
          .maybeSingle();
        throwIfBackendError(profileError, "Falha ao validar plano do usuario");

        const planId = normalizePlanId(profile?.plan_id);
        if (!planId) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const limits = resolveEffectiveLimitsByPlanId(planId);
        if (!limits) throw new Error(PLAN_SYNC_ERROR_MESSAGE);

        const maxGroupSlots = limits?.groupsPerAutomation ?? 0;
        if (maxGroupSlots !== -1) {
          const slotsUsedByOthers = automations
            .filter((item) => item.id !== id)
            .reduce((sum, item) => sum + ((item.destination_group_ids as unknown[]) || []).length, 0);
          if (slotsUsedByOthers + input.destinationGroupIds.length > maxGroupSlots) {
            throw new Error(
              `Limite de grupos atingido. Seu plano permite ${maxGroupSlots} grupo(s) no total entre todas as automacoes. As outras automacoes ja usam ${slotsUsedByOthers}.`,
            );
          }
        }
      }

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.intervalMinutes !== undefined) updates.interval_minutes = input.intervalMinutes;
      if (input.minPrice !== undefined) updates.min_price = input.minPrice;
      if (input.maxPrice !== undefined) updates.max_price = input.maxPrice;
      if (input.vitrineTabs !== undefined) updates.categories = input.vitrineTabs;
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
        || input.vitrineTabs !== undefined
      ) {
        const currentFilters = readAutomationKeywordFilters(currentAutomation?.config);
        const currentSource = readMarketplaceAutomationConfig(currentAutomation?.config, marketplace);
        const positiveKeywords = input.positiveKeywords !== undefined
          ? normalizeKeywordList(input.positiveKeywords)
          : currentFilters.positiveKeywords;
        const negativeKeywords = input.negativeKeywords !== undefined
          ? normalizeKeywordList(input.negativeKeywords)
          : currentFilters.negativeKeywords;
        const vitrineTabs = input.vitrineTabs !== undefined
          ? input.vitrineTabs
          : currentSource.vitrineTabs;
        const effectiveSessionId = input.sessionId !== undefined
          ? input.sessionId
          : readAutomationSessionId(currentAutomation?.config, currentAutomation?.session_id);
        let config = mergeAutomationKeywordFilters(currentAutomation?.config, { positiveKeywords, negativeKeywords });
        config = mergeMarketplaceAutomationConfig(config, { marketplace, vitrineTabs });
        config = mergeAutomationSessionConfig(config, effectiveSessionId);
        updates.config = config;
      }

      const { error } = await backend
        .from("shopee_automations")
        .update(updates)
        .eq("id", id);
      throwIfBackendError(error, "Falha ao atualizar automacao");
    },
    onSuccess: async (_, variables) => {
      qc.invalidateQueries({ queryKey });
      toast.success("Automacao atualizada!");
      if (user) {
        await logHistorico(user.id, "automation_run", marketplaceLabel, variables.id, "info", `Automacao ${marketplaceShortLabel} atualizada`);
      }
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Erro ao atualizar automacao"),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await backend
        .from("shopee_automations")
        .update({ is_active: !isActive })
        .eq("id", id);
      throwIfBackendError(error, "Falha ao alterar status da automacao");
    },
    onSuccess: async (_, variables) => {
      qc.invalidateQueries({ queryKey });
      if (user) {
        const nextState = variables.isActive ? "pausada" : "retomada";
        await logHistorico(user.id, "automation_run", marketplaceLabel, variables.id, "info", `Automacao ${marketplaceShortLabel} ${nextState}`);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await backend.from("shopee_automations").delete().eq("id", id);
      throwIfBackendError(error, "Falha ao excluir automacao");
    },
    onSuccess: async (_, deletedId) => {
      qc.invalidateQueries({ queryKey });
      toast.success("Automacao excluida");
      if (user) {
        await logHistorico(user.id, "automation_run", marketplaceLabel, deletedId, "warning", `Automacao ${marketplaceShortLabel} removida`);
      }
    },
  });

  const duplicateAutomation = async (automation: MarketplaceAutomationRow) => {
    if (!user) return;
    const filters = readAutomationKeywordFilters(automation.config);
    const sourceConfig = readMarketplaceAutomationConfig(automation.config, marketplace);
    await createMutation.mutateAsync({
      name: `Cópia de ${automation.name}`,
      intervalMinutes: automation.interval_minutes,
      minPrice: Number(automation.min_price),
      maxPrice: Number(automation.max_price),
      vitrineTabs: sourceConfig.vitrineTabs,
      destinationGroupIds: (automation.destination_group_ids || []) as string[],
      masterGroupIds: (automation.master_group_ids || []) as string[],
      templateId: automation.template_id || undefined,
      sessionId: readAutomationSessionId(automation.config, automation.session_id) || undefined,
      activeHoursStart: automation.active_hours_start,
      activeHoursEnd: automation.active_hours_end,
      positiveKeywords: filters.positiveKeywords,
      negativeKeywords: filters.negativeKeywords,
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
      throwIfBackendError(error, "Falha ao pausar automacoes");
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey });
      toast.success("Todas as automacoes foram pausadas");
      if (user) {
        await logHistorico(user.id, "automation_run", marketplaceLabel, "-", "info", `Acao em massa: pausar automacoes ${marketplaceShortLabel}`);
      }
    },
    onError: () => toast.error("Erro ao pausar automacoes"),
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
      throwIfBackendError(error, "Falha ao retomar automacoes");
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey });
      toast.success("Todas as automacoes foram retomadas");
      if (user) {
        await logHistorico(user.id, "automation_run", marketplaceLabel, "-", "info", `Acao em massa: retomar automacoes ${marketplaceShortLabel}`);
      }
    },
    onError: () => toast.error("Erro ao retomar automacoes"),
  });

  const refreshAllMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");
      if (automations.length === 0) return { refreshed: false };

      const activeAutomationIds = automations
        .filter((automation) => automation.is_active)
        .map((automation) => automation.id);

      if (activeAutomationIds.length === 0) return { refreshed: false };

      const pauseResult = await backend
        .from("shopee_automations")
        .update({ is_active: false })
        .in("id", activeAutomationIds);
      if (pauseResult.error) throw new Error("pause_failed");

      const resumeResult = await backend
        .from("shopee_automations")
        .update({ is_active: true })
        .in("id", activeAutomationIds);
      if (resumeResult.error) throw new Error("resume_failed");

      return { refreshed: true };
    },
    onSuccess: async (result) => {
      qc.invalidateQueries({ queryKey });
      if (!result?.refreshed) {
        toast.info("Nao ha automacoes ativas para atualizar");
        return;
      }
      toast.success("Automacoes atualizadas: pausadas e retomadas");
      if (user) {
        await logHistorico(user.id, "automation_run", marketplaceLabel, "-", "info", `Acao em massa: atualizar automacoes ${marketplaceShortLabel}`);
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "unknown_error";
      if (message === "pause_failed") {
        toast.error("Nao foi possivel pausar todas as automacoes");
      } else if (message === "resume_failed") {
        toast.error("As automacoes foram pausadas, mas nao foi possivel retomar todas");
      } else {
        toast.error("Erro ao atualizar automacoes");
      }
      qc.invalidateQueries({ queryKey });
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
