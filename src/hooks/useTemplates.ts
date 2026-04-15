import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/backend/types";
import type { Template, TemplateCategory, TemplateScope } from "@/lib/types";
import { toast } from "sonner";
import { useCallback, useMemo } from "react";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import { normalizePlanId, PLAN_SYNC_ERROR_MESSAGE } from "@/lib/plan-id";

const TEMPLATE_SCOPE_TAG_PREFIX = "scope:";

function normalizeTemplateCategory(value: unknown): TemplateCategory {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "oferta" || normalized === "cupom" || normalized === "geral") {
    return normalized;
  }
  if (normalized === "general") {
    return "geral";
  }
  return "oferta";
}

function normalizeTemplateScope(value: unknown): TemplateScope {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "meli") return "meli";
  if (normalized === "amazon") return "amazon";
  return "shopee";
}

function isScopeConstraintViolation(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message || "").toLowerCase();
  if (!message) return false;
  return message.includes("templates_scope_check")
    || (message.includes("scope") && message.includes("check"));
}

function scopeTag(scope: TemplateScope): string {
  return `${TEMPLATE_SCOPE_TAG_PREFIX}${scope}`;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function extractScopeFromRow(row: Tables<"templates">): TemplateScope {
  const source = row as unknown as Record<string, unknown>;
  const tags = normalizeTags(source.tags);
  if (tags.some((tag) => tag.toLowerCase() === scopeTag("amazon"))) {
    return "amazon";
  }
  const explicitScope = String(source.scope || "").trim();
  if (explicitScope) {
    return normalizeTemplateScope(explicitScope);
  }
  return tags.some((tag) => tag.toLowerCase() === scopeTag("meli"))
    ? "meli"
    : "shopee";
}

function ensureScopeTag(existingTags: unknown, scope: TemplateScope): string[] {
  const tags = normalizeTags(existingTags);
  const marker = scopeTag(scope);
  if (tags.some((tag) => tag.toLowerCase() === marker)) {
    return tags;
  }
  return [...tags, marker];
}

function mapRow(row: Tables<"templates">): Template {
  const source = row as unknown as Record<string, unknown>;
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    category: normalizeTemplateCategory(row.category),
    scope: extractScopeFromRow(row),
    tags: normalizeTags(source.tags),
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

export function useTemplates(scope: TemplateScope = "shopee") {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const templatesQueryKey = useMemo(
    () => ["templates", user?.id, scope] as const,
    [scope, user?.id],
  );

  const updateTemplatesCache = useCallback((updater: (prev: Template[]) => Template[]) => {
    qc.setQueryData<Template[]>(templatesQueryKey, (prev) => updater(prev || []));
  }, [qc, templatesQueryKey]);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: templatesQueryKey,
    queryFn: async () => {
      const { data, error } = await backend
        .from("templates")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = Array.isArray(data) ? (data as Tables<"templates">[]) : [];
      return rows
        .map(mapRow)
        .filter((item) => item.scope === scope);
    },
    enabled: !!user,
  });

  const defaultTemplate = useMemo(
    () => templates.find((item) => item.isDefault) || null,
    [templates],
  );

  const createTemplate = useCallback(async (name: string, content: string, category: TemplateCategory) => {
    if (!user) {
      toast.error("Usuário não autenticado");
      return null;
    }
    if (!name || !content) {
      toast.error("Preencha nome e conteúdo");
      return null;
    }

    if (!isAdmin) {
      const { data: profile, error: profileError } = await backend
        .from("profiles")
        .select("plan_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (profileError) {
        toast.error(profileError.message || "Falha ao validar plano do usuário");
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

      const maxTemplates = limits.templates ?? 0;
        if (maxTemplates !== -1 && templates.length >= maxTemplates) {
        const scopeLabel = scope === "amazon" ? "Amazon" : scope === "meli" ? "Mercado Livre" : "Shopee";
        toast.error(`Limite de templates ${scopeLabel} atingido para o seu nível de acesso.`);
        return null;
      }
    }

    const payload: Record<string, unknown> = {
      name,
      content,
      category: normalizeTemplateCategory(category),
      tags: ensureScopeTag([], scope),
      scope,
    };

    let { data, error } = await backend
      .from("templates")
      .insert(payload)
      .select()
      .single();

    // Backward compatibility for environments where DB constraint still rejects scope='amazon'.
    if (error && scope !== "shopee" && isScopeConstraintViolation(error)) {
      ({ data, error } = await backend
        .from("templates")
        .insert({
          ...payload,
          scope: "shopee",
        })
        .select()
        .single());
    }

    if (error) {
      toast.error(error.message || "Erro ao criar template");
      return null;
    }

    const next = mapRow(data as Tables<"templates">);
    
    // Update cache with the newly created template
    updateTemplatesCache((prev) => [next, ...prev]);
    
    // Force refetch to ensure consistency with server data
    // Use setTimeout to let the optimistic update render first
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: templatesQueryKey });
    }, 0);

    toast.success("Template criado!");
    return next;
  }, [isAdmin, qc, scope, templates.length, templatesQueryKey, updateTemplatesCache, user]);

  const updateTemplate = useCallback(async (
    id: string,
    updates: Partial<Pick<Template, "name" | "content" | "category">>,
  ): Promise<boolean> => {
    if (!user) {
      toast.error("Usuário não autenticado");
      return false;
    }

    const current = templates.find((item) => item.id === id);
    const sanitizedUpdates: Record<string, unknown> = {
      ...updates,
      ...(updates.category ? { category: normalizeTemplateCategory(updates.category) } : {}),
      tags: ensureScopeTag(current?.tags, scope),
      scope,
    };

    const previousTemplates = templates;
    updateTemplatesCache((prev) => prev.map((item) => (
      item.id === id
        ? {
          ...item,
          ...sanitizedUpdates,
          scope,
          tags: ensureScopeTag(item.tags, scope),
        }
        : item
    )));

    let { error } = await backend
      .from("templates")
      .update(sanitizedUpdates)
      .eq("id", id);

    if (error && scope !== "shopee" && isScopeConstraintViolation(error)) {
      ({ error } = await backend
        .from("templates")
        .update({
          ...sanitizedUpdates,
          scope: "shopee",
        })
        .eq("id", id));
    }

    if (error) {
      updateTemplatesCache(() => previousTemplates);
      toast.error(error.message || "Erro ao atualizar template");
      return false;
    }

    // Force refetch to ensure consistency with server data
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: templatesQueryKey });
    }, 0);

    toast.success("Template atualizado");
    return true;
  }, [qc, scope, templates, templatesQueryKey, updateTemplatesCache, user]);

  const deleteTemplate = useCallback(async (id: string) => {
    if (!user) {
      toast.error("Usuário não autenticado");
      return;
    }

    const previousTemplates = templates;
    updateTemplatesCache((prev) => prev.filter((item) => item.id !== id));

    const { error } = await backend
      .from("templates")
      .delete()
      .eq("id", id);

    if (error) {
      updateTemplatesCache(() => previousTemplates);
      toast.error(error.message || "Erro ao remover template");
      return;
    }

    // Force refetch to ensure consistency with server data
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: templatesQueryKey });
    }, 0);

    toast.success("Template removido");
  }, [qc, templates, templatesQueryKey, updateTemplatesCache, user]);

  const setDefaultTemplate = useCallback(async (id: string) => {
    if (!user) return;

    const scopeTemplateIds = templates.map((template) => template.id);
    if (scopeTemplateIds.length === 0) return;

    const previousTemplates = templates;
    const current = templates.find((item) => item.id === id);
    const newVal = !(current?.isDefault);

    updateTemplatesCache((prev) => prev.map((item) => ({
      ...item,
      isDefault: newVal ? item.id === id : false,
    })));

    const clearResult = await backend
      .from("templates")
      .update({ is_default: false })
      .in("id", scopeTemplateIds);

    if (clearResult.error) {
      updateTemplatesCache(() => previousTemplates);
      toast.error(clearResult.error.message || "Erro ao definir template padrao");
      return;
    }

    if (newVal) {
      const setResult = await backend
        .from("templates")
        .update({ is_default: true })
        .eq("id", id);

      if (setResult.error) {
        updateTemplatesCache(() => previousTemplates);
        toast.error(setResult.error.message || "Erro ao definir template padrao");
        return;
      }
      toast.success("Template definido como padrao *");
    } else {
      toast.success("Template padrao removido");
    }

    // Force refetch to ensure consistency with server data
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: templatesQueryKey });
    }, 0);
  }, [qc, scope, templates, templatesQueryKey, updateTemplatesCache, user]);

  const duplicateTemplate = useCallback(async (id: string) => {
    const template = templates.find((item) => item.id === id);
    if (!template || !user) return;

    await createTemplate(`Cópia de ${template.name}`, template.content, template.category);
  }, [createTemplate, templates, user]);

  return {
    templates,
    defaultTemplate,
    isLoading,
    scope,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    duplicateTemplate,
  };
}
