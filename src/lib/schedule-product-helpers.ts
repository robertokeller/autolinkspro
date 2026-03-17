/**
 * Shared helper to map a ShopeeProduct into ScheduleProductModal's product prop.
 * Eliminates copy-pasted mapping in ShopeeVitrine and ShopeePesquisa.
 */
import type { ShopeeProduct } from "@/components/shopee/ProductCard";

export function toScheduleProduct(p: ShopeeProduct) {
  return {
    title: p.title,
    affiliateLink: p.affiliateLink,
    imageUrl: p.imageUrl,
    salePrice: p.salePrice,
    originalPrice: p.originalPrice,
    discount: p.discount,
    sales: p.sales,
    commission: p.commission,
    shopName: p.shopName,
  };
}
