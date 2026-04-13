import { LayoutDashboard, SearchCheck, ArrowLeftRight, LayoutGrid, ShoppingCart } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useAccessControl } from "@/hooks/useAccessControl";
import { useViewportProfile } from "@/hooks/useViewportProfile";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

type BottomNavItem = {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (path: string) => boolean;
};

const baseItems: BottomNavItem[] = [
  {
    label: "Inicio",
    href: ROUTES.app.dashboard,
    icon: LayoutDashboard,
    isActive: (path) => path === ROUTES.app.dashboard,
  },
  {
    label: "Vitrine",
    href: ROUTES.app.shopeeVitrine,
    icon: LayoutGrid,
    isActive: (path) => path.startsWith(ROUTES.app.shopeeVitrine),
  },
  {
    label: "Pesquisa",
    href: ROUTES.app.shopeePesquisa,
    icon: SearchCheck,
    isActive: (path) => path.startsWith(ROUTES.app.shopeePesquisa),
  },
  {
    label: "Conversor",
    href: ROUTES.app.shopeeConversor,
    icon: ArrowLeftRight,
    isActive: (path) => path.startsWith(ROUTES.app.shopeeConversor),
  },
];

const meliItem: BottomNavItem = {
  label: "Meli",
  href: ROUTES.app.vitrineMl,
  icon: ShoppingCart,
  isActive: (path) =>
    path.startsWith(ROUTES.app.vitrineMl)
    || path.startsWith(ROUTES.app.mercadolivreConfiguracoes)
    || path.startsWith(ROUTES.app.automacoesMeli)
    || path.startsWith(ROUTES.app.templatesMeli),
};

export function MobileBottomNav() {
  const location = useLocation();
  const { canSeeFeature } = useAccessControl();
  const viewport = useViewportProfile();
  const showMeli = canSeeFeature("mercadoLivre");
  const isDensePhone = viewport.isPortraitPhone || viewport.isTiny;
  const items = showMeli ? [...baseItems.slice(0, 3), meliItem, baseItems[3]] : baseItems;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <div
        className={cn(
          "mx-auto grid h-[var(--mobile-bottom-nav-height)] max-w-[720px] px-1 pb-[var(--safe-area-bottom)] pt-1",
          isDensePhone ? "gap-0.5" : "gap-1",
        )}
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item) => {
          const active = item.isActive(location.pathname);
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                "touch-target flex min-w-0 flex-col items-center justify-center rounded-xl px-1 font-medium transition-colors",
                isDensePhone ? "gap-0.5 text-2xs" : "gap-1 text-xs",
                active ? "bg-primary/10 text-primary" : "text-muted-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <item.icon className={cn(isDensePhone ? "h-[17px] w-[17px]" : "h-[18px] w-[18px]", active && "text-primary")} />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
