import {
  applyAmazonTemplatePlaceholders,
  buildAmazonTemplatePlaceholderData,
  type AmazonTemplateProductInput,
} from "@/lib/amazon-template-placeholders";
import {
  applyMeliTemplatePlaceholders,
  buildMeliTemplatePlaceholderData,
  type MeliTemplateProductInput,
} from "@/lib/meli-template-placeholders";

export type MarketplaceTemplateScope = "meli" | "amazon";

export interface MarketplaceTemplatePlaceholderLegendItem {
  key: string;
  description: string;
}

export interface MarketplaceTemplateModule {
  scope: MarketplaceTemplateScope;
  defaultTemplateContent: string;
  placeholderLegend: MarketplaceTemplatePlaceholderLegendItem[];
  previewSample: Record<string, string>;
  buildPlaceholderData: (product: Record<string, unknown> | null | undefined, affiliateLink: string) => Record<string, string>;
  applyPlaceholders: (templateContent: string, placeholderData: Record<string, string>) => string;
}

export const MELI_TEMPLATE_MODULE: MarketplaceTemplateModule = {
  scope: "meli",
  defaultTemplateContent: "**{titulo}**\nDe R$ {preco_original} por R$ {preco}\n{parcelamento}\nNota: {avaliacao} ({avaliacoes})\nLoja: {vendedor}\n{link}",
  placeholderLegend: [
    { key: "{titulo}", description: "Titulo do produto" },
    { key: "{preco}", description: "Preco atual do produto" },
    { key: "{preco_original}", description: "Preco anterior do produto (quando houver)" },
    { key: "{link}", description: "Link de afiliado convertido" },
    { key: "{imagem}", description: "Imagem do produto (envio como anexo)" },
    { key: "{avaliacao}", description: "Nota media (quando disponivel)" },
    { key: "{avaliacoes}", description: "Quantidade de avaliacoes (quando disponivel)" },
    { key: "{parcelamento}", description: "Condicoes de parcelamento (quando disponivel)" },
    { key: "{vendedor}", description: "Nome da loja/vendedor (quando disponivel)" },
  ],
  previewSample: buildMeliTemplatePlaceholderData(
    {
      title: "Smartwatch Ultra Pro Bluetooth",
      productUrl: "https://www.mercadolivre.com.br/exemplo/p/MLB123456",
      imageUrl: "",
      price: 149.9,
      oldPrice: 249.9,
      installmentsText: "10x de R$14,99 sem juros",
      seller: "Loja Oficial Brasil",
      rating: 4.8,
      reviewsCount: 2311,
    },
    "https://autolinks.pro/exemplo",
  ),
  buildPlaceholderData: (product, affiliateLink) => buildMeliTemplatePlaceholderData(product as MeliTemplateProductInput | null | undefined, affiliateLink),
  applyPlaceholders: (templateContent, placeholderData) => applyMeliTemplatePlaceholders(templateContent, placeholderData),
};

export const AMAZON_TEMPLATE_MODULE: MarketplaceTemplateModule = {
  scope: "amazon",
  defaultTemplateContent: "**{titulo}**\nDe R$ {preco_original} por R$ {preco}\n{desconto}\nVendedor: {vendedor}\n{link}",
  placeholderLegend: [
    { key: "{titulo}", description: "Titulo do produto (tambem aceita {título})" },
    { key: "{preco}", description: "Preco atual do produto (tambem aceita {preço})" },
    { key: "{preco_original}", description: "Preco anterior do produto (tambem aceita {preço_original})" },
    { key: "{desconto}", description: "Desconto textual da oferta (quando disponivel)" },
    { key: "{parcelamento}", description: "Condicoes de parcelamento (quando disponivel)" },
    { key: "{vendedor}", description: "Loja/vendedor do anuncio" },
    { key: "{avaliacao}", description: "Nota media do produto (quando disponivel)" },
    { key: "{avaliacoes}", description: "Quantidade de avaliacoes (quando disponivel)" },
    { key: "{link}", description: "Link de afiliado convertido" },
    { key: "{imagem}", description: "Imagem do produto (envio como anexo)" },
  ],
  previewSample: buildAmazonTemplatePlaceholderData(
    {
      title: "Smartwatch Ultra Pro Bluetooth",
      productUrl: "https://www.amazon.com.br/dp/B0TEST1234",
      imageUrl: "",
      price: 149.9,
      oldPrice: 249.9,
      discountText: "40% off",
      seller: "Loja Oficial Brasil",
    },
    "https://www.amazon.com.br/dp/B0TEST1234?tag=seutag-20",
  ),
  buildPlaceholderData: (product, affiliateLink) => buildAmazonTemplatePlaceholderData(product as AmazonTemplateProductInput | null | undefined, affiliateLink),
  applyPlaceholders: (templateContent, placeholderData) => applyAmazonTemplatePlaceholders(templateContent, placeholderData),
};

export function getMarketplaceTemplateModule(scope: MarketplaceTemplateScope): MarketplaceTemplateModule {
  return scope === "amazon" ? AMAZON_TEMPLATE_MODULE : MELI_TEMPLATE_MODULE;
}
