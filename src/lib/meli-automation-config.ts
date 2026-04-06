import {
  isMarketplaceAutomationConfig,
  mergeMarketplaceAutomationConfig,
  normalizeMarketplaceAutomationVitrineTabs,
  readMarketplaceAutomationConfig,
  type MarketplaceAutomationConfigView,
} from "@/lib/marketplace-automation-config";

export type MeliAutomationConfigView = MarketplaceAutomationConfigView;

export function normalizeMeliVitrineTabs(value: unknown): string[] {
  return normalizeMarketplaceAutomationVitrineTabs(value);
}

export function isMeliAutomationConfig(config: unknown): boolean {
  return isMarketplaceAutomationConfig(config, "meli");
}

export function readMeliAutomationConfig(config: unknown): MeliAutomationConfigView {
  return readMarketplaceAutomationConfig(config, "meli");
}

export function mergeMeliAutomationConfig(
  config: unknown,
  input: {
    vitrineTabs?: string[];
  },
) {
  return mergeMarketplaceAutomationConfig(config, {
    marketplace: "meli",
    vitrineTabs: input.vitrineTabs,
  });
}
