import { useEffect, useMemo, useRef, useState } from "react";
import { templateSchema } from "@/lib/validations";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ShopeeCredentialsBanner } from "@/components/ShopeeCredentialsBanner";
import { ScheduleProductModal } from "@/components/shopee/ScheduleProductModal";
import type { ShopeeProduct } from "@/components/shopee/ProductCard";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { useAmazonAffiliateTag } from "@/hooks/useAmazonAffiliateTag";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  FileText,
  Plus,
  Edit,
  Trash2,
  Copy,
  Star,
  Loader2,
  Link2,
  CheckCheck,
  Eye,
  CalendarDays,
  ImageIcon,
  Wand2,
} from "lucide-react";
import { useTemplates } from "@/hooks/useTemplates";
import { useShopeeLinkModule } from "@/contexts/ShopeeLinkModuleContext";
import type { Template, TemplateCategory } from "@/lib/types";
import type { MeliTemplateProductInput } from "@/lib/meli-template-placeholders";
import type { AmazonTemplateProductInput } from "@/lib/amazon-template-placeholders";
import { AMAZON_TEMPLATE_MODULE, MELI_TEMPLATE_MODULE } from "@/lib/marketplace-template-modules";
import { convertMarketplaceLink } from "@/lib/marketplace-link-converter";
import {
  applyTemplatePlaceholders,
  buildTemplatePlaceholderData,
  templateRequestsAiGeneratedCta,
  templateRequestsImageAttachment,
  templateRequestsPersonalizedCta,
  templateRequestsRandomCta,
} from "@/lib/template-placeholders";
import { renderRichTextPreviewHtml, renderTemplatePreviewHtml, formatMessageForPlatform } from "@/lib/rich-text";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const DEFAULT_TEMPLATE_FORM = {
  name: "",
  content: "",
  category: "oferta" as TemplateCategory,
};

const DEFAULT_TEMPLATE_CONTENT = "**{titulo}**\nDe R$ {preco_original} por R$ {preco}\n{desconto}% OFF\nNota: {avaliacao}\n{link}";

const PLACEHOLDER_LEGEND: Array<{ key: string; description: string }> = [
  { key: "{titulo}", description: "Nome do produto" },
  { key: "{preco}", description: "PreÃƒÂ§o com desconto" },
  { key: "{preco_original}", description: "PreÃƒÂ§o cheio (sem desconto)" },
  { key: "{desconto}", description: "Desconto percentual da oferta" },
  { key: "{link}", description: "Seu link de afiliado" },
  { key: "{cta_aleatoria}", description: "CTA automÃƒÂ¡tica com variaÃƒÂ§ÃƒÂ£o anti-repetiÃƒÂ§ÃƒÂ£o" },
  { key: "{cta_personalizada}", description: "CTA personalizada aleatÃƒÂ³ria das suas frases ativas" },
  { key: "{cta_gerada_por_ia}", description: "CTA gerada por IA com tom configurado por modelo" },
  { key: "{imagem}", description: "Imagem do produto (vai como anexo)" },
  { key: "{avaliacao}", description: "Nota dos compradores" },
];

const PLACEHOLDER_DESCRIPTION_OVERRIDES: Readonly<Partial<Record<string, string>>> = {
  "{preco}": "Preco com desconto",
  "{preco_original}": "Preco cheio (sem desconto)",
  "{desconto}": "Percentual da oferta (preco original - preco atual)",
  "{cta_aleatoria}": "CTA automatica com variacao anti-repeticao",
  "{cta_personalizada}": "CTA personalizada aleatoria das suas frases ativas",
};

const PLACEHOLDER_FIELDS: ReadonlyArray<{ key: string; description: string }> = PLACEHOLDER_LEGEND.map((item) => ({
  key: item.key,
  description: PLACEHOLDER_DESCRIPTION_OVERRIDES[item.key] || item.description,
}));

type AiCtaToneSelectorOption = {
  toneToken: string;
  toneKey: string;
  label: string;
  description: string;
};

const AI_CTA_DEFAULT_TONE_TOKEN = "cta_beneficio";

const AI_CTA_TONE_SELECTOR_OPTIONS: ReadonlyArray<AiCtaToneSelectorOption> = [
  {
    toneToken: "cta_urgencia",
    toneKey: "urgencia",
    label: "Urgencia",
    description: "Acao imediata com senso de agora.",
  },
  {
    toneToken: "cta_escassez",
    toneKey: "escassez",
    label: "Escassez",
    description: "Pouca disponibilidade e tempo curto.",
  },
  {
    toneToken: "cta_oportunidade",
    toneKey: "oportunidade",
    label: "Oportunidade",
    description: "Tom de achado com vantagem real.",
  },
  {
    toneToken: "cta_beneficio",
    toneKey: "beneficio",
    label: "Beneficio",
    description: "Utilidade e valor percebido.",
  },
  {
    toneToken: "cta_curiosidade",
    toneKey: "curiosidade",
    label: "Curiosidade",
    description: "Intriga clara para clique rapido.",
  },
  {
    toneToken: "cta_preco_forte",
    toneKey: "preco_forte",
    label: "Preco forte",
    description: "Sensacao de preco muito bom.",
  },
  {
    toneToken: "cta_achadinho",
    toneKey: "achadinho",
    label: "Achadinho",
    description: "Descoberta boa, leve e certeira.",
  },
  {
    toneToken: "cta_prova_social",
    toneKey: "prova_social",
    label: "Prova social",
    description: "Validacao social com naturalidade.",
  },
  {
    toneToken: "cta_desejo",
    toneKey: "desejo",
    label: "Desejo",
    description: "Aumenta vontade de ter o produto.",
  },
  {
    toneToken: "cta_dica_amiga",
    toneKey: "dica_amiga",
    label: "Dica amiga",
    description: "Recomendacao rapida com tom proximo.",
  },
  {
    toneToken: "cta_rotativo",
    toneKey: "rotativo",
    label: "Rotativo",
    description: "Alterna automaticamente entre os tons ativos da CTA IA.",
  },
];

const AI_CTA_TONE_SELECTOR_BY_TOKEN = new Map(
  AI_CTA_TONE_SELECTOR_OPTIONS.map((option) => [option.toneToken, option]),
);

// Preview rendered with sample data so the user sees a live render while editing
const PREVIEW_SAMPLE: Record<string, string> = {
  "{titulo}": "Fone Bluetooth TWS Pro",
  "{preco}": "67,90",
  "{preco_original}": "189,90",
  "{desconto}": "64",
  "{link}": "https://shope.ee/exemplo",
  "{cta_aleatoria}": "Comenta QUERO e garante o seu antes que esgote!",
  "{cta_personalizada}": "Comenta QUERO pra receber o link com desconto agora.",
  "{cta_gerada_por_ia}": "Clica no link e aproveita essa oferta antes de acabar",
  "{imagem}": "",
  "{avaliacao}": "4.8",
};

const MODEL_EDITOR_MODAL_FRAME_CLASS = "w-[min(calc(100vw-1rem),1020px)] max-h-[min(90dvh,calc(100dvh-1rem))] overflow-hidden rounded-2xl border border-border/60 bg-background p-0 shadow-2xl";
const TONE_MODAL_FRAME_CLASS = "w-[min(calc(100vw-1rem),760px)] max-h-[88dvh] overflow-hidden rounded-2xl border border-border/60 bg-background p-0 shadow-2xl";
const PERSONALIZED_MODAL_FRAME_CLASS = "w-[min(calc(100vw-1rem),860px)] max-h-[88dvh] overflow-hidden rounded-2xl border border-border/60 bg-background p-0 shadow-2xl";
const MODAL_HEADER_CLASS = "border-b px-4 py-4 text-left sm:px-6 sm:py-5";
const MODAL_BODY_CLASS = "min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5";
const MODAL_FOOTER_CLASS = "border-t bg-background/80 px-4 py-3 sm:px-6 sm:py-4";
const MODEL_MAIN_CARD_CLASS = "glass overflow-hidden border-border/60 shadow-sm";
const MODEL_MODAL_SECTION_CLASS = "mx-auto w-full max-w-3xl space-y-2.5 rounded-xl border border-border/60 bg-card/40 p-3 sm:space-y-3 sm:p-4";

type SupportedMarketplace = "shopee" | "mercadolivre" | "amazon";

interface MarketplaceOfferProduct extends Partial<ShopeeProduct> {
  productUrl?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  installmentsText?: string;
  seller?: string;
  reviewsCount?: number | null;
  discountText?: string;
  badgeText?: string;
  asin?: string;
}

interface GeneratedOffer {
  marketplace: SupportedMarketplace;
  templateId: string;
  templateName: string;
  message: string;
  affiliateLink: string;
  originalLink?: string;
  conversionTimeMs?: number | null;
  product: MarketplaceOfferProduct | null;
  imageUrl: string;
  requestsImageAttachment: boolean;
}

interface ConvertedAffiliateResult {
  marketplace: SupportedMarketplace;
  affiliateLink: string;
  originalLink: string;
  conversionTimeMs: number | null;
}

type MeliConvertLinkResponse = {
  affiliateLink?: string;
  originalLink?: string;
  resolvedLink?: string;
  conversionTimeMs?: number;
};

type MeliProductSnapshotResponse = {
  productUrl?: string;
  title?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  installmentsText?: string;
  seller?: string;
  rating?: number | null;
  reviewsCount?: number | null;
};

type AmazonProductSnapshotResponse = {
  productUrl?: string;
  title?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  discountText?: string;
  installmentsText?: string;
  seller?: string;
  rating?: number | null;
  reviewsCount?: number | null;
  badgeText?: string;
  asin?: string;
};

type RandomCtaNextResponse = {
  phrase?: string;
};

type PersonalizedCtaItem = {
  id: string;
  phrase: string;
  isActive: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type PersonalizedCtaListResponse = {
  items?: PersonalizedCtaItem[];
};

type PersonalizedCtaSaveResponse = {
  item?: PersonalizedCtaItem | null;
};

type PersonalizedCtaNextResponse = {
  phrase?: string;
};

type AiCtaToneItem = {
  key: string;
  label: string;
  description: string;
  sortOrder?: number;
  isActive?: boolean;
};

type AiCtaTonesListResponse = {
  items?: AiCtaToneItem[];
};

type AiCtaConfigItem = {
  id: string;
  templateId: string;
  toneKey: string;
  isActive: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type AiCtaConfigGetResponse = {
  templateId?: string;
  toneKey?: string;
  isActive?: boolean;
  item?: AiCtaConfigItem | null;
};

type AiCtaConfigSaveResponse = {
  item?: AiCtaConfigItem | null;
};

type AiCtaPlaceholdersNextResponse = {
  items?: Record<string, string>;
};

interface SchedulableProductInput {
  title?: string;
  affiliateLink: string;
  imageUrl?: string;
  salePrice?: number;
  originalPrice?: number;
  discount?: number;
  sales?: number;
  commission?: number;
  shopName?: string;
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    const parsed = String(value || "").trim();
    if (parsed) return parsed;
  }
  return "";
}

function normalizeAiCtaToneKey(value: unknown): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^cta_/, "");

  return normalized;
}

function toAiCtaToneToken(value: unknown): string {
  const toneKey = normalizeAiCtaToneKey(value);
  if (!toneKey) return AI_CTA_DEFAULT_TONE_TOKEN;

  const token = `cta_${toneKey}`;
  return AI_CTA_TONE_SELECTOR_BY_TOKEN.has(token) ? token : AI_CTA_DEFAULT_TONE_TOKEN;
}

function parseLocalizedNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const raw = String(value || "").trim();
  if (!raw) return undefined;

  let normalized = raw
    .replace(/[R$\s]/gi, "")
    .replace(/[^0-9.,-]/g, "");

  if (!normalized) return undefined;

  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/,/g, "");
  } else if (/^-?\d+,\d+$/.test(normalized)) {
    normalized = normalized.replace(",", ".");
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return parseLocalizedNumber(value);
}

function toPositiveNumber(value: unknown): number | undefined {
  const parsed = parseLocalizedNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeUrlInput(rawUrl: string): string {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function detectMarketplaceFromUrl(rawUrl: string): SupportedMarketplace | null {
  try {
    const parsed = new URL(normalizeUrlInput(rawUrl));
    const host = parsed.hostname.toLowerCase();

    if (host === "amazon.com.br" || host.endsWith(".amazon.com.br")) {
      return "amazon";
    }

    if (
      host === "meli.la"
      || host.endsWith(".meli.la")
      || host === "mlb.am"
      || host.endsWith(".mlb.am")
      || host.includes("mercadolivre")
      || host.includes("mercadolibre")
    ) {
      return "mercadolivre";
    }

    if (host.includes("shopee.") || host.endsWith("shope.ee")) {
      return "shopee";
    }
  } catch {
    return null;
  }

  return null;
}

function marketplaceLabel(value: SupportedMarketplace): string {
  if (value === "mercadolivre") return "Mercado Livre";
  if (value === "amazon") return "Amazon";
  return "Shopee";
}

function mergeTemplatePlaceholderData(
  marketplace: SupportedMarketplace,
  product: MarketplaceOfferProduct | null,
  affiliateLink: string,
): Record<string, string> {
  const genericData = buildTemplatePlaceholderData(
    product as Partial<ShopeeProduct> | null,
    affiliateLink,
  );

  if (marketplace === "mercadolivre") {
    const moduleData = MELI_TEMPLATE_MODULE.buildPlaceholderData(
      product as MeliTemplateProductInput,
      affiliateLink,
    );
    return {
      ...genericData,
      ...moduleData,
      "{desconto}": genericData["{desconto}"] || "",
    };
  }

  if (marketplace === "amazon") {
    const moduleData = AMAZON_TEMPLATE_MODULE.buildPlaceholderData(
      product as AmazonTemplateProductInput,
      affiliateLink,
    );
    return {
      ...genericData,
      ...moduleData,
      "{desconto}": firstNonEmptyString(genericData["{desconto}"], moduleData["{desconto}"]),
    };
  }

  return genericData;
}

function applyMarketplaceTemplate(
  marketplace: SupportedMarketplace,
  templateContent: string,
  placeholderData: Record<string, string>,
): string {
  if (marketplace === "mercadolivre") {
    return MELI_TEMPLATE_MODULE.applyPlaceholders(templateContent, placeholderData);
  }
  if (marketplace === "amazon") {
    return AMAZON_TEMPLATE_MODULE.applyPlaceholders(templateContent, placeholderData);
  }
  return applyTemplatePlaceholders(templateContent, placeholderData);
}

function withRandomCtaPlaceholderData(
  placeholderData: Record<string, string>,
  randomPhrase: string,
): Record<string, string> {
  const normalizedPhrase = String(randomPhrase || "").trim();
  if (!normalizedPhrase) return placeholderData;

  return {
    ...placeholderData,
    "{cta_aleatoria}": normalizedPhrase,
    "{{cta_aleatoria}}": normalizedPhrase,
    "{cta aleatoria}": normalizedPhrase,
    "{{cta aleatoria}}": normalizedPhrase,
  };
}

function withPersonalizedCtaPlaceholderData(
  placeholderData: Record<string, string>,
  personalizedPhrase: string,
): Record<string, string> {
  const normalizedPhrase = String(personalizedPhrase || "").trim();
  if (!normalizedPhrase) return placeholderData;

  return {
    ...placeholderData,
    "{cta_personalizada}": normalizedPhrase,
    "{{cta_personalizada}}": normalizedPhrase,
    "{cta personalizada}": normalizedPhrase,
    "{{cta personalizada}}": normalizedPhrase,
  };
}

function withAiGeneratedCtaPlaceholderData(
  placeholderData: Record<string, string>,
  generatedPlaceholderData: Record<string, string>,
): Record<string, string> {
  if (!generatedPlaceholderData || Object.keys(generatedPlaceholderData).length === 0) {
    return placeholderData;
  }

  return {
    ...placeholderData,
    ...generatedPlaceholderData,
  };
}

function resolveProductImageUrl(product: Partial<ShopeeProduct> | null | undefined): string {
  const source = (product || {}) as Record<string, unknown>;
  return firstNonEmptyString(
    source.imageUrl,
    source.image_url,
    source.image,
    source.thumbnail,
  );
}

function toSchedulableProduct(offer: GeneratedOffer): SchedulableProductInput {
  const source = (offer.product || {}) as Record<string, unknown>;
  const salePrice = toPositiveNumber(source.salePrice ?? source.price);
  const originalPrice = toPositiveNumber(
    source.originalPrice
    ?? source.oldPrice
    ?? source.priceMinBeforeDiscount
    ?? source.priceBeforeDiscount
    ?? source.priceMin,
  );

  return {
    title: firstNonEmptyString(source.title, source.productName, "Oferta"),
    affiliateLink: offer.affiliateLink,
    imageUrl: offer.imageUrl,
    salePrice,
    originalPrice,
    discount: toFiniteNumber(source.discount ?? source.priceDiscountRate),
    sales: toFiniteNumber(source.sales),
    commission: toFiniteNumber(source.commission ?? source.commissionRate),
    shopName: firstNonEmptyString(source.shopName, source.seller),
  };
}

export default function ModelosDeMensagem() {
  const {
    templates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    duplicateTemplate,
  } = useTemplates("message");
  const {
    isConfigured,
    isLoading: shopeeLoading,
    convertLink,
  } = useShopeeLinkModule();
  const {
    sessions,
    isLoading: meliSessionsLoading,
  } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const hasActiveMeliSession = useMemo(
    () => sessions.some((session) => session.status === "active"),
    [sessions],
  );
  const {
    isConfigured: hasAmazonTagConfigured,
    isLoading: amazonTagLoading,
  } = useAmazonAffiliateTag();

  // Ã¢â€â‚¬Ã¢â€â‚¬ modal create/edit Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState(DEFAULT_TEMPLATE_FORM);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Ã¢â€â‚¬Ã¢â€â‚¬ delete dialog Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleteTarget = templates.find((t) => t.id === deleteId);

  // Ã¢â€â‚¬Ã¢â€â‚¬ converter tool Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const [converterLink, setConverterLink] = useState("");
  const [converterTemplateId, setConverterTemplateId] = useState("");
  const [showConverterTemplateSelector, setShowConverterTemplateSelector] = useState(false);
  const [generatedOffer, setGeneratedOffer] = useState<GeneratedOffer | null>(null);
  const [convertedAffiliateResult, setConvertedAffiliateResult] = useState<ConvertedAffiliateResult | null>(null);
  const [imagePreviewFailed, setImagePreviewFailed] = useState(false);
  const [converting, setConverting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedAffiliateLink, setCopiedAffiliateLink] = useState(false);
  const [scheduleProduct, setScheduleProduct] = useState<SchedulableProductInput | null>(null);
  const [scheduleTemplateId, setScheduleTemplateId] = useState("");
  const [showPersonalizedCtaModal, setShowPersonalizedCtaModal] = useState(false);
  const [personalizedCtas, setPersonalizedCtas] = useState<PersonalizedCtaItem[]>([]);
  const [personalizedCtasLoading, setPersonalizedCtasLoading] = useState(false);
  const [personalizedCtasSaving, setPersonalizedCtasSaving] = useState(false);
  const [newPersonalizedCta, setNewPersonalizedCta] = useState("");
  const [editingPersonalizedCtaId, setEditingPersonalizedCtaId] = useState<string | null>(null);
  const [editingPersonalizedCtaPhrase, setEditingPersonalizedCtaPhrase] = useState("");
  const [showAiCtaModal, setShowAiCtaModal] = useState(false);
  const [aiCtaTones, setAiCtaTones] = useState<AiCtaToneItem[]>([]);
  const [selectedAiCtaToneToken, setSelectedAiCtaToneToken] = useState(AI_CTA_DEFAULT_TONE_TOKEN);
  const [aiCtaToneConfigured, setAiCtaToneConfigured] = useState(false);
  const [aiCtaLoading, setAiCtaLoading] = useState(false);

  useEffect(() => {
    setImagePreviewFailed(false);
  }, [generatedOffer?.imageUrl]);

  const trimmedConverterLink = useMemo(
    () => converterLink.trim(),
    [converterLink],
  );
  const detectedMarketplace = useMemo(
    () => detectMarketplaceFromUrl(trimmedConverterLink),
    [trimmedConverterLink],
  );
  const fallbackTemplateId = useMemo(
    () => templates.find((template) => template.isDefault)?.id || templates[0]?.id || "",
    [templates],
  );
  const selectedConverterTemplateId = useMemo(
    () => converterTemplateId || fallbackTemplateId,
    [converterTemplateId, fallbackTemplateId],
  );
  const selectedConverterTemplate = useMemo(
    () => templates.find((template) => template.id === selectedConverterTemplateId) || null,
    [selectedConverterTemplateId, templates],
  );
  const selectedConverterTemplateLabel = selectedConverterTemplate?.name || "Selecionar modelo de mensagem";
  const canRunLinkActions = !converting && !!trimmedConverterLink;
  const canGenerateFromTemplate = canRunLinkActions && templates.length > 0;

  useEffect(() => {
    if (templates.length === 0) {
      if (converterTemplateId) {
        setConverterTemplateId("");
      }
      return;
    }

    if (!converterTemplateId) return;
    if (templates.some((template) => template.id === converterTemplateId)) return;

    setConverterTemplateId(fallbackTemplateId);
  }, [converterTemplateId, fallbackTemplateId, templates]);

  const handleGenerateFromTemplateClick = () => {
    if (!showConverterTemplateSelector) {
      setShowConverterTemplateSelector(true);
      if (!converterTemplateId && fallbackTemplateId) {
        setConverterTemplateId(fallbackTemplateId);
      }
      if (templates.length === 0) {
        toast.error("Crie um modelo antes de gerar mensagem.");
      }
      return;
    }

    void handleConvert();
  };

  // Ã¢â€â‚¬Ã¢â€â‚¬ helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const openNew = () => {
    setForm(DEFAULT_TEMPLATE_FORM);
    setEditing(null);
    setSelectedAiCtaToneToken(AI_CTA_DEFAULT_TONE_TOKEN);
    setAiCtaToneConfigured(false);
    void preloadAiCtaToneForModelModal();
    setShowModal(true);
  };

  const openEdit = (t: Template) => {
    setForm({ name: t.name, content: t.content, category: "oferta" });
    setEditing(t);
    setSelectedAiCtaToneToken(AI_CTA_DEFAULT_TONE_TOKEN);
    setAiCtaToneConfigured(false);
    void preloadAiCtaToneForModelModal(t.id);
    setShowModal(true);
  };

  const preloadAiCtaToneForModelModal = async (templateId?: string) => {
    try {
      const tonesList = await loadAiCtaTones();
      const fallbackToneToken = toAiCtaToneToken(tonesList[0]?.key || AI_CTA_DEFAULT_TONE_TOKEN);

      if (templateId) {
        await loadAiCtaConfigForTemplate(templateId, tonesList);
        return;
      }

      setSelectedAiCtaToneToken(fallbackToneToken);
    } catch {
      // Keep modal usable even if AI CTA metadata cannot be loaded.
      setSelectedAiCtaToneToken(AI_CTA_DEFAULT_TONE_TOKEN);
    }
  };

  const insertPlaceholder = (key: string) => {
    const el = textareaRef.current;
    if (!el) {
      setForm((p) => ({ ...p, content: p.content + key }));
      return;
    }
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const next = form.content.slice(0, s) + key + form.content.slice(e);
    setForm((p) => ({ ...p, content: next }));
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(s + key.length, s + key.length);
    }, 0);
  };

  const wrapSelection = (open: string, close: string, emptyPlaceholder: string) => {
    const el = textareaRef.current;
    const s = el ? el.selectionStart : form.content.length;
    const e = el ? el.selectionEnd : form.content.length;
    const selected = form.content.slice(s, e);
    const inner = selected || emptyPlaceholder;
    const wrapped = `${open}${inner}${close}`;
    const next = form.content.slice(0, s) + wrapped + form.content.slice(e);
    setForm((p) => ({ ...p, content: next }));
    setTimeout(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(s + open.length, s + open.length + inner.length);
    }, 0);
  };

  const handleSave = async () => {
    const payload = { ...form, category: "oferta" as TemplateCategory };
    const parsed = templateSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.errors[0].message);
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const ok = await updateTemplate(editing.id, payload);
        if (!ok) return;

        const toneSaved = await persistAiCtaToneForTemplate(editing.id);
        if (toneSaved) setShowModal(false);
      } else {
        const created = await createTemplate(payload.name, payload.content, payload.category);
        if (!created) return;

        const toneSaved = await persistAiCtaToneForTemplate(created.id);
        if (toneSaved) setShowModal(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const normalizePersonalizedCtaPhrase = (value: string): string => {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const loadPersonalizedCtas = async () => {
    setPersonalizedCtasLoading(true);
    try {
      const response = await invokeBackendRpc<PersonalizedCtaListResponse>("cta-personalizada-list", {
        body: { source: "modelos-page" },
      });
      const items = Array.isArray(response?.items) ? response.items : [];
      setPersonalizedCtas(items);
    } catch {
      toast.error("Nao foi possivel carregar as CTAs personalizadas.");
    } finally {
      setPersonalizedCtasLoading(false);
    }
  };

  const openPersonalizedCtasModal = async () => {
    setShowPersonalizedCtaModal(true);
    await loadPersonalizedCtas();
  };

  const handleCreatePersonalizedCta = async () => {
    const phrase = normalizePersonalizedCtaPhrase(newPersonalizedCta);
    if (!phrase) {
      toast.error("Digite uma CTA personalizada antes de adicionar.");
      return;
    }

    setPersonalizedCtasSaving(true);
    try {
      await invokeBackendRpc<PersonalizedCtaSaveResponse>("cta-personalizada-save", {
        body: {
          phrase,
          isActive: true,
          source: "modelos-page",
        },
      });
      setNewPersonalizedCta("");
      await loadPersonalizedCtas();
      toast.success("CTA personalizada adicionada.");
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      toast.error(message || "Nao foi possivel salvar a CTA personalizada.");
    } finally {
      setPersonalizedCtasSaving(false);
    }
  };

  const handleStartEditPersonalizedCta = (item: PersonalizedCtaItem) => {
    setEditingPersonalizedCtaId(item.id);
    setEditingPersonalizedCtaPhrase(item.phrase || "");
  };

  const handleCancelEditPersonalizedCta = () => {
    setEditingPersonalizedCtaId(null);
    setEditingPersonalizedCtaPhrase("");
  };

  const handleSaveEditedPersonalizedCta = async (item: PersonalizedCtaItem) => {
    const phrase = normalizePersonalizedCtaPhrase(editingPersonalizedCtaPhrase);
    if (!phrase) {
      toast.error("A CTA personalizada nao pode ficar vazia.");
      return;
    }

    setPersonalizedCtasSaving(true);
    try {
      await invokeBackendRpc<PersonalizedCtaSaveResponse>("cta-personalizada-save", {
        body: {
          id: item.id,
          phrase,
          isActive: item.isActive,
          source: "modelos-page",
        },
      });
      handleCancelEditPersonalizedCta();
      await loadPersonalizedCtas();
      toast.success("CTA personalizada atualizada.");
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      toast.error(message || "Nao foi possivel atualizar a CTA personalizada.");
    } finally {
      setPersonalizedCtasSaving(false);
    }
  };

  const handleTogglePersonalizedCta = async (id: string, isActive: boolean) => {
    setPersonalizedCtasSaving(true);
    try {
      await invokeBackendRpc<PersonalizedCtaSaveResponse>("cta-personalizada-toggle", {
        body: {
          id,
          isActive,
          source: "modelos-page",
        },
      });
      await loadPersonalizedCtas();
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      toast.error(message || "Nao foi possivel atualizar o status da CTA personalizada.");
    } finally {
      setPersonalizedCtasSaving(false);
    }
  };

  const handleDeletePersonalizedCta = async (id: string) => {
    setPersonalizedCtasSaving(true);
    try {
      await invokeBackendRpc<{ ok?: boolean }>("cta-personalizada-delete", {
        body: {
          id,
          source: "modelos-page",
        },
      });
      if (editingPersonalizedCtaId === id) {
        handleCancelEditPersonalizedCta();
      }
      await loadPersonalizedCtas();
      toast.success("CTA personalizada removida.");
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      toast.error(message || "Nao foi possivel excluir a CTA personalizada.");
    } finally {
      setPersonalizedCtasSaving(false);
    }
  };

  const loadAiCtaTones = async (): Promise<AiCtaToneItem[]> => {
    const fallbackItems: AiCtaToneItem[] = AI_CTA_TONE_SELECTOR_OPTIONS.map((option, index) => ({
      key: option.toneKey,
      label: option.label,
      description: option.description,
      sortOrder: index + 1,
      isActive: true,
    }));

    try {
      const response = await invokeBackendRpc<AiCtaTonesListResponse>("cta-ia-tones-list", {
        body: {
          source: "modelos-page",
        },
      });

      const items = Array.isArray(response?.items)
        ? response.items.filter((item) => item && item.key)
        : [];
      const sortedItems = [...items].sort((left, right) => {
        const leftOrder = Number.isFinite(Number(left.sortOrder)) ? Number(left.sortOrder) : 0;
        const rightOrder = Number.isFinite(Number(right.sortOrder)) ? Number(right.sortOrder) : 0;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return String(left.label || left.key).localeCompare(String(right.label || right.key));
      });

      const resolvedItems = sortedItems.length > 0 ? sortedItems : fallbackItems;
      setAiCtaTones(resolvedItems);
      return resolvedItems;
    } catch {
      setAiCtaTones(fallbackItems);
      return fallbackItems;
    }
  };

  const loadAiCtaConfigForTemplate = async (
    templateId: string,
    tonesList: AiCtaToneItem[] = aiCtaTones,
  ) => {
    const fallbackToneToken = toAiCtaToneToken(tonesList[0]?.key || AI_CTA_DEFAULT_TONE_TOKEN);

    try {
      const response = await invokeBackendRpc<AiCtaConfigGetResponse>("cta-ia-config-get", {
        body: {
          templateId,
          source: "modelos-page",
        },
      });

      const responseToneKey = firstNonEmptyString(
        response?.toneKey,
        response?.item?.toneKey,
      );

      setSelectedAiCtaToneToken(responseToneKey ? toAiCtaToneToken(responseToneKey) : fallbackToneToken);
    } catch {
      setSelectedAiCtaToneToken(fallbackToneToken);
    }
  };

  const openAiCtaModal = async () => {
    setShowAiCtaModal(true);
    setAiCtaLoading(true);

    try {
      const tonesList = await loadAiCtaTones();
      const fallbackToneToken = toAiCtaToneToken(tonesList[0]?.key || AI_CTA_DEFAULT_TONE_TOKEN);

      if (editing?.id) {
        await loadAiCtaConfigForTemplate(editing.id, tonesList);
      } else if (!selectedAiCtaToneToken) {
        setSelectedAiCtaToneToken(fallbackToneToken);
      }
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      toast.error(message || "Nao foi possivel carregar configuracoes de CTA IA.");
    } finally {
      setAiCtaLoading(false);
    }
  };

  const handleApplyAiCtaTone = () => {
    if (!selectedAiCtaToneToken) {
      toast.error("Selecione um tom para a CTA IA.");
      return;
    }

    setAiCtaToneConfigured(true);
    setShowAiCtaModal(false);
  };

  const persistAiCtaToneForTemplate = async (templateId: string): Promise<boolean> => {
    if (!aiCtaToneConfigured) return true;

    const toneToken = firstNonEmptyString(selectedAiCtaToneToken, AI_CTA_DEFAULT_TONE_TOKEN);
    const toneKey = normalizeAiCtaToneKey(toneToken);
    if (!toneKey) return true;

    try {
      await invokeBackendRpc<AiCtaConfigSaveResponse>("cta-ia-config-save", {
        body: {
          templateId,
          toneKey: toneToken,
          isActive: true,
          source: "modelos-page",
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      toast.error(message || "Nao foi possivel salvar a configuracao de CTA IA.");
      return false;
    }
  };

  const resolveRandomCtaPreviewPhrase = async (templateContent: string): Promise<string> => {
    if (!templateRequestsRandomCta(templateContent)) return "";

    try {
      const response = await invokeBackendRpc<RandomCtaNextResponse>("cta-random-next", {
        body: {
          source: "modelos-preview",
          persist: false,
        },
      });
      return firstNonEmptyString(response?.phrase);
    } catch {
      return "";
    }
  };

  const resolvePersonalizedCtaPreviewPhrase = async (templateContent: string): Promise<string> => {
    if (!templateRequestsPersonalizedCta(templateContent)) return "";

    try {
      const response = await invokeBackendRpc<PersonalizedCtaNextResponse>("cta-personalizada-next", {
        body: {
          source: "modelos-preview",
        },
      });
      return firstNonEmptyString(response?.phrase);
    } catch {
      return "";
    }
  };

  const resolveAiGeneratedCtaPreviewData = async (
    template: Template,
    offerTitle: string,
  ): Promise<Record<string, string>> => {
    if (!templateRequestsAiGeneratedCta(template.content)) return {};

    try {
      const response = await invokeBackendRpc<AiCtaPlaceholdersNextResponse>("cta-ia-placeholders-next", {
        body: {
          templateId: template.id,
          templateContent: template.content,
          offerTitle,
          source: "modelos-preview",
          persist: false,
        },
      });
      return response?.items && typeof response.items === "object"
        ? response.items
        : {};
    } catch {
      return {};
    }
  };

  const resolveConverterInput = (): { link: string; marketplace: SupportedMarketplace } | null => {
    const link = converterLink.trim();
    if (!link) {
      toast.error("Cole um link da Shopee, Mercado Livre ou Amazon primeiro");
      return null;
    }

    const marketplace = detectMarketplaceFromUrl(link);
    if (!marketplace) {
      toast.error("Use um link vÃƒÂ¡lido da Shopee, Mercado Livre ou Amazon");
      return null;
    }

    if (marketplace === "shopee" && !isConfigured) {
      toast.error("Preencha as credenciais da Shopee antes de converter");
      return null;
    }

    if (marketplace === "mercadolivre") {
      if (meliSessionsLoading) {
        toast.error("Aguarde o carregamento das sessÃƒÂµes do Mercado Livre");
        return null;
      }
      if (!hasActiveMeliSession) {
        toast.error("Conecte uma sessÃƒÂ£o Mercado Livre ativa para converter");
        return null;
      }
    }

    if (marketplace === "amazon") {
      if (amazonTagLoading) {
        toast.error("Aguarde o carregamento da configuraÃƒÂ§ÃƒÂ£o Amazon");
        return null;
      }
      if (!hasAmazonTagConfigured) {
        toast.error("Configure sua tag Amazon antes de converter");
        return null;
      }
    }

    return { link, marketplace };
  };

  const handleConvertAffiliateLink = async () => {
    const resolvedInput = resolveConverterInput();
    if (!resolvedInput) return;

    const { link, marketplace } = resolvedInput;

    setConverting(true);
    setGeneratedOffer(null);
    setConvertedAffiliateResult(null);
    setCopied(false);
    setCopiedAffiliateLink(false);

    try {
      if (marketplace === "shopee") {
        const conversion = await convertLink(link, { source: "modelos-converter-link-shopee" });
        const affiliateLink = firstNonEmptyString(conversion.affiliateLink, link);

        setConvertedAffiliateResult({
          marketplace,
          affiliateLink,
          originalLink: link,
          conversionTimeMs: Number.isFinite(Number(conversion.conversionTimeMs))
            ? Number(conversion.conversionTimeMs)
            : null,
        });
        toast.success("Link de afiliado convertido.");
        return;
      }

      if (marketplace === "mercadolivre") {
        const conversion = await invokeBackendRpc<MeliConvertLinkResponse>("meli-convert-link", {
          body: {
            url: link,
            source: "modelos-converter-link-meli",
          },
        });

        const affiliateLink = firstNonEmptyString(
          conversion.affiliateLink,
          conversion.resolvedLink,
          conversion.originalLink,
          link,
        );

        setConvertedAffiliateResult({
          marketplace,
          affiliateLink,
          originalLink: firstNonEmptyString(conversion.originalLink, link),
          conversionTimeMs: Number.isFinite(Number(conversion.conversionTimeMs))
            ? Number(conversion.conversionTimeMs)
            : null,
        });
        toast.success("Link de afiliado convertido.");
        return;
      }

      const conversion = await convertMarketplaceLink({
        url: link,
        source: "modelos-converter-link-amazon",
      });
      if (conversion.marketplace !== "amazon") {
        throw new Error("Use um link vÃƒÂ¡lido da Amazon.");
      }

      const affiliateLink = firstNonEmptyString(
        conversion.affiliateLink,
        conversion.resolvedLink,
        conversion.originalLink,
        link,
      );

      setConvertedAffiliateResult({
        marketplace,
        affiliateLink,
        originalLink: firstNonEmptyString(conversion.originalLink, link),
        conversionTimeMs: Number.isFinite(Number(conversion.conversionTimeMs))
          ? Number(conversion.conversionTimeMs)
          : null,
      });
      toast.success("Link de afiliado convertido.");
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      const normalized = message
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (normalized.includes("cache da vitrine") || normalized.includes("atualize a vitrine")) {
        toast.error("ServiÃƒÂ§o Amazon desatualizado em execuÃƒÂ§ÃƒÂ£o. Reinicie o runtime para usar extraÃƒÂ§ÃƒÂ£o direta da pÃƒÂ¡gina do produto.");
      } else {
        toast.error(message || "NÃƒÂ£o deu pra converter o link");
      }
    } finally {
      setConverting(false);
    }
  };

  const handleConvert = async () => {
    const resolvedInput = resolveConverterInput();
    if (!resolvedInput) return;

    const { link, marketplace } = resolvedInput;

    const template = templates.find((t) => t.id === selectedConverterTemplateId);
    if (!template) {
      toast.error("Escolha um modelo de mensagem primeiro");
      return;
    }

    setConverting(true);
    setGeneratedOffer(null);
    setConvertedAffiliateResult(null);
    setCopied(false);
    setCopiedAffiliateLink(false);
    try {
      const randomCtaPhrase = await resolveRandomCtaPreviewPhrase(template.content);
      const personalizedCtaPhrase = await resolvePersonalizedCtaPreviewPhrase(template.content);

      if (templateRequestsPersonalizedCta(template.content) && !personalizedCtaPhrase) {
        toast.warning("Seu modelo usa {cta_personalizada}, mas voce ainda nao tem CTA personalizada ativa.");
      }

      if (marketplace === "shopee") {
        const conversion = await convertLink(link, { source: "modelos-converter-shopee" });
        const affiliateLink = conversion.affiliateLink || link;
        const product = (conversion.product || null) as MarketplaceOfferProduct | null;
        const basePlaceholderData = mergeTemplatePlaceholderData("shopee", product, affiliateLink);
        const aiGeneratedCtaPlaceholderData = await resolveAiGeneratedCtaPreviewData(
          template,
          firstNonEmptyString(product?.title, "Oferta Shopee"),
        );
        const placeholderData = withAiGeneratedCtaPlaceholderData(
          withPersonalizedCtaPlaceholderData(
            withRandomCtaPlaceholderData(basePlaceholderData, randomCtaPhrase),
            personalizedCtaPhrase,
          ),
          aiGeneratedCtaPlaceholderData,
        );
        const message = applyMarketplaceTemplate("shopee", template.content, placeholderData);
        const imageUrl = resolveProductImageUrl(conversion.product);

        setConverterTemplateId(template.id);
        setGeneratedOffer({
          marketplace: "shopee",
          templateId: template.id,
          templateName: template.name,
          message,
          affiliateLink,
          originalLink: link,
          conversionTimeMs: Number.isFinite(Number(conversion.conversionTimeMs))
            ? Number(conversion.conversionTimeMs)
            : null,
          product,
          imageUrl,
          requestsImageAttachment: templateRequestsImageAttachment(template.content),
        });
        return;
      }

      if (marketplace === "mercadolivre") {
        const conversion = await invokeBackendRpc<MeliConvertLinkResponse>("meli-convert-link", {
          body: {
            url: link,
            source: "modelos-converter-meli",
          },
        });

        const snapshotTargetUrl = firstNonEmptyString(
          conversion.resolvedLink,
          conversion.originalLink,
          link,
        );
        const affiliateLink = firstNonEmptyString(conversion.affiliateLink, snapshotTargetUrl);

        let productSnapshot: MeliProductSnapshotResponse | null = null;
        try {
          productSnapshot = await invokeBackendRpc<MeliProductSnapshotResponse>("meli-product-snapshot", {
            body: {
              productUrl: snapshotTargetUrl,
            },
          });
        } catch {
          toast.warning("Link convertido, mas alguns dados do produto nÃƒÂ£o puderam ser carregados.");
        }

        const product: MarketplaceOfferProduct = {
          title: firstNonEmptyString(productSnapshot?.title, "Oferta Mercado Livre"),
          productUrl: firstNonEmptyString(productSnapshot?.productUrl, snapshotTargetUrl),
          imageUrl: firstNonEmptyString(productSnapshot?.imageUrl),
          price: toFiniteNumber(productSnapshot?.price) ?? null,
          oldPrice: toFiniteNumber(productSnapshot?.oldPrice) ?? null,
          installmentsText: firstNonEmptyString(productSnapshot?.installmentsText),
          seller: firstNonEmptyString(productSnapshot?.seller),
          rating: toFiniteNumber(productSnapshot?.rating),
          reviewsCount: toFiniteNumber(productSnapshot?.reviewsCount) ?? null,
        };

        const basePlaceholderData = mergeTemplatePlaceholderData("mercadolivre", product, affiliateLink);
        const aiGeneratedCtaPlaceholderData = await resolveAiGeneratedCtaPreviewData(
          template,
          firstNonEmptyString(product.title, "Oferta Mercado Livre"),
        );
        const placeholderData = withAiGeneratedCtaPlaceholderData(
          withPersonalizedCtaPlaceholderData(
            withRandomCtaPlaceholderData(basePlaceholderData, randomCtaPhrase),
            personalizedCtaPhrase,
          ),
          aiGeneratedCtaPlaceholderData,
        );
        const message = applyMarketplaceTemplate("mercadolivre", template.content, placeholderData);

        setConverterTemplateId(template.id);
        setGeneratedOffer({
          marketplace: "mercadolivre",
          templateId: template.id,
          templateName: template.name,
          message,
          affiliateLink,
          originalLink: firstNonEmptyString(productSnapshot?.productUrl, snapshotTargetUrl),
          conversionTimeMs: Number.isFinite(Number(conversion.conversionTimeMs))
            ? Number(conversion.conversionTimeMs)
            : null,
          product,
          imageUrl: firstNonEmptyString(product.imageUrl),
          requestsImageAttachment: templateRequestsImageAttachment(template.content),
        });
        return;
      }

      const conversion = await convertMarketplaceLink({
        url: link,
        source: "modelos-converter-amazon",
      });
      if (conversion.marketplace !== "amazon") {
        throw new Error("Use um link vÃƒÂ¡lido da Amazon.");
      }

      const snapshotTargetUrl = firstNonEmptyString(conversion.resolvedLink, conversion.originalLink, link);
      const affiliateLink = firstNonEmptyString(conversion.affiliateLink, snapshotTargetUrl);
      const productSnapshot = await invokeBackendRpc<AmazonProductSnapshotResponse>("amazon-product-snapshot", {
        body: {
          productUrl: snapshotTargetUrl,
          asin: conversion.asin,
        },
      });

      const hasSnapshotCoreFields = Boolean(firstNonEmptyString(productSnapshot?.title)) && (
        (toFiniteNumber(productSnapshot?.price) ?? 0) > 0
        || Boolean(firstNonEmptyString(productSnapshot?.discountText))
        || Boolean(firstNonEmptyString(productSnapshot?.imageUrl))
      );
      if (!hasSnapshotCoreFields) {
        throw new Error("NÃƒÂ£o foi possÃƒÂ­vel extrair os dados do produto Amazon. Tente novamente em alguns instantes.");
      }

      const originalLink = firstNonEmptyString(productSnapshot?.productUrl, snapshotTargetUrl);
      const product: MarketplaceOfferProduct = {
        title: firstNonEmptyString(productSnapshot?.title, "Produto Amazon"),
        productUrl: firstNonEmptyString(productSnapshot?.productUrl, originalLink),
        imageUrl: firstNonEmptyString(productSnapshot?.imageUrl),
        price: toFiniteNumber(productSnapshot?.price) ?? null,
        oldPrice: toFiniteNumber(productSnapshot?.oldPrice) ?? null,
        discountText: firstNonEmptyString(productSnapshot?.discountText),
        installmentsText: firstNonEmptyString(productSnapshot?.installmentsText),
        seller: firstNonEmptyString(productSnapshot?.seller),
        badgeText: firstNonEmptyString(productSnapshot?.badgeText),
        asin: firstNonEmptyString(productSnapshot?.asin, conversion.asin),
        rating: toFiniteNumber(productSnapshot?.rating),
        reviewsCount: toFiniteNumber(productSnapshot?.reviewsCount) ?? null,
      };

      const basePlaceholderData = mergeTemplatePlaceholderData("amazon", product, affiliateLink);
      const aiGeneratedCtaPlaceholderData = await resolveAiGeneratedCtaPreviewData(
        template,
        firstNonEmptyString(product.title, "Produto Amazon"),
      );
      const placeholderData = withAiGeneratedCtaPlaceholderData(
        withPersonalizedCtaPlaceholderData(
          withRandomCtaPlaceholderData(basePlaceholderData, randomCtaPhrase),
          personalizedCtaPhrase,
        ),
        aiGeneratedCtaPlaceholderData,
      );
      const message = applyMarketplaceTemplate("amazon", template.content, placeholderData);

      setConverterTemplateId(template.id);
      setGeneratedOffer({
        marketplace: "amazon",
        templateId: template.id,
        templateName: template.name,
        message,
        affiliateLink,
        originalLink,
        conversionTimeMs: Number.isFinite(Number(conversion.conversionTimeMs))
          ? Number(conversion.conversionTimeMs)
          : null,
        product,
        imageUrl: firstNonEmptyString(product.imageUrl),
        requestsImageAttachment: templateRequestsImageAttachment(template.content),
      });
    } catch (error) {
      const message = error instanceof Error ? String(error.message || "") : "";
      const normalized = message
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (normalized.includes("cache da vitrine") || normalized.includes("atualize a vitrine")) {
        toast.error("ServiÃƒÂ§o Amazon desatualizado em execuÃƒÂ§ÃƒÂ£o. Reinicie o runtime para usar extraÃƒÂ§ÃƒÂ£o direta da pÃƒÂ¡gina do produto.");
      } else {
        toast.error(message || "NÃƒÂ£o deu pra converter o link");
      }
    } finally {
      setConverting(false);
    }
  };

  const handleCopy = () => {
    if (!generatedOffer?.message) return;
    // Convert to WhatsApp native format (*bold*, _italic_, ~strike~) so the
    // copied text renders correctly when pasted manually into WhatsApp or
    // Telegram (both accept the single-marker syntax in their chat input).
    navigator.clipboard.writeText(formatMessageForPlatform(generatedOffer.message, "whatsapp"));
    setCopied(true);
    toast.success("Copiado!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyConvertedAffiliateLink = () => {
    if (!convertedAffiliateResult?.affiliateLink) return;

    navigator.clipboard.writeText(convertedAffiliateResult.affiliateLink);
    setCopiedAffiliateLink(true);
    toast.success("Link de afiliado copiado!");
    setTimeout(() => setCopiedAffiliateLink(false), 2000);
  };

  const handleScheduleGeneratedOffer = () => {
    if (!generatedOffer) return;

    setScheduleTemplateId(generatedOffer.templateId);
    setScheduleProduct(toSchedulableProduct(generatedOffer));
  };

  const selectedAiCtaTone = useMemo(
    () => AI_CTA_TONE_SELECTOR_BY_TOKEN.get(selectedAiCtaToneToken) || null,
    [selectedAiCtaToneToken],
  );

  const selectableAiCtaTones = useMemo(() => {
    const activeToneKeys = new Set(
      aiCtaTones
        .map((tone) => normalizeAiCtaToneKey(tone.key))
        .filter(Boolean),
    );

    if (activeToneKeys.size === 0) return AI_CTA_TONE_SELECTOR_OPTIONS;

    const filtered = AI_CTA_TONE_SELECTOR_OPTIONS.filter((option) => activeToneKeys.has(option.toneKey));
    return filtered.length > 0 ? filtered : AI_CTA_TONE_SELECTOR_OPTIONS;
  }, [aiCtaTones]);

  const generatedOfferPreviewHtml = useMemo(
    () => (generatedOffer ? renderRichTextPreviewHtml(generatedOffer.message) : ""),
    [generatedOffer],
  );

  if (shopeeLoading) return null;

  return (
    <div className="ds-page">
      <PageHeader
        title="Modelos de Mensagem"
        description="Crie modelos de mensagem e gere previas completas para Shopee, Mercado Livre e Amazon."
      >
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1.5" />
            Novo modelo de mensagem
          </Button>
        </div>
      </PageHeader>

      {!isConfigured && <ShopeeCredentialsBanner />}

      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div className="space-y-5">
          <Card className={MODEL_MAIN_CARD_CLASS}>
            <CardHeader className="space-y-3 border-b pb-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1.5">
                  <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                    <Wand2 className="h-4 w-4 text-primary" />
                    Gerador de mensagem com modelo
                  </CardTitle>
                  <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground sm:text-sm">
                    Fluxo unificado: cole um link da Shopee, Mercado Livre ou Amazon para converter o afiliado e gerar mensagem pronta com o modelo selecionado.
                  </p>
                </div>
                <Badge variant="secondary" className="text-[11px]">
                  {templates.length} {templates.length === 1 ? "modelo" : "modelos"}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[11px]",
                    detectedMarketplace ? "border-primary/30 text-primary" : "text-muted-foreground",
                  )}
                >
                  {detectedMarketplace ? `Marketplace: ${marketplaceLabel(detectedMarketplace)}` : "Marketplace: aguardando link"}
                </Badge>
                {(showConverterTemplateSelector || generatedOffer) ? (
                  <span className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-xs text-muted-foreground">
                    Modelo ativo: <span className="font-medium text-foreground">{selectedConverterTemplateLabel}</span>
                  </span>
                ) : null}
              </div>
            </CardHeader>

            <CardContent className="space-y-5 pt-5">
              <div className="mx-auto w-full max-w-3xl space-y-4 rounded-xl border border-border/60 bg-muted/10 p-4 sm:space-y-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label className="text-xs font-medium text-foreground">Link do produto</Label>
                  <p className="text-[11px] text-muted-foreground">Shopee, Mercado Livre ou Amazon</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Cole o link para converter ou gerar mensagem</Label>
                  <Input
                    placeholder="Cole o link do produto aqui"
                    value={converterLink}
                    onChange={(e) => setConverterLink(e.target.value)}
                    className="h-11"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canRunLinkActions) {
                        void handleConvertAffiliateLink();
                      }
                    }}
                  />
                </div>

                <div className="grid grid-cols-1 gap-2 pt-1 sm:flex sm:items-center sm:justify-center sm:gap-3">
                  <Button
                    variant="outline"
                    onClick={handleConvertAffiliateLink}
                    disabled={!canRunLinkActions}
                    className="h-10 w-full sm:w-auto sm:min-w-[190px]"
                  >
                    {converting ? (
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : (
                      <Link2 className="h-4 w-4 mr-1.5" />
                    )}
                    Converter link
                  </Button>

                  <Button
                    onClick={handleGenerateFromTemplateClick}
                    disabled={!canRunLinkActions || (showConverterTemplateSelector && !canGenerateFromTemplate)}
                    className="h-10 w-full sm:w-auto sm:min-w-[230px]"
                  >
                    {converting && showConverterTemplateSelector ? (
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : (
                      <Wand2 className="h-4 w-4 mr-1.5" />
                    )}
                    {showConverterTemplateSelector ? "Confirmar e gerar mensagem" : "Gerar mensagem"}
                  </Button>
                </div>

                {showConverterTemplateSelector ? (
                  <div className="mx-auto w-full max-w-xl space-y-1.5 rounded-lg border border-border/60 bg-background/70 p-3">
                    <Label className="text-xs text-muted-foreground">Modelo de mensagem</Label>
                    {templates.length > 0 ? (
                      <Select value={converterTemplateId} onValueChange={setConverterTemplateId}>
                        <SelectTrigger className="h-10">
                          <SelectValue placeholder={selectedConverterTemplateLabel} />
                        </SelectTrigger>
                        <SelectContent>
                          {templates.map((template) => (
                            <SelectItem key={template.id} value={template.id}>
                              {template.name}
                              {template.isDefault ? " *" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        Nenhum modelo disponivel. Crie um modelo para gerar mensagem.
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              {templates.length === 0 ? (
                <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3 text-center text-xs text-muted-foreground">
                  Crie um modelo antes de gerar mensagem.
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className={MODEL_MAIN_CARD_CLASS}>
            <CardHeader className="space-y-3 border-b pb-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                  <Eye className="h-4 w-4 text-primary" />
                  Preview da mensagem
                </CardTitle>
                {generatedOffer?.conversionTimeMs ? (
                  <Badge variant="outline" className="text-[11px]">{generatedOffer.conversionTimeMs}ms</Badge>
                ) : convertedAffiliateResult?.conversionTimeMs ? (
                  <Badge variant="outline" className="text-[11px]">{convertedAffiliateResult.conversionTimeMs}ms</Badge>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground sm:text-sm">
                Resultado da conversao ou da mensagem completa aparece aqui.
              </p>
            </CardHeader>

            <CardContent className="space-y-4 pt-5">
              {generatedOffer ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border/60 bg-muted/15 p-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Mensagem gerada</Label>
                      <p className="text-xs text-muted-foreground">
                        Modelo: <span className="font-medium text-foreground">{generatedOffer.templateName}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Marketplace: <span className="font-medium text-foreground">{marketplaceLabel(generatedOffer.marketplace)}</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={handleCopy} className="h-8 text-xs">
                        {copied ? (
                          <CheckCheck className="h-3.5 w-3.5 mr-1 text-success" />
                        ) : (
                          <Copy className="h-3.5 w-3.5 mr-1" />
                        )}
                        {copied ? "Copiado!" : "Copiar"}
                      </Button>
                      <Button size="sm" onClick={handleScheduleGeneratedOffer} className="h-8 text-xs">
                        <CalendarDays className="h-3.5 w-3.5 mr-1" />
                        Agendar
                      </Button>
                    </div>
                  </div>

                  {generatedOffer.requestsImageAttachment && (
                    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <ImageIcon className="h-3.5 w-3.5" />
                        Previa de midia do placeholder {"{imagem}"}
                      </div>
                      {generatedOffer.imageUrl && !imagePreviewFailed ? (
                        <img
                          src={generatedOffer.imageUrl}
                          alt="Previa da imagem da oferta"
                          className="h-40 w-full rounded-md border bg-muted object-cover"
                          loading="lazy"
                          onError={() => setImagePreviewFailed(true)}
                        />
                      ) : (
                        <div className="flex h-20 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs text-muted-foreground">
                          Este modelo usa {"{imagem}"}, mas esse produto nao retornou uma imagem valida.
                        </div>
                      )}
                    </div>
                  )}

                  <pre
                    className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: generatedOfferPreviewHtml }}
                  />
                </>
              ) : convertedAffiliateResult ? (
                <>
                  <div className="space-y-1 rounded-lg border border-border/60 bg-muted/15 p-3">
                    <Label className="text-xs text-muted-foreground">Link de afiliado convertido</Label>
                    <p className="text-xs text-muted-foreground">
                      Marketplace: <span className="font-medium text-foreground">{marketplaceLabel(convertedAffiliateResult.marketplace)}</span>
                    </p>
                  </div>

                  <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2.5">
                    <Label className="mb-1 block text-xs text-muted-foreground">Link final de afiliado</Label>
                    <p className="break-all font-mono text-xs leading-relaxed text-primary">{convertedAffiliateResult.affiliateLink}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={handleCopyConvertedAffiliateLink} className="h-8 text-xs">
                      {copiedAffiliateLink ? (
                        <CheckCheck className="h-3.5 w-3.5 mr-1 text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 mr-1" />
                      )}
                      {copiedAffiliateLink ? "Copiado!" : "Copiar link"}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
                  Converta um link de afiliado ou gere uma mensagem para visualizar o resultado aqui.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className={cn(MODEL_MAIN_CARD_CLASS, "md:sticky md:top-20")}>
          <CardHeader className="space-y-3 border-b pb-5">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base sm:text-lg">Modelos de mensagem salvos</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {templates.length} {templates.length === 1 ? "modelo" : "modelos"}
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="pt-5">
            {templates.length > 0 ? (
              <div className="max-h-[calc(100dvh-240px)] space-y-3 overflow-y-auto pr-1">
                {templates.map((template) => (
                  <Card
                    key={template.id}
                    className={cn(
                      "relative overflow-hidden rounded-xl border border-border/60 bg-card/70 shadow-sm",
                      template.isDefault && "ring-1 ring-primary/30",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-y-0 left-0 w-1.5",
                        template.isDefault ? "bg-primary/70" : "bg-border",
                      )}
                    />

                    <CardContent className="relative px-4 py-4 sm:px-5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 pl-1">
                          <p className="truncate text-sm font-semibold leading-tight sm:text-base">
                            {template.name}
                          </p>
                        </div>

                        <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/80 px-1 py-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className={cn("h-8 w-8", template.isDefault ? "text-primary" : "text-muted-foreground")}
                            onClick={() => setDefaultTemplate(template.id)}
                            title={template.isDefault ? "Remover padrao" : "Definir como padrao"}
                          >
                            <Star className={cn("h-3.5 w-3.5", template.isDefault && "fill-primary")} />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => duplicateTemplate(template.id)}
                            title="Duplicar"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => openEdit(template)}
                            title="Editar"
                          >
                            <Edit className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-destructive"
                            onClick={() => setDeleteId(template.id)}
                            title="Excluir"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={FileText}
                title="Nenhum modelo ainda"
                description="Crie modelos com campos como {titulo}, {preco} e {link} para gerar mensagens automaticas."
                actionLabel="Criar modelo"
                onAction={openNew}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Ã¢â€â‚¬Ã¢â€â‚¬ Modal criar / editar Ã¢â€â‚¬Ã¢â€â‚¬ */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className={MODEL_EDITOR_MODAL_FRAME_CLASS}>
          <div className="grid h-full max-h-[94dvh] grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader className={cn(MODAL_HEADER_CLASS, "space-y-3 pr-12 text-center sm:pr-14 sm:text-center")}>
              <div className="flex flex-wrap items-center justify-center gap-2 text-center">
                <DialogTitle className="text-lg font-semibold tracking-tight">
                  {editing ? "Editar modelo de mensagem" : "Novo modelo de mensagem"}
                </DialogTitle>
                <Badge variant="secondary" className="text-[11px]">
                  {editing ? "Edicao" : "Novo"}
                </Badge>
              </div>
              <p className="mx-auto max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Estruture seu modelo com placeholders e visualize o resultado em tempo real.
              </p>
            </DialogHeader>

            <div className="grid min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1.18fr)_minmax(280px,0.82fr)]">
              <div className="min-h-0 space-y-4 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
                <section className={MODEL_MODAL_SECTION_CLASS}>
                  <Label className="text-sm font-medium">Nome</Label>
                  <Input
                    placeholder="Ex: Oferta Padrao"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="h-11"
                  />
                </section>

                <section className={MODEL_MODAL_SECTION_CLASS}>
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Conteudo</Label>
                    <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border bg-muted/20 px-2 py-2">
                      <button
                        type="button"
                        onClick={() => wrapSelection("**", "**", "negrito")}
                        title="Negrito"
                        className="flex h-8 w-8 items-center justify-center rounded border bg-background text-sm font-bold transition-colors hover:bg-secondary/60"
                      >
                        B
                      </button>
                      <button
                        type="button"
                        onClick={() => wrapSelection("__", "__", "italico")}
                        title="Italico"
                        className="flex h-8 w-8 items-center justify-center rounded border bg-background text-sm italic transition-colors hover:bg-secondary/60"
                      >
                        I
                      </button>
                      <button
                        type="button"
                        onClick={() => wrapSelection("~~", "~~", "riscado")}
                        title="Riscado"
                        className="flex h-8 w-8 items-center justify-center rounded border bg-background text-sm line-through transition-colors hover:bg-secondary/60"
                      >
                        S
                      </button>
                      <span className="basis-full text-center text-xs text-muted-foreground">
                        Selecione o texto e clique para formatar.
                      </span>
                    </div>
                  </div>

                  <Textarea
                    ref={textareaRef}
                    rows={11}
                    placeholder={DEFAULT_TEMPLATE_CONTENT}
                    value={form.content}
                    onChange={(e) => setForm({ ...form, content: e.target.value })}
                    className="min-h-[210px] resize-none leading-relaxed sm:min-h-[230px]"
                  />
                </section>

                <section className={MODEL_MODAL_SECTION_CLASS}>
                  <div className="space-y-0.5 text-center">
                    <Label className="text-sm font-medium">Campos disponiveis</Label>
                    <p className="text-xs text-muted-foreground">Clique em um campo para inserir no cursor.</p>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 justify-center text-xs"
                      onClick={openAiCtaModal}
                    >
                      CTA por IA ({selectedAiCtaTone?.label || "Beneficio"})
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 justify-center text-xs"
                      onClick={openPersonalizedCtasModal}
                    >
                      CTAs personalizadas
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-2 rounded-lg border border-border/60 bg-muted/10 p-2.5 sm:grid-cols-2">
                    {PLACEHOLDER_FIELDS.map((item) => {
                      const isInUse = form.content.includes(item.key);
                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => insertPlaceholder(item.key)}
                          title={item.description}
                          className={cn(
                            "min-h-[58px] rounded-md border px-2.5 py-2 text-left transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                            isInUse
                              ? "border-border/80 bg-muted/45"
                              : "border-border/55 bg-background/70 hover:border-border hover:bg-muted/30",
                          )}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[12px] font-medium text-foreground">{item.key}</span>
                            {isInUse ? (
                              <span className="rounded-full border border-border/70 bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Em uso
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{item.description}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>

              <div className="min-h-0 overflow-y-auto border-t border-border/60 bg-muted/20 px-3 py-3 sm:px-5 sm:py-4 lg:border-l lg:border-t-0">
                <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col rounded-xl border border-border/60 bg-card/50 p-3 sm:p-4">
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1.5 text-sm font-medium">
                      <Eye className="h-3 w-3" />
                      Preview em tempo real
                    </Label>
                    <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                      Visualizacao com dados de exemplo.
                    </p>
                  </div>
                  <pre
                    className="mt-2.5 min-h-[220px] flex-1 overflow-auto whitespace-pre-wrap rounded-xl border bg-background p-3 text-sm leading-relaxed sm:p-4 lg:min-h-0"
                    dangerouslySetInnerHTML={{
                      __html: renderTemplatePreviewHtml(
                        form.content || DEFAULT_TEMPLATE_CONTENT,
                        PREVIEW_SAMPLE,
                      ),
                    }}
                  />
                </div>
              </div>
            </div>

            <DialogFooter className={cn(MODAL_FOOTER_CLASS, "justify-center sm:justify-center")}>
              <Button variant="outline" className="w-full sm:w-auto sm:min-w-[160px]" onClick={() => setShowModal(false)}>
                Cancelar
              </Button>
              <Button className="w-full sm:w-auto sm:min-w-[190px]" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {editing ? "Salvar alteracoes" : "Criar modelo"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showPersonalizedCtaModal}
        onOpenChange={(open) => {
          setShowPersonalizedCtaModal(open);
          if (!open) {
            setNewPersonalizedCta("");
            handleCancelEditPersonalizedCta();
          }
        }}
      >
        <DialogContent className={PERSONALIZED_MODAL_FRAME_CLASS}>
          <div className="grid h-full max-h-[88dvh] grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader className={MODAL_HEADER_CLASS}>
              <DialogTitle>CTAs personalizadas</DialogTitle>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Cadastre frases e use o placeholder {"{cta_personalizada}"} para sortear entre as CTAs ativas.
              </p>
            </DialogHeader>

            <div className={`${MODAL_BODY_CLASS} space-y-4`}>
            <div className="rounded-xl border bg-muted/20 p-3 space-y-2.5">
              <Label className="text-sm font-medium">Nova CTA personalizada</Label>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <Input
                  className="h-9 text-sm"
                  placeholder="Ex: O mais barato que já passou por aqui..."
                  value={newPersonalizedCta}
                  onChange={(e) => setNewPersonalizedCta(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleCreatePersonalizedCta();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreatePersonalizedCta}
                  disabled={personalizedCtasLoading || personalizedCtasSaving || !newPersonalizedCta.trim()}
                  className="sm:min-w-28"
                >
                  {personalizedCtasSaving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                  Adicionar
                </Button>
              </div>
            </div>

            <div className="rounded-xl border bg-background/70 p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm font-medium">Suas CTAs personalizadas</Label>
                <span className="text-xs text-muted-foreground">
                  {personalizedCtas.length} {personalizedCtas.length === 1 ? "CTA" : "CTAs"}
                </span>
              </div>

              {personalizedCtasLoading ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Carregando CTAs personalizadas...
                </div>
              ) : personalizedCtas.length === 0 ? (
                <div className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
                  Nenhuma CTA personalizada cadastrada ainda.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {personalizedCtas.map((item) => {
                    const isEditing = editingPersonalizedCtaId === item.id;

                    return (
                      <div key={item.id} className="rounded-md border border-border/60 bg-background/45 px-2.5 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          {isEditing ? (
                            <div className="flex-1 min-w-[220px]">
                              <Input
                                value={editingPersonalizedCtaPhrase}
                                onChange={(e) => setEditingPersonalizedCtaPhrase(e.target.value)}
                                className="h-8 text-sm"
                              />
                            </div>
                          ) : (
                            <p className="flex-1 min-w-[220px] whitespace-pre-wrap break-words text-sm leading-snug">
                              {item.phrase}
                            </p>
                          )}

                          <div className="flex items-center gap-1.5 shrink-0">
                            <Switch
                              checked={item.isActive}
                              disabled={personalizedCtasSaving}
                              onCheckedChange={(checked) => {
                                void handleTogglePersonalizedCta(item.id, checked);
                              }}
                            />
                            <span className={`text-xs font-medium ${item.isActive ? "text-emerald-600" : "text-muted-foreground"}`}>
                              {item.isActive ? "Ativa" : "Inativa"}
                            </span>
                            {!isEditing ? (
                              <>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => handleStartEditPersonalizedCta(item)}
                                  disabled={personalizedCtasSaving}
                                  aria-label="Editar CTA"
                                  title="Editar CTA"
                                  className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                                >
                                  <Edit className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => {
                                    void handleDeletePersonalizedCta(item.id);
                                  }}
                                  disabled={personalizedCtasSaving}
                                  aria-label="Excluir CTA"
                                  title="Excluir CTA"
                                  className="h-7 w-7 rounded-md text-destructive hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
                          {isEditing ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={handleCancelEditPersonalizedCta}
                                disabled={personalizedCtasSaving}
                                className="h-8"
                              >
                                Cancelar
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => {
                                  void handleSaveEditedPersonalizedCta(item);
                                }}
                                disabled={personalizedCtasSaving}
                                className="h-8"
                              >
                                {personalizedCtasSaving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                                Salvar
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            </div>

            <DialogFooter className={MODAL_FOOTER_CLASS}>
              <Button size="sm" variant="outline" onClick={() => setShowPersonalizedCtaModal(false)}>
                Fechar
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showAiCtaModal}
        onOpenChange={(open) => {
          setShowAiCtaModal(open);
        }}
      >
        <DialogContent className={TONE_MODAL_FRAME_CLASS}>
          <div className="grid h-full max-h-[88dvh] grid-rows-[auto_minmax(0,1fr)_auto]">
            <DialogHeader className={MODAL_HEADER_CLASS}>
              <DialogTitle>CTA gerada por IA</DialogTitle>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Escolha apenas o tom da CTA para este modelo.
              </p>
            </DialogHeader>

            <div className={`${MODAL_BODY_CLASS}`}>
              {aiCtaLoading ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Carregando configuracoes de CTA IA...
                </div>
              ) : (
                <div className="mx-auto w-full max-w-md space-y-2">
                  <Label className="text-sm font-medium">Tom da CTA IA</Label>
                  <Select value={selectedAiCtaToneToken} onValueChange={setSelectedAiCtaToneToken}>
                    <SelectTrigger className="h-10 text-sm">
                      <SelectValue placeholder="Selecione um tom" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectableAiCtaTones.map((tone) => (
                        <SelectItem key={tone.toneToken} value={tone.toneToken}>
                          {tone.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <DialogFooter className={MODAL_FOOTER_CLASS}>
              <Button size="sm" variant="outline" onClick={() => setShowAiCtaModal(false)}>
                Fechar
              </Button>
              <Button
                size="sm"
                onClick={handleApplyAiCtaTone}
                disabled={aiCtaLoading || !selectedAiCtaToneToken}
              >
                Aplicar tom
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <ScheduleProductModal
        open={!!scheduleProduct}
        onOpenChange={(open) => {
          if (!open) {
            setScheduleProduct(null);
            setScheduleTemplateId("");
          }
        }}
        initialTemplateId={scheduleTemplateId}
        initialMessage={generatedOffer?.message || ""}
        product={scheduleProduct || undefined}
      />

      {/* Ã¢â€â‚¬Ã¢â€â‚¬ ConfirmaÃƒÂ§ÃƒÂ£o de exclusÃƒÂ£o Ã¢â€â‚¬Ã¢â€â‚¬ */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <AlertDialogContent className="w-[min(calc(100vw-1rem),32rem)] rounded-2xl border border-border/60">
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir modelo de mensagem?</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              O modelo <strong>{deleteTarget?.name}</strong> vai ser apagado de forma permanente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteId) deleteTemplate(deleteId);
                setDeleteId(null);
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
