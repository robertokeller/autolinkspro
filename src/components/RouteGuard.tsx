import { RoutePendingState } from "@/components/RoutePendingState";
import { useAuth } from "@/contexts/AuthContext";
import { useAccessControl } from "@/hooks/useAccessControl";
import { useMaintenanceMode } from "@/hooks/useMaintenanceMode";
import { ROUTES } from "@/lib/routes";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useRef } from "react";

const AUTH_LOADING_DEADLINE_MS = 2500;

interface RouteGuardProps {
  requireAdmin?: boolean;
  allowAdmin?: boolean;
}

export function RouteGuard({ requireAdmin = false, allowAdmin = false }: RouteGuardProps) {
  const { user, isAdmin, isLoading } = useAuth();
  const { isPlanExpired, isCheckingAccess } = useAccessControl();
  const { state: maintenance, isLoading: maintenanceLoading } = useMaintenanceMode();
  const location = useLocation();
  // Use a ref (not a module-level variable) so each RouteGuard instance tracks its own
  // loading deadline independently and doesn't leak state across re-mounts.
  const authLoadingSinceRef = useRef<number | null>(null);

  const isAccountRoute = location.pathname === ROUTES.app.account;
  const isDashboardRoute = location.pathname === ROUTES.app.dashboard;
  const appPathPrefixes = [
    ROUTES.app.dashboard,
    ROUTES.app.connectionsRoot,
    ROUTES.app.whatsappRoot,
    ROUTES.app.routes,
    ROUTES.app.shopeeRoot,
    ROUTES.app.amazonRoot,
    ROUTES.app.shopeeConversor,
    ROUTES.app.mercadolivreRoot,
    ROUTES.app.vitrineMl,
    ROUTES.app.automacoesMeli,
    ROUTES.app.templatesMeli,
    ROUTES.app.schedules,
    ROUTES.app.linkHub,
    ROUTES.app.history,
    ROUTES.app.metricasLegacy,
    ROUTES.app.metricas,
    ROUTES.app.account,
  ];
  const hubPathPrefix = ROUTES.hubPublic.replace(":slug", "");
  const isAppProtectedPath = appPathPrefixes.some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`));
  const isHubProtectedPath = location.pathname.startsWith(hubPathPrefix);

  if (isLoading && authLoadingSinceRef.current == null) {
    authLoadingSinceRef.current = Date.now();
  }

  if (!isLoading) {
    authLoadingSinceRef.current = null;
  }

  const loadingExpired = authLoadingSinceRef.current != null
    && Date.now() - authLoadingSinceRef.current > AUTH_LOADING_DEADLINE_MS;

  if (isLoading && !user && !loadingExpired) {
    return <RoutePendingState label="Validando sessão..." />;
  }

  if (isLoading && !user && loadingExpired) {
    return <Navigate to={ROUTES.auth.login} replace />;
  }

  if (!user) return <Navigate to={ROUTES.auth.login} replace />;

  if (requireAdmin) {
    if (maintenanceLoading) {
      return <RoutePendingState label="Verificando status da plataforma..." />;
    }
    if (!isAdmin) return <Navigate to={ROUTES.auth.login} replace />;
    if (maintenance.maintenance_enabled && !maintenance.allow_admin_bypass) {
      return <Navigate to={ROUTES.maintenance} replace />;
    }
    return <Outlet />;
  }

  if (!isAdmin && maintenanceLoading) {
    return <RoutePendingState label="Verificando status da plataforma..." />;
  }

  if (!isAdmin && maintenance.maintenance_enabled && (isAppProtectedPath || isHubProtectedPath)) {
    return <Navigate to={ROUTES.maintenance} replace />;
  }

  if (!isAdmin && isCheckingAccess) {
    return <RoutePendingState label="Validando plano..." />;
  }

  if (!isAdmin && isPlanExpired && isAppProtectedPath && !isAccountRoute && !isDashboardRoute) {
    return <Navigate to={ROUTES.app.dashboard} replace />;
  }

  if (!allowAdmin && isAdmin) return <Navigate to={ROUTES.admin.root} replace />;
  return <Outlet />;
}
