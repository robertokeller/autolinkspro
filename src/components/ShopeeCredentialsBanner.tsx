import { Link } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/routes";

export function ShopeeCredentialsBanner() {
  return (
    <Alert variant="destructive" className="border-destructive/30 bg-destructive/5">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Credenciais não configuradas</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>Você precisa configurar as credenciais da Shopee pra usar isso.</span>
        <Button size="sm" variant="outline" asChild>
          <Link to={ROUTES.app.shopeeConfiguracoes}>Ir pra Configurações</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

