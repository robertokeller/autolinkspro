import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import { logHistorico } from "@/lib/log-historico";
import { toast } from "sonner";
import type { Tables } from "@/integrations/backend/types";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import {
  mergeAutomationKeywordFilters,
  normalizeKeywordList,
  readAutomationKeywordFilters,
} from "@/lib/automation-keywords";
import {
  isMeliAutomationConfig,
  mergeMeliAutomationConfig,
  readMeliAutomationConfig,
} from "@/lib/meli-automation-config";

export type MeliAutomationRow = Tables<"shopee_automations">;

export interface CreateMeliAutomationInput {
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

function filterMeliAutomations(rows: MeliAutomationRow[]): MeliAutomationRow[] {
  return rows.filter((row) => isMeliAutomationConfig(row.config));
}

export function useMeliAutomacoes() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();

  const { data: automations = [], isLoading } = useQuery<MeliAutomationRow[]>({
    queryKey: ["meli_automations", user?.id],
    queryFn: async () => {
      const { data, error } = await backend
        .from("shopee_automations")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return filterMeliAutomations((data ?? []) as MeliAutomationRow[]);
    },
    enabled: !!user,
  });

  const createMutation = useMutation({
    mutationFn: async (input: CreateMeliAutomationInput) => {
      if (!user) throw new Error("Not authenticated");

      if (!isAdmin) {
        const { data: profile, error: profileError } = await backend
          .from("profiles")
          .select("plan_id")
          .maybeSingle();
        if (profileError) throw profileError;

        const limits = resolveEffectiveLimitsByPlanId(profile?.plan_id || "plan-starter");
        const maxAutomations = limits?.automations ?? 0;
        if (maxAutomations !== -1 && automations.length >= maxAutomations) {
          throw new Error("Limite de automacoes Mercado Livre atingido para o seu nivel de acesso.");
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
      config = mergeMeliAutomationConfig(config, { vitrineTabs: input.vitrineTabs });

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
        session_id: input.sessionId || null,
        active_hours_start: input.activeHoursStart || "08:00",
        active_hours_end: input.activeHoursEnd || "20:00",
        config,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meli_automations"] });
      toast.success("Automacao criada!");
      if (user) logHistorico(user.id, "automation_run", "Mercado Livre", "", "success", "Automacao ML criada");
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Erro ao criar automacao"),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...input }: Partial<CreateMeliAutomationInput> & { id: string }) => {
      if (!user) throw new Error("Not authenticated");

      if (!isAdmin && input.destinationGroupIds !== undefined) {
        const { data: profile, error: profileError } = await backend
          .from("profiles")
          .select("plan_id")
          .maybeSingle();
        if (profileError) throw profileError;
        const limits = resolveEffectiveLimitsByPlanId(profile?.plan_id || "plan-starter");
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
      if (input.vitrineTabs !== undefined) {
        updates.categories = input.vitrineTabs;
      }
      if (input.destinationGroupIds !== undefined) updates.destination_group_ids = input.destinationGroupIds;
      if (input.masterGroupIds !== undefined) updates.master_group_ids = input.masterGroupIds;
      if (input.templateId !== undefined) updates.template_id = input.templateId || null;
      if (input.sessionId !== undefined) updates.session_id = input.sessionId || null;
      if (input.activeHoursStart !== undefined) updates.active_hours_start = input.activeHoursStart;
      if (input.activeHoursEnd !== undefined) updates.active_hours_end = input.activeHoursEnd;
      if (
        input.positiveKeywords !== undefined
        || input.negativeKeywords !== undefined
        || input.vitrineTabs !== undefined
      ) {
        const currentAutomation = automations.find((item) => item.id === id);
        const currentFilters = readAutomationKeywordFilters(currentAutomation?.config);
        const currentSource = readMeliAutomationConfig(currentAutomation?.config);
        const positiveKeywords = input.positiveKeywords !== undefined
          ? normalizeKeywordList(input.positiveKeywords)
          : currentFilters.positiveKeywords;
        const negativeKeywords = input.negativeKeywords !== undefined
          ? normalizeKeywordList(input.negativeKeywords)
          : currentFilters.negativeKeywords;
        const vitrineTabs = input.vitrineTabs !== undefined
          ? input.vitrineTabs
          : currentSource.vitrineTabs;
        let config = mergeAutomationKeywordFilters(currentAutomation?.config, { positiveKeywords, negativeKeywords });
        config = mergeMeliAutomationConfig(config, { vitrineTabs });
        updates.config = config;
      }

      const { error } = await backend
        .from("shopee_automations")
        .update(updates)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: async (_, variables) => {
      qc.invalidateQueries({ queryKey: ["meli_automations"] });
      toast.success("Automacao atualizada!");
      if (user) {
        await logHistorico(user.id, "automation_run", "Mercado Livre", variables.id, "info", "Automacao ML atualizada");
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
      if (error) throw error;
    },
    onSuccess: async (_, variables) => {
      qc.invalidateQueries({ queryKey: ["meli_automations"] });
      if (user) {
        const nextState = variables.isActive ? "pausada" : "retomada";
        await logHistorico(user.id, "automation_run", "Mercado Livre", variables.id, "info", `Automacao ML ${nextState}`);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await backend.from("shopee_automations").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: async (_, deletedId) => {
      qc.invalidateQueries({ queryKey: ["meli_automations"] });
      toast.success("Automacao excluida");
      if (user) {
        await logHistorico(user.id, "automation_run", "Mercado Livre", deletedId, "warning", "Automacao ML removida");
      }
    },
  });

  const duplicateAutomation = async (auto: MeliAutomationRow) => {
    if (!user) return;
    const filters = readAutomationKeywordFilters(auto.config);
    const sourceConfig = readMeliAutomationConfig(auto.config);
    await createMutation.mutateAsync({
      name: `Copia de ${auto.name}`,
      intervalMinutes: auto.interval_minutes,
      minPrice: Number(auto.min_price),
      maxPrice: Number(auto.max_price),
      vitrineTabs: sourceConfig.vitrineTabs,
      destinationGroupIds: (auto.destination_group_ids || []) as string[],
      masterGroupIds: (auto.master_group_ids as string[]) || [],
      templateId: auto.template_id || undefined,
      sessionId: auto.session_id || undefined,
      activeHoursStart: auto.active_hours_start,
      activeHoursEnd: auto.active_hours_end,
      positiveKeywords: filters.positiveKeywords,
      negativeKeywords: filters.negativeKeywords,
    });
  };

  const meliAutomationIds = automations.map((item) => item.id);

  const pauseAllMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");
      if (meliAutomationIds.length === 0) return;
      const { error } = await backend
        .from("shopee_automations")
        .update({ is_active: false })
        .in("id", meliAutomationIds)
        .eq("is_active", true);
      if (error) throw error;
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["meli_automations"] });
      toast.success("Todas as automacoes foram pausadas");
      if (user) {
        await logHistorico(user.id, "automation_run", "Mercado Livre", "-", "info", "Acao em massa: pausar automacoes ML");
      }
    },
    onError: () => toast.error("Erro ao pausar automacoes"),
  });

  const resumeAllMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");
      if (meliAutomationIds.length === 0) return;
      const { error } = await backend
        .from("shopee_automations")
        .update({ is_active: true })
        .in("id", meliAutomationIds)
        .eq("is_active", false);
      if (error) throw error;
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["meli_automations"] });
      toast.success("Todas as automacoes foram retomadas");
      if (user) {
        await logHistorico(user.id, "automation_run", "Mercado Livre", "-", "info", "Acao em massa: retomar automacoes ML");
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
      qc.invalidateQueries({ queryKey: ["meli_automations"] });
      if (!result?.refreshed) {
        toast.info("Nao ha automacoes ativas para atualizar");
        return;
      }
      toast.success("Automacoes atualizadas: pausadas e retomadas");
      if (user) {
        await logHistorico(user.id, "automation_run", "Mercado Livre", "-", "info", "Acao em massa: atualizar automacoes ML");
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
      qc.invalidateQueries({ queryKey: ["meli_automations"] });
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
