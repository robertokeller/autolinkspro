import { RoutePendingState } from "@/components/RoutePendingState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccessControl } from "@/hooks/useAccessControl";
import { ROUTES } from "@/lib/routes";
import { AlertTriangle, Lock } from "lucide-react";
import type { AppFeature } from "@/lib/access-control";
import type { ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";

interface FeatureRouteGuardProps {
  feature: AppFeature;
  children: ReactNode;
}

export function FeatureRouteGuard({ feature, children }: FeatureRouteGuardProps) {
  const { canAccess, getFeaturePolicy, isCheckingAccess, isPlanExpired } = useAccessControl();
  const navigate = useNavigate();

  if (isCheckingAccess) return <RoutePendingState label="Validando acesso..." />;
  if (canAccess(feature)) return <>{children}</>;

  const policy = getFeaturePolicy(feature);
  if (policy.mode === "hidden") {
    return <Navigate to={ROUTES.app.dashboard} replace />;
  }

  if (isPlanExpired) {
    return (
      <div className="flex min-h-[calc(100dvh-9rem)] w-full items-center justify-center px-4 py-8">
        <Card className="glass w-full max-w-2xl border-destructive/40 shadow-lg">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <CardTitle className="text-xl">Plano expirado</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 text-center">
            <p className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">
              Seu plano expirou e este recurso está temporariamente bloqueado. Renove a assinatura para voltar a usar esta e todas as outras funcionalidades.
            </p>
            <div className="flex flex-col items-stretch justify-center gap-2 sm:flex-row">
              <Button onClick={() => navigate(ROUTES.app.account)}>Renovar agora</Button>
              <Button variant="outline" onClick={() => navigate(ROUTES.app.dashboard)}>Voltar ao painel</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-9rem)] w-full items-center justify-center px-4 py-8">
      <Card className="glass w-full max-w-2xl border-border/70 shadow-lg">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Lock className="h-5 w-5" />
          </div>
          <CardTitle className="text-xl">Esta funcionalidade não está liberada para sua conta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          <p className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">
            {policy.blockedMessage ||
              "Seu plano atual não inclui este recurso. Você pode continuar usando normalmente as funcionalidades já liberadas ou fazer upgrade quando quiser."}
          </p>
          <div className="flex flex-col items-stretch justify-center gap-2 sm:flex-row">
            <Button onClick={() => navigate(ROUTES.app.account)}>Ver planos e liberar acesso</Button>
            <Button variant="outline" onClick={() => navigate(ROUTES.app.dashboard)}>Voltar ao painel</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
