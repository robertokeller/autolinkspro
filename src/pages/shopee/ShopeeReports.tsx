import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { PageWrapper } from "@/components/PageWrapper";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShopeeCredentialsBanner } from "@/components/ShopeeCredentialsBanner";
import { useShopeeCredentials } from "@/hooks/useShopeeCredentials";
import { backend } from "@/integrations/backend/client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { cn } from "@/lib/utils";
import { AlertTriangle, BarChart3, CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Clock3, Layers3, MousePointerClick, Package, RefreshCw, Search, ShoppingCart, Sparkles, TrendingUp, Wallet } from "lucide-react";
import { toast } from "sonner";

type ShopeeReportPreset = "today" | "yesterday" | "7d" | "30d" | "60d" | "90d" | "thisMonth" | "lastMonth" | "custom";
type ShopeeReportSource = "conversion" | "validated";
type ReportInnerView = "dashboard" | "clicks" | "sales" | "history";

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
};

type ShopeeQuickPreset = Exclude<ShopeeReportPreset, "custom">;

const DEFAULT_REPORT_FILTERS: ShopeeReportFilters = {
  orderStatus: "ALL",
};

const DEFAULT_PRESET: ShopeeReportPreset = "30d";
const DEFAULT_ROLLING_DAYS = 14;
const MIN_ROLLING_DAYS = 1;
const MAX_ROLLING_DAYS = 365;

const PERIOD_INTERACTIVE_CHIPS: Array<{ value: ShopeeReportPreset; label: string }> = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "thisMonth", label: "Este mês" },
  { value: "custom", label: "Personalizado" },
];

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function clampRollingDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ROLLING_DAYS;
  return Math.min(MAX_ROLLING_DAYS, Math.max(MIN_ROLLING_DAYS, Math.trunc(value)));
}

function buildRollingRange(days: number): DateRange {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  const safeDays = clampRollingDays(days);
  start.setUTCDate(start.getUTCDate() - (safeDays - 1));
  return { startDate: toYmd(start), endDate: toYmd(end) };
}

function buildPresetRange(preset: ShopeeQuickPreset): DateRange {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);

  if (preset === "today") {
    const ymd = toYmd(end);
    return { startDate: ymd, endDate: ymd };
  }

  if (preset === "yesterday") {
    const yesterday = new Date(end);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const ymd = toYmd(yesterday);
    return { startDate: ymd, endDate: ymd };
  }

  if (preset === "thisMonth") {
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    return { startDate: toYmd(start), endDate: toYmd(end) };
  }

  if (preset === "lastMonth") {
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
    const monthEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0));
    return { startDate: toYmd(start), endDate: toYmd(monthEnd) };
  }

  return buildRollingRange(preset === "7d" ? 7 : preset === "30d" ? 30 : preset === "60d" ? 60 : 90);
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

function formatYmdShort(value: string): string {
  if (!isValidYmd(value)) return value;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return value;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function formatRangeSummary(range: DateRange): string {
  if (!isValidYmd(range.startDate) || !isValidYmd(range.endDate)) return "Período inválido";
  if (range.startDate === range.endDate) return formatYmdShort(range.startDate);
  return `${formatYmdShort(range.startDate)} - ${formatYmdShort(range.endDate)}`;
}

function formatCountLabel(value: number, singular: string, plural: string): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${formatNumber(safe)} ${safe === 1 ? singular : plural}`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "COMPLETED") return "default";
  if (normalized === "PENDING" || normalized === "UNPAID") return "secondary";
  if (normalized === "CANCELLED" || normalized === "FRAUD") return "destructive";
  return "outline";
}

function orderStatusLabel(status: string): string {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "COMPLETED") return "Concluído";
  if (normalized === "PENDING") return "Pendente";
  if (normalized === "CANCELLED") return "Cancelado";
  if (normalized === "UNPAID") return "Não pago";
  if (normalized === "FRAUD") return "Fraude";
  return "Desconhecido";
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
  latestPurchaseTime: number;
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

const UNKNOWN_CHANNEL_LABEL = "Desconhecido";
const UNKNOWN_SUB_ID_LABEL = "Sem ID de Sub";

function formatHourBucket(timestampSec: number): string {
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return "Sem horário";
  const date = new Date(timestampSec * 1000);
  const hour = String(date.getHours()).padStart(2, "0");
  return `${hour}:00 - ${hour}:59`;
}

function normalizeSubId(rawValue: string): string {
  const raw = String(rawValue || "").trim();
  if (!raw || raw === "----" || raw === "-" || raw.toLowerCase() === "null") return UNKNOWN_SUB_ID_LABEL;
  const firstToken = raw.split(/[\s|,;]+/)[0] || raw;
  return firstToken;
}

function normalizeClickChannel(rawValue: string): string {
  const raw = String(rawValue || "").trim();
  if (!raw) return UNKNOWN_CHANNEL_LABEL;

  const lowered = raw.toLowerCase();
  if (["unknown", "desconhecido", "n/a", "na", "none", "(not set)", "null", "-"].includes(lowered)) {
    return UNKNOWN_CHANNEL_LABEL;
  }

  const maybeHost = raw.replace(/^https?:\/\//i, "").split("/")[0].trim().toLowerCase();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(maybeHost)) {
    return maybeHost.replace(/^www\./, "");
  }

  return raw;
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
    const current = uniqueEvents.get(conversionKey) || {
      clickTime: 0,
      channel: UNKNOWN_CHANNEL_LABEL,
      subId: UNKNOWN_SUB_ID_LABEL,
    };

    const rowClickTime = Number(row.clickTime || 0);
    const rowChannel = normalizeClickChannel(String(row.referrer || ""));
    const rowSubId = normalizeSubId(String(row.utmContent || ""));

    if (rowClickTime >= current.clickTime) {
      current.clickTime = rowClickTime;
      if (rowChannel !== UNKNOWN_CHANNEL_LABEL) current.channel = rowChannel;
      if (rowSubId !== UNKNOWN_SUB_ID_LABEL) current.subId = rowSubId;
    } else {
      if (current.channel === UNKNOWN_CHANNEL_LABEL && rowChannel !== UNKNOWN_CHANNEL_LABEL) current.channel = rowChannel;
      if (current.subId === UNKNOWN_SUB_ID_LABEL && rowSubId !== UNKNOWN_SUB_ID_LABEL) current.subId = rowSubId;
    }

    uniqueEvents.set(conversionKey, current);
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
    latestPurchaseTime: number;
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
      latestPurchaseTime: 0,
      sales: 0,
      totalCommission: 0,
      items: 0,
      orderIds: new Set<string>(),
    };

    const eventTime = Math.max(Number(row.purchaseTime || 0), Number(row.clickTime || 0));
    current.latestPurchaseTime = Math.max(current.latestPurchaseTime, Number.isFinite(eventTime) ? eventTime : 0);
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
      latestPurchaseTime: entry.latestPurchaseTime,
      sales: Number(entry.sales.toFixed(2)),
      totalCommission: Number(entry.totalCommission.toFixed(2)),
      items: entry.items,
      orders: entry.orderIds.size,
    }))
    .sort((a, b) => b.latestPurchaseTime - a.latestPurchaseTime || b.totalCommission - a.totalCommission || b.sales - a.sales || b.items - a.items)
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

function getAvailableReportViews(): ReportInnerView[] {
  return ["dashboard", "clicks", "sales", "history"];
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
          aria-label="Primeira página"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Página anterior"
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
          aria-label="Próxima página"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          disabled={page >= totalPages}
          onClick={() => onPageChange(totalPages)}
          aria-label="Última página"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function DataTableShell(props: {
  minWidth: number;
  className?: string;
  children: ReactNode;
}) {
  const contentStyle = props.minWidth > 0 ? { minWidth: props.minWidth } : undefined;

  return (
    <div className={cn("overflow-x-auto rounded-xl border border-border/40 bg-background/50 shadow-sm", props.className)}>
      <div className="w-full" style={contentStyle}>
        {props.children}
      </div>
    </div>
  );
}

function TruncatedCellText(props: {
  value: string;
  fallback?: string;
  className?: string;
}) {
  const raw = String(props.value || "").trim();
  const text = raw || props.fallback || "-";
  return (
    <span className={cn("block min-w-0 truncate", props.className)} title={text}>
      {text}
    </span>
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
    <Card className="flex min-h-[140px] flex-col justify-center border-border/40 bg-card/90 p-5 shadow-sm ring-1 ring-black/5 backdrop-blur-md dark:ring-white/10 transition-all hover:bg-card">
      <CardContent className="flex flex-1 flex-col justify-end space-y-2 p-0">
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
  availableViews: ReportInnerView[];
  activeView: ReportInnerView;
  onActiveViewChange: (view: ReportInnerView) => void;
}) {
  const { title, block, currency, source, availableViews, activeView, onActiveViewChange } = props;

  const sourceLabel = source === "conversion" ? "Comissões estimadas" : "Comissões validadas";
  const sourceHint = source === "conversion"
    ? "Leitura de conversões em tempo real para monitorar tendência e projeção de receita."
    : "Base validada pela plataforma para fechamento financeiro e conciliação final.";

  const [salesSearch, setSalesSearch] = useState("");
  const [clickChannelPage, setClickChannelPage] = useState(1);
  const [clickSubIdPage, setClickSubIdPage] = useState(1);
  const [productPage, setProductPage] = useState(1);
  const [salesChannelPage, setSalesChannelPage] = useState(1);
  const [salesSubIdPage, setSalesSubIdPage] = useState(1);
  const [salesTrendPage, setSalesTrendPage] = useState(1);
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

  const sortedRows = useMemo(
    () => [...block.rows].sort((a, b) => {
      const timeA = Math.max(Number(a.purchaseTime || 0), Number(a.clickTime || 0));
      const timeB = Math.max(Number(b.purchaseTime || 0), Number(b.clickTime || 0));
      if (timeB !== timeA) return timeB - timeA;
      return String(b.orderId || "").localeCompare(String(a.orderId || ""));
    }),
    [block.rows],
  );

  const filteredRows = useMemo(() => {
    const needle = salesSearch.trim().toLowerCase();
    if (!needle) return sortedRows;
    return sortedRows.filter((row) => {
      const haystack = [row.itemName, row.shopName, row.orderId, row.conversionId, row.utmContent]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [salesSearch, sortedRows]);

  const statusItems = useMemo(
    () => [
      {
        key: "completed",
        label: "Concluído",
        count: block.summary.completedOrders,
        badgeVariant: "success" as const,
        barClass: "bg-success/80",
      },
      {
        key: "pending",
        label: "Pendente",
        count: block.summary.pendingOrders,
        badgeVariant: "warning" as const,
        barClass: "bg-warning/80",
      },
      {
        key: "cancelled",
        label: "Cancelado",
        count: block.summary.cancelledOrders,
        badgeVariant: "destructive" as const,
        barClass: "bg-destructive/80",
      },
      {
        key: "unpaid",
        label: "Não pago",
        count: block.summary.unpaidOrders,
        badgeVariant: "secondary" as const,
        barClass: "bg-muted-foreground/70",
      },
    ],
    [block.summary.cancelledOrders, block.summary.completedOrders, block.summary.pendingOrders, block.summary.unpaidOrders],
  );

  const trackedSubIds = useMemo(
    () => clickInsights.bySubId.filter((item) => item.label !== UNKNOWN_SUB_ID_LABEL).length,
    [clickInsights.bySubId],
  );
  const realClickChannels = useMemo(
    () => clickInsights.byChannel.filter((item) => item.label !== UNKNOWN_CHANNEL_LABEL),
    [clickInsights.byChannel],
  );
  const unknownChannelClicks = useMemo(
    () => clickInsights.byChannel.find((item) => item.label === UNKNOWN_CHANNEL_LABEL)?.clicks || 0,
    [clickInsights.byChannel],
  );
  const realClickSubIds = useMemo(
    () => clickInsights.bySubId.filter((item) => item.label !== UNKNOWN_SUB_ID_LABEL),
    [clickInsights.bySubId],
  );
  const missingSubIdClicks = useMemo(
    () => clickInsights.bySubId.find((item) => item.label === UNKNOWN_SUB_ID_LABEL)?.clicks || 0,
    [clickInsights.bySubId],
  );
  const clickChannelsOrdered = useMemo(
    () => [...realClickChannels].sort((a, b) => b.clicks - a.clicks || a.label.localeCompare(b.label)),
    [realClickChannels],
  );
  const clickSubIdsOrdered = useMemo(
    () => [...realClickSubIds].sort((a, b) => b.clicks - a.clicks || a.label.localeCompare(b.label)),
    [realClickSubIds],
  );
  const statusTotal = useMemo(
    () => statusItems.reduce((sum, item) => sum + item.count, 0),
    [statusItems],
  );

  const dailySeries = useMemo(() => [...block.daily].sort((a, b) => b.date.localeCompare(a.date)), [block.daily]);

  useEffect(() => {
    setHistoryPage(1);
  }, [salesSearch]);

  useEffect(() => {
    setSalesTrendPage(1);
  }, [dailySeries.length]);

  const pagedClickChannels = useMemo(
    () => paginateByPage(clickChannelsOrdered, clickChannelPage, 8),
    [clickChannelPage, clickChannelsOrdered],
  );
  const pagedClickSubIds = useMemo(
    () => paginateByPage(clickSubIdsOrdered, clickSubIdPage, 8),
    [clickSubIdPage, clickSubIdsOrdered],
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
  const salesTrend = useMemo(() => {
    const points = dailySeries.map((day) => ({
      date: day.date,
      sales: Number(day.sales || 0),
      totalCommission: Number(day.totalCommission || 0),
      orders: Number(day.orders || 0),
    }));

    const maxSales = points.reduce((max, point) => Math.max(max, point.sales), 0);
    const activeDays = points.filter((point) => point.sales > 0).length;
    const totalSales = points.reduce((sum, point) => sum + point.sales, 0);
    const totalOrders = points.reduce((sum, point) => sum + point.orders, 0);
    const bestDay = points.reduce<(typeof points)[number] | null>((best, point) => {
      if (!best || point.sales > best.sales) return point;
      return best;
    }, null);

    return {
      points,
      maxSales: maxSales > 0 ? maxSales : 1,
      activeDays,
      totalSales,
      totalOrders,
      bestDay,
    };
  }, [dailySeries]);

  const pagedSalesTrend = useMemo(
    () => paginateByPage(salesTrend.points, salesTrendPage, 8),
    [salesTrend.points, salesTrendPage],
  );

  const showDashboard = availableViews.includes("dashboard");
  const showClicks = availableViews.includes("clicks");
  const showSales = availableViews.includes("sales");
  const showHistory = availableViews.includes("history");
  const tabViewportClass = "space-y-5";

  const headerStats = [
    {
      key: "conversions",
      label: "Conversões",
      value: formatNumber(block.summary.conversions),
    },
    {
      key: "orders",
      label: "Pedidos",
      value: formatNumber(block.summary.orders),
    },
    {
      key: "commission",
      label: "Comissão total",
      value: formatMoney(block.summary.totalCommission, currency),
    },
    {
      key: "ticket",
      label: "Ticket médio",
      value: formatMoney(block.summary.averageTicket, currency),
    },
  ];

  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden border-border/50 bg-card/80 shadow-sm">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_20%,hsl(var(--primary)/0.1),transparent_44%),radial-gradient(circle_at_88%_8%,hsl(var(--warning)/0.12),transparent_42%)]" />
        <CardContent className="relative space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl space-y-1.5">
              <Badge variant={source === "conversion" ? "info" : "success"} className="w-fit gap-1.5 px-3 py-1">
                <Layers3 className="h-3.5 w-3.5" />
                {sourceLabel}
              </Badge>
              <h3 className="text-lg font-bold tracking-tight sm:text-xl">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{sourceHint}</p>
            </div>
          </div>

          <div className="grid items-stretch gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {headerStats.map((item) => (
              <div key={item.key} className="rounded-xl border border-border/40 bg-background/85 px-3 py-2.5">
                <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</p>
                <p className="mt-1 text-base font-semibold leading-none">{item.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Tabs
        value={activeView}
        onValueChange={(value) => onActiveViewChange(value as ReportInnerView)}
        className="space-y-5"
      >
        <TabsList className="grid h-auto w-full grid-cols-1 gap-1.5 rounded-2xl border border-border/60 bg-muted/25 p-1.5 sm:grid-cols-2 xl:grid-cols-4">
          {showDashboard && (
            <TabsTrigger
              value="dashboard"
              className="min-h-[72px] h-full flex-col items-center justify-center gap-0.5 rounded-xl border border-transparent px-3 py-2.5 text-center data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              <span className="flex items-center justify-center gap-1.5 text-sm font-semibold">
                <BarChart3 className="h-4 w-4" />
                Painel
              </span>
              <span className="text-2xs font-medium text-muted-foreground">Visão executiva da operação</span>
            </TabsTrigger>
          )}

          {showClicks && (
            <TabsTrigger
              value="clicks"
              className="min-h-[72px] h-full flex-col items-center justify-center gap-0.5 rounded-xl border border-transparent px-3 py-2.5 text-center data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              <span className="flex items-center justify-center gap-1.5 text-sm font-semibold">
                <MousePointerClick className="h-4 w-4" />
                Cliques
              </span>
              <span className="text-2xs font-medium text-muted-foreground">Origem e distribuição do tráfego</span>
            </TabsTrigger>
          )}

          {showSales && (
            <TabsTrigger
              value="sales"
              className="min-h-[72px] h-full flex-col items-center justify-center gap-0.5 rounded-xl border border-transparent px-3 py-2.5 text-center data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              <span className="flex items-center justify-center gap-1.5 text-sm font-semibold">
                <ShoppingCart className="h-4 w-4" />
                Vendas
              </span>
              <span className="text-2xs font-medium text-muted-foreground">Produtos, canais e evolução diária</span>
            </TabsTrigger>
          )}

          {showHistory && (
            <TabsTrigger
              value="history"
              className="min-h-[72px] h-full flex-col items-center justify-center gap-0.5 rounded-xl border border-transparent px-3 py-2.5 text-center data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              <span className="flex items-center justify-center gap-1.5 text-sm font-semibold">
                <Search className="h-4 w-4" />
                Histórico
              </span>
              <span className="text-2xs font-medium text-muted-foreground">Eventos detalhados por pedido e item</span>
            </TabsTrigger>
          )}
        </TabsList>

        {showDashboard && (
        <TabsContent value="dashboard" className="mt-0 animate-in fade-in duration-500">
          <div className={tabViewportClass}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ReportKpiCard
              title="Total vendido"
              value={formatMoney(block.summary.totalSales, currency)}
              sub={`${formatNumber(block.summary.orders)} pedidos no período`}
              icon={TrendingUp}
              tone="primary"
            />
            <ReportKpiCard
              title="Comissão total"
              value={formatMoney(block.summary.totalCommission, currency)}
              sub={`Líquida: ${formatMoney(block.summary.netCommission, currency)}`}
              icon={Wallet}
              tone="success"
            />
            <ReportKpiCard
              title="Conversões"
              value={formatNumber(block.summary.conversions)}
              sub={`Itens vendidos: ${formatNumber(block.summary.items)}`}
              icon={ShoppingCart}
              tone="info"
            />
            <ReportKpiCard
              title="Fraudes mapeadas"
              value={formatNumber(block.summary.fraudItems)}
              sub={`Ticket médio: ${formatMoney(block.summary.averageTicket, currency)}`}
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
                  description="Distribuição dos estados para leitura rápida do funil de conversão."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {statusTotal <= 0 ? (
                  <p className="text-sm text-muted-foreground">Sem status de pedidos para o período selecionado.</p>
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
                  <p>{`Concluídos: ${formatNumber(block.summary.completedOrders)}`}</p>
                  <p>{`Pendentes: ${formatNumber(block.summary.pendingOrders)}`}</p>
                  <p>{`Cancelados: ${formatNumber(block.summary.cancelledOrders)}`}</p>
                  <p>{`Não pagos: ${formatNumber(block.summary.unpaidOrders)}`}</p>
                </div>
              </CardContent>
              </Card>

              <Card className="border-border/70 bg-card/70 shadow-sm xl:col-span-3">
              <CardHeader className="pb-3">
                <ReportSectionHeader
                  icon={CalendarDays}
                  title="Evolução de vendas no período"
                  description="Série diária baseada no período filtrado da API Shopee, com foco em volume e comissão."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {salesTrend.points.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Sem série diária para o período selecionado.</p>
                ) : (
                  <>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <div className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5 text-center">
                        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Dias com venda</p>
                        <p className="mt-1 text-sm font-semibold">
                          {`${formatNumber(salesTrend.activeDays)} de ${formatNumber(salesTrend.points.length)}`}
                        </p>
                      </div>

                      <div className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5 text-center">
                        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Melhor dia</p>
                        <p className="mt-1 text-sm font-semibold">
                          {salesTrend.bestDay ? formatYmdShort(salesTrend.bestDay.date) : "-"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {salesTrend.bestDay ? formatMoney(salesTrend.bestDay.sales, currency) : "Sem vendas"}
                        </p>
                      </div>

                      <div className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5 text-center">
                        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Acumulado</p>
                        <p className="mt-1 text-sm font-semibold">{formatMoney(salesTrend.totalSales, currency)}</p>
                        <p className="text-xs text-muted-foreground">{formatCountLabel(salesTrend.totalOrders, "pedido", "pedidos")}</p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {pagedSalesTrend.pageItems.map((point) => {
                        const width = point.sales <= 0
                          ? 2
                          : Math.max(8, (point.sales / salesTrend.maxSales) * 100);

                        return (
                          <div key={point.date} className="rounded-xl border border-border/60 bg-background/60 px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-semibold">{formatYmdShort(point.date)}</p>
                              <p className="text-xs text-muted-foreground">{formatCountLabel(point.orders, "pedido", "pedidos")}</p>
                            </div>

                            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
                              <div className="h-full rounded-full bg-primary/85" style={{ width: `${width}%` }} />
                            </div>

                            <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
                              <p className="font-semibold">{formatMoney(point.sales, currency)}</p>
                              <p className="text-muted-foreground">{`Comissão: ${formatMoney(point.totalCommission, currency)}`}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <TablePager
                      page={pagedSalesTrend.page}
                      totalPages={pagedSalesTrend.totalPages}
                      from={pagedSalesTrend.from}
                      to={pagedSalesTrend.to}
                      total={pagedSalesTrend.total}
                      itemLabel="dias"
                      onPageChange={setSalesTrendPage}
                    />
                  </>
                )}
              </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
        )}

        {showClicks && (
        <TabsContent value="clicks" className="mt-0 animate-in fade-in duration-500">
          <div className={tabViewportClass}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ReportKpiCard
              title="Cliques rastreados"
              value={formatNumber(clickInsights.totalClicks)}
              sub="Eventos únicos por conversão"
              icon={MousePointerClick}
              tone="primary"
            />
            <ReportKpiCard
              title="Hora de pico"
              value={clickInsights.peakHour?.label || "-"}
              sub={clickInsights.peakHour ? formatCountLabel(clickInsights.peakHour.clicks, "clique", "cliques") : "Sem dados"}
              icon={Clock3}
              tone="warning"
            />
            <ReportKpiCard
              title="Canais mapeados"
              value={formatNumber(realClickChannels.length)}
              sub={unknownChannelClicks > 0
                ? `${formatNumber(unknownChannelClicks)} cliques sem origem identificada`
                : "Origens reais de tráfego"}
              icon={TrendingUp}
              tone="info"
            />
            <ReportKpiCard
              title="IDs de Sub ativos"
              value={formatNumber(trackedSubIds)}
              sub={missingSubIdClicks > 0 ? `+ ${formatNumber(missingSubIdClicks)} cliques sem ID de Sub` : "Todos os cliques com ID de Sub"}
              icon={Layers3}
              tone="success"
            />
            </div>

            <Card className="border-border/70 bg-card/70 shadow-sm">
            <CardHeader className="pb-3">
              <ReportSectionHeader
                icon={BarChart3}
                title="Distribuição por hora"
                description="Comparativo de intensidade de cliques por janela horária."
              />
            </CardHeader>
            <CardContent>
              {clickInsights.byHour.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sem cliques rastreados no período selecionado.</p>
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
                        <p className="mt-1.5 text-xs text-muted-foreground">{formatCountLabel(point.clicks, "clique", "cliques")}</p>
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
                  title="Cliques reais por canal"
                  description="Apenas eventos com clickTime válido, ordenados do maior para o menor."
                  action={unknownChannelClicks > 0 ? (
                    <Badge variant="outline">{`${formatNumber(unknownChannelClicks)} sem origem`}</Badge>
                  ) : undefined}
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {pagedClickChannels.total === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum canal real encontrado para o período.</p>
                ) : (
                  <>
                    <DataTableShell minWidth={0}>
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="w-12 px-3 py-2 font-semibold">#</th>
                            <th className="w-[44%] px-3 py-2 font-semibold">Canal</th>
                            <th className="w-[22%] px-3 py-2 font-semibold">Cliques</th>
                            <th className="w-[22%] px-3 py-2 font-semibold">Participação</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedClickChannels.pageItems.map((point, index) => {
                            const rank = pagedClickChannels.from + index;
                            return (
                            <tr key={point.key} className="border-t border-border/60 align-top">
                              <td className="px-3 py-2.5">
                                <Badge variant="outline" className="min-w-[2rem] justify-center">{rank}</Badge>
                              </td>
                              <td className="px-3 py-2.5 font-medium">
                                <TruncatedCellText value={point.label} className="font-medium" />
                              </td>
                              <td className="px-3 py-2.5">{formatNumber(point.clicks)}</td>
                              <td className="px-3 py-2.5">{`${point.share.toFixed(1)}%`}</td>
                            </tr>
                            );
                          })}
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
                  title="Cliques reais por ID de Sub"
                  description="Apenas IDs de Sub válidos, ordenados do maior para o menor."
                  action={missingSubIdClicks > 0 ? (
                    <Badge variant="outline">{`${formatNumber(missingSubIdClicks)} sem ID de Sub`}</Badge>
                  ) : undefined}
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {pagedClickSubIds.total === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum ID de Sub válido detectado para o período.</p>
                ) : (
                  <>
                    <DataTableShell minWidth={0}>
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="w-12 px-3 py-2 font-semibold">#</th>
                            <th className="w-[44%] px-3 py-2 font-semibold">ID de Sub</th>
                            <th className="w-[22%] px-3 py-2 font-semibold">Cliques</th>
                            <th className="w-[22%] px-3 py-2 font-semibold">Participação</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedClickSubIds.pageItems.map((point, index) => {
                            const rank = pagedClickSubIds.from + index;
                            return (
                            <tr key={point.key} className="border-t border-border/60 align-top">
                              <td className="px-3 py-2.5">
                                <Badge variant="outline" className="min-w-[2rem] justify-center">{rank}</Badge>
                              </td>
                              <td className="px-3 py-2.5 font-medium">
                                <TruncatedCellText value={point.label} className="font-medium" />
                              </td>
                              <td className="px-3 py-2.5">{formatNumber(point.clicks)}</td>
                              <td className="px-3 py-2.5">{`${point.share.toFixed(1)}%`}</td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </DataTableShell>

                    <TablePager
                      page={pagedClickSubIds.page}
                      totalPages={pagedClickSubIds.totalPages}
                      from={pagedClickSubIds.from}
                      to={pagedClickSubIds.to}
                      total={pagedClickSubIds.total}
                      itemLabel="IDs de Sub"
                      onPageChange={setClickSubIdPage}
                    />
                  </>
                )}
              </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
        )}

        {showSales && (
        <TabsContent value="sales" className="mt-0 animate-in fade-in duration-500">
          <div className={tabViewportClass}>
            <Card className="border-border/70 bg-card/70 shadow-sm">
            <CardHeader className="pb-3">
              <ReportSectionHeader
                icon={Sparkles}
                title="Principais produtos por comissão"
                description="Itens mais recentes primeiro, destacando a contribuição de comissão no período."
              />
            </CardHeader>
            <CardContent className="space-y-3">
              {pagedTopProducts.total === 0 ? (
                <p className="text-sm text-muted-foreground">Sem produtos para o período selecionado.</p>
              ) : (
                <>
                  <DataTableShell minWidth={0}>
                    <table className="w-full table-fixed text-sm">
                      <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="w-[30%] px-3 py-2 font-semibold">Item</th>
                          <th className="w-[18%] px-3 py-2 font-semibold">Última compra</th>
                          <th className="w-[10%] px-3 py-2 font-semibold">Itens</th>
                          <th className="w-[10%] px-3 py-2 font-semibold">Pedidos</th>
                          <th className="w-[16%] px-3 py-2 font-semibold">Vendido</th>
                          <th className="w-[16%] px-3 py-2 font-semibold">Comissão</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedTopProducts.pageItems.map((product) => (
                          <tr key={product.key} className="border-t border-border/60 align-top">
                            <td className="px-3 py-2.5 font-medium">
                              <TruncatedCellText value={product.itemName} className="font-medium" />
                            </td>
                            <td className="px-3 py-2.5">{formatDateTime(product.latestPurchaseTime)}</td>
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
                  title="Canal: volume e comissão"
                  description="Consolidado de pedidos, vendas e comissões por canal."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {pagedSalesChannels.total === 0 ? (
                  <p className="text-sm text-muted-foreground">Sem canais com vendas para o período.</p>
                ) : (
                  <>
                    <DataTableShell minWidth={0}>
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="w-[44%] px-3 py-2 font-semibold">Canal</th>
                            <th className="w-[16%] px-3 py-2 font-semibold">Pedidos</th>
                            <th className="w-[20%] px-3 py-2 font-semibold">Vendido</th>
                            <th className="w-[20%] px-3 py-2 font-semibold">Comissão</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedSalesChannels.pageItems.map((point) => (
                            <tr key={point.key} className="border-t border-border/60 align-top">
                              <td className="px-3 py-2.5 font-medium">
                                <TruncatedCellText value={point.label} className="font-medium" />
                              </td>
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
                  title="ID de Sub: volume e comissão"
                  description="Leitura dos resultados por identificador de campanha."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {pagedSalesSubIds.total === 0 ? (
                  <p className="text-sm text-muted-foreground">Sem IDs de Sub com vendas no período.</p>
                ) : (
                  <>
                    <DataTableShell minWidth={0}>
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="w-[44%] px-3 py-2 font-semibold">ID de Sub</th>
                            <th className="w-[16%] px-3 py-2 font-semibold">Pedidos</th>
                            <th className="w-[20%] px-3 py-2 font-semibold">Vendido</th>
                            <th className="w-[20%] px-3 py-2 font-semibold">Comissão</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedSalesSubIds.pageItems.map((point) => (
                            <tr key={point.key} className="border-t border-border/60 align-top">
                              <td className="px-3 py-2.5 font-medium">
                                <TruncatedCellText value={point.label} className="font-medium" />
                              </td>
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
                      itemLabel="IDs de Sub"
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
                title="Resumo diário"
                description="Série temporal de vendas, comissões e volume de pedidos."
              />
            </CardHeader>
            <CardContent className="space-y-3">
              {pagedDaily.total === 0 ? (
                <p className="text-sm text-muted-foreground">Sem dados diários para o período.</p>
              ) : (
                <>
                  <DataTableShell minWidth={0}>
                    <table className="w-full table-fixed text-sm">
                      <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="w-[18%] px-3 py-2 font-semibold">Data</th>
                          <th className="w-[22%] px-3 py-2 font-semibold">Vendido</th>
                          <th className="w-[22%] px-3 py-2 font-semibold">Comissão</th>
                          <th className="w-[22%] px-3 py-2 font-semibold">Líquida</th>
                          <th className="w-[8%] px-3 py-2 font-semibold">Pedidos</th>
                          <th className="w-[8%] px-3 py-2 font-semibold">Itens</th>
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
          </div>

        </TabsContent>
        )}

        {showHistory && (
        <TabsContent value="history" className="mt-0 animate-in fade-in duration-500">
          <div className={tabViewportClass}>
            <Card className="border-border/70 bg-card/70 shadow-sm">
            <CardHeader className="pb-3">
              <ReportSectionHeader
                icon={Search}
                title="Histórico de vendas"
                description="Consulta detalhada dos eventos de conversão por pedido e item."
                action={(
                  <div className="relative w-full sm:w-[340px]">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={salesSearch}
                      onChange={(event) => setSalesSearch(event.target.value)}
                      placeholder="Buscar item, loja, pedido ou ID de Sub"
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
                  <DataTableShell minWidth={0}>
                    <table className="w-full table-fixed text-sm">
                      <thead className="bg-muted/45 text-left text-2xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="w-[11%] px-3 py-2 font-semibold">Compra</th>
                          <th className="w-[11%] px-3 py-2 font-semibold">Clique</th>
                          <th className="w-[13%] px-3 py-2 font-semibold">Pedido</th>
                          <th className="w-[18%] px-3 py-2 font-semibold">Item</th>
                          <th className="w-[12%] px-3 py-2 font-semibold">Loja</th>
                          <th className="w-[12%] px-3 py-2 font-semibold">Canal</th>
                          <th className="w-[9%] px-3 py-2 font-semibold">ID de Sub</th>
                          <th className="w-[8%] px-3 py-2 font-semibold">Vendido</th>
                          <th className="w-[8%] px-3 py-2 font-semibold">Comissão</th>
                          <th className="w-[10%] px-3 py-2 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedHistory.pageItems.map((row, idx) => (
                          <tr key={`${row.conversionId}:${row.orderId}:${idx}`} className="border-t border-border/60 align-top">
                            <td className="px-3 py-2.5">{formatDateTime(row.purchaseTime)}</td>
                            <td className="px-3 py-2.5">{formatDateTime(row.clickTime)}</td>
                            <td className="px-3 py-2.5">
                              <TruncatedCellText value={row.orderId || "-"} className="font-semibold" />
                              <TruncatedCellText value={`Conv: ${row.conversionId || "-"}`} className="mt-1 text-xs text-muted-foreground" />
                            </td>
                            <td className="px-3 py-2.5">
                              <TruncatedCellText value={row.itemName || "-"} className="font-medium" />
                              <TruncatedCellText value={row.displayItemStatus || "-"} className="mt-1 text-xs text-muted-foreground" />
                            </td>
                            <td className="px-3 py-2.5">
                              <TruncatedCellText value={row.shopName || "-"} />
                            </td>
                            <td className="px-3 py-2.5">
                              <TruncatedCellText value={row.referrer || "-"} />
                            </td>
                            <td className="px-3 py-2.5">
                              <TruncatedCellText value={normalizeSubId(row.utmContent)} />
                            </td>
                            <td className="px-3 py-2.5">{formatMoney(row.actualAmount, currency)}</td>
                            <td className="px-3 py-2.5">{formatMoney(row.totalCommission, currency)}</td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                <Badge variant={statusVariant(row.orderStatus)}>{orderStatusLabel(row.orderStatus)}</Badge>
                                {row.fraudStatus === "FRAUD" ? <Badge variant="destructive">Fraude</Badge> : null}
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
          </div>
        </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export default function ShopeeReports() {
  const { isConfigured, isLoading: loadingCredentials } = useShopeeCredentials();
  const [activeSource, setActiveSource] = useState<ShopeeReportSource>("conversion");
  const [activeView, setActiveView] = useState<ReportInnerView>("dashboard");
  const [preset, setPreset] = useState<ShopeeReportPreset>(DEFAULT_PRESET);
  const [draftRange, setDraftRange] = useState<DateRange>(() => buildPresetRange(DEFAULT_PRESET));
  const [appliedRange, setAppliedRange] = useState<DateRange>(() => buildPresetRange(DEFAULT_PRESET));
  const [draftFilters, setDraftFilters] = useState<ShopeeReportFilters>(DEFAULT_REPORT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<ShopeeReportFilters>(DEFAULT_REPORT_FILTERS);

  const reportsQuery = useQuery<ShopeeReportsResponse>({
    queryKey: ["shopee-reports", appliedRange.startDate, appliedRange.endDate, appliedFilters],
    enabled: isConfigured && !loadingCredentials,
    staleTime: 60_000,
    queryFn: async () => {
      const { data: { session } } = await backend.auth.getSession();
      if (!session) throw new Error("Sessão expirada. Faça login novamente.");

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

      throw (lastError || new Error("Função de relatório Shopee não implementada no backend."));
    },
  });

  const availableViews = useMemo<ReportInnerView[]>(() => getAvailableReportViews(), []);

  useEffect(() => {
    if (!reportsQuery.error) return;
    const rawMessage = reportsQuery.error instanceof Error ? reportsQuery.error.message : "Falha ao carregar relatórios Shopee";
    if (isFunctionNotImplementedError(rawMessage)) {
      toast.error("Backend de relatórios Shopee não sincronizado. Reinicie API e microsserviço Shopee.");
      return;
    }
    toast.error(rawMessage);
  }, [reportsQuery.error]);

  const currency = reportsQuery.data?.currency || "BRL";

  const handlePresetChange = (value: ShopeeReportPreset) => {
    setPreset(value);
    if (value === "custom") return;
    const range = buildPresetRange(value as ShopeeQuickPreset);
    setDraftRange(range);
  };

  const handleApplyRange = () => {
    const startDate = String(draftRange.startDate || "").trim();
    const endDate = String(draftRange.endDate || "").trim();
    if (!isValidYmd(startDate) || !isValidYmd(endDate)) {
      toast.error("Datas inválidas. Use o formato YYYY-MM-DD.");
      return;
    }
    if (startDate > endDate) {
      toast.error("Período inválido: data inicial maior que a data final.");
      return;
    }
    setAppliedRange({ startDate, endDate });
    setAppliedFilters({ ...draftFilters });
  };

  const handleResetFilters = () => {
    const baseRange = buildPresetRange(DEFAULT_PRESET);
    setPreset(DEFAULT_PRESET);
    setDraftRange(baseRange);
    setAppliedRange(baseRange);
    setDraftFilters(DEFAULT_REPORT_FILTERS);
    setAppliedFilters(DEFAULT_REPORT_FILTERS);
  };

  return (
    <PageWrapper fallbackLabel="Carregando relatórios...">
      <div className="ds-page pb-[calc(var(--safe-area-bottom)+0.75rem)]">
        <PageHeader
          title="Relatórios Shopee"
          description="Painel operacional para acompanhar comissões, cliques, produtos e histórico de vendas."
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
          <Card className="border-border/45 bg-card/75 shadow-sm">
            <CardContent className="px-3 py-2 sm:px-4 sm:py-2.5">
              <div className="mx-auto flex max-w-[1040px] items-center justify-center">
                <div className="flex w-full items-center justify-center gap-2 whitespace-nowrap">
                  <Badge variant="outline" className="h-7 rounded-full px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Filtros da consulta
                    </Badge>

                    <Badge variant="secondary" className="h-7 rounded-full px-2 text-[11px] font-medium">
                      {formatRangeSummary(draftRange)}
                    </Badge>

                    <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-background/55 px-0.5 py-0.5">
                      {PERIOD_INTERACTIVE_CHIPS.map((chip) => (
                        <Button
                          key={chip.value}
                          type="button"
                          size="sm"
                          variant={preset === chip.value ? "default" : "ghost"}
                          className={cn(
                            "h-6 rounded-full px-2 text-[11px] font-medium",
                            preset === chip.value ? "shadow-sm" : "text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() => handlePresetChange(chip.value)}
                          disabled={reportsQuery.isFetching}
                        >
                          {chip.label}
                        </Button>
                      ))}
                    </div>

                    {preset === "custom" ? (
                      <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/55 px-1 py-0.5">
                        <DatePicker
                          value={draftRange.startDate}
                          onChange={(nextDate) => setDraftRange((prev) => ({ ...prev, startDate: nextDate }))}
                          placeholder="Início"
                          className="h-7 w-[98px] rounded-full text-[11px]"
                        />

                        <DatePicker
                          value={draftRange.endDate}
                          onChange={(nextDate) => setDraftRange((prev) => ({ ...prev, endDate: nextDate }))}
                          minDate={draftRange.startDate}
                          placeholder="Fim"
                          className="h-7 w-[98px] rounded-full text-[11px]"
                        />
                      </div>
                    ) : null}

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetFilters}
                      disabled={reportsQuery.isFetching}
                      className="h-7 rounded-full px-3 text-xs"
                    >
                      Limpar
                    </Button>

                    <Button
                      size="sm"
                      onClick={handleApplyRange}
                      disabled={reportsQuery.isFetching}
                      className="h-7 rounded-full px-3 text-xs"
                    >
                      <CalendarDays className="mr-1 h-3.5 w-3.5" />
                      Aplicar
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
                title="Sem dados de relatório"
                description="Não foi possível carregar os dados para o período informado."
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
                className="min-h-[78px] h-full flex-col items-center justify-center gap-0.5 rounded-xl border border-transparent px-4 py-3 text-center data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                <span className="flex items-center justify-center gap-1.5 text-sm font-semibold">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Comissões estimadas
                </span>
                <span className="text-2xs text-muted-foreground">Acompanhamento em tempo real da captação</span>
              </TabsTrigger>

              <TabsTrigger
                value="validated"
                className="min-h-[78px] h-full flex-col items-center justify-center gap-0.5 rounded-xl border border-transparent px-4 py-3 text-center data-[state=active]:border-border/70 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                <span className="flex items-center justify-center gap-1.5 text-sm font-semibold">
                  <Wallet className="h-4 w-4 text-success" />
                  Comissões validadas
                </span>
                <span className="text-2xs text-muted-foreground">Base consolidada para fechamento financeiro</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="conversion" className="mt-0">
              <ReportBlockView
                source="conversion"
                title="Visão de conversões"
                block={reportsQuery.data.conversion}
                currency={currency}
                availableViews={availableViews}
                activeView={activeView}
                onActiveViewChange={setActiveView}
              />
            </TabsContent>

            <TabsContent value="validated" className="mt-0">
              <ReportBlockView
                source="validated"
                title="Visão de validação"
                block={reportsQuery.data.validated}
                currency={currency}
                availableViews={availableViews}
                activeView={activeView}
                onActiveViewChange={setActiveView}
              />
            </TabsContent>
          </Tabs>
        ) : null}
      </div>
    </PageWrapper>
  );
}
