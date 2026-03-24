import { RouteGuard } from "@/components/RouteGuard";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { ROUTES } from "@/lib/routes";
import { Pages } from "@/routes/lazy-pages";
import { Route } from "react-router-dom";

export function AdminRoutes() {
  return (
    <Route element={<RouteGuard requireAdmin />}>
      <Route element={<AdminLayout />}>
        <Route path={ROUTES.admin.root} element={<Pages.AdminDashboard />} />
        <Route path={ROUTES.admin.users} element={<Pages.AdminUsers />} />
        <Route path={ROUTES.admin.plans} element={<Pages.AdminPlans />} />
        <Route path={ROUTES.admin.access} element={<Pages.AdminAccess />} />
        <Route path={ROUTES.admin.logs} element={<Pages.AdminLogs />} />
        <Route path={ROUTES.admin.notifications} element={<Pages.AdminNotifications />} />
        <Route path={ROUTES.admin.whatsapp} element={<Pages.AdminWhatsApp />} />
      </Route>
    </Route>
  );
}
