import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Template, TemplateCategory } from "@/lib/types";
import type { Tables } from "@/integrations/backend/types";
import { toast } from "sonner";
import { useCallback, useMemo } from "react";

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

function mapRow(row: Tables<"templates">): Template {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    category: normalizeTemplateCategory(row.category),
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

export function useTemplates() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const templatesQueryKey = useMemo(() => ["templates", user?.id] as const, [user?.id]);

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
      return (data || []).map(mapRow);
    },
    enabled: !!user,
  });

  const defaultTemplate = useMemo(() => templates.find((t) => t.isDefault) || null, [templates]);

  const createTemplate = useCallback(async (name: string, content: string, category: TemplateCategory) => {
    if (!user) { toast.error("Usuário não autenticado"); return null; }
    if (!name || !content) { toast.error("Preencha nome e conteúdo"); return null; }
    const { data, error } = await backend.from("templates").insert({
      name,
      content,
      category: normalizeTemplateCategory(category),
    }).select().single();
    if (error) { toast.error("Erro ao criar template"); return null; }
    const next = mapRow(data);
    updateTemplatesCache((prev) => [next, ...prev]);
    qc.invalidateQueries({ queryKey: templatesQueryKey });
    toast.success("Template criado!");
    return next;
  }, [user, qc, templatesQueryKey, updateTemplatesCache]);

  const updateTemplate = useCallback(async (id: string, updates: Partial<Pick<Template, "name" | "content" | "category">>) => {
    if (!user) { toast.error("Usuário não autenticado"); return; }
    const sanitizedUpdates = {
      ...updates,
      ...(updates.category ? { category: normalizeTemplateCategory(updates.category) } : {}),
    };

    const previousTemplates = templates;
    updateTemplatesCache((prev) => prev.map((item) => (item.id === id ? { ...item, ...sanitizedUpdates } : item)));

    const { error } = await backend.from("templates").update(sanitizedUpdates).eq("id", id);
    if (error) {
      updateTemplatesCache(() => previousTemplates);
      toast.error("Erro ao atualizar template");
      return;
    }
    qc.invalidateQueries({ queryKey: templatesQueryKey });
    toast.success("Template atualizado");
  }, [templates, qc, user, templatesQueryKey, updateTemplatesCache]);

  const deleteTemplate = useCallback(async (id: string) => {
    if (!user) { toast.error("Usuário não autenticado"); return; }
    const previousTemplates = templates;
    updateTemplatesCache((prev) => prev.filter((item) => item.id !== id));

    const { error } = await backend.from("templates").delete().eq("id", id);
    if (error) {
      updateTemplatesCache(() => previousTemplates);
      toast.error("Erro ao remover template");
      return;
    }
    qc.invalidateQueries({ queryKey: templatesQueryKey });
    toast.success("Template removido");
  }, [templates, qc, user, templatesQueryKey, updateTemplatesCache]);

  const setDefaultTemplate = useCallback(async (id: string) => {
    if (!user) return;
    const previousTemplates = templates;
    const current = templates.find((t) => t.id === id);
    const newVal = !(current?.isDefault);
    updateTemplatesCache((prev) => prev.map((item) => ({
      ...item,
      isDefault: newVal ? item.id === id : false,
    })));

    const clearResult = await backend.from("templates").update({ is_default: false });
    if (clearResult.error) {
      updateTemplatesCache(() => previousTemplates);
      toast.error("Erro ao definir template padrão");
      return;
    }

    if (newVal) {
      const setResult = await backend.from("templates").update({ is_default: true }).eq("id", id);
      if (setResult.error) {
        updateTemplatesCache(() => previousTemplates);
        toast.error("Erro ao definir template padrão");
        return;
      }
      toast.success("Template definido como padrão *");
    } else {
      toast.success("Template padrão removido");
    }

    qc.invalidateQueries({ queryKey: templatesQueryKey });
  }, [qc, user, templates, templatesQueryKey, updateTemplatesCache]);

  const duplicateTemplate = useCallback(async (id: string) => {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl || !user) return;
    await createTemplate(`Cópia de ${tpl.name}`, tpl.content, tpl.category);
  }, [templates, user, createTemplate]);

  return { templates, defaultTemplate, isLoading, createTemplate, updateTemplate, deleteTemplate, setDefaultTemplate, duplicateTemplate };
}
