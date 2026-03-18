import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RoutePendingState } from "@/components/RoutePendingState";
import { useAuth } from "@/contexts/AuthContext";
import { useMaintenanceMode } from "@/hooks/useMaintenanceMode";
import { ROUTES } from "@/lib/routes";
import { Navigate, useNavigate } from "react-router-dom";

export default function Maintenance() {
  const navigate = useNavigate();
  const { user, isAdmin, isLoading: authLoading } = useAuth();
  const { state, isLoading } = useMaintenanceMode();

  const canBypass = useMemo(() => {
    return Boolean(user && isAdmin && state.allow_admin_bypass);
  }, [isAdmin, state.allow_admin_bypass, user]);

  if (authLoading || isLoading) {
    return <RoutePendingState label="Verificando status da plataforma..." />;
  }

  if (!state.maintenance_enabled) {
    if (user && isAdmin) return <Navigate to={ROUTES.admin.root} replace />;
    if (user) return <Navigate to={ROUTES.app.dashboard} replace />;
    return <Navigate to={ROUTES.auth.login} replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 px-4 py-10">
      <Card className="w-full max-w-2xl border-amber-500/40">
        <CardHeader>
          <CardTitle>{state.maintenance_title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{state.maintenance_message}</p>
          {state.maintenance_eta && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
              Previsao de volta: {state.maintenance_eta}
            </div>
          )}
          {!canBypass && (
            <p className="text-xs text-muted-foreground">
              O painel está em manutenção agora. Voltamos logo!
            </p>
          )}
          {canBypass && (
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => navigate(ROUTES.auth.login)}>
                Ir para login
              </Button>
              <Button onClick={() => navigate(ROUTES.admin.root)}>
                Entrar no painel admin
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
