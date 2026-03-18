import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, ExternalLink, CalendarDays, Star, ShoppingCart } from "lucide-react";
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
      toast.error("Link não disponível");
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
      toast.error("Link não disponível pra esse produto");
      return;
    }
    window.open(product.affiliateLink, "_blank");
  };

  return (
    <Card className="glass overflow-hidden group hover:shadow-lg transition-all duration-200 flex flex-col animate-card-in">
      {/* Image */}
      <div className="aspect-square bg-muted relative overflow-hidden">
        <img
          src={product.imageUrl || "/placeholder.svg"}
          alt={product.title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
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

      <CardContent className="p-3 space-y-2.5 flex-1 flex flex-col">
        {/* Title */}
        <p className="text-sm font-medium line-clamp-2 leading-snug min-h-[2.5rem]">
          {product.title}
        </p>

        {/* Price row */}
        <div className="flex items-end justify-between gap-2">
          <div className="space-y-0.5">
            {originalPrice > salePrice && originalPrice > 0 && (
              <span className="text-xs text-muted-foreground line-through block">
                R$ {originalPrice.toFixed(2)}
              </span>
            )}
            {salePrice > 0 && (
              <p className="text-base font-bold text-primary">
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
              <Star className="h-3 w-3 text-warning fill-warning" />
              {rating.toFixed(1)}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-1.5 pt-1 mt-auto">
          <Button
            size="sm"
            className="flex-1 text-xs h-8"
            onClick={copyLink}
          >
            <Copy className="h-3 w-3 mr-1" />
            Copiar link
          </Button>
          {onSchedule && (
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              onClick={() => onSchedule(product)}
              title="Agendar envio"
            >
              <CalendarDays className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            onClick={openAffiliateLink}
            title="Abrir no site"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
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
