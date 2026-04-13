import type { Json } from "@/integrations/backend/types";

export type MarketplaceAutomationKind = "meli" | "amazon";

export interface MarketplaceAutomationConfigView {
  marketplace: MarketplaceAutomationKind;
  vitrineTabs: string[];
}

const DEFAULT_VITRINE_TAB = "destaques";
const ALLOWED_TABS = new Set([
  "destaques",
  "top_performance",
  "mais_vendidos",
  "ofertas_quentes",
  "melhor_avaliados",
]);

const TAB_ALIASES: Record<string, string> = {
  all: "destaques",
  destaques: "destaques",
  top_performance: "top_performance",
  mais_vendidos: "mais_vendidos",
  ofertas_quentes: "ofertas_quentes",
  melhor_avaliados: "melhor_avaliados",
  mais_amadas: "melhor_avaliados",
  mais_amados: "melhor_avaliados",
  beleza_cuidados: "destaques",
  calcados_roupas_bolsas: "destaques",
  casa_moveis_decoracao: "destaques",
  celulares_telefones: "destaques",
  construcao: "destaques",
  eletrodomesticos: "destaques",
  esportes_fitness: "destaques",
  ferramentas: "destaques",
  informatica: "destaques",
  saude: "destaques",
};

function normalizeMarketplace(value: unknown, fallback: MarketplaceAutomationKind = "meli"): MarketplaceAutomationKind {
  return String(value || "").trim().toLowerCase() === "amazon" ? "amazon" : fallback;
}

function normalizeVitrineTab(raw: unknown): string {
  const normalized = String(raw || "").trim().toLowerCase();
  const mapped = TAB_ALIASES[normalized] || normalized;
  if (!ALLOWED_TABS.has(mapped)) return "";
  return mapped;
}

export function normalizeMarketplaceAutomationVitrineTabs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabs: string[] = [];
  for (const raw of value) {
    const normalized = normalizeVitrineTab(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tabs.push(normalized);
  }
  return tabs;
}

export function isMarketplaceAutomationConfig(
  config: unknown,
  marketplace: MarketplaceAutomationKind,
): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const source = config as Record<string, unknown>;
  return normalizeMarketplace(source.marketplace, "meli") === marketplace;
}

export function readMarketplaceAutomationConfig(
  config: unknown,
  marketplace: MarketplaceAutomationKind,
): MarketplaceAutomationConfigView {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const vitrineTabs = normalizeMarketplaceAutomationVitrineTabs(source.vitrineTabs);
  return {
    marketplace: normalizeMarketplace(source.marketplace, marketplace),
    vitrineTabs: vitrineTabs.length > 0 ? vitrineTabs : [DEFAULT_VITRINE_TAB],
  };
}

export function mergeMarketplaceAutomationConfig(
  config: unknown,
  input: {
    marketplace: MarketplaceAutomationKind;
    vitrineTabs?: string[];
  },
): Json {
  const source = config && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
  const nextTabs = input.vitrineTabs !== undefined
    ? normalizeMarketplaceAutomationVitrineTabs(input.vitrineTabs)
    : normalizeMarketplaceAutomationVitrineTabs(source.vitrineTabs);

  source.marketplace = input.marketplace;
  source.vitrineTabs = nextTabs.length > 0 ? nextTabs : [DEFAULT_VITRINE_TAB];
  return source as Json;
}
