import { MarketplaceAutomacoesPage } from "@/components/automations/MarketplaceAutomacoesPage";
import { useMeliAutomacoes } from "@/hooks/useMeliAutomacoes";

export default function MercadoLivreAutomacoes() {
  const automationController = useMeliAutomacoes();
  return <MarketplaceAutomacoesPage marketplace="meli" automationController={automationController} />;
}
