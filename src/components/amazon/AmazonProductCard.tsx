import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, CalendarDays, ShoppingCart, Star, Store, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export type AmazonVitrineItem = {
  id: string;
  tab: string;
  asin?: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  price: number;
  oldPrice: number | null;
  discountText: string;
  seller: string;
  shippingText?: string;
  installmentsText?: string;
  badgeText: string;
};

interface AmazonProductCardProps {
  item: AmazonVitrineItem;
  onConvert: (item: AmazonVitrineItem) => void;
  onSchedule: (item: AmazonVitrineItem) => void;
  isConverting?: boolean;
  isScheduling?: boolean;
}

const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2,
});

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return brlFormatter.format(value);
}

function calculateDiscountPercent(oldPrice: number | null | undefined, price: number | null | undefined): number {
  if (oldPrice === null || oldPrice === undefined || !Number.isFinite(oldPrice) || oldPrice <= 0) return 0;
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return 0;
  if (oldPrice <= price) return 0;
  const percent = Math.round(((oldPrice - price) / oldPrice) * 100);
  return Number.isFinite(percent) ? Math.max(0, percent) : 0;
}

function normalizeInstallmentsText(value: string): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = normalized.match(/(\d{1,2})x\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) return normalized.replace(/^ou\s+/i, "").trim();
  const suffix = /sem juros/i.test(normalized) ? " sem juros" : "";
  return `${match[1]}x de R$${match[2]}${suffix}`;
}

export function AmazonProductCard({ 
  item, 
  onConvert, 
  onSchedule, 
  isConverting, 
  isScheduling 
}: AmazonProductCardProps) {
  const discountPercent = calculateDiscountPercent(item.oldPrice, item.price);
  const installmentsText = normalizeInstallmentsText(item.installmentsText || "");

  return (
    <Card className="glass animate-card-in flex flex-col overflow-hidden transition-all duration-300 group hover:shadow-xl hover:-translate-y-1 hover:border-primary/20 cursor-pointer">
      {/* Image */}
      <div className="relative aspect-square overflow-hidden bg-secondary/20 m-1.5 rounded-lg border border-border/5">
        <img
          src={item.imageUrl || "/placeholder.svg"}
          alt={item.title}
          className="h-full w-full object-contain p-2 scale-110"
          onError={(e) => { e.currentTarget.src = "/placeholder.svg"; }}
          loading="lazy"
        />
        {discountPercent > 0 && (
          <Badge className="absolute top-2 right-2 bg-destructive text-destructive-foreground text-xs font-bold shadow-md">
            -{discountPercent}%
          </Badge>
        )}
      </div>

      <CardContent className="flex flex-1 flex-col space-y-2 p-2.5 pt-1.5 min-[420px]:space-y-2.5 min-[420px]:p-3 min-[420px]:pt-2 sm:p-3.5 sm:pt-2.5">
        {/* Title */}
        <p className="min-h-[2.25rem] text-xs font-medium leading-snug line-clamp-2 min-[420px]:min-h-[2.5rem] min-[420px]:text-sm">
          {item.title}
        </p>

        {/* Shop/Seller row */}
        <div className="flex items-center justify-between gap-2">
          {item.seller && (
            <p className="text-xs text-muted-foreground truncate flex-1 flex items-center gap-1">
              <Store className="h-3 w-3 shrink-0" />
              {item.seller}
            </p>
          )}
          {item.asin && (
            <span className="text-2xs text-muted-foreground font-mono opacity-60">
              ASIN: {item.asin}
            </span>
          )}
        </div>

        {/* Price row */}
        <div className="flex items-end justify-between gap-1 min-[420px]:gap-2">
          <div className="space-y-0.5 min-w-0">
            {item.oldPrice && item.oldPrice > item.price && (
              <span className="text-2xs text-muted-foreground line-through block min-[420px]:text-xs">
                {formatPrice(item.oldPrice)}
              </span>
            )}
            <p className="text-sm font-bold text-primary min-[420px]:text-base">
              {formatPrice(item.price)}
            </p>
          </div>
          <div className="text-right space-y-0.5">
            {installmentsText && (
              <span className="text-2xs font-medium text-success block leading-tight min-[420px]:text-xs">
                {installmentsText}
              </span>
            )}
          </div>
        </div>

        {/* Buttons row */}
        <div className="grid grid-cols-2 gap-1.5 pt-1 min-[420px]:gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-2 text-xs font-semibold sm:h-9"
            onClick={(e) => { e.stopPropagation(); onConvert(item); }}
            disabled={isConverting}
          >
            {isConverting ? <ShoppingCart className="h-3.5 w-3.5 animate-bounce" /> : <Copy className="h-3.5 w-3.5" />}
            Gerar
          </Button>

          <Button
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs font-semibold sm:h-9"
            onClick={(e) => { e.stopPropagation(); onSchedule(item); }}
            disabled={isScheduling}
          >
            {isScheduling ? <CalendarDays className="h-3.5 w-3.5 animate-pulse" /> : <CalendarDays className="h-3.5 w-3.5" />}
            Agendar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
