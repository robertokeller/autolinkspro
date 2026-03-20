import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Loader2, ShoppingBag, SlidersHorizontal, ChevronDown, ChevronRight, LayoutList } from "lucide-react";
import { useShopeeCredentials } from "@/hooks/useShopeeCredentials";
import { ShopeeCredentialsBanner } from "@/components/ShopeeCredentialsBanner";
import { ScheduleProductModal } from "@/components/shopee/ScheduleProductModal";
import { ProductCard, ProductCardSkeleton, type ShopeeProduct } from "@/components/shopee/ProductCard";
import { EmptyState } from "@/components/EmptyState";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { backend } from "@/integrations/backend/client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { toast } from "sonner";
import { SHOPEE_CATEGORIES, deduplicateProducts, type ShopeeCategory } from "@/lib/shopee-categories";
import { toScheduleProduct } from "@/lib/schedule-product-helpers";
import { cn } from "@/lib/utils";
import { RoutePendingState } from "@/components/RoutePendingState";
import { useViewportProfile } from "@/hooks/useViewportProfile";

function isEligibleAffiliateProduct(product: ShopeeProduct): boolean {
  const affiliateLink = String(product.affiliateLink || "").trim();
  if (!/^https?:\/\//i.test(affiliateLink)) return false;
  const commissionRate = Number(product.commission || 0);
  const commissionValue = Number(product.commissionValue || 0);
  return commissionRate > 0 || commissionValue > 0;
}

function getVisualCategoryIcon(icon: string) {
  const value = String(icon || "").trim();
  if (!value) return null;
  // Ignore technical short codes such as CEL, MODA, MASC.
  if (/^[A-Z0-9]{2,6}$/.test(value)) return null;
  return value;
}

export default function ShopeePesquisa() {
  const { isConfigured, isLoading } = useShopeeCredentials();
  const viewport = useViewportProfile();
  const isMobileView = viewport.isMobile || viewport.isTiny;
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [products, setProducts] = useState<ShopeeProduct[]>([]);
  const [searched, setSearched] = useState(false);
  const [sortBy, setSortBy] = useState("sales");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [minDiscount, setMinDiscount] = useState(0);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minCommission, setMinCommission] = useState(0);

  // Category navigation
  const [activeCatId, setActiveCatId] = useState<number | null>(null);
  const [activeSubId, setActiveSubId] = useState<number | null>(null);
  const [expandedCatIds, setExpandedCatIds] = useState<Set<number>>(new Set());

  // Schedule modal
  const [scheduleProduct, setScheduleProduct] = useState<ShopeeProduct | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const categoryListTypeRef = useRef<Map<number, 3 | 4>>(new Map());

  // Auto-load first category on mount
  useEffect(() => {
    const first = SHOPEE_CATEGORIES[0];
    if (first && isConfigured) {
      setActiveCatId(first.id);
      // Auto-expand first category if it has subcategories
      if (first.subcategories.length > 0) {
        setExpandedCatIds(new Set([first.id]));
      }
      fetchByCategory(first.id, 3, 1, false, first.label);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigured]);

  // The active category object
  const activeCat = useMemo(
    () => SHOPEE_CATEGORIES.find((c) => c.id === activeCatId) || null,
    [activeCatId]
  );

  // Label for breadcrumb
  const activeLabel = useMemo(() => {
    if (activeSubId && activeCat) {
      const sub = activeCat.subcategories.find((s) => s.id === activeSubId);
      const icon = getVisualCategoryIcon(activeCat.icon);
      const prefix = icon ? `${icon} ` : "";
      return sub ? `${prefix}${activeCat.label} > ${sub.label}` : null;
    }
    if (activeCat) {
      const icon = getVisualCategoryIcon(activeCat.icon);
      const prefix = icon ? `${icon} ` : "";
      return `${prefix}${activeCat.label}`;
    }
    return null;
  }, [activeCat, activeSubId]);

  // API call: fetch by category using Shopee matchId + listType (3=L1, 4=L2)
  const fetchByCategory = useCallback(async (
    matchId: number,
    listType: number,
    pageNum = 1,
    append = false,
    fallbackKeyword = "",
  ) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (append) setLoadingMore(true);
    else { setSearching(true); setProducts([]); setSearched(false); }

    try {
      const { data: { session } } = await backend.auth.getSession();
      if (!session) { toast.error("Sessão expirada. Faça login de novo."); return; }

      const runCategoryQuery = (params: Record<string, unknown>) => invokeBackendRpc<{ results?: Record<string, { products?: ShopeeProduct[]; hasMore?: boolean; error?: string }> }>("shopee-batch", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: {
          queries: [{
            id: "cat",
            type: "search",
            params,
          }],
        },
      });

      const preferredListType: 3 | 4 = categoryListTypeRef.current.get(matchId) ?? (listType === 4 ? 4 : 3);
      let resolvedListType: 3 | 4 = preferredListType;

      const res = await runCategoryQuery({ matchId, listType: preferredListType, sortBy, limit: 20, page: pageNum });

      if (controller.signal.aborted) return;

      let r = res.results?.cat;
      const canFallback = !append && !!fallbackKeyword.trim();
      const normalizedError = String(r?.error || "").toLowerCase();
      const hasCategoryTypeError = normalizedError.includes("wrong type");

      // Some Shopee categories can flip between listType 3/4 depending on backend changes.
      if (hasCategoryTypeError) {
        const alternateListType: 3 | 4 = preferredListType === 3 ? 4 : 3;
        const retryRes = await runCategoryQuery({ matchId, listType: alternateListType, sortBy, limit: 20, page: pageNum });
        if (controller.signal.aborted) return;

        const retryResult = retryRes.results?.cat;
        if (!retryResult?.error) {
          resolvedListType = alternateListType;
          categoryListTypeRef.current.set(matchId, resolvedListType);
          r = retryResult;
        }
      }

      if (!r?.error) {
        categoryListTypeRef.current.set(matchId, resolvedListType);
      }

      const finalError = String(r?.error || "").toLowerCase();
      const shouldFallbackByType = finalError.includes("wrong type");
      const shouldFallbackByUpstream = finalError.includes("system error") || finalError.includes("fetch failed");

      if ((shouldFallbackByType || shouldFallbackByUpstream) && canFallback) {
        const fallbackRes = await runCategoryQuery({ keyword: fallbackKeyword.trim(), sortBy, limit: 20, page: pageNum });

        r = fallbackRes.results?.cat;
      }

      if (r?.error) { toast.error(r.error); if (!append) setProducts([]); return; }

      const newProducts = deduplicateProducts((r?.products || []) as ShopeeProduct[])
        .filter((item) => isEligibleAffiliateProduct(item));
      setProducts(append ? (prev) => deduplicateProducts([...prev, ...newProducts]) : newProducts);
      setHasMore(r?.hasMore === true);
      setPage(pageNum);
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : "Não deu pra carregar essa categoria");
        if (!append) setProducts([]);
      }
    } finally {
      if (!controller.signal.aborted) {
        setSearching(false);
        setLoadingMore(false);
        setSearched(true);
      }
    }
  }, [sortBy]);

  // API call: text search
  const doSearch = useCallback(async (keyword: string, pageNum = 1, append = false) => {
    if (!keyword.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (append) setLoadingMore(true);
    else { setSearching(true); setProducts([]); setSearched(false); }

    try {
      const { data: { session } } = await backend.auth.getSession();
      if (!session) { toast.error("Sessão expirada. Faça login de novo."); return; }

      const res = await invokeBackendRpc<{ results?: Record<string, { products?: ShopeeProduct[]; hasMore?: boolean; error?: string }> }>("shopee-batch", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: {
          queries: [{
            id: "search",
            type: "search",
            params: { keyword: keyword.trim(), sortBy, limit: 20, page: pageNum },
          }],
        },
      });

      if (controller.signal.aborted) return;

      const r = res.results?.search;
      if (r?.error) { toast.error(r.error); if (!append) setProducts([]); return; }

      const newProducts = deduplicateProducts((r?.products || []) as ShopeeProduct[])
        .filter((item) => isEligibleAffiliateProduct(item));
      setProducts(append ? (prev) => deduplicateProducts([...prev, ...newProducts]) : newProducts);
      setHasMore(r?.hasMore === true);
      setPage(pageNum);
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : "Erro na busca");
        if (!append) setProducts([]);
      }
    } finally {
      if (!controller.signal.aborted) {
        setSearching(false);
        setLoadingMore(false);
        setSearched(true);
      }
    }
  }, [sortBy]);

  // Handlers
  const handleSearch = () => {
    if (!searchQuery.trim()) return;
    setActiveCatId(null);
    setActiveSubId(null);
    doSearch(searchQuery, 1);
  };

  const handleCategoryClick = (cat: ShopeeCategory) => {
    // Toggle expand if has subcategories
    if (cat.subcategories.length > 0) {
      setExpandedCatIds((prev) => {
        const next = new Set(prev);
        if (next.has(cat.id)) next.delete(cat.id);
        else next.add(cat.id);
        return next;
      });
    }
    setActiveCatId(cat.id);
    setActiveSubId(null);
    setSearchQuery("");
    fetchByCategory(cat.id, 3, 1, false, cat.label);
  };

  const handleSubClick = (catId: number, subId: number) => {
    setActiveCatId(catId);
    setActiveSubId(subId);
    setSearchQuery("");
    const parentCategory = SHOPEE_CATEGORIES.find((cat) => cat.id === catId);
    const subLabel = parentCategory?.subcategories.find((sub) => sub.id === subId)?.label || "";
    const fallbackKeyword = `${parentCategory?.label || ""} ${subLabel}`.trim();
    fetchByCategory(subId, 4, 1, false, fallbackKeyword);
  };

  const loadMore = () => {
    if (searchQuery.trim()) {
      doSearch(searchQuery, page + 1, true);
    } else if (activeSubId) {
      fetchByCategory(activeSubId, 4, page + 1, true);
    } else if (activeCatId) {
      fetchByCategory(activeCatId, 3, page + 1, true);
    }
  };

  // Client-side filters
  const filtered = products.filter((p) => {
    if (minDiscount > 0 && p.discount < minDiscount) return false;
    if (minPrice && p.salePrice < Number(minPrice)) return false;
    if (maxPrice && p.salePrice > Number(maxPrice)) return false;
    if (minCommission > 0 && p.commission * 100 < minCommission) return false;
    return true;
  });

  if (isLoading) {
    return <RoutePendingState label="Carregando pesquisa..." />;
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader title="Pesquisa de ofertas" description="Navegue por categorias ou busque pelo nome" />
      {!isConfigured && <ShopeeCredentialsBanner />}

      {isConfigured && (
        <>
          {/* Search + Sort bar */}
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <Input
              placeholder="Buscar produtos..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="flex-1"
            />
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sales">Mais vendidos</SelectItem>
                <SelectItem value="relevancy">Relevância</SelectItem>
                <SelectItem value="price_asc">Menor preço</SelectItem>
                <SelectItem value="price_desc">Maior preço</SelectItem>
                <SelectItem value="commission">Maior comissão</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleSearch} disabled={searching} className="sm:self-auto">
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>

          {/* Main layout: sidebar + content */}
          <div className="flex flex-col items-start gap-5 lg:flex-row">

            {/* Category Sidebar - collapsible on mobile */}
            {isMobileView ? (
              <Collapsible open={categoriesOpen} onOpenChange={setCategoriesOpen} className="w-full">
                <CollapsibleTrigger asChild>
                  <Button variant="outline" className="w-full justify-between gap-2 h-11">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <LayoutList className="h-4 w-4" />
                      {activeLabel || "Categorias"}
                    </span>
                    <ChevronDown className={cn("h-4 w-4 transition-transform", categoriesOpen && "rotate-180")} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="rounded-xl border bg-card overflow-hidden">
                    <ScrollArea className="h-56">
                      <nav className="p-1.5 space-y-0.5">
                  {SHOPEE_CATEGORIES.map((cat) => {
                    const isExpanded = expandedCatIds.has(cat.id);
                    const isCatActive = activeCatId === cat.id && !activeSubId;
                    const hasSubs = cat.subcategories.length > 0;
                    const visualIcon = getVisualCategoryIcon(cat.icon);

                    return (
                      <div key={cat.id}>
                        {/* Category row */}
                        <button
                          onClick={() => handleCategoryClick(cat)}
                          disabled={searching}
                          className={cn(
                            "w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-all duration-150 text-left group",
                            isCatActive
                              ? "bg-primary text-primary-foreground font-medium"
                              : "hover:bg-accent text-foreground"
                          )}
                        >
                          {visualIcon && <span className="text-base leading-none shrink-0">{visualIcon}</span>}
                          <span className="flex-1 truncate text-xs font-medium">{cat.label}</span>
                          {hasSubs && (
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                                isExpanded ? "rotate-90" : "",
                                isCatActive ? "text-primary-foreground/70" : "text-muted-foreground"
                              )}
                            />
                          )}
                        </button>

                        {/* Subcategory rows */}
                        {hasSubs && isExpanded && (
                          <div className="ml-3 mt-0.5 mb-0.5 pl-2.5 border-l border-border space-y-0.5 animate-fade-in">
                            {cat.subcategories.map((sub) => {
                              const isSubActive = activeSubId === sub.id;
                              return (
                                <button
                                  key={sub.id}
                                  onClick={() => handleSubClick(cat.id, sub.id)}
                                  disabled={searching}
                                  className={cn(
                                    "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-all duration-150 text-left",
                                    isSubActive
                                      ? "bg-primary/15 text-primary font-semibold"
                                      : "hover:bg-accent text-muted-foreground hover:text-foreground"
                                  )}
                                >
                                  <span className="w-1 h-1 rounded-full bg-current shrink-0 opacity-60" />
                                  {sub.label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </nav>
              </ScrollArea>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <aside className="sticky top-4 w-full shrink-0 overflow-hidden rounded-xl border bg-card lg:w-60">
                <div className="px-3 py-2.5 border-b bg-muted/40">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Categorias</p>
                </div>
                <ScrollArea className="h-64 lg:h-[calc(100vh-220px)]">
                  <nav className="p-1.5 space-y-0.5">
                    {SHOPEE_CATEGORIES.map((cat) => {
                      const isExpanded = expandedCatIds.has(cat.id);
                      const isCatActive = activeCatId === cat.id && !activeSubId;
                      const hasSubs = cat.subcategories.length > 0;
                      const visualIcon = getVisualCategoryIcon(cat.icon);

                      return (
                        <div key={cat.id}>
                          <button
                            onClick={() => handleCategoryClick(cat)}
                            disabled={searching}
                            className={cn(
                              "w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-all duration-150 text-left group",
                              isCatActive
                                ? "bg-primary text-primary-foreground font-medium"
                                : "hover:bg-accent text-foreground"
                            )}
                          >
                            {visualIcon && <span className="text-base leading-none shrink-0">{visualIcon}</span>}
                            <span className="flex-1 truncate text-xs font-medium">{cat.label}</span>
                            {hasSubs && (
                              <ChevronRight
                                className={cn(
                                  "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                                  isExpanded ? "rotate-90" : "",
                                  isCatActive ? "text-primary-foreground/70" : "text-muted-foreground"
                                )}
                              />
                            )}
                          </button>

                          {hasSubs && isExpanded && (
                            <div className="ml-3 mt-0.5 mb-0.5 pl-2.5 border-l border-border space-y-0.5 animate-fade-in">
                              {cat.subcategories.map((sub) => {
                                const isSubActive = activeSubId === sub.id;
                                return (
                                  <button
                                    key={sub.id}
                                    onClick={() => handleSubClick(cat.id, sub.id)}
                                    disabled={searching}
                                    className={cn(
                                      "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-all duration-150 text-left",
                                      isSubActive
                                        ? "bg-primary/15 text-primary font-semibold"
                                        : "hover:bg-accent text-muted-foreground hover:text-foreground"
                                    )}
                                  >
                                    <span className="w-1 h-1 rounded-full bg-current shrink-0 opacity-60" />
                                    {sub.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </nav>
                </ScrollArea>
              </aside>
            )}

            {/* Products area */}
            <div className="min-w-0 flex-1 space-y-5">

              {/* Active context label */}
              {(activeLabel || (searchQuery && searched && !searching && !activeCatId)) && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {activeLabel ? (
                    <span>Mostrando: <span className="font-medium text-foreground">{activeLabel}</span></span>
                  ) : (
                    <>
                      <Search className="h-3.5 w-3.5" />
                      Resultados para "<span className="font-medium text-foreground">{searchQuery}</span>"
                    </>
                  )}
                </div>
              )}

              {/* Filters */}
              {searched && products.length > 0 && (
                <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {filtered.length} de {products.length} produtos
                    </span>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-xs">
                        <SlidersHorizontal className="h-3.5 w-3.5 mr-1" />
                        Filtros
                        <ChevronDown className={cn("h-3 w-3 ml-1 transition-transform", filtersOpen ? "rotate-180" : "")} />
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="pt-3">
                    <div className="grid grid-cols-1 gap-3 rounded-lg border bg-card p-3 min-[420px]:grid-cols-2 md:grid-cols-4 md:gap-4 md:p-4">
                      <div className="space-y-2">
                        <Label className="text-sm">Desconto mínimo: {minDiscount}%</Label>
                        <Slider value={[minDiscount]} onValueChange={([v]) => setMinDiscount(v)} max={90} step={5} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm">Comissão mínima: {minCommission}%</Label>
                        <Slider value={[minCommission]} onValueChange={([v]) => setMinCommission(v)} max={50} step={1} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm">Preço mínimo</Label>
                        <Input type="number" placeholder="R$ 0" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} className="h-9 text-sm" />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-sm">Preço máximo</Label>
                        <Input type="number" placeholder="R$ 9999" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className="h-9 text-sm" />
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}

              {/* Loading skeletons */}
              {searching && (
                <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 md:gap-4 lg:grid-cols-4 xl:gap-5">
                  {Array.from({ length: 8 }).map((_, i) => <ProductCardSkeleton key={i} index={i} />)}
                </div>
              )}

              {/* Product grid */}
              {!searching && filtered.length > 0 && (
                <>
                  <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 md:gap-4 lg:grid-cols-4 xl:gap-5">
                    {filtered.map((p) => (
                      <ProductCard key={p.id} product={p} onSchedule={setScheduleProduct} />
                    ))}
                  </div>
                  {hasMore && (
                    <div className="flex justify-center pt-4">
                      <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                        {loadingMore ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <ShoppingBag className="h-4 w-4 mr-1.5" />}
                        Carregar mais
                      </Button>
                    </div>
                  )}
                </>
              )}

              {/* Empty states */}
              {!searching && searched && filtered.length === 0 && (
                <EmptyState icon={Search} title="Nada encontrado" description="Tente outra palavra-chave, categoria, ou mude os filtros." />
              )}

              {!searched && !searching && isConfigured && (
                <EmptyState icon={Search} title="Explore ofertas" description="Escolha uma categoria ao lado ou busque pelo nome do produto." />
              )}
            </div>
          </div>
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
