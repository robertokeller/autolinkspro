import { RoutePendingState } from "@/components/RoutePendingState";
import { useAuth } from "@/contexts/AuthContext";
import { useMaintenanceMode } from "@/hooks/useMaintenanceMode";
import { ROUTES } from "@/lib/routes";
import { Navigate, Outlet } from "react-router-dom";

export function AuthPageGuard() {
  const { user, isAdmin, isLoading } = useAuth();
  const { state: maintenance, isLoading: maintenanceLoading } = useMaintenanceMode();

  if (isLoading) {
    return <RoutePendingState label="Validando sessão..." />;
  }

  // Do not block public auth pages while anonymous users type.
  // Maintenance state only matters after authentication succeeds.
  if (!user) {
    return <Outlet />;
  }

  if (maintenanceLoading) {
    return <RoutePendingState label="Verificando status da plataforma..." />;
  }

  if (isAdmin) {
    if (maintenance.maintenance_enabled && !maintenance.allow_admin_bypass) {
      return <Navigate to={ROUTES.maintenance} replace />;
    }
    return <Navigate to={ROUTES.admin.root} replace />;
  }

  if (maintenance.maintenance_enabled) {
    return <Navigate to={ROUTES.maintenance} replace />;
  }

  return <Navigate to={ROUTES.app.dashboard} replace />;
}
