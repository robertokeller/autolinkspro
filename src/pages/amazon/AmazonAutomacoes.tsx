import { MarketplaceAutomacoesPage } from "@/components/automations/MarketplaceAutomacoesPage";
import { useAmazonAutomacoes } from "@/hooks/useAmazonAutomacoes";

export default function AmazonAutomacoes() {
  const automationController = useAmazonAutomacoes();
  return <MarketplaceAutomacoesPage marketplace="amazon" automationController={automationController} />;
}
