import { Link, Outlet, useLocation } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useAuth } from "@/contexts/AuthContext";
import { ROUTES } from "@/lib/routes";
import { Bell, CreditCard, KeyRound, LayoutDashboard, LogOut, ScrollText, Shield, Users } from "lucide-react";

const adminNav = [
  { title: "Dashboard", icon: LayoutDashboard, href: ROUTES.admin.root },
  { title: "Usuários", icon: Users, href: ROUTES.admin.users },
  { title: "Planos", icon: CreditCard, href: ROUTES.admin.plans },
  { title: "Notificações", icon: Bell, href: ROUTES.admin.notifications },
  { title: "Logs do Sistema", icon: ScrollText, href: ROUTES.admin.logs },
  { title: "Controle de Acesso", icon: KeyRound, href: ROUTES.admin.access },
];

function AdminSidebar() {
  const location = useLocation();
  const { signOut } = useAuth();

  const isActive = (href: string) =>
    href === ROUTES.admin.root ? location.pathname === ROUTES.admin.root : location.pathname.startsWith(href);

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="px-3 py-4">
        <Link to={ROUTES.admin.root} className="flex items-center gap-2.5 px-1">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-destructive text-destructive-foreground">
            <Shield className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-2 truncate">
            <span className="text-base font-bold tracking-tight">Auto Links</span>
            <Badge variant="destructive" className="px-1.5 py-0 text-2xs uppercase tracking-[0.1em]">
              Admin
            </Badge>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-2xs tracking-wide text-muted-foreground">Gerenciamento</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {adminNav.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.title}>
                    <Link to={item.href}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sair"
              onClick={() => signOut()}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <LogOut className="h-4 w-4" />
              <span>Sair</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export function AdminLayout() {
  return (
    <SidebarProvider defaultOpen>
      <AdminSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Badge variant="outline" className="border-destructive/50 text-destructive">
            <Shield className="mr-1 h-3 w-3" />
            Painel Administrativo
          </Badge>
          <div className="flex-1" />
        </header>
        <main className="animate-fade-in flex-1 overflow-auto bg-gradient-to-b from-background via-background to-muted/20 p-4 sm:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
