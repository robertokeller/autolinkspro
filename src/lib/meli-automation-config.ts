import type { Json } from "@/integrations/backend/types";

export interface MeliAutomationConfigView {
  marketplace: "meli" | "shopee";
  vitrineTabs: string[];
}

const DEFAULT_MELI_VITRINE_TAB = "top_performance";
const MELI_VITRINE_ALLOWED_TABS = new Set([
  "top_performance",
  "mais_vendidos",
  "ofertas_quentes",
  "melhor_avaliados",
]);

const MELI_VITRINE_TAB_ALIASES: Record<string, string> = {
  all: "top_performance",
  top_performance: "top_performance",
  mais_vendidos: "mais_vendidos",
  ofertas_quentes: "ofertas_quentes",
  melhor_avaliados: "melhor_avaliados",
  beleza_cuidados: "top_performance",
  calcados_roupas_bolsas: "top_performance",
  casa_moveis_decoracao: "top_performance",
  celulares_telefones: "top_performance",
  construcao: "top_performance",
  eletrodomesticos: "top_performance",
  esportes_fitness: "top_performance",
  ferramentas: "top_performance",
  informatica: "top_performance",
  saude: "top_performance",
};

function normalizeMarketplace(value: unknown): "meli" | "shopee" {
  return String(value || "").trim().toLowerCase() === "meli" ? "meli" : "shopee";
}

function normalizeMeliVitrineTab(raw: unknown): string {
  const normalized = String(raw || "").trim().toLowerCase();
  const mapped = MELI_VITRINE_TAB_ALIASES[normalized] || normalized;
  if (!MELI_VITRINE_ALLOWED_TABS.has(mapped)) return "";
  return mapped;
}

export function normalizeMeliVitrineTabs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabs: string[] = [];
  for (const raw of value) {
    const normalized = normalizeMeliVitrineTab(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tabs.push(normalized);
  }
  return tabs;
}

export function isMeliAutomationConfig(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const source = config as Record<string, unknown>;
  return normalizeMarketplace(source.marketplace) === "meli";
}

export function readMeliAutomationConfig(config: unknown): MeliAutomationConfigView {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const vitrineTabs = normalizeMeliVitrineTabs(source.vitrineTabs);
  return {
    marketplace: normalizeMarketplace(source.marketplace),
    vitrineTabs: vitrineTabs.length > 0 ? vitrineTabs : [DEFAULT_MELI_VITRINE_TAB],
  };
}

export function mergeMeliAutomationConfig(
  config: unknown,
  input: {
    vitrineTabs?: string[];
  },
): Json {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
  const nextTabs = input.vitrineTabs !== undefined
    ? normalizeMeliVitrineTabs(input.vitrineTabs)
    : normalizeMeliVitrineTabs(source.vitrineTabs);

  source.marketplace = "meli";
  source.vitrineTabs = nextTabs.length > 0 ? nextTabs : [DEFAULT_MELI_VITRINE_TAB];
  return source as Json;
}
