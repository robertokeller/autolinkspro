import { useState, useEffect, useCallback, useRef } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Loader2, ShoppingBag, RefreshCw, TrendingUp, DollarSign, Award, BadgePercent, Star } from "lucide-react";
import { useShopeeCredentials } from "@/hooks/useShopeeCredentials";
import { ShopeeCredentialsBanner } from "@/components/ShopeeCredentialsBanner";
import { ScheduleProductModal } from "@/components/shopee/ScheduleProductModal";
import { ProductCard, ProductCardSkeleton, type ShopeeProduct } from "@/components/shopee/ProductCard";
import { EmptyState } from "@/components/EmptyState";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { RoutePendingState } from "@/components/RoutePendingState";
import { backend } from "@/integrations/backend/client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { toScheduleProduct } from "@/lib/schedule-product-helpers";
import { toast } from "sonner";

interface TabConfig {
  key: "sales" | "commission" | "discount" | "rating" | "top";
  label: string;
  icon: React.ElementType;
  listType: number;
  sortType: string;
}

const TABS: TabConfig[] = [
  { key: "sales", label: "Mais Vendidos", icon: TrendingUp, listType: 0, sortType: "sales" },
  { key: "commission", label: "Maior Comissão", icon: DollarSign, listType: 0, sortType: "commission" },
  { key: "discount", label: "Maior Desconto", icon: BadgePercent, listType: 0, sortType: "discount" },
  { key: "rating", label: "Melhor Avaliação", icon: Star, listType: 0, sortType: "rating" },
  { key: "top", label: "Top Performance", icon: Award, listType: 2, sortType: "sales" },
];

type TabKey = TabConfig["key"];

const TABS_BY_KEY = Object.fromEntries(TABS.map((tab) => [tab.key, tab])) as Record<TabKey, TabConfig>;

function isEligibleAffiliateProduct(product: ShopeeProduct): boolean {
  const affiliateLink = String(product.affiliateLink || "").trim();
  if (!/^https?:\/\//i.test(affiliateLink)) return false;
  const commissionRate = Number(product.commission || 0);
  const commissionValue = Number(product.commissionValue || 0);
  return commissionRate > 0 || commissionValue > 0;
}

function toSafeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortProductsByTab(products: ShopeeProduct[], tabKey: TabKey): ShopeeProduct[] {
  const sorted = [...products];

  sorted.sort((a, b) => {
    const aSales = toSafeNumber(a.sales);
    const bSales = toSafeNumber(b.sales);
    const aCommissionValue = toSafeNumber(a.commissionValue) > 0
      ? toSafeNumber(a.commissionValue)
      : toSafeNumber(a.salePrice) * toSafeNumber(a.commission);
    const bCommissionValue = toSafeNumber(b.commissionValue) > 0
      ? toSafeNumber(b.commissionValue)
      : toSafeNumber(b.salePrice) * toSafeNumber(b.commission);
    const aCommissionRate = toSafeNumber(a.commission);
    const bCommissionRate = toSafeNumber(b.commission);
    const aDiscount = toSafeNumber(a.discount);
    const bDiscount = toSafeNumber(b.discount);
    const aRating = toSafeNumber(a.rating);
    const bRating = toSafeNumber(b.rating);

    if (tabKey === "commission") {
      return (bCommissionValue - aCommissionValue) || (bCommissionRate - aCommissionRate) || (bSales - aSales);
    }
    if (tabKey === "discount") {
      return (bDiscount - aDiscount) || (bSales - aSales) || (bRating - aRating);
    }
    if (tabKey === "rating") {
      return (bRating - aRating) || (bSales - aSales) || (bDiscount - aDiscount);
    }
    if (tabKey === "top") {
      return (bSales - aSales) || (bRating - aRating) || (bCommissionValue - aCommissionValue);
    }
    return (bSales - aSales) || (bRating - aRating) || (bDiscount - aDiscount);
  });

  return sorted;
}

interface TabState {
  products: ShopeeProduct[];
  loading: boolean;
  page: number;
  hasMore: boolean;
  loadingMore: boolean;
  fetched: boolean;
}

const emptyTab: TabState = { products: [], loading: false, page: 1, hasMore: false, loadingMore: false, fetched: false };

export default function ShopeeVitrine() {
  const { isConfigured, isLoading } = useShopeeCredentials();
  const [activeTab, setActiveTab] = useState<TabKey>("sales");
  const [tabs, setTabs] = useState<Record<TabKey, TabState>>(() =>
    (Object.fromEntries(TABS.map((t) => [t.key, { ...emptyTab }])) as Record<TabKey, TabState>)
  );
  const [scheduleProduct, setScheduleProduct] = useState<ShopeeProduct | null>(null);
  const fetchedRef = useRef(false);

  const fetchTab = useCallback(async (tabKey: TabKey, pageNum = 1, append = false) => {
    const tab = TABS_BY_KEY[tabKey];
    setTabs((prev) => ({
      ...prev,
      [tabKey]: { ...prev[tabKey], loading: !append, loadingMore: append },
    }));

    try {
      const { data: { session } } = await backend.auth.getSession();
      if (!session) throw new Error("Sessão expirada");

      const params: Record<string, unknown> = {
        sortBy: tab.sortType, listType: tab.listType, limit: 20, page: pageNum,
      };

      const res = await invokeBackendRpc<{ results?: Record<string, { products?: ShopeeProduct[]; hasMore?: boolean }> }>("shopee-batch", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { queries: [{ id: tabKey, type: "products", params }] },
      });

      const r = res.results?.[tabKey];
      const newProducts = ((r?.products || []) as ShopeeProduct[])
        .filter((item) => isEligibleAffiliateProduct(item));

      setTabs((prev) => {
        const mergedProducts = append ? [...prev[tabKey].products, ...newProducts] : newProducts;
        const orderedProducts = sortProductsByTab(mergedProducts, tabKey);

        return {
          ...prev,
          [tabKey]: {
            products: orderedProducts,
            loading: false,
            loadingMore: false,
            page: pageNum,
            hasMore: r?.hasMore === true,
            fetched: true,
          },
        };
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra carregar a vitrine");
      setTabs((prev) => ({
        ...prev,
        [tabKey]: { ...prev[tabKey], loading: false, loadingMore: false, fetched: true },
      }));
    }
  }, []);

  useEffect(() => {
    if (isConfigured && !isLoading && !fetchedRef.current) {
      fetchedRef.current = true;
      fetchTab("sales");
    }
  }, [isConfigured, isLoading, fetchTab]);

  const handleTabClick = (key: TabKey) => {
    setActiveTab(key);
    const state = tabs[key];
    if (!state?.fetched) fetchTab(key);
  };

  const refreshCurrent = () => {
    setTabs((prev) => ({ ...prev, [activeTab]: { ...emptyTab } }));
    fetchTab(activeTab);
  };

  const loadMore = () => {
    const state = tabs[activeTab];
    if (state) fetchTab(activeTab, state.page + 1, true);
  };

  if (isLoading) {
    return <RoutePendingState label="Carregando vitrine..." />;
  }

  const state = tabs[activeTab] || emptyTab;
  const anyLoading = state.loading;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader title="Vitrine" description="Produtos em destaque com links de afiliado">
        {isConfigured && (
          <Button size="sm" variant="outline" onClick={refreshCurrent} disabled={anyLoading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${anyLoading ? "animate-spin" : ""}`} />
            Atualizar
          </Button>
        )}
      </PageHeader>

      {!isConfigured && <ShopeeCredentialsBanner />}

      {isConfigured && (
        <>
          {/* Tab bar */}
          <ScrollArea className="w-full whitespace-nowrap">
            <div className="flex min-w-full justify-center gap-2.5 pb-2.5">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                return (
                  <Button
                    key={tab.key}
                    size="sm"
                    variant={activeTab === tab.key ? "default" : "outline"}
                    className="h-9 shrink-0 gap-2 rounded-full px-4 text-sm"
                    onClick={() => handleTabClick(tab.key)}
                    disabled={state.loading}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </Button>
                );
              })}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>

          {/* Loading */}
          {state.loading && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:gap-5">
              {Array.from({ length: 8 }).map((_, i) => <ProductCardSkeleton key={i} />)}
            </div>
          )}

          {/* Products */}
          {!state.loading && state.products.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:gap-5">
                {state.products.map((p, idx) => (
                  <ProductCard key={p.id} product={p} onSchedule={setScheduleProduct} priorityImage={idx < 4} />
                ))}
              </div>
              {state.hasMore && (
                <div className="flex justify-center pt-5">
                  <Button variant="outline" onClick={loadMore} disabled={state.loadingMore}>
                    {state.loadingMore ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <ShoppingBag className="h-4 w-4 mr-1.5" />}
                    Carregar mais
                  </Button>
                </div>
              )}
            </>
          )}

          {!state.loading && state.fetched && state.products.length === 0 && (
            <EmptyState icon={ShoppingBag} title="Nenhum produto" description="Nenhum produto encontrado. Tenta atualizar." />
          )}
        </>
      )}

      <ScheduleProductModal
        open={!!scheduleProduct}
        onOpenChange={(open) => { if (!open) setScheduleProduct(null); }}
        product={scheduleProduct ? toScheduleProduct(scheduleProduct) : undefined}
      />
    </div>
  );
}
