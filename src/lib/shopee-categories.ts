/**
 * Verified Shopee Affiliate API category map (BR region).
 * All IDs tested 2026-02-20 with real API calls returning products.
 *
 * L1 categories use listType: 3, matchId: <id>
 * L2 subcategories use listType: 4, matchId: <id>
 */

export interface ShopeeSubCategory {
  id: number;
  label: string;
}

export interface ShopeeCategory {
  id: number;
  label: string;
  icon: string;
  subcategories: ShopeeSubCategory[];
}

export const SHOPEE_CATEGORIES: ShopeeCategory[] = [
  {
    id: 100646,
    label: "Alimentos",
    icon: "🍎",
    subcategories: [
      { id: 100647, label: "Mercearia" },
      { id: 100648, label: "Naturais" },
      { id: 100649, label: "Limpeza" },
      { id: 100650, label: "Suplementos" },
    ],
  },
  {
    id: 102187,
    label: "Automotivo",
    icon: "🚗",
    subcategories: [
      { id: 100640, label: "Peças & Acessórios" },
      { id: 100641, label: "Motos" },
      { id: 102188, label: "Estética Automotiva" },
    ],
  },
  {
    id: 100632,
    label: "Bebê",
    icon: "🍼",
    subcategories: [{ id: 100633, label: "Infantil" }],
  },
  {
    id: 100630,
    label: "Beleza & Perfumaria",
    icon: "💄",
    subcategories: [],
  },
  {
    id: 100015,
    label: "Bolsas & Mochilas",
    icon: "🎒",
    subcategories: [{ id: 100533, label: "Mochilas" }],
  },
  {
    id: 100532,
    label: "Calçados Femininos",
    icon: "👠",
    subcategories: [],
  },
  {
    id: 100012,
    label: "Calçados Masculinos",
    icon: "👟",
    subcategories: [],
  },
  {
    id: 100636,
    label: "Casa & Decoração",
    icon: "🏠",
    subcategories: [],
  },
  {
    id: 100013,
    label: "Celulares & Eletrônicos",
    icon: "📱",
    subcategories: [
      { id: 100074, label: "Acessórios" },
      { id: 100535, label: "Áudio & Fones" },
      { id: 100644, label: "Informática" },
      { id: 100534, label: "Relógios & Wearables" },
    ],
  },
  {
    id: 100637,
    label: "Esportes & Lazer",
    icon: "⚽",
    subcategories: [],
  },
  {
    id: 100639,
    label: "Hobbies & Lazer",
    icon: "🎮",
    subcategories: [],
  },
  {
    id: 100643,
    label: "Livros",
    icon: "📚",
    subcategories: [],
  },
  {
    id: 100017,
    label: "Moda Feminina",
    icon: "👗",
    subcategories: [],
  },
  {
    id: 100011,
    label: "Moda Masculina",
    icon: "👔",
    subcategories: [],
  },
  {
    id: 100638,
    label: "Papelaria",
    icon: "✏️",
    subcategories: [],
  },
  {
    id: 100631,
    label: "Pet Shop",
    icon: "🐾",
    subcategories: [],
  },
  {
    id: 100018,
    label: "Saúde",
    icon: "💊",
    subcategories: [{ id: 100019, label: "Cuidado Pessoal" }],
  },
];

/** Flat list of all browsable items (L1 + L2) for quick lookup */
export interface FlatCategory {
  matchId: number;
  listType: 3 | 4;
  label: string;
  icon: string;
  parentLabel?: string;
}

export function getFlatCategories(): FlatCategory[] {
  const flat: FlatCategory[] = [];
  for (const cat of SHOPEE_CATEGORIES) {
    flat.push({ matchId: cat.id, listType: 3, label: cat.label, icon: cat.icon });
    for (const sub of cat.subcategories) {
      flat.push({ matchId: sub.id, listType: 4, label: sub.label, icon: cat.icon, parentLabel: cat.label });
    }
  }
  return flat;
}

/** Deduplicate products by comparing first 50 chars of name + image filename */
import type { ShopeeProduct } from "@/components/shopee/ProductCard";

export function deduplicateProducts(products: ShopeeProduct[]): ShopeeProduct[] {
  const seen = new Set<string>();
  return products.filter((p) => {
    const nameKey = p.title.toLowerCase().slice(0, 50);
    const imgFile = p.imageUrl?.split("/").pop()?.split("?")[0] || "";
    const key = `${nameKey}|${imgFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Fisher-Yates shuffle */
export function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

