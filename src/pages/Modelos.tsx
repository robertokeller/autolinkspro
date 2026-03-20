import { useRef, useState } from "react";
import { templateSchema } from "@/lib/validations";
import { useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ShopeeCredentialsBanner } from "@/components/ShopeeCredentialsBanner";
import { ScheduleProductModal } from "@/components/shopee/ScheduleProductModal";
import type { ShopeeProduct } from "@/components/shopee/ProductCard";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
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
} from "lucide-react";
import { useTemplateModule } from "@/contexts/TemplateModuleContext";
import { useShopeeLinkModule } from "@/contexts/ShopeeLinkModuleContext";
import type { Template, TemplateCategory } from "@/lib/types";
import {
  applyTemplatePlaceholders,
  buildTemplatePlaceholderData,
  templateRequestsImageAttachment,
} from "@/lib/template-placeholders";
import { renderRichTextPreviewHtml, renderTemplatePreviewHtml, formatMessageForPlatform } from "@/lib/rich-text";
import { toast } from "sonner";

const DEFAULT_TEMPLATE_FORM = {
  name: "",
  content: "",
  category: "oferta" as TemplateCategory,
};

const DEFAULT_TEMPLATE_CONTENT = "**{titulo}**\nDe R$ {preco_original} por R$ {preco}\n{desconto}% OFF 🔥\n{link}";

const PLACEHOLDER_LEGEND: Array<{ key: string; description: string }> = [
  { key: "{titulo}", description: "Nome do produto" },
  { key: "{preco}", description: "Preço com desconto" },
  { key: "{preco_original}", description: "Preço cheio (sem desconto)" },
  { key: "{desconto}", description: "Quanto economiza (%)" },
  { key: "{link}", description: "Seu link de afiliado" },
  { key: "{imagem}", description: "Imagem do produto (vai como anexo)" },
  { key: "{avaliacao}", description: "Nota dos compradores" },
];

// Preview rendered with sample data so the user sees a live render while editing
const PREVIEW_SAMPLE: Record<string, string> = {
  "{titulo}": "Fone Bluetooth TWS Pro",
  "{preco}": "67,90",
  "{preco_original}": "189,90",
  "{desconto}": "64",
  "{link}": "https://shope.ee/exemplo",
  "{imagem}": "",
  "{avaliacao}": "4.8",
};

interface GeneratedOffer {
  templateId: string;
  templateName: string;
  message: string;
  affiliateLink: string;
  product: Partial<ShopeeProduct> | null;
  imageUrl: string;
  requestsImageAttachment: boolean;
}

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

function toFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
    ?? source.priceMinBeforeDiscount
    ?? source.priceBeforeDiscount
    ?? source.priceMin,
  );

  return {
    title: firstNonEmptyString(source.title, source.productName, "Oferta Shopee"),
    affiliateLink: offer.affiliateLink,
    imageUrl: offer.imageUrl,
    salePrice,
    originalPrice,
    discount: toFiniteNumber(source.discount ?? source.priceDiscountRate),
    sales: toFiniteNumber(source.sales),
    commission: toFiniteNumber(source.commission ?? source.commissionRate),
    shopName: firstNonEmptyString(source.shopName),
  };
}

export default function Templates() {
  const {
    templates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    duplicateTemplate,
  } = useTemplateModule();
  const {
    isConfigured,
    isLoading: shopeeLoading,
    convertLink,
  } = useShopeeLinkModule();

  // ── modal create/edit ────────────────────────────────────────────────
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState(DEFAULT_TEMPLATE_FORM);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── delete dialog ────────────────────────────────────────────────────
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleteTarget = templates.find((t) => t.id === deleteId);

  // ── converter tool ───────────────────────────────────────────────────
  const [converterLink, setConverterLink] = useState("");
  const [converterTemplateId, setConverterTemplateId] = useState("");
  const [generatedOffer, setGeneratedOffer] = useState<GeneratedOffer | null>(null);
  const [converting, setConverting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scheduleProduct, setScheduleProduct] = useState<SchedulableProductInput | null>(null);
  const [scheduleTemplateId, setScheduleTemplateId] = useState("");

  // ── helpers ──────────────────────────────────────────────────────────
  const openNew = () => {
    setForm(DEFAULT_TEMPLATE_FORM);
    setEditing(null);
    setShowModal(true);
  };

  const openEdit = (t: Template) => {
    setForm({ name: t.name, content: t.content, category: "oferta" });
    setEditing(t);
    setShowModal(true);
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
        await updateTemplate(editing.id, payload);
      } else {
        await createTemplate(payload.name, payload.content, payload.category);
      }
      setShowModal(false);
    } finally {
      setSaving(false);
    }
  };

  const handleConvert = async () => {
    const link = converterLink.trim();
    if (!link) {
      toast.error("Cole um link da Shopee primeiro");
      return;
    }
    if (!isConfigured) {
      toast.error("Preencha as credenciais da Shopee antes de converter");
      return;
    }

    const effectiveId =
      converterTemplateId ||
      templates.find((t) => t.isDefault)?.id ||
      templates[0]?.id;
    const template = templates.find((t) => t.id === effectiveId);
    if (!template) {
      toast.error("Escolha um template primeiro");
      return;
    }

    setConverting(true);
    setGeneratedOffer(null);
    setCopied(false);
    try {
      const conversion = await convertLink(link, { source: "templates-converter" });
      const affiliateLink = conversion.affiliateLink || link;
      const data = buildTemplatePlaceholderData(conversion.product, affiliateLink);
      const message = applyTemplatePlaceholders(template.content, data);
      const imageUrl = resolveProductImageUrl(conversion.product);

      setConverterTemplateId(template.id);
      setGeneratedOffer({
        templateId: template.id,
        templateName: template.name,
        message,
        affiliateLink,
        product: conversion.product || null,
        imageUrl,
        requestsImageAttachment: templateRequestsImageAttachment(template.content),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra converter o link");
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

  const handleScheduleGeneratedOffer = () => {
    if (!generatedOffer) return;

    setScheduleTemplateId(generatedOffer.templateId);
    setScheduleProduct(toSchedulableProduct(generatedOffer));
  };

  const generatedOfferPreviewHtml = useMemo(
    () => (generatedOffer ? renderRichTextPreviewHtml(generatedOffer.message) : ""),
    [generatedOffer],
  );

  if (shopeeLoading) return null;

  return (
    <div className="ds-page">
      <PageHeader
        title="Templates Shopee"
        description="Monte modelos de mensagem e gere ofertas com dados reais da Shopee"
      >
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1.5" />
          Novo template
        </Button>
      </PageHeader>

      {!isConfigured && <ShopeeCredentialsBanner />}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <Card className="glass xl:sticky xl:top-20">
          <CardHeader className="border-b pb-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <Link2 className="h-4 w-4 text-primary" />
              Gerador de oferta com template
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Cole um link da Shopee, escolha o template e gere a mensagem pronta com preview.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Link do produto</Label>
                <Input
                  placeholder="Cole o link do produto Shopee aqui"
                  value={converterLink}
                  onChange={(e) => setConverterLink(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleConvert()}
                />
              </div>

              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Template</Label>
                  <Select value={converterTemplateId} onValueChange={setConverterTemplateId}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          templates.find((t) => t.isDefault)?.name || "Selecionar template"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                          {t.isDefault ? " ★" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={handleConvert}
                  disabled={converting || !converterLink.trim()}
                  className="h-10 sm:min-w-28"
                >
                  {converting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <Link2 className="h-4 w-4 mr-1.5" />
                  )}
                  Converter
                </Button>
              </div>
            </div>

            {generatedOffer && (
              <div className="space-y-3">
                <Separator />
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <Label className="text-xs text-muted-foreground">Oferta gerada</Label>
                    <p className="text-[11px] text-muted-foreground">
                      Template: <span className="font-medium text-foreground">{generatedOffer.templateName}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
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
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <ImageIcon className="h-3.5 w-3.5" />
                      Prévia de mídia do placeholder {"{imagem}"}
                    </div>
                    {generatedOffer.imageUrl ? (
                      <img
                        src={generatedOffer.imageUrl}
                        alt="Prévia da imagem da oferta"
                        className="h-40 w-full rounded-md border bg-muted object-cover"
                        loading="lazy"
                        onError={(e) => { e.currentTarget.src = "/placeholder.svg"; }}
                      />
                    ) : (
                      <div className="flex h-20 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs text-muted-foreground">
                        Este template usa {"{imagem}"}, mas esse produto não retornou uma imagem válida.
                      </div>
                    )}
                  </div>
                )}

                {/* safe: renderRichTextPreviewHtml escapes all HTML via escapeHtml() before applying markup tags */}
                <pre
                  className="text-sm whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 leading-relaxed max-h-72 overflow-y-auto"
                  dangerouslySetInnerHTML={{
                    __html: generatedOfferPreviewHtml,
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader className="border-b pb-4">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-sm">Templates salvos</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {templates.length} {templates.length === 1 ? "template" : "templates"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {templates.length > 0 ? (
              <div className="space-y-3">
                {templates.map((template) => (
                  <Card
                    key={template.id}
                    className={`relative overflow-hidden rounded-xl border bg-card/70 shadow-sm ${
                      template.isDefault ? "ring-1 ring-primary/30" : ""
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`absolute inset-y-0 left-0 w-1.5 ${template.isDefault ? "bg-primary/70" : "bg-border"}`}
                    />

                    <CardContent className="relative px-4 py-3.5 sm:px-5 sm:py-4">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <div className="min-w-0 flex-1 pl-1">
                          <p className="truncate text-base font-semibold leading-tight tracking-tight">
                            {template.name}
                          </p>
                        </div>

                        {template.isDefault && (
                          <Badge
                            variant="secondary"
                            className="text-[11px] bg-primary/12 text-primary shrink-0"
                          >
                            Padrão
                          </Badge>
                        )}

                        <div className="shrink-0 flex items-center gap-1 rounded-full border border-border/60 bg-background/80 px-1 py-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className={`h-8 w-8 ${template.isDefault ? "text-primary" : "text-muted-foreground"}`}
                            onClick={() => setDefaultTemplate(template.id)}
                            title={template.isDefault ? "Remover padrão" : "Definir como padrão"}
                          >
                            <Star className={`h-3.5 w-3.5 ${template.isDefault ? "fill-primary" : ""}`} />
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
                title="Nenhum template ainda"
                description='Crie templates com campos como {titulo}, {preco} e {link} pra gerar ofertas automáticas.'
                actionLabel="Criar template"
                onAction={openNew}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Modal criar / editar ── */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-w-4xl max-h-[92dvh] overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>{editing ? "Editar template" : "Novo template"}</DialogTitle>
          </DialogHeader>

          <div className="grid md:grid-cols-2 overflow-y-auto md:overflow-hidden">
            {/* ─ Esquerda: formulário ─ */}
            <div className="space-y-4 px-6 py-5 overflow-y-auto max-h-[50dvh] md:max-h-[72dvh]">
              <div className="space-y-2">
                <Label>Nome</Label>
                <Input
                  placeholder="Ex: Oferta Padrão"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label>Conteúdo</Label>
                <div className="flex items-center gap-1 mb-1">
                  <button
                    type="button"
                    onClick={() => wrapSelection("**", "**", "negrito")}
                    title="Negrito — funciona no WhatsApp e Telegram"
                    className="h-7 w-8 rounded border bg-background text-sm font-bold hover:bg-secondary/60 transition-colors flex items-center justify-center"
                  >
                    B
                  </button>
                  <button
                    type="button"
                    onClick={() => wrapSelection("__", "__", "itálico")}
                    title="Itálico — funciona no WhatsApp e Telegram"
                    className="h-7 w-7 rounded border bg-background text-sm italic hover:bg-secondary/60 transition-colors flex items-center justify-center"
                  >
                    I
                  </button>
                  <button
                    type="button"
                    onClick={() => wrapSelection("~~", "~~", "riscado")}
                    title="Riscado — funciona no WhatsApp e Telegram"
                    className="h-7 w-8 rounded border bg-background text-sm line-through hover:bg-secondary/60 transition-colors flex items-center justify-center"
                  >
                    S
                  </button>
                  <span className="text-2xs text-muted-foreground ml-1">
                    Selecione o texto e clique pra formatar
                  </span>
                </div>
                <Textarea
                  ref={textareaRef}
                  rows={8}
                  placeholder={DEFAULT_TEMPLATE_CONTENT}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Campos disponíveis — clique pra inserir onde o cursor está
                </Label>
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {PLACEHOLDER_LEGEND.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => insertPlaceholder(p.key)}
                        className="inline-flex items-center rounded-md border bg-background px-2 py-1 text-xs hover:bg-secondary/50 transition-colors"
                        title={p.description}
                      >
                        <code className="text-primary font-mono">{p.key}</code>
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-0.5 pt-1 border-t">
                    {PLACEHOLDER_LEGEND.map((p) => (
                      <div key={p.key} className="flex gap-2 py-0.5 text-xs text-muted-foreground">
                        <code className="text-primary shrink-0 w-32">{p.key}</code>
                        <span>{p.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ─ Direita: preview ao vivo ─ */}
            <div className="border-t md:border-t-0 md:border-l bg-muted/20 px-6 py-5 space-y-3 flex flex-col overflow-hidden max-h-[50dvh] md:max-h-[72dvh]">
              <div className="shrink-0">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Eye className="h-3 w-3" />
                  Preview em tempo real
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Visualizado com dados de exemplo.
                </p>
              </div>
              {/* safe: renderTemplatePreviewHtml escapes all HTML via escapeHtml() before applying markup tags */}
              <pre className="flex-1 text-sm whitespace-pre-wrap rounded-lg border bg-background p-3 overflow-y-auto leading-relaxed"
                dangerouslySetInnerHTML={{
                  __html: renderTemplatePreviewHtml(
                    form.content || DEFAULT_TEMPLATE_CONTENT,
                    PREVIEW_SAMPLE
                  ),
                }}
              />
            </div>
          </div>

          <DialogFooter className="border-t px-6 py-4">
            <Button variant="outline" onClick={() => setShowModal(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              {editing ? "Salvar alterações" : "Criar template"}
            </Button>
          </DialogFooter>
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
        product={scheduleProduct || undefined}
      />

      {/* ── Confirmação de exclusão ── */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir template?</AlertDialogTitle>
            <AlertDialogDescription>
              O template <strong>{deleteTarget?.name}</strong> vai ser apagado de vez.
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
