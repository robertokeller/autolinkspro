import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowLeftRight,
  CalendarDays,
  ChevronRight,
  FileText,
  History,
  LayoutDashboard,
  LayoutGrid,
  Layers,
  Link2,
  LogOut,
  Package,
  Route,
  SearchCheck,
  ShoppingBag,
  SlidersHorizontal,
  UserCircle,
  Bot,
  ShoppingCart,
  Handshake,
} from "lucide-react";
import { TelegramIcon, WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/contexts/AuthContext";
import { useAccessControl } from "@/hooks/useAccessControl";
import { useIsMobile } from "@/hooks/use-mobile";
import { ROUTES } from "@/lib/routes";

const shopeeSubNav = [
  { title: "Vitrine de ofertas", icon: LayoutGrid, href: ROUTES.app.shopeeVitrine },
  { title: "Pesquisa de Ofertas", icon: SearchCheck, href: ROUTES.app.shopeePesquisa },
  { title: "Piloto automático", icon: Bot, href: ROUTES.app.shopeeAutomacoes },
  { title: "Templates Shopee", icon: FileText, href: ROUTES.app.shopeeTemplates },
  { title: "Configurações", icon: SlidersHorizontal, href: ROUTES.app.shopeeConfiguracoes },
];

const meliSubNav = [
  { title: "Vitrine de ofertas", icon: LayoutGrid, href: ROUTES.app.vitrineMl },
  { title: "Piloto automático", icon: Bot, href: ROUTES.app.automacoesMeli },
  { title: "Templates Meli", icon: FileText, href: ROUTES.app.templatesMeli },
  { title: "Configurações", icon: SlidersHorizontal, href: ROUTES.app.mercadolivreConfiguracoes },
];

const amazonSubNav = [
  { title: "Vitrine de ofertas", icon: LayoutGrid, href: ROUTES.app.vitrineAmazon },
  { title: "Piloto automático", icon: Bot, href: ROUTES.app.automacoesamazon },
  { title: "Templates Amazon", icon: FileText, href: ROUTES.app.templatesAmazon },
  { title: "Configurações", icon: SlidersHorizontal, href: ROUTES.app.amazonConfiguracoes },
];

export function AppSidebar() {
  const location = useLocation();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const { signOut } = useAuth();
  const { canSeeFeature, isPlanExpired } = useAccessControl();
  const navigationLocked = isPlanExpired;

  const featureVisibility = {
    telegramConnections: canSeeFeature("telegramConnections"),
    mercadoLivre: canSeeFeature("mercadoLivre"),
    amazon: canSeeFeature("amazon"),
    shopeeAutomations: canSeeFeature("shopeeAutomations"),
    templates: canSeeFeature("templates"),
    routes: canSeeFeature("routes"),
    schedules: canSeeFeature("schedules"),
    linkHub: canSeeFeature("linkHub"),
  };

  const isActive = (href: string) => location.pathname.startsWith(href);
  const isShopeeActive = location.pathname.startsWith(ROUTES.app.shopeeRoot);
  const isMeliActive = location.pathname.startsWith(ROUTES.app.mercadolivreRoot)
    || location.pathname === ROUTES.app.vitrineMl
    || location.pathname === ROUTES.app.automacoesMeli
    || location.pathname === ROUTES.app.templatesMeli;
  const isAmazonActive = location.pathname.startsWith(ROUTES.app.amazonRoot)
    || location.pathname === ROUTES.app.vitrineAmazon
    || location.pathname === ROUTES.app.automacoesamazon
    || location.pathname === ROUTES.app.templatesAmazon;

  const [isShopeeOpen, setIsShopeeOpen] = useState(isShopeeActive);
  const [isMeliOpen, setIsMeliOpen] = useState(isMeliActive);
  const [isAmazonOpen, setIsAmazonOpen] = useState(isAmazonActive);

  useEffect(() => {
    if (isShopeeActive) setIsShopeeOpen(true);
  }, [isShopeeActive]);

  useEffect(() => {
    if (isMeliActive) setIsMeliOpen(true);
  }, [isMeliActive]);

  useEffect(() => {
    if (isAmazonActive) setIsAmazonOpen(true);
  }, [isAmazonActive]);

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const handleSignOut = () => {
    closeMobileSidebar();
    signOut();
  };

  const visibleShopeeSubNav = shopeeSubNav.filter((item) => {
    if (item.href === ROUTES.app.shopeeAutomacoes) return featureVisibility.shopeeAutomations;
    if (item.href === ROUTES.app.shopeeTemplates) return featureVisibility.templates;
    return true;
  });

  const visibleMeliSubNav = featureVisibility.mercadoLivre
    ? meliSubNav.filter((item) => {
      if (item.href === ROUTES.app.automacoesMeli) return featureVisibility.shopeeAutomations;
      if (item.href === ROUTES.app.templatesMeli) return featureVisibility.templates;
      return true;
    })
    : [];

  const visibleAmazonSubNav = featureVisibility.amazon
    ? amazonSubNav.filter((item) => {
      if (item.href === ROUTES.app.automacoesamazon) return featureVisibility.shopeeAutomations;
      if (item.href === ROUTES.app.templatesAmazon) return featureVisibility.templates;
      return true;
    })
    : [];

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="AutoLinks!">
              <Link to={ROUTES.app.dashboard} onClick={closeMobileSidebar}>
                <div className="flex aspect-square size-8 shrink-0 items-center justify-center">
                  <img
                    src="/brand/icon-64.png"
                    alt="AutoLinks!"
                    className="h-8 w-8 rounded-lg object-contain"
                  />
                </div>
                <span className="truncate text-base font-bold tracking-tight">AutoLinks!</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent className={navigationLocked ? "pointer-events-none select-none opacity-60" : undefined}>
        {navigationLocked && (
          <div className="px-3 py-2 text-xs text-warning">
            Plano vencido. Menu bloqueado ate a renovacao.
          </div>
        )}
        <SidebarGroup>
          <SidebarGroupLabel>Início</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.dashboard)} tooltip="Dashboard">
                  <Link to={ROUTES.app.dashboard} onClick={closeMobileSidebar}>
                    <LayoutDashboard className="h-4 w-4" />
                    <span>Dashboard</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.history)} tooltip="Histórico">
                  <Link to={ROUTES.app.history} onClick={closeMobileSidebar}>
                    <History className="h-4 w-4" />
                    <span>Histórico</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>Marketplaces</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <Collapsible asChild open={isShopeeOpen} onOpenChange={setIsShopeeOpen} className="group/collapsible">
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip="Shopee" isActive={isShopeeActive}>
                      <ShoppingBag className="h-4 w-4" />
                      <span>Shopee</span>
                      <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {visibleShopeeSubNav.map((item) => (
                        <SidebarMenuSubItem key={item.href}>
                          <SidebarMenuSubButton asChild isActive={location.pathname === item.href}>
                            <Link to={item.href} onClick={closeMobileSidebar}>
                              <item.icon className="h-4 w-4" />
                              <span>{item.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>

              {featureVisibility.mercadoLivre && (
              <Collapsible asChild open={isMeliOpen} onOpenChange={setIsMeliOpen} className="group/collapsible">
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip="Mercado Livre" isActive={isMeliActive}>
                      <ShoppingCart className="h-4 w-4" />
                      <span>Mercado Livre</span>
                      <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {visibleMeliSubNav.map((item) => (
                        <SidebarMenuSubItem key={item.href}>
                          <SidebarMenuSubButton asChild isActive={location.pathname === item.href}>
                            <Link to={item.href} onClick={closeMobileSidebar}>
                              <item.icon className="h-4 w-4" />
                              <span>{item.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
              )}

              {featureVisibility.amazon && (
              <Collapsible asChild open={isAmazonOpen} onOpenChange={setIsAmazonOpen} className="group/collapsible">
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip="Amazon" isActive={isAmazonActive}>
                      <Package className="h-4 w-4" />
                      <span>Amazon</span>
                      <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {visibleAmazonSubNav.map((item) => (
                        <SidebarMenuSubItem key={item.href}>
                          <SidebarMenuSubButton asChild isActive={location.pathname === item.href}>
                            <Link to={item.href} onClick={closeMobileSidebar}>
                              <item.icon className="h-4 w-4" />
                              <span>{item.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>Ferramentas</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {featureVisibility.schedules && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.schedules)} tooltip="Agendamentos">
                  <Link to={ROUTES.app.schedules} onClick={closeMobileSidebar}>
                    <CalendarDays className="h-4 w-4" />
                    <span>Agendamentos</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.shopeeConversor)} tooltip="Conversor de links">
                  <Link to={ROUTES.app.shopeeConversor} onClick={closeMobileSidebar}>
                    <ArrowLeftRight className="h-4 w-4" />
                    <span>Conversor de links</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {featureVisibility.routes && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.routes)} tooltip="Rotas automáticas">
                  <Link to={ROUTES.app.routes} onClick={closeMobileSidebar}>
                    <Route className="h-4 w-4" />
                    <span>Rotas automáticas</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>Conexões</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {featureVisibility.linkHub && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.linkHub)} tooltip="Link Hub">
                  <Link to={ROUTES.app.linkHub} onClick={closeMobileSidebar}>
                    <Link2 className="h-4 w-4" />
                    <span>Link Hub</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              {featureVisibility.telegramConnections && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.connectionsTelegram)} tooltip="Telegram">
                  <Link to={ROUTES.app.connectionsTelegram} onClick={closeMobileSidebar}>
                    <TelegramIcon className="h-4 w-4" />
                    <span>Telegram</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.connectionsWhatsApp)} tooltip="WhatsApp">
                  <Link to={ROUTES.app.connectionsWhatsApp} onClick={closeMobileSidebar}>
                    <WhatsAppIcon className="h-4 w-4" />
                    <span>WhatsApp</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive(ROUTES.app.connectionsMasterGroups)} tooltip="Grupos Mestres">
                  <Link to={ROUTES.app.connectionsMasterGroups} onClick={closeMobileSidebar}>
                    <Layers className="h-4 w-4" />
                    <span>Grupos Mestres</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          {!navigationLocked && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isActive(ROUTES.app.ajuda)} tooltip="Ajuda">
                <Link to={ROUTES.app.ajuda} onClick={closeMobileSidebar}>
                  <FileText className="h-4 w-4" />
                  <span>Ajuda</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {!navigationLocked && (
            <SidebarMenuItem>
              <SidebarMenuButton 
                asChild 
                isActive={isActive(ROUTES.app.afiliado)} 
                tooltip="Parceiros"
                className="text-primary hover:text-primary/80 font-medium"
              >
                <Link to={ROUTES.app.afiliado} onClick={closeMobileSidebar}>
                  <Handshake className="h-4 w-4" />
                  <span>Parceiros</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isActive(ROUTES.app.account)} tooltip="Minha conta">
              <Link to={ROUTES.app.account} onClick={closeMobileSidebar}>
                <UserCircle className="h-4 w-4" />
                <span>Minha conta</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleSignOut}
              tooltip="Sair"
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
