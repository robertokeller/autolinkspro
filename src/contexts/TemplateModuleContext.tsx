/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, type PropsWithChildren } from "react";
import { useTemplates } from "@/hooks/useTemplates";
import { applyTemplatePlaceholders } from "@/lib/template-placeholders";
import type { Template } from "@/lib/types";

interface ApplyTemplateInput {
  templateId?: string | null;
  fallbackContent?: string;
  placeholderData?: Record<string, string>;
}

interface TemplateModuleContextValue {
  templates: Template[];
  defaultTemplate: Template | null;
  isLoading: boolean;
  createTemplate: ReturnType<typeof useTemplates>["createTemplate"];
  updateTemplate: ReturnType<typeof useTemplates>["updateTemplate"];
  deleteTemplate: ReturnType<typeof useTemplates>["deleteTemplate"];
  setDefaultTemplate: ReturnType<typeof useTemplates>["setDefaultTemplate"];
  duplicateTemplate: ReturnType<typeof useTemplates>["duplicateTemplate"];
  applyTemplate: (input: ApplyTemplateInput) => string;
}

const TemplateModuleContext = createContext<TemplateModuleContextValue | null>(null);

export function TemplateModuleProvider({ children }: PropsWithChildren) {
  const {
    templates,
    defaultTemplate,
    isLoading,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    duplicateTemplate,
  } = useTemplates("shopee");

  const applyTemplate = useCallback((input: ApplyTemplateInput) => {
    const template = (input.templateId
      ? templates.find((item) => item.id === input.templateId) || null
      : null)
      || defaultTemplate
      || templates[0]
      || null;

    if (!template) {
      return input.fallbackContent || "";
    }

    return applyTemplatePlaceholders(template.content, input.placeholderData || {});
  }, [defaultTemplate, templates]);

  const value = useMemo<TemplateModuleContextValue>(() => ({
    templates,
    defaultTemplate,
    isLoading,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    duplicateTemplate,
    applyTemplate,
  }), [
    templates,
    defaultTemplate,
    isLoading,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    duplicateTemplate,
    applyTemplate,
  ]);

  return (
    <TemplateModuleContext.Provider value={value}>
      {children}
    </TemplateModuleContext.Provider>
  );
}

export function useTemplateModule() {
  const context = useContext(TemplateModuleContext);
  if (!context) {
    throw new Error("useTemplateModule precisa ser usado dentro de TemplateModuleProvider");
  }
  return context;
}
