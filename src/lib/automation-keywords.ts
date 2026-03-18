import type { Json } from "@/integrations/backend/types";

export interface AutomationKeywordFilters {
  positiveKeywords: string[];
  negativeKeywords: string[];
}

export type AutomationOfferSourceMode = "search" | "vitrine";

export interface AutomationOfferSourceConfig {
  offerSourceMode: AutomationOfferSourceMode;
  vitrineTabs: string[];
}

export const AUTOMATION_VITRINE_TAB_OPTIONS = [
  { id: "sales", label: "Mais vendidos" },
  { id: "commission", label: "Maior comissão" },
  { id: "discount", label: "Maior desconto" },
  { id: "rating", label: "Melhor avaliação" },
  { id: "top", label: "Top performance" },
] as const;

const VITRINE_TAB_SET = new Set<string>(AUTOMATION_VITRINE_TAB_OPTIONS.map((tab) => tab.id));
const DEFAULT_VITRINE_TAB = "sales";

function normalizeKeyword(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeKeywordList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of value) {
    const keyword = normalizeKeyword(raw);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    list.push(keyword);
  }
  return list;
}

export function splitKeywordCsv(value: string): string[] {
  const parts = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalizeKeywordList(parts);
}

export function readAutomationKeywordFilters(config: unknown): AutomationKeywordFilters {
  const cfg = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  return {
    positiveKeywords: normalizeKeywordList(cfg.positiveKeywords),
    negativeKeywords: normalizeKeywordList(cfg.negativeKeywords),
  };
}

export function mergeAutomationKeywordFilters(
  config: unknown,
  filters: AutomationKeywordFilters,
): Json {
  const base = config && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
  base.positiveKeywords = normalizeKeywordList(filters.positiveKeywords);
  base.negativeKeywords = normalizeKeywordList(filters.negativeKeywords);
  return base as Json;
}

function normalizeOfferSourceMode(value: unknown): AutomationOfferSourceMode {
  return String(value || "").trim().toLowerCase() === "vitrine" ? "vitrine" : "search";
}

export function normalizeVitrineTabList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of value) {
    const normalized = String(raw || "").trim().toLowerCase();
    if (!normalized || !VITRINE_TAB_SET.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    list.push(normalized);
  }
  return list;
}

export function readAutomationOfferSourceConfig(config: unknown): AutomationOfferSourceConfig {
  const cfg = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const offerSourceMode = normalizeOfferSourceMode(cfg.offerSourceMode);
  const tabs = normalizeVitrineTabList(cfg.vitrineTabs);
  return {
    offerSourceMode,
    vitrineTabs: tabs.length > 0 ? tabs : [DEFAULT_VITRINE_TAB],
  };
}

export function mergeAutomationOfferSourceConfig(
  config: unknown,
  source: Partial<AutomationOfferSourceConfig>,
): Json {
  const base = config && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};

  const currentMode = normalizeOfferSourceMode(base.offerSourceMode);
  const currentTabs = normalizeVitrineTabList(base.vitrineTabs);

  const nextMode = source.offerSourceMode !== undefined
    ? normalizeOfferSourceMode(source.offerSourceMode)
    : currentMode;

  const nextTabsRaw = source.vitrineTabs !== undefined
    ? normalizeVitrineTabList(source.vitrineTabs)
    : currentTabs;

  base.offerSourceMode = nextMode;
  base.vitrineTabs = nextTabsRaw.length > 0 ? nextTabsRaw : [DEFAULT_VITRINE_TAB];

  return base as Json;
}

export function keywordsToCsv(keywords: string[]): string {
  return (keywords || []).join(", ");
}
