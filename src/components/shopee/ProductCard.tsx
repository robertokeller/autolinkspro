import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, ExternalLink, CalendarDays, ThumbsUp, ShoppingCart } from "lucide-react";
import { toast } from "sonner";

export interface ShopeeProduct {
  id: string;
  title: string;
  imageUrl: string;
  originalPrice: number;
  salePrice: number;
  discount: number;
  commission: number;
  commissionValue?: number;
  sales: number;
  link: string;
  affiliateLink: string;
  category: string;
  shopName?: string;
  shopId?: string;
  itemId?: string;
  rating?: number;
}

interface ProductCardProps {
  product: ShopeeProduct;
  onSchedule?: (product: ShopeeProduct) => void;
  priorityImage?: boolean;
}

export function ProductCard({ product, onSchedule, priorityImage }: ProductCardProps) {
  const originalPrice = Number(product.originalPrice) || 0;
  const salePrice = Number(product.salePrice) || 0;
  const commission = Number(product.commission) || 0;
  const commissionValue = Number(product.commissionValue) || 0;
  const sales = Number(product.sales) || 0;
  const discount = Number(product.discount) || 0;
  const rating = Number(product.rating) || 0;

  const copyLink = () => {
    if (!product.affiliateLink) {
      toast.error("Link nï¿½o disponï¿½vel");
      return;
    }
    navigator.clipboard.writeText(product.affiliateLink);
    toast.success("Link copiado!");
  };

  // commissionRate comes as decimal from API (0.13 = 13%)
  const commissionPercent = commission > 0 && commission < 1 ? Math.round(commission * 100) : commission;
  
  // commissionValue already comes in R$ from API; fallback: salePrice * rate
  const estimatedCommission =
    commissionValue > 0
      ? commissionValue
      : salePrice > 0 && commission > 0
        ? salePrice * commission
        : 0;

  const openAffiliateLink = () => {
    if (!product.affiliateLink) {
      toast.error("Link não disponível para esse produto");
      return;
    }
    // Security: validate protocol before opening to prevent javascript: / data: injection
    try {
      const parsed = new URL(product.affiliateLink);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        toast.error("Link inválido.");
        return;
      }
    } catch {
      toast.error("Link inválido.");
      return;
    }
    window.open(product.affiliateLink, "_blank", "noopener,noreferrer");
  };

  return (
    <Card className="glass animate-card-in flex flex-col overflow-hidden transition-all duration-300 group hover:shadow-xl hover:-translate-y-1 hover:border-primary/20 cursor-pointer">
      {/* Image */}
      <div className="relative aspect-square overflow-hidden bg-secondary/20 m-1.5 rounded-lg border border-border/5">
        <img
          src={product.imageUrl || "/placeholder.svg"}
          alt={product.title}
          className="h-full w-full object-contain p-2 scale-110"
          onError={(e) => { e.currentTarget.src = "/placeholder.svg"; }}
          loading={priorityImage ? "eager" : "lazy"}
          decoding="async"
          {...(priorityImage ? { fetchPriority: "high" as const } : {})}
        />
        {discount > 0 && (
          <Badge className="absolute top-2 right-2 bg-destructive text-destructive-foreground text-xs font-bold shadow-md">
            -{discount}%
          </Badge>
        )}
        {commissionPercent > 0 && (
          <Badge className="absolute top-2 left-2 bg-success text-success-foreground text-2xs font-semibold shadow-md">
            {commissionPercent}% com.
          </Badge>
        )}
      </div>

      <CardContent className="flex flex-1 flex-col space-y-2 p-2.5 pt-1.5 min-[420px]:space-y-2.5 min-[420px]:p-3 min-[420px]:pt-2 sm:p-3.5 sm:pt-2.5">
        {/* Title */}
        <p className="min-h-[2.25rem] text-xs font-medium leading-snug line-clamp-2 min-[420px]:min-h-[2.5rem] min-[420px]:text-sm">
          {product.title}
        </p>

        {/* Price row */}
        <div className="flex items-end justify-between gap-1 min-[420px]:gap-2">
          <div className="space-y-0.5 min-w-0">
            {originalPrice > salePrice && originalPrice > 0 && (
              <span className="text-2xs text-muted-foreground line-through block min-[420px]:text-xs">
                R$ {originalPrice.toFixed(2)}
              </span>
            )}
            {salePrice > 0 && (
              <p className="text-sm font-bold text-primary min-[420px]:text-base">
                R$ {salePrice.toFixed(2)}
              </p>
            )}
          </div>
          <div className="text-right space-y-0.5">
            {estimatedCommission > 0 && (
              <span className="text-xs font-semibold text-success block">
                +R$ {estimatedCommission.toFixed(2)}
              </span>
            )}
            {sales > 0 && (
              <span className="text-xs text-muted-foreground flex items-center gap-0.5 justify-end">
                <ShoppingCart className="h-3 w-3" />
                {sales.toLocaleString("pt-BR")}
              </span>
            )}
          </div>
        </div>

        {/* Shop + rating row */}
        <div className="flex items-center justify-between gap-2">
          {product.shopName && (
            <p className="text-xs text-muted-foreground truncate flex-1">
              {product.shopName}
            </p>
          )}
          {rating > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-muted-foreground shrink-0">
              <ThumbsUp className="h-3 w-3 text-warning fill-warning" />
              {rating.toFixed(1)}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="mt-auto flex w-full flex-col gap-2 pt-3">
          <Button
            size="sm"
            className="w-full text-xs font-medium"
            onClick={copyLink}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copiar Link
          </Button>

          <div className="flex w-full items-center gap-2">
            {onSchedule && (
              <Button
                size="sm"
                variant="outline"
                className="flex-1 text-xs font-medium px-2"
                onClick={() => onSchedule(product)}
                title="Criar Agendamento"
              >
                <CalendarDays className="mr-2 h-3.5 w-3.5" />
                Agendar Envio
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs font-medium px-2"
              onClick={openAffiliateLink}
              title="Abrir Link"
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              Abrir Link
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ProductCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <Card
      className="glass overflow-hidden"
      style={{ animationDelay: `${index * 60}ms`, animationFillMode: "both" }}
    >
      <div className="aspect-square relative overflow-hidden bg-muted">
        <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      </div>
      <CardContent className="p-3 space-y-2.5">
        <div className="relative overflow-hidden h-4 bg-muted rounded w-full">
          <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" style={{ animationDelay: `${index * 60 + 100}ms` }} />
        </div>
        <div className="relative overflow-hidden h-4 bg-muted rounded w-3/4">
          <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" style={{ animationDelay: `${index * 60 + 150}ms` }} />
        </div>
        <div className="flex justify-between gap-2">
          <div className="relative overflow-hidden h-5 bg-muted rounded w-20">
            <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>
          <div className="relative overflow-hidden h-4 bg-muted rounded w-16">
            <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>
        </div>
        <div className="relative overflow-hidden h-3 bg-muted rounded w-24">
          <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        </div>
        <div className="flex gap-1.5 pt-1">
          <div className="relative overflow-hidden h-8 bg-muted rounded flex-1">
            <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>
          <div className="relative overflow-hidden h-8 w-8 bg-muted rounded">
            <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>
          <div className="relative overflow-hidden h-8 w-8 bg-muted rounded">
            <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
