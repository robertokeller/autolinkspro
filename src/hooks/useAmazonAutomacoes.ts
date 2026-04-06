import {
  useMarketplaceAutomacoes,
  type CreateMarketplaceAutomationInput,
  type MarketplaceAutomationRow,
} from "@/hooks/useMarketplaceAutomacoes";

export type AmazonAutomationRow = MarketplaceAutomationRow;
export type CreateAmazonAutomationInput = CreateMarketplaceAutomationInput;

export function useAmazonAutomacoes() {
  return useMarketplaceAutomacoes("amazon");
}
