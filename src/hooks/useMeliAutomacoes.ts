import {
  useMarketplaceAutomacoes,
  type CreateMarketplaceAutomationInput,
  type MarketplaceAutomationRow,
} from "@/hooks/useMarketplaceAutomacoes";

export type MeliAutomationRow = MarketplaceAutomationRow;
export type CreateMeliAutomationInput = CreateMarketplaceAutomationInput;

export function useMeliAutomacoes() {
  return useMarketplaceAutomacoes("meli");
}
