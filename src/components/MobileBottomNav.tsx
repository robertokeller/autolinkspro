import { LayoutDashboard, SearchCheck, ArrowLeftRight, LayoutGrid, ShoppingCart } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useAccessControl } from "@/hooks/useAccessControl";
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
  const showMeli = canSeeFeature("mercadoLivre");
  const items = showMeli ? [...baseItems.slice(0, 3), meliItem, baseItems[3]] : baseItems;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden">
      <div
        className="grid h-[var(--mobile-bottom-nav-height)] px-1 pb-[var(--safe-area-bottom)] pt-1"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item) => {
          const active = item.isActive(location.pathname);
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                "touch-target flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium transition-colors",
                active ? "bg-primary/10 text-primary" : "text-muted-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <item.icon className={cn("h-[18px] w-[18px]", active && "text-primary")} />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
