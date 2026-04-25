import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { PageWrapper } from "@/components/PageWrapper";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShopeeCredentialsBanner } from "@/components/ShopeeCredentialsBanner";
import { useShopeeCredentials } from "@/hooks/useShopeeCredentials";
import { backend } from "@/integrations/backend/client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { cn } from "@/lib/utils";
import { AlertTriangle, BarChart3, CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Clock3, Filter, Layers3, MousePointerClick, Package, RefreshCw, Search, ShoppingCart, Sparkles, Store, TrendingUp, Wallet } from "lucide-react";
import { toast } from "sonner";

type ShopeeReportPreset = "7d" | "30d" | "60d" | "90d" | "custom";
type ShopeeReportSource = "conversion" | "validated";

type ShopeeReportRow = {
  source: "conversion" | "validated";
  purchaseTime: number;
  clickTime: number;
  conversionId: string;
  orderId: string;
  orderStatus: string;
  itemId: string;
  itemName: string;
  shopName: string;
  qty: number;
  actualAmount: number;
  totalCommission: number;
  netCommission: number;
  referrer: string;
  utmContent: string;
  fraudStatus: string;
  displayItemStatus: string;
};

type ShopeeReportStatusPoint = {
  status: string;
  count: number;
};

type ShopeeReportShopPoint = {
  shopId: string;
  shopName: string;
  sales: number;
  totalCommission: number;
  items: number;
  orders: number;
};

type ShopeeReportDailyPoint = {
  date: string;
  sales: number;
  totalCommission: number;
  netCommission: number;
  orders: number;
  items: number;
};

type ShopeeReportSummary = {
  conversions: number;
  orders: number;
  items: number;
  totalSales: number;
  totalCommission: number;
  netCommission: number;
  sellerCommission?: number;
  shopeeCommission?: number;
  averageTicket: number;
  cancelledOrders: number;
  pendingOrders: number;
  completedOrders: number;
  unpaidOrders: number;
  fraudItems: number;
};

type ShopeeReportBlock = {
  summary: ShopeeReportSummary;
  rows: ShopeeReportRow[];
  daily: ShopeeReportDailyPoint[];
  statusBreakdown: ShopeeReportStatusPoint[];
  topShops: ShopeeReportShopPoint[];
  pagesScanned: number;
  rawConversions: number;
};

type ShopeeReportsResponse = {
  success: true;
  currency: string;
  period: {
    startDate: string;
    endDate: string;
    startTimestamp: number;
    endTimestamp: number;
  };
  conversion: ShopeeReportBlock;
  validated: ShopeeReportBlock;
};

type DateRange = {
  startDate: string;
  endDate: string;
};

type ShopeeReportFilters = {
  orderStatus: "ALL" | "UNPAID" | "PENDING" | "COMPLETED" | "CANCELLED";
  buyerType: "ALL" | "NEW" | "EXISTING";
};

const DEFAULT_REPORT_FILTERS: ShopeeReportFilters = {
  orderStatus: "ALL",
  buyerType: "ALL",
};

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildPresetRange(preset: Exclude<ShopeeReportPreset, "custom">): DateRange {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : preset === "60d" ? 60 : 90;
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: toYmd(start), endDate: toYmd(end) };
}

function isValidYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isFunctionNotImplementedError(message: string): boolean {
  const normalized = String(message || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return normalized.includes("funcao nao implementada");
}

function toRpcFilters(filters: ShopeeReportFilters): Record<string, string> {
  return {
    orderStatus: filters.orderStatus,
    buyerType: filters.buyerType,
  };
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: currency || "BRL",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("pt-BR").format(Number.isFinite(value) ? value : 0);
}

function formatDateTime(timestampSec: number): string {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return "-";
  const date = new Date(timestampSec * 1000);
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "COMPLETED") return "default";
  if (normalized === "PENDING" || normalized === "UNPAID") return "secondary";
  if (normalized === "CANCELLED" || normalized === "FRAUD") return "destructive";
  return "outline";
}

type ClickAggregatePoint = {
  key: string;
  label: string;
  clicks: number;
  share: number;
};

type ReportClickInsights = {
  totalClicks: number;
  peakHour: { label: string; clicks: number } | null;
  byHour: ClickAggregatePoint[];
  byChannel: ClickAggregatePoint[];
  bySubId: ClickAggregatePoint[];
};

type ReportProductPoint = {
  key: string;
  itemName: string;
  sales: number;
  totalCommission: number;
  items: number;
  orders: number;
};

type ReportSalesBreakdownPoint = {
  key: string;
  label: string;
  sales: number;
  totalCommission: number;
  items: number;
  orders: number;
};

function formatHourBucket(timestampSec: number): string {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return "Sem horario";
  const date = new Date(timestampSec * 1000);
  const hour = String(date.getHours()).padStart(2, "0");
  return `${hour}:00 - ${hour}:59`;
}

function normalizeSubId(rawValue: string): string {
  const raw = String(rawValue || "").trim();
  if (!raw || raw === "----" || raw === "-" || raw.toLowerCase() === "null") return "Sem Sub ID";
  const firstToken = raw.split(/[\s|,;]+/)[0] || raw;
  return firstToken.length > 40 ? firstToken.slice(0, 40) : firstToken;
}

function toClickAggregatePoints(sourceMap: Map<string, number>, total: number): ClickAggregatePoint[] {
  if (total <= 0) return [];
  return Array.from(sourceMap.entries())
    .map(([label, clicks]) => ({
      key: label,
      label,
      clicks,
      share: Number(((clicks / total) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.clicks - a.clicks || a.label.localeCompare(b.label));
}

function buildClickInsights(rows: ShopeeReportRow[]): ReportClickInsights {
  const uniqueEvents = new Map<string, { clickTime: number; channel: string; subId: string }>();

  for (const row of rows) {
    const conversionKey = String(row.conversionId || "").trim() || `${row.orderId || "sem-pedido"}:${row.itemId || "sem-item"}`;
    if (uniqueEvents.has(conversionKey)) continue;

    uniqueEvents.set(conversionKey, {
      clickTime: Number(row.clickTime || 0),
      channel: String(row.referrer || "").trim() || "Desconhecido",
      subId: normalizeSubId(String(row.utmContent || "")),
    });
  }

  const events = Array.from(uniqueEvents.values()).filter((event) => event.clickTime > 0);
  const hourMap = new Map<string, number>();
  const channelMap = new Map<string, number>();
  const subIdMap = new Map<string, number>();

  for (const event of events) {
    const hourLabel = formatHourBucket(event.clickTime);
    hourMap.set(hourLabel, (hourMap.get(hourLabel) || 0) + 1);
    channelMap.set(event.channel, (channelMap.get(event.channel) || 0) + 1);
    subIdMap.set(event.subId, (subIdMap.get(event.subId) || 0) + 1);
  }

  const totalClicks = events.length;
  const byHour = toClickAggregatePoints(hourMap, totalClicks);
  const byChannel = toClickAggregatePoints(channelMap, totalClicks);
  const bySubId = toClickAggregatePoints(subIdMap, totalClicks);

  return {
    totalClicks,
    peakHour: byHour.length > 0 ? { label: byHour[0].label, clicks: byHour[0].clicks } : null,
    byHour,
    byChannel,
    bySubId,
  };
}

function buildTopProducts(rows: ShopeeReportRow[]): ReportProductPoint[] {
  const byProduct = new Map<string, {
    key: string;
    itemName: string;
    sales: number;
    totalCommission: number;
    items: number;
    orderIds: Set<string>;
  }>();

  for (const row of rows) {
    const productKey = String(row.itemId || "").trim() || String(row.itemName || "").trim().toLowerCase() || "item-desconhecido";
    const current = byProduct.get(productKey) || {
      key: productKey,
      itemName: String(row.itemName || "Item sem nome").trim() || "Item sem nome",
      sales: 0,
      totalCommission: 0,
      items: 0,
      orderIds: new Set<string>(),
    };

    current.sales += Number(row.actualAmount || 0);
    current.totalCommission += Number(row.totalCommission || 0);
    current.items += Math.max(1, Number(row.qty || 0));
    if (row.orderId) current.orderIds.add(String(row.orderId));
    byProduct.set(productKey, current);
  }

  return Array.from(byProduct.values())
    .map((entry) => ({
      key: entry.key,
      itemName: entry.itemName,
      sales: Number(entry.sales.toFixed(2)),
      totalCommission: Number(entry.totalCommission.toFixed(2)),
      items: entry.items,
      orders: entry.orderIds.size,
    }))
    .sort((a, b) => b.totalCommission - a.totalCommission || b.sales - a.sales || b.items - a.items)
    .slice(0, 60);
}

function buildSalesBreakdown(
  rows: ShopeeReportRow[],
  labelFromRow: (row: ShopeeReportRow) => string,
): ReportSalesBreakdownPoint[] {
  const breakdown = new Map<string, {
    key: string;
    label: string;
    sales: number;
    totalCommission: number;
    items: number;
    orderIds: Set<string>;
  }>();

  for (const row of rows) {
    const label = labelFromRow(row);
    const key = label.toLowerCase();
    const current = breakdown.get(key) || {
      key,
      label,
      sales: 0,
      totalCommission: 0,
      items: 0,
      orderIds: new Set<string>(),
    };

    current.sales += Number(row.actualAmount || 0);
    current.totalCommission += Number(row.totalCommission || 0);
    current.items += Math.max(1, Number(row.qty || 0));
    if (row.orderId) current.orderIds.add(row.orderId);
    breakdown.set(key, current);
  }

  return Array.from(breakdown.values())
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      sales: Number(entry.sales.toFixed(2)),
      totalCommission: Number(entry.totalCommission.toFixed(2)),
      items: entry.items,
      orders: entry.orderIds.size,
    }))
    .sort((a, b) => b.totalCommission - a.totalCommission || b.sales - a.sales || b.orders - a.orders);
}

type ReportKpiTone = "primary" | "success" | "info" | "warning";

type PageSlice<T> = {
  pageItems: T[];
  page: number;
  totalPages: number;
  from: number;
  to: number;
  total: number;
};

function paginateByPage<T>(items: T[], requestedPage: number, pageSize: number): PageSlice<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const startIndex = (page - 1) * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);
  const from = total === 0 ? 0 : startIndex + 1;
  const to = total === 0 ? 0 : Math.min(total, startIndex + pageItems.length);

  return {
    pageItems,
    page,
    totalPages,
    from,
    to,
    total,
  };
}

function ReportSectionHeader(props: {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  action?: ReactNode;
}) {
  const { title, description, icon: Icon, action } = props;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <CardTitle className="text-sm sm:text-base">{title}</CardTitle>
        </div>
        <CardDescription className="pl-9 text-xs sm:text-sm">{description}</CardDescription>
      </div>
      {action ? <div className="w-full shrink-0 sm:w-auto">{action}</div> : null}
    </div>
  );
}

function TablePager(props: {
  page: number;
  totalPages: number;
  from: number;
  to: number;
  total: number;
  itemLabel: string;
  onPageChange: (nextPage: number) => void;
  className?: string;
}) {
  const { page, totalPages, from, to, total, itemLabel, onPageChange, className } = props;

  if (total <= 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3", className)}>
      <p className="text-xs text-muted-foreground">
        {`Mostrando ${formatNumber(from)}-${formatNumber(to)} de ${formatNumber(total)} ${itemLabel}`}
      </p>

      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          disabled={page <= 1}
          onClick={() => onPageChange(1)}
          aria-label="Primeira pagina"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Pagina anterior"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[68px] text-center text-xs font-semibold text-muted-foreground">
          {`${formatNumber(page)} / ${formatNumber(totalPages)}`}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="Proxima pagina"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          disabled={page >= totalPages}
          onClick={() => onPageChange(totalPages)}
          aria-label="Ultima pagina"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function DataTableShell(props: {
  minWidth: number;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/70 bg-background/70">
      <div className="w-full" style={{ minWidth: props.minWidth }}>
        {props.children}
      </div>
    </div>
  );
}

function ReportKpiCard(props: {
  title: string;
  value: string;
  sub?: string;
  icon: ComponentType<{ className?: string }>;
  tone?: ReportKpiTone;
}) {
  const { title, value, sub, icon: Icon, tone = "primary" } = props;

  const toneIconClasses: Record<ReportKpiTone, string> = {
    primary: "bg-primary/12 text-primary",
    success: "bg-success/12 text-success",
    info: "bg-info/12 text-info",
    warning: "bg-warning/12 text-warning",
  };

  return (
    <Card className="glass border-border/60 shadow-sm">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
          <span className={cn("inline-flex h-8 w-8 items-center justify-center rounded-lg", toneIconClasses[tone])}>
            <Icon className="h-4 w-4" />
          </span>
        </div>
        <p className="text-xl font-bold tracking-tight text-foreground">{value}</p>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

function ReportBlockView(props: {
  title: string;
  block: ShopeeReportBlock;
  currency: string;
  source: ShopeeReportSource;
}) {
  const { title, block, currency, source } = props;

  const sourceLabel = source === "conversion" ? "Comissoes estimadas" : "Comissoes validadas";
  const sourceHint = source === "conversion"
    ? "Leitura de conversoes em tempo real para monitorar tendencia e projecao de receita."
    : "Base validada pela plataforma para fechamento financeiro e conciliacao final.";

  const [salesSearch, setSalesSearch] = useState("");
  const [clickChannelPage, setClickChannelPage] = useState(1);
  const [clickSubIdPage, setClickSubIdPage] = useState(1);
  const [productPage, setProductPage] = useState(1);
  const [salesChannelPage, setSalesChannelPage] = useState(1);
  const [salesSubIdPage, setSalesSubIdPage] = useState(1);
  const [dailyPage, setDailyPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);

  const clickInsights = useMemo(() => buildClickInsights(block.rows), [block.rows]);
  const topProducts = useMemo(() => buildTopProducts(block.rows), [block.rows]);
  const channelSalesBreakdown = useMemo(
    () => buildSalesBreakdown(block.rows, (row) => String(row.referrer || "").trim() || "Desconhecido"),
    [block.rows],
  );
  const subIdSalesBreakdown = useMemo(
    () => buildSalesBreakdown(block.rows, (row) => normalizeSubId(String(row.utmContent || ""))),
    [block.rows],
  );

  const filteredRows = useMemo(() => {
    const needle = salesSearch.trim().toLowerCase();
    if (!needle) return block.rows;
    return block.rows.filter((row) => {
      const haystack = [row.itemName, row.shopName, row.orderId, row.conversionId, row.utmContent]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [block.rows, salesSearch]);

  const statusItems = useMemo(
    () => [
      {
        key: "completed",
        label: "Completed",
        count: block.summary.completedOrders,
        badgeVariant: "success" as const,
        barClass: "bg-success/80",
      },
      {
        key: "pending",
        label: "Pending",
        count: block.summary.pendingOrders,
        badgeVariant: "warning" as const,
        barClass: "bg-warning/80",
      },
      {
        key: "cancelled",
        label: "Cancelled",
        count: block.summary.cancelledOrders,
        badgeVariant: "destructive" as const,
        barClass: "bg-destructive/80",
      },
      {
        key: "unpaid",
        label: "Unpaid",
        count: block.summary.unpaidOrders,
        badgeVariant: "secondary" as const,
        barClass: "bg-muted-foreground/70",
      },
    ],
    [block.summary.cancelledOrders, block.summary.completedOrders, block.summary.pendingOrders, block.summary.unpaidOrders],
  );

  const trackedSubIds = useMemo(
    () => clickInsights.bySubId.filter((item) => item.label !== "Sem Sub ID").length,
    [clickInsights.bySubId],
  );
  const statusTotal = useMemo(
    () => statusItems.reduce((sum, item) => sum + item.count, 0),
    [statusItems],
  );
  const coveragePercent = useMemo(() => {
    if (block.rawConversions <= 0) return 0;
    return Math.max(0, Math.min(100, (block.summary.conversions / block.rawConversions) * 100));
  }, [block.rawConversions, block.summary.conversions]);

  const dailySeries = useMemo(() => [...block.daily].sort((a, b) => a.date.localeCompare(b.date)), [block.daily]);

  useEffect(() => {
    setHistoryPage(1);
  }, [salesSearch]);

  const pagedClickChannels = useMemo(
    () => paginateByPage(clickInsights.byChannel, clickChannelPage, 8),
    [clickChannelPage, clickInsights.byChannel],
  );
  const pagedClickSubIds = useMemo(
    () => paginateByPage(clickInsights.bySubId, clickSubIdPage, 8),
    [clickSubIdPage, clickInsights.bySubId],
  );
  const pagedTopProducts = useMemo(
    () => paginateByPage(topProducts, productPage, 8),
    [productPage, topProducts],
  );
  const pagedSalesChannels = useMemo(
    () => paginateByPage(channelSalesBreakdown, salesChannelPage, 8),
    [channelSalesBreakdown, salesChannelPage],
  );
  const pagedSalesSubIds = useMemo(
    () => paginateByPage(subIdSalesBreakdown, salesSubIdPage, 8),
    [salesSubIdPage, subIdSalesBreakdown],
  );
  const pagedDaily = useMemo(
    () => paginateByPage(dailySeries, dailyPage, 7),
    [dailyPage, dailySeries],
  );
  const pagedHistory = useMemo(
    () => paginateByPage(filteredRows, historyPage, 12),
    [filteredRows, historyPage],
  );

  const maxHourlyClicks = clickInsights.byHour[0]?.clicks || 1;

  return (
    <div className="space-y-6">
      <Card className="glass relative overflow-hidden border-border/60">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_20%,hsl(var(--primary)/0.14),transparent_45%),radial-gradient(circle_at_88%_8%,hsl(var(--warning)/0.2),transparent_42%)]" />
        <CardContent className="relative space-y-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl space-y-2">
              <Badge variant={source === "conversion" ? "info" : "success"} className="w-fit gap-1.5 px-3 py-1">
                <Layers3 className="h-3.5 w-3.5" />
                {sourceLabel}
              </Badge>
              <h3 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{sourceHint}</p>
            </div>

            <div className="grid w-full gap-2 sm:w-auto sm:min-w-[320px] sm:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-background/65 px-3 py-2.5">
                <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Paginas lidas</p>
                <p className="mt-1 text-lg font-bold leading-none">{formatNumber(block.pagesScanned)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Leituras processadas</p>
              </div>

              <div className="rounded-xl border border-border/60 bg-background/65 px-3 py-2.5">
                <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Cobertura</p>
                <p className="mt-1 text-lg font-bold leading-none">{`${coveragePercent.toFixed(0)}%`}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {`${formatNumber(block.summary.conversions)} de ${formatNumber(block.rawConversions)} registros`}
                </p>
              </div>
            </div>
          </div>

          <Separator className="bg-border/70" />

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-border/60 bg-background/65 px-3 py-2.5">
              <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Conversoes</p>
              <p className="mt-1 text-lg font-bold leading-none">{formatNumber(block.summary.conversions)}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/65 px-3 py-2.5">
              <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Pedidos</p>
              <p className="mt-1 text-lg font-bold leading-none">{formatNumber(block.summary.orders)}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/65 px-3 py-2.5">
              <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Comissao total</p>
              <p className="mt-1 text-lg font-bold leading-none">{formatMoney(block.summary.totalCommission, currency)}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/65 px-3 py-2.5">
              <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Ticket medio</p>
              <p className="mt-1 text-lg font-bold leading-none">{formatMoney(block.summary.averageTicket, currency)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="dashboard" className="space-y-5" key={`${source}-views`}>
        <TabsList className="grid h-auto w-full grid-cols-1 gap-1.5 rounded-2xl border border-border/60 bg-muted/25 p-1.5 sm:grid-cols-3">
          <TabsTrigger
            value="dashboard"
            className="h-full flex-col items-start gap-0.5 rounded-xl border border-transparent px-3 py-2.5 text-left data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <BarChart3 className="h-4 w-4" />
              Dashboard
            </span>
            <span className="text-2xs font-medium text-muted-foreground">Visao executiva da operacao</span>
          </TabsTrigger>

          <TabsTrigger
            value="clicks"
            className="h-full flex-col items-start gap-0.5 rounded-xl border border-transparent px-3 py-2.5 text-left data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <MousePointerClick className="h-4 w-4" />
              Cliques
            </span>
            <span className="text-2xs font-medium text-muted-foreground">Origem e distribuicao do trafego</span>
          </TabsTrigger>

          <TabsTrigger
            value="sales"
            className="h-full flex-col items-start gap-0.5 rounded-xl border border-transparent px-3 py-2.5 text-left data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <ShoppingCart className="h-4 w-4" />
              Vendas e historico
            </span>
            <span className="text-2xs font-medium text-muted-foreground">Produtos, canais e eventos detalhados</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ReportKpiCard
              title="Total vendido"
              value={formatMoney(block.summary.totalSales, currency)}
              sub={`${formatNumber(block.summary.orders)} pedidos no periodo`}
              icon={TrendingUp}
              tone="primary"
            />
            <ReportKpiCard
              title="Comissao total"
              value={formatMoney(block.summary.totalCommission, currency)}
              sub={`Liquida: ${formatMoney(block.summary.netCommission, currency)}`}
              icon={Wallet}
              tone="success"
            />
            <ReportKpiCard
              title="Conversoes"
              value={formatNumber(block.summary.conversions)}
              sub={`Itens vendidos: ${formatNumber(block.summary.items)}`}
              icon={ShoppingCart}
              tone="info"
            />
            <ReportKpiCard
              title="Fraudes mapeadas"
              value={formatNumber(block.summary.fraudItems)}
              sub={`Ticket medio: ${formatMoney(block.summary.averageTicket, currency)}`}
              icon={Package}
              tone="warning"
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-5">
            <Card className="border-border/70 bg-card/70 shadow-sm xl:col-span-2">
              <CardHeader className="pb-3">
                <ReportSectionHeader
                  icon={Package}
                  title="Status de pedidos"
                  description="Distribuicao dos estados para leitura rapida do funil de conversao."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {statusTotal <= 0 ? (
                  <p className="text-sm text-muted-foreground">Sem status de pedidos para o periodo selecionado.</p>
                ) : (
                  statusItems.map((item) => {
                    const ratio = statusTotal > 0 ? (item.count / statusTotal) * 100 : 0;
                    return (
                      <div key={item.key} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant={item.badgeVariant}>{item.label}</Badge>
                          <p className="text-xs font-semibold text-muted-foreground">{formatNumber(item.count)}</p>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
                          <div
                            className={cn("h-full rounded-full transition-all", item.barClass)}
                            style={{ width: `${Math.max(4, ratio)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}

                <Separator className="bg-border/70" />

                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <p>{`Completed: ${formatNumber(block.summary.completedOrders)}`}</p>
                  <p>{`Pending: ${formatNumber(block.summary.pendingOrders)}`}</p>
                  <p>{`Cancelled: ${formatNumber(block.summary.cancelledOrders)}`}</p>
                  <p>{`Unpaid: ${formatNumber(block.summary.unpaidOrders)}`}</p>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/70 shadow-sm xl:col-span-3">
              <CardHeader className="pb-3">
                <ReportSectionHeader
                  icon={Store}
                  title="Top lojas por comissao"
                  description="Ranking das lojas com maior impacto de comissao no periodo selecionado."
                />
              </CardHeader>
              <CardContent className="space-y-2">
                {block.topShops.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Sem lojas com vendas no periodo atual.</p>
                ) : (
                  block.topShops.slice(0, 8).map((shop, index) => (
                    <div
                      key={`${shop.shopId}:${shop.shopName}`}
                      className="grid grid-cols-[auto,1fr,auto] items-center gap-3 rounded-xl border border-border/60 bg-background/60 px-3 py-2.5"
                    >
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-muted/40 text-xs font-bold">
                        {index + 1}
                      </span>

                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{shop.shopName}</p>
                        <p className="text-xs text-muted-foreground">
                          {`${formatNumber(shop.orders)} pedidos - ${formatNumber(shop.items)} itens`}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="text-sm font-semibold">{formatMoney(shop.totalCommission, currency)}</p>
                        <p className="text-xs text-muted-foreground">{formatMoney(shop.sales, currency)}</p>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="clicks" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ReportKpiCard
              title="Cliques rastreados"
              value={formatNumber(clickInsights.totalClicks)}
              sub="Eventos unicos por conversao"
              icon={MousePointerClick}
              tone="primary"
            />
            <ReportKpiCard
              title="Hora de pico"
              value={clickInsights.peakHour?.label || "-"}
              sub={clickInsights.peakHour ? `${formatNumber(clickInsights.peakHour.clicks)} cliques` : "Sem dados"}
              icon={Clock3}
              tone="warning"
            />
            <ReportKpiCard
              title="Canais mapeados"
              value={formatNumber(clickInsights.byChannel.length)}
              sub="Origens distintas de trafego"
              icon={TrendingUp}
              tone="info"
            />
            <ReportKpiCard
              title="Sub IDs ativos"
              value={formatNumber(trackedSubIds)}
              sub={clickInsights.bySubId.some((item) => item.label === "Sem Sub ID") ? "Inclui eventos sem Sub ID" : "Todos os eventos com Sub ID"}
              icon={Layers3}
              tone="success"
            />
          </div>

          <Card className="border-border/70 bg-card/70 shadow-sm">
            <CardHeader className="pb-3">
              <ReportSectionHeader
                icon={BarChart3}
                title="Distribuicao por hora"
                description="Comparativo de intensidade de cliques por janela horaria."
              />
            </CardHeader>
            <CardContent>
              {clickInsights.byHour.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sem cliques rastreados no periodo selecionado.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {clickInsights.byHour.slice(0, 12).map((point, index) => {
                    const width = Math.max(10, (point.clicks / maxHourlyClicks) * 100);
                    return (
                      <div key={point.key} className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold">{point.label}</p>
                          <Badge variant={index === 0 ? "info" : "outline"}>
                            {`${point.share.toFixed(1)}%`}
                          </Badge>
                        </div>
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
                          <div className="h-full rounded-full bg-primary/85" style={{ width: `${width}%` }} />
                        </div>
                        <p className="mt-1.5 text-xs text-muted-foreground">{`${formatNumber(point.clicks)} cliques`}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-border/70 bg-card/70 shadow-sm">
              <CardHeader className="pb-3">
                <ReportSectionHeader
                  icon={TrendingUp}
                  title="Cliques por canal"
                  description="Participacao percentual de cada origem de trafego."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {pagedClickChannels.total === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum canal encontrado para o periodo.</p>
                ) : (
                  <>
                    <DataTableShell minWidth={560}>
                      <table className="w-full text-sm">
                        <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Canal</th>
                            <th className="px-3 py-2 font-semibold">Cliques</th>
                            <th className="px-3 py-2 font-semibold">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedClickChannels.pageItems.map((point) => (
                            <tr key={point.key} className="border-t border-border/60 align-top">
                              <td className="px-3 py-2.5 font-medium">{point.label}</td>
                              <td className="px-3 py-2.5">{formatNumber(point.clicks)}</td>
                              <td className="px-3 py-2.5">{`${point.share.toFixed(1)}%`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTableShell>

                    <TablePager
                      page={pagedClickChannels.page}
                      totalPages={pagedClickChannels.totalPages}
                      from={pagedClickChannels.from}
                      to={pagedClickChannels.to}
                      total={pagedClickChannels.total}
                      itemLabel="canais"
                      onPageChange={setClickChannelPage}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/70 shadow-sm">
              <CardHeader className="pb-3">
                <ReportSectionHeader
                  icon={Layers3}
                  title="Cliques por Sub ID"
                  description="Quebra de cliques por identificador de campanha."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {pagedClickSubIds.total === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum Sub ID detectado para o periodo.</p>
                ) : (
                  <>
                    <DataTableShell minWidth={560}>
                      <table className="w-full text-sm">
                        <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Sub ID</th>
                            <th className="px-3 py-2 font-semibold">Cliques</th>
                            <th className="px-3 py-2 font-semibold">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedClickSubIds.pageItems.map((point) => (
                            <tr key={point.key} className="border-t border-border/60 align-top">
                              <td className="px-3 py-2.5 font-medium">{point.label}</td>
                              <td className="px-3 py-2.5">{formatNumber(point.clicks)}</td>
                              <td className="px-3 py-2.5">{`${point.share.toFixed(1)}%`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTableShell>

                    <TablePager
                      page={pagedClickSubIds.page}
                      totalPages={pagedClickSubIds.totalPages}
                      from={pagedClickSubIds.from}
                      to={pagedClickSubIds.to}
                      total={pagedClickSubIds.total}
                      itemLabel="sub IDs"
                      onPageChange={setClickSubIdPage}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="sales" className="space-y-4">
          <Card className="border-border/70 bg-card/70 shadow-sm">
            <CardHeader className="pb-3">
              <ReportSectionHeader
                icon={Sparkles}
                title="Top produtos por comissao"
                description="Ranking dos itens com maior contribuicao de receita no periodo."
              />
            </CardHeader>
            <CardContent className="space-y-3">
              {pagedTopProducts.total === 0 ? (
                <p className="text-sm text-muted-foreground">Sem produtos para o periodo selecionado.</p>
              ) : (
                <>
                  <DataTableShell minWidth={860}>
                    <table className="w-full text-sm">
                      <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Item</th>
                          <th className="px-3 py-2 font-semibold">Itens</th>
                          <th className="px-3 py-2 font-semibold">Pedidos</th>
                          <th className="px-3 py-2 font-semibold">Vendido</th>
                          <th className="px-3 py-2 font-semibold">Comissao</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedTopProducts.pageItems.map((product) => (
                          <tr key={product.key} className="border-t border-border/60 align-top">
                            <td className="px-3 py-2.5 font-medium">{product.itemName}</td>
                            <td className="px-3 py-2.5">{formatNumber(product.items)}</td>
                            <td className="px-3 py-2.5">{formatNumber(product.orders)}</td>
                            <td className="px-3 py-2.5">{formatMoney(product.sales, currency)}</td>
                            <td className="px-3 py-2.5 font-semibold">{formatMoney(product.totalCommission, currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTableShell>

                  <TablePager
                    page={pagedTopProducts.page}
                    totalPages={pagedTopProducts.totalPages}
                    from={pagedTopProducts.from}
                    to={pagedTopProducts.to}
                    total={pagedTopProducts.total}
                    itemLabel="produtos"
                    onPageChange={setProductPage}
                  />
                </>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-border/70 bg-card/70 shadow-sm">
              <CardHeader className="pb-3">
                <ReportSectionHeader
                  icon={TrendingUp}
                  title="Canal: volume e comissao"
                  description="Consolidado de pedidos, vendas e comissoes por canal."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {pagedSalesChannels.total === 0 ? (
                  <p className="text-sm text-muted-foreground">Sem canais com vendas para o periodo.</p>
                ) : (
                  <>
                    <DataTableShell minWidth={620}>
                      <table className="w-full text-sm">
                        <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Canal</th>
                            <th className="px-3 py-2 font-semibold">Pedidos</th>
                            <th className="px-3 py-2 font-semibold">Vendido</th>
                            <th className="px-3 py-2 font-semibold">Comissao</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedSalesChannels.pageItems.map((point) => (
                            <tr key={point.key} className="border-t border-border/60 align-top">
                              <td className="px-3 py-2.5 font-medium">{point.label}</td>
                              <td className="px-3 py-2.5">{formatNumber(point.orders)}</td>
                              <td className="px-3 py-2.5">{formatMoney(point.sales, currency)}</td>
                              <td className="px-3 py-2.5 font-semibold">{formatMoney(point.totalCommission, currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTableShell>

                    <TablePager
                      page={pagedSalesChannels.page}
                      totalPages={pagedSalesChannels.totalPages}
                      from={pagedSalesChannels.from}
                      to={pagedSalesChannels.to}
                      total={pagedSalesChannels.total}
                      itemLabel="canais"
                      onPageChange={setSalesChannelPage}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/70 shadow-sm">
              <CardHeader className="pb-3">
                <ReportSectionHeader
                  icon={Layers3}
                  title="Sub ID: volume e comissao"
                  description="Leitura dos resultados por identificador de campanha."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {pagedSalesSubIds.total === 0 ? (
                  <p className="text-sm text-muted-foreground">Sem Sub IDs com vendas no periodo.</p>
                ) : (
                  <>
                    <DataTableShell minWidth={620}>
                      <table className="w-full text-sm">
                        <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Sub ID</th>
                            <th className="px-3 py-2 font-semibold">Pedidos</th>
                            <th className="px-3 py-2 font-semibold">Vendido</th>
                            <th className="px-3 py-2 font-semibold">Comissao</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedSalesSubIds.pageItems.map((point) => (
                            <tr key={point.key} className="border-t border-border/60 align-top">
                              <td className="px-3 py-2.5 font-medium">{point.label}</td>
                              <td className="px-3 py-2.5">{formatNumber(point.orders)}</td>
                              <td className="px-3 py-2.5">{formatMoney(point.sales, currency)}</td>
                              <td className="px-3 py-2.5 font-semibold">{formatMoney(point.totalCommission, currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTableShell>

                    <TablePager
                      page={pagedSalesSubIds.page}
                      totalPages={pagedSalesSubIds.totalPages}
                      from={pagedSalesSubIds.from}
                      to={pagedSalesSubIds.to}
                      total={pagedSalesSubIds.total}
                      itemLabel="sub IDs"
                      onPageChange={setSalesSubIdPage}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="border-border/70 bg-card/70 shadow-sm">
            <CardHeader className="pb-3">
              <ReportSectionHeader
                icon={CalendarDays}
                title="Resumo diario"
                description="Serie temporal de vendas, comissoes e volume de pedidos."
              />
            </CardHeader>
            <CardContent className="space-y-3">
              {pagedDaily.total === 0 ? (
                <p className="text-sm text-muted-foreground">Sem dados diarios para o periodo.</p>
              ) : (
                <>
                  <DataTableShell minWidth={760}>
                    <table className="w-full text-sm">
                      <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Data</th>
                          <th className="px-3 py-2 font-semibold">Vendido</th>
                          <th className="px-3 py-2 font-semibold">Comissao</th>
                          <th className="px-3 py-2 font-semibold">Liquida</th>
                          <th className="px-3 py-2 font-semibold">Pedidos</th>
                          <th className="px-3 py-2 font-semibold">Itens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedDaily.pageItems.map((day) => (
                          <tr key={day.date} className="border-t border-border/60 align-top">
                            <td className="px-3 py-2.5">{day.date}</td>
                            <td className="px-3 py-2.5">{formatMoney(day.sales, currency)}</td>
                            <td className="px-3 py-2.5">{formatMoney(day.totalCommission, currency)}</td>
                            <td className="px-3 py-2.5">{formatMoney(day.netCommission, currency)}</td>
                            <td className="px-3 py-2.5">{formatNumber(day.orders)}</td>
                            <td className="px-3 py-2.5">{formatNumber(day.items)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTableShell>

                  <TablePager
                    page={pagedDaily.page}
                    totalPages={pagedDaily.totalPages}
                    from={pagedDaily.from}
                    to={pagedDaily.to}
                    total={pagedDaily.total}
                    itemLabel="dias"
                    onPageChange={setDailyPage}
                  />
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card/70 shadow-sm">
            <CardHeader className="pb-3">
              <ReportSectionHeader
                icon={Search}
                title="Historico de vendas"
                description="Consulta detalhada dos eventos de conversao por pedido e item."
                action={(
                  <div className="relative w-full sm:w-[340px]">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={salesSearch}
                      onChange={(event) => setSalesSearch(event.target.value)}
                      placeholder="Buscar item, loja, pedido ou Sub ID"
                      className="h-10 pl-9"
                    />
                  </div>
                )}
              />
            </CardHeader>
            <CardContent className="space-y-3">
              {pagedHistory.total === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma venda encontrada para o filtro aplicado.</p>
              ) : (
                <>
                  <DataTableShell minWidth={1220}>
                    <table className="w-full text-sm">
                      <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Compra</th>
                          <th className="px-3 py-2 font-semibold">Clique</th>
                          <th className="px-3 py-2 font-semibold">Pedido</th>
                          <th className="px-3 py-2 font-semibold">Item</th>
                          <th className="px-3 py-2 font-semibold">Loja</th>
                          <th className="px-3 py-2 font-semibold">Canal</th>
                          <th className="px-3 py-2 font-semibold">Sub ID</th>
                          <th className="px-3 py-2 font-semibold">Vendido</th>
                          <th className="px-3 py-2 font-semibold">Comissao</th>
                          <th className="px-3 py-2 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedHistory.pageItems.map((row, idx) => (
                          <tr key={`${row.conversionId}:${row.orderId}:${idx}`} className="border-t border-border/60 align-top">
                            <td className="px-3 py-2.5">{formatDateTime(row.purchaseTime)}</td>
                            <td className="px-3 py-2.5">{formatDateTime(row.clickTime)}</td>
                            <td className="px-3 py-2.5">
                              <p className="font-semibold">{row.orderId || "-"}</p>
                              <p className="text-xs text-muted-foreground">{`Conv: ${row.conversionId || "-"}`}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              <p className="max-w-[340px] whitespace-normal font-medium leading-snug">{row.itemName || "-"}</p>
                              <p className="mt-1 text-xs text-muted-foreground">{row.displayItemStatus || "-"}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              <p className="max-w-[220px] whitespace-normal leading-snug">{row.shopName || "-"}</p>
                            </td>
                            <td className="px-3 py-2.5">{row.referrer || "-"}</td>
                            <td className="px-3 py-2.5">{normalizeSubId(row.utmContent)}</td>
                            <td className="px-3 py-2.5">{formatMoney(row.actualAmount, currency)}</td>
                            <td className="px-3 py-2.5">{formatMoney(row.totalCommission, currency)}</td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                <Badge variant={statusVariant(row.orderStatus)}>{row.orderStatus || "UNKNOWN"}</Badge>
                                {row.fraudStatus === "FRAUD" ? <Badge variant="destructive">FRAUD</Badge> : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTableShell>

                  <TablePager
                    page={pagedHistory.page}
                    totalPages={pagedHistory.totalPages}
                    from={pagedHistory.from}
                    to={pagedHistory.to}
                    total={pagedHistory.total}
                    itemLabel="registros"
                    onPageChange={setHistoryPage}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function ShopeeReports() {
  const { isConfigured, isLoading: loadingCredentials } = useShopeeCredentials();
  const [activeSource, setActiveSource] = useState<ShopeeReportSource>("conversion");
  const [preset, setPreset] = useState<ShopeeReportPreset>("30d");
  const [draftRange, setDraftRange] = useState<DateRange>(() => buildPresetRange("30d"));
  const [appliedRange, setAppliedRange] = useState<DateRange>(() => buildPresetRange("30d"));
  const [draftFilters, setDraftFilters] = useState<ShopeeReportFilters>(DEFAULT_REPORT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<ShopeeReportFilters>(DEFAULT_REPORT_FILTERS);

  const reportsQuery = useQuery<ShopeeReportsResponse>({
    queryKey: ["shopee-reports", appliedRange.startDate, appliedRange.endDate, appliedFilters],
    enabled: isConfigured && !loadingCredentials,
    staleTime: 60_000,
    queryFn: async () => {
      const { data: { session } } = await backend.auth.getSession();
      if (!session) throw new Error("Sessao expirada. Faca login novamente.");

      const payloadBody = {
        startDate: appliedRange.startDate,
        endDate: appliedRange.endDate,
        filters: toRpcFilters(appliedFilters),
      };
      const candidates = ["shopee-reports", "shopee_reports", "shopee reports"] as const;

      let lastError: Error | null = null;
      for (const fnName of candidates) {
        try {
          return await invokeBackendRpc<ShopeeReportsResponse>(fnName, { body: payloadBody });
        } catch (error) {
          if (error instanceof Error && isFunctionNotImplementedError(error.message)) {
            lastError = error;
            continue;
          }
          throw error;
        }
      }

      throw (lastError || new Error("Funcao de relatorio Shopee nao implementada no backend."));
    },
  });

  useEffect(() => {
    if (!reportsQuery.error) return;
    const rawMessage = reportsQuery.error instanceof Error ? reportsQuery.error.message : "Falha ao carregar relatorios Shopee";
    if (isFunctionNotImplementedError(rawMessage)) {
      toast.error("Backend de relatorios Shopee nao sincronizado. Reinicie API e microservico Shopee.");
      return;
    }
    toast.error(rawMessage);
  }, [reportsQuery.error]);

  const currency = reportsQuery.data?.currency || "BRL";

  const handlePresetChange = (value: ShopeeReportPreset) => {
    setPreset(value);
    if (value === "custom") return;
    const range = buildPresetRange(value);
    setDraftRange(range);
    setAppliedRange(range);
  };

  const handleApplyRange = () => {
    const startDate = String(draftRange.startDate || "").trim();
    const endDate = String(draftRange.endDate || "").trim();
    if (!isValidYmd(startDate) || !isValidYmd(endDate)) {
      toast.error("Datas invalidas. Use o formato YYYY-MM-DD.");
      return;
    }
    if (startDate > endDate) {
      toast.error("Periodo invalido: data inicial maior que data final.");
      return;
    }
    setAppliedRange({ startDate, endDate });
    setAppliedFilters({ ...draftFilters });
  };

  const handleResetFilters = () => {
    const baseRange = buildPresetRange("30d");
    setPreset("30d");
    setDraftRange(baseRange);
    setAppliedRange(baseRange);
    setDraftFilters(DEFAULT_REPORT_FILTERS);
    setAppliedFilters(DEFAULT_REPORT_FILTERS);
  };

  return (
    <PageWrapper fallbackLabel="Carregando relatorios...">
      <div className="ds-page pb-[calc(var(--safe-area-bottom)+0.75rem)]">
        <PageHeader
          title="Relatorios Shopee"
          description="Painel operacional para acompanhar comissoes, cliques, produtos e historico de vendas."
        >
          {isConfigured && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => { void reportsQuery.refetch(); }}
              disabled={reportsQuery.isFetching}
              className="min-w-[138px]"
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${reportsQuery.isFetching ? "animate-spin" : ""}`} />
              Atualizar dados
            </Button>
          )}
        </PageHeader>

        {!isConfigured ? <ShopeeCredentialsBanner /> : null}

        {isConfigured ? (
          <Card className="glass border-border/60">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-base">Filtros da consulta</CardTitle>
                  <CardDescription>
                    Defina periodo e recortes para reconstruir os dados em todas as abas.
                  </CardDescription>
                </div>

                <Badge variant="outline" className="gap-1.5 px-3 py-1">
                  <Filter className="h-3.5 w-3.5" />
                  Painel de filtros
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-12">
                <div className="space-y-1 xl:col-span-3">
                  <Label>Periodo</Label>
                  <Select value={preset} onValueChange={(value) => handlePresetChange(value as ShopeeReportPreset)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7d">Ultimos 7 dias</SelectItem>
                      <SelectItem value="30d">Ultimos 30 dias</SelectItem>
                      <SelectItem value="60d">Ultimos 60 dias</SelectItem>
                      <SelectItem value="90d">Ultimos 90 dias</SelectItem>
                      <SelectItem value="custom">Personalizado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1 xl:col-span-2">
                  <Label>Data inicial</Label>
                  <Input
                    type="date"
                    value={draftRange.startDate}
                    onChange={(event) => setDraftRange((prev) => ({ ...prev, startDate: event.target.value }))}
                    disabled={preset !== "custom"}
                  />
                </div>

                <div className="space-y-1 xl:col-span-2">
                  <Label>Data final</Label>
                  <Input
                    type="date"
                    value={draftRange.endDate}
                    onChange={(event) => setDraftRange((prev) => ({ ...prev, endDate: event.target.value }))}
                    disabled={preset !== "custom"}
                  />
                </div>

                <div className="space-y-1 xl:col-span-2">
                  <Label>Status do pedido</Label>
                  <Select
                    value={draftFilters.orderStatus}
                    onValueChange={(value) => setDraftFilters((prev) => ({ ...prev, orderStatus: value as ShopeeReportFilters["orderStatus"] }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Todos" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">Todos</SelectItem>
                      <SelectItem value="UNPAID">Unpaid</SelectItem>
                      <SelectItem value="PENDING">Pending</SelectItem>
                      <SelectItem value="COMPLETED">Completed</SelectItem>
                      <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1 xl:col-span-3">
                  <Label>Tipo de comprador</Label>
                  <Select
                    value={draftFilters.buyerType}
                    onValueChange={(value) => setDraftFilters((prev) => ({ ...prev, buyerType: value as ShopeeReportFilters["buyerType"] }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Todos" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">Todos</SelectItem>
                      <SelectItem value="NEW">Novo</SelectItem>
                      <SelectItem value="EXISTING">Existente</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator className="bg-border/70" />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {`Periodo aplicado: ${appliedRange.startDate} ate ${appliedRange.endDate}`}
                </p>

                <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleResetFilters}
                    disabled={reportsQuery.isFetching}
                    className="min-w-[110px]"
                  >
                    Limpar
                  </Button>

                  <Button
                    size="sm"
                    onClick={handleApplyRange}
                    disabled={reportsQuery.isFetching}
                    className="min-w-[150px]"
                  >
                    <CalendarDays className="mr-1.5 h-4 w-4" />
                    Aplicar filtros
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {isConfigured && reportsQuery.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-64" />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
            <Skeleton className="h-72 w-full" />
          </div>
        ) : null}

        {isConfigured && !reportsQuery.isLoading && !reportsQuery.data ? (
          <Card>
            <CardContent className="p-4">
              <EmptyState
                icon={AlertTriangle}
                title="Sem dados de relatorio"
                description="Nao foi possivel carregar os dados para o periodo informado."
              />
            </CardContent>
          </Card>
        ) : null}

        {isConfigured && reportsQuery.data ? (
          <Tabs
            value={activeSource}
            onValueChange={(value) => setActiveSource(value as ShopeeReportSource)}
            className="space-y-5"
          >
            <TabsList className="grid h-auto w-full grid-cols-1 gap-2 rounded-2xl border border-border/60 bg-muted/25 p-1.5 md:grid-cols-2">
              <TabsTrigger
                value="conversion"
                className="h-full flex-col items-start gap-0.5 rounded-xl border border-transparent px-4 py-3 text-left data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Comissoes estimadas
                </span>
                <span className="text-2xs text-muted-foreground">Acompanhamento em tempo real da captacao</span>
              </TabsTrigger>

              <TabsTrigger
                value="validated"
                className="h-full flex-col items-start gap-0.5 rounded-xl border border-transparent px-4 py-3 text-left data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Wallet className="h-4 w-4 text-success" />
                  Comissoes validadas
                </span>
                <span className="text-2xs text-muted-foreground">Base consolidada para fechamento financeiro</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value={activeSource} forceMount className="space-y-5">
              <ReportBlockView
                key={activeSource}
                source={activeSource}
                title={activeSource === "conversion" ? "Visao de conversoes" : "Visao de validacao"}
                block={activeSource === "conversion" ? reportsQuery.data.conversion : reportsQuery.data.validated}
                currency={currency}
              />
            </TabsContent>
          </Tabs>
        ) : null}
      </div>
    </PageWrapper>
  );
}
