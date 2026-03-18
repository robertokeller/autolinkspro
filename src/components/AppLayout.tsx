import { Link, Outlet, useLocation } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { AppSidebar } from "@/components/AppSidebar";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { PlanExpiryBanner } from "@/components/PlanExpiryBanner";
import { ThemeToggle } from "@/components/ThemeToggle";
import { APP_ROUTE_TITLES, ROUTES } from "@/lib/routes";

export function AppLayout() {
  const location = useLocation();
  const pageName = APP_ROUTE_TITLES[location.pathname] || "Página";

  return (
    <SidebarProvider defaultOpen>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-[var(--app-header-height)] shrink-0 items-center gap-2 border-b px-[var(--app-page-x)]">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to={ROUTES.app.dashboard} className="inline-flex items-center gap-1.5">
                    <img src="/brand/logo-chama-64.png" alt="" className="h-3.5 w-3.5 object-contain" loading="lazy" />
                    <span>Auto Links</span>
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{pageName}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex-1" />
          <NotificationBell />
          <ThemeToggle />
        </header>
        <PlanExpiryBanner />
        <main className="animate-fade-in flex-1 overflow-auto px-[var(--app-page-x)] py-[var(--app-page-y)]">
          <div className="mx-auto w-full max-w-[var(--content-max-width)]">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
