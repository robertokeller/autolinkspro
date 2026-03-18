import type { Json } from "@/integrations/backend/types";

export interface AutomationKeywordFilters {
  positiveKeywords: string[];
  negativeKeywords: string[];
}

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

export function keywordsToCsv(keywords: string[]): string {
  return (keywords || []).join(", ");
}

