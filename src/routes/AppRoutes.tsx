import { LoadingScreen } from "@/components/LoadingScreen";
import { useAuth } from "@/contexts/AuthContext";
import { ROUTES } from "@/lib/routes";
import { AdminRoutes } from "@/routes/admin-routes";
import { ProtectedAppRoutes } from "@/routes/app-routes";
import { Pages } from "@/routes/lazy-pages";
import { PublicRoutes } from "@/routes/public-routes";
import { Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

function FallbackRoute() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to={ROUTES.auth.login} replace />;
  }

  return <Pages.NotFound />;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        {PublicRoutes()}
        {ProtectedAppRoutes()}
        {AdminRoutes()}
        <Route path="*" element={<FallbackRoute />} />
      </Routes>
    </Suspense>
  );
}
