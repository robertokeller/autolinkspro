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
import { useViewportProfile } from "@/hooks/useViewportProfile";
import { APP_ROUTE_TITLES, ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

export function AppLayout() {
  const location = useLocation();
  const pageName = APP_ROUTE_TITLES[location.pathname] || "Pagina";
  const viewport = useViewportProfile();
  const compactHeader = viewport.isTiny || viewport.isMobile;

  return (
    <SidebarProvider defaultOpen>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-30 border-b bg-background/95 px-[calc(var(--app-page-x)+var(--safe-area-left))] pr-[calc(var(--app-page-x)+var(--safe-area-right))] backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex h-[var(--app-header-height)] items-center gap-2 app-safe-top">
            <SidebarTrigger className={cn("-ml-1", compactHeader && "h-9 w-9")} />

            {compactHeader ? (
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold tracking-tight">{pageName}</p>
              </div>
            ) : (
              <>
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
              </>
            )}

            <div className="flex-1" />
            <div className="flex items-center gap-1 sm:gap-1.5">
              <NotificationBell />
              <ThemeToggle />
            </div>
          </div>
        </header>

        <PlanExpiryBanner />

        <main className="animate-fade-in flex-1 overflow-auto px-[calc(var(--app-page-x)+var(--safe-area-left))] pr-[calc(var(--app-page-x)+var(--safe-area-right))] py-[var(--app-page-y)] pb-[calc(var(--app-page-y)+var(--safe-area-bottom))]">
          <div className="mx-auto w-full max-w-[var(--content-max-width)]">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
