import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/backend/types";
import type { Template, TemplateCategory, TemplateScope } from "@/lib/types";
import { toast } from "sonner";
import { useCallback, useMemo } from "react";

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
  return String(value || "").trim().toLowerCase() === "meli" ? "meli" : "shopee";
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
  const explicitScope = String(source.scope || "").trim();
  if (explicitScope) {
    return normalizeTemplateScope(explicitScope);
  }

  const tags = normalizeTags(source.tags);
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
  const { user } = useAuth();
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
        .eq("scope", scope)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || [])
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
      toast.error("Usuario nao autenticado");
      return null;
    }
    if (!name || !content) {
      toast.error("Preencha nome e conteudo");
      return null;
    }

    const payload: Record<string, unknown> = {
      name,
      content,
      category: normalizeTemplateCategory(category),
      tags: ensureScopeTag([], scope),
      scope,
    };

    const { data, error } = await backend
      .from("templates")
      .insert(payload)
      .select()
      .single();

    if (error) {
      toast.error("Erro ao criar template");
      return null;
    }

    const next = mapRow(data);
    if (next.scope === scope) {
      updateTemplatesCache((prev) => [next, ...prev]);
    }

    qc.invalidateQueries({ queryKey: templatesQueryKey });
    toast.success("Template criado!");
    return next;
  }, [qc, scope, templatesQueryKey, updateTemplatesCache, user]);

  const updateTemplate = useCallback(async (
    id: string,
    updates: Partial<Pick<Template, "name" | "content" | "category">>,
  ) => {
    if (!user) {
      toast.error("Usuario nao autenticado");
      return;
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

    const { error } = await backend
      .from("templates")
      .update(sanitizedUpdates)
      .eq("id", id);

    if (error) {
      updateTemplatesCache(() => previousTemplates);
      toast.error("Erro ao atualizar template");
      return;
    }

    qc.invalidateQueries({ queryKey: templatesQueryKey });
    toast.success("Template atualizado");
  }, [qc, scope, templates, templatesQueryKey, updateTemplatesCache, user]);

  const deleteTemplate = useCallback(async (id: string) => {
    if (!user) {
      toast.error("Usuario nao autenticado");
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
      toast.error("Erro ao remover template");
      return;
    }

    qc.invalidateQueries({ queryKey: templatesQueryKey });
    toast.success("Template removido");
  }, [qc, templates, templatesQueryKey, updateTemplatesCache, user]);

  const setDefaultTemplate = useCallback(async (id: string) => {
    if (!user) return;

    const scopedIds = templates.map((item) => item.id);
    if (scopedIds.length === 0) return;

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
      .in("id", scopedIds);

    if (clearResult.error) {
      updateTemplatesCache(() => previousTemplates);
      toast.error("Erro ao definir template padrao");
      return;
    }

    if (newVal) {
      const setResult = await backend
        .from("templates")
        .update({ is_default: true })
        .eq("id", id);

      if (setResult.error) {
        updateTemplatesCache(() => previousTemplates);
        toast.error("Erro ao definir template padrao");
        return;
      }
      toast.success("Template definido como padrao *");
    } else {
      toast.success("Template padrao removido");
    }

    qc.invalidateQueries({ queryKey: templatesQueryKey });
  }, [qc, templates, templatesQueryKey, updateTemplatesCache, user]);

  const duplicateTemplate = useCallback(async (id: string) => {
    const template = templates.find((item) => item.id === id);
    if (!template || !user) return;

    await createTemplate(`Copia de ${template.name}`, template.content, template.category);
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
