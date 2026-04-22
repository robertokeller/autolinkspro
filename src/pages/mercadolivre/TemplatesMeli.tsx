import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { templateSchema } from "@/lib/validations";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { MercadoLivreScheduleModal } from "@/components/mercadolivre/MercadoLivreScheduleModal";
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
  CalendarDays,
  CheckCheck,
  Copy,
  Edit,
  Eye,
  FileText,
  ImageIcon,
  Link2,
  Loader2,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useTemplates } from "@/hooks/useTemplates";
import { useMercadoLivreSessions } from "@/hooks/useMercadoLivreSessions";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import type { Template, TemplateCategory } from "@/lib/types";
import { ROUTES } from "@/lib/routes";
import { templateRequestsImageAttachment } from "@/lib/template-placeholders";
import type { MeliTemplateProductInput } from "@/lib/meli-template-placeholders";
import { MELI_TEMPLATE_MODULE } from "@/lib/marketplace-template-modules";
import { formatMessageForPlatform, renderRichTextPreviewHtml, renderTemplatePreviewHtml } from "@/lib/rich-text";

const DEFAULT_TEMPLATE_FORM = {
  name: "",
  content: "",
  category: "oferta" as TemplateCategory,
};

const DEFAULT_TEMPLATE_CONTENT = MELI_TEMPLATE_MODULE.defaultTemplateContent;
const PLACEHOLDER_LEGEND = MELI_TEMPLATE_MODULE.placeholderLegend;
const PREVIEW_SAMPLE = MELI_TEMPLATE_MODULE.previewSample;

type MeliScheduleProductInput = {
  title?: string;
  affiliateLink: string;
  productUrl?: string;
  imageUrl?: string;
  price?: number | null;
  oldPrice?: number | null;
  installmentsText?: string;
  seller?: string;
  rating?: number | null;
  reviewsCount?: number | null;
};

type GeneratedOffer = {
  templateId: string;
  templateName: string;
  message: string;
  affiliateLink: string;
  originalLink: string;
  conversionTimeMs: number | null;
  requestsImageAttachment: boolean;
  product: MeliScheduleProductInput;
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

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    const parsed = String(value || "").trim();
    if (parsed) return parsed;
  }
  return "";
}

function isLikelyMeliUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    return (
      host.includes("mercadolivre")
      || host.includes("mercadolibre")
      || host === "meli.la"
      || host.endsWith(".meli.la")
      || host === "mlb.am"
      || host.endsWith(".mlb.am")
    );
  } catch {
    return false;
  }
}

export default function TemplatesMeli() {
  const {
    templates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    duplicateTemplate,
  } = useTemplates("meli");

  const { sessions, isLoading: sessionsLoading } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const activeSessions = useMemo(
    () => sessions.filter((session) => session.status === "active"),
    [sessions],
  );
  const hasActiveMeliSession = activeSessions.length > 0;

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState(DEFAULT_TEMPLATE_FORM);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleteTarget = templates.find((template) => template.id === deleteId);

  const [converterLink, setConverterLink] = useState("");
  const [converterTemplateId, setConverterTemplateId] = useState("");
  const [generatedOffer, setGeneratedOffer] = useState<GeneratedOffer | null>(null);
  const [converting, setConverting] = useState(false);
  const [copied, setCopied] = useState(false);

  const [scheduleProduct, setScheduleProduct] = useState<MeliScheduleProductInput | null>(null);
  const [scheduleTemplateId, setScheduleTemplateId] = useState("");

  const generatedOfferPreviewHtml = useMemo(
    () => {
      if (!generatedOffer) return "";
      // Use renderRichTextPreviewHtml to display the final substituted message with proper formatting
      const html = renderRichTextPreviewHtml(generatedOffer.message);
      return html;
    },
    [generatedOffer],
  );

  const openNew = () => {
    setForm({
      ...DEFAULT_TEMPLATE_FORM,
      content: DEFAULT_TEMPLATE_CONTENT,
    });
    setEditing(null);
    setShowModal(true);
  };

  const openEdit = (template: Template) => {
    setForm({
      name: template.name,
      content: template.content,
      category: template.category || "oferta",
    });
    setEditing(template);
    setShowModal(true);
  };

  const insertPlaceholder = (key: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setForm((prev) => ({ ...prev, content: `${prev.content}${key}` }));
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextContent = form.content.slice(0, start) + key + form.content.slice(end);
    setForm((prev) => ({ ...prev, content: nextContent }));

    setTimeout(() => {
      textarea.focus();
      const cursor = start + key.length;
      textarea.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const wrapSelection = (openMarker: string, closeMarker: string, emptyPlaceholder: string) => {
    const textarea = textareaRef.current;
    const start = textarea ? textarea.selectionStart : form.content.length;
    const end = textarea ? textarea.selectionEnd : form.content.length;
    const selected = form.content.slice(start, end);
    const inner = selected || emptyPlaceholder;
    const wrapped = `${openMarker}${inner}${closeMarker}`;
    const nextContent = form.content.slice(0, start) + wrapped + form.content.slice(end);
    setForm((prev) => ({ ...prev, content: nextContent }));

    setTimeout(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(start + openMarker.length, start + openMarker.length + inner.length);
    }, 0);
  };

  const handleSave = async () => {
    const payload = {
      name: form.name,
      content: form.content,
      category: form.category,
    };

    const parsed = templateSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message || "Dados inválidos");
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        const ok = await updateTemplate(editing.id, parsed.data);
        if (ok) setShowModal(false);
      } else {
        const created = await createTemplate(parsed.data.name, parsed.data.content, parsed.data.category);
        if (created) setShowModal(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleConvert = async () => {
    const link = converterLink.trim();
    if (!link) {
      toast.error("Cole um link do Mercado Livre primeiro.");
      return;
    }
    if (!isLikelyMeliUrl(link)) {
      toast.error("Use um link válido do Mercado Livre.");
      return;
    }
    if (!hasActiveMeliSession) {
      toast.error("Conecte uma sessão Mercado Livre ativa para converter.");
      return;
    }

    const effectiveTemplateId = (
      converterTemplateId
      || templates.find((template) => template.isDefault)?.id
      || templates[0]?.id
      || ""
    );
    const template = templates.find((item) => item.id === effectiveTemplateId) || null;
    if (!template) {
      toast.error("Escolha um template para gerar a mensagem.");
      return;
    }

    setConverting(true);
    setCopied(false);
    setGeneratedOffer(null);
    try {
      const conversion = await invokeBackendRpc<{
        affiliateLink?: string;
        originalLink?: string;
        resolvedLink?: string;
        conversionTimeMs?: number;
      }>("meli-convert-link", {
        body: {
          url: link,
          source: "templatesmeli-converter",
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
        toast.warning("Link convertido, mas alguns dados do produto não puderam ser carregados.");
      }

      const originalLink = firstNonEmptyString(productSnapshot?.productUrl, snapshotTargetUrl);

      const productTitle = firstNonEmptyString(
        productSnapshot?.title,
        "Oferta Mercado Livre",
      );

      const productInput: MeliTemplateProductInput = {
        title: productTitle,
        productUrl: firstNonEmptyString(productSnapshot?.productUrl, originalLink),
        imageUrl: firstNonEmptyString(productSnapshot?.imageUrl),
        price: Number.isFinite(Number(productSnapshot?.price)) ? Number(productSnapshot?.price) : null,
        oldPrice: Number.isFinite(Number(productSnapshot?.oldPrice)) ? Number(productSnapshot?.oldPrice) : null,
        installmentsText: firstNonEmptyString(productSnapshot?.installmentsText),
        seller: firstNonEmptyString(productSnapshot?.seller),
        rating: Number.isFinite(Number(productSnapshot?.rating)) ? Number(productSnapshot?.rating) : null,
        reviewsCount: Number.isFinite(Number(productSnapshot?.reviewsCount)) ? Number(productSnapshot?.reviewsCount) : null,
      };

      const placeholderData = MELI_TEMPLATE_MODULE.buildPlaceholderData(productInput, affiliateLink);
      const message = MELI_TEMPLATE_MODULE.applyPlaceholders(template.content, placeholderData);

      setConverterTemplateId(template.id);
      setGeneratedOffer({
        templateId: template.id,
        templateName: template.name,
        message,
        affiliateLink,
        originalLink,
        conversionTimeMs: Number.isFinite(Number(conversion.conversionTimeMs))
          ? Number(conversion.conversionTimeMs)
          : null,
        requestsImageAttachment: templateRequestsImageAttachment(template.content),
        product: {
          title: productTitle,
          affiliateLink,
          productUrl: productInput.productUrl,
          imageUrl: productInput.imageUrl,
          price: productInput.price,
          oldPrice: productInput.oldPrice,
          installmentsText: productInput.installmentsText,
          seller: productInput.seller,
          rating: productInput.rating,
          reviewsCount: productInput.reviewsCount,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível converter o link.");
    } finally {
      setConverting(false);
    }
  };

  const handleCopy = async () => {
    const content = generatedOffer?.message || "";
    if (!content) return;
    await navigator.clipboard.writeText(formatMessageForPlatform(content, "whatsapp"));
    setCopied(true);
    toast.success("Mensagem copiada.");
    setTimeout(() => setCopied(false), 1800);
  };

  const handleScheduleGeneratedOffer = () => {
    if (!generatedOffer) return;
    setScheduleTemplateId(generatedOffer.templateId);
    setScheduleProduct(generatedOffer.product);
  };

  return (
    <div className="ds-page pb-[calc(var(--safe-area-bottom)+0.25rem)]">
      <PageHeader
        title="Templates Mercado Livre"
        description="Monte templates e gere mensagens com conversão de link Mercado Livre"
      >
        <Button size="sm" onClick={openNew} className="w-full sm:w-auto">
          <Plus className="mr-1.5 h-4 w-4" />
          Novo template
        </Button>
      </PageHeader>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <Card className="glass xl:sticky xl:top-20">
          <CardHeader className="border-b pb-4">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Link2 className="h-4 w-4 text-primary" />
              Gerador de mensagem Mercado Livre
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Cole um link do Mercado Livre, converta para afiliado e gere a mensagem final com template.
            </p>
          </CardHeader>

          <CardContent className="space-y-4 pt-4">
            {activeSessions.length === 0 && !sessionsLoading && (
              <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                <p className="text-foreground">
                  Nenhuma sessão Mercado Livre ativa para conversão.
                </p>
                <Link to={ROUTES.app.mercadolivreConfiguracoes} className="font-medium text-primary underline-offset-2 hover:underline">
                  Abrir configurações do Mercado Livre
                </Link>
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Link do produto</Label>
                <Input
                  placeholder="Cole o link do produto Mercado Livre"
                  value={converterLink}
                  onChange={(event) => setConverterLink(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleConvert();
                    }
                  }}
                />
              </div>

              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Template</Label>
                  <Select value={converterTemplateId} onValueChange={setConverterTemplateId}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          templates.find((template) => template.isDefault)?.name
                          || "Selecionar template"
                        }
                      />
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
                </div>

                <Button
                  onClick={() => { void handleConvert(); }}
                  disabled={converting || !converterLink.trim() || !hasActiveMeliSession || templates.length === 0}
                  className="h-10 w-full sm:min-w-28 sm:w-auto"
                >
                  {converting ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="mr-1.5 h-4 w-4" />
                  )}
                  Converter
                </Button>
              </div>
            </div>

            {/* Live template preview with sample data */}
            {templates.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  <Label className="text-xs text-muted-foreground">
                    Preview do template selecionado
                  </Label>
                </div>
                {(() => {
                  const effectiveTemplateId = (
                    converterTemplateId
                    || templates.find((t) => t.isDefault)?.id
                    || templates[0]?.id
                  );
                  const template = templates.find((t) => t.id === effectiveTemplateId);
                  const templatePreviewHtml = template
                    ? renderTemplatePreviewHtml(template.content, PREVIEW_SAMPLE)
                    : "";
                  return (
                    <pre
                      className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-background p-3 text-xs leading-relaxed text-muted-foreground"
                      dangerouslySetInnerHTML={{ __html: templatePreviewHtml }}
                    />
                  );
                })()}
              </div>
            )}

            {generatedOffer && (
              <div className="space-y-3">
                <Separator />
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <Label className="text-xs text-muted-foreground">Mensagem gerada</Label>
                    <p className="text-xs text-muted-foreground">
                      Template: <span className="font-medium text-foreground">{generatedOffer.templateName}</span>
                    </p>
                    {!!generatedOffer.conversionTimeMs && (
                      <p className="text-xs text-muted-foreground">
                        Conversão: {generatedOffer.conversionTimeMs} ms
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => { void handleCopy(); }} className="h-8 text-xs">
                      {copied ? (
                        <CheckCheck className="mr-1 h-3.5 w-3.5 text-success" />
                      ) : (
                        <Copy className="mr-1 h-3.5 w-3.5" />
                      )}
                      {copied ? "Copiado!" : "Copiar"}
                    </Button>
                    <Button size="sm" onClick={handleScheduleGeneratedOffer} className="h-8 text-xs">
                      <CalendarDays className="mr-1 h-3.5 w-3.5" />
                      Agendar
                    </Button>
                  </div>
                </div>

                {generatedOffer.requestsImageAttachment && (
                  <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <ImageIcon className="h-3.5 w-3.5" />
                      Placeholder de imagem detectado
                    </div>
                    <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                      O template usa {"{imagem}"}. A imagem será enviada como anexo quando estiver disponível no fluxo de origem.
                    </div>
                  </div>
                )}

                <pre
                  className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: generatedOfferPreviewHtml }}
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
                    className={`relative overflow-hidden rounded-xl border bg-card/70 shadow-sm ${template.isDefault ? "ring-1 ring-primary/30" : ""}`}
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
                          <Badge variant="secondary" className="shrink-0 bg-primary/12 text-xs text-primary">
                            Padrão
                          </Badge>
                        )}

                        <div className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background/80 px-1 py-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className={`h-9 w-9 sm:h-8 sm:w-8 ${template.isDefault ? "text-primary" : "text-muted-foreground"}`}
                            onClick={() => { void setDefaultTemplate(template.id); }}
                            title={template.isDefault ? "Remover padrão" : "Definir como padrão"}
                          >
                            <Star className={`h-3.5 w-3.5 ${template.isDefault ? "fill-primary" : ""}`} />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-9 w-9 sm:h-8 sm:w-8"
                            onClick={() => { void duplicateTemplate(template.id); }}
                            title="Duplicar"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-9 w-9 sm:h-8 sm:w-8"
                            onClick={() => openEdit(template)}
                            title="Editar"
                          >
                            <Edit className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-9 w-9 text-destructive sm:h-8 sm:w-8"
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
                title="Nenhum template Meli ainda"
                description="Crie templates com campos como {titulo}, {preco} e {link} para gerar mensagens padronizadas."
                actionLabel="Criar template"
                onAction={openNew}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="flex max-h-[92dvh] w-[min(calc(100vw-1rem),72rem)] max-w-none flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b px-6 py-4">
            <DialogTitle>{editing ? "Editar template Meli" : "Novo template Meli"}</DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1 grid overflow-hidden md:grid-cols-2">
            <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-5">
              <div className="space-y-2">
                <Label>Nome</Label>
                <Input
                  placeholder="Ex: Oferta padrão Meli"
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                />
              </div>

              <div className="space-y-2">
                <Label>Conteúdo</Label>
                <div className="mb-1 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => wrapSelection("**", "**", "negrito")}
                    title="Negrito"
                    className="flex h-7 w-8 items-center justify-center rounded border bg-background text-sm font-bold transition-colors hover:bg-secondary/60"
                  >
                    B
                  </button>
                  <button
                    type="button"
                    onClick={() => wrapSelection("__", "__", "itálico")}
                    title="Itálico"
                    className="flex h-7 w-7 items-center justify-center rounded border bg-background text-sm italic transition-colors hover:bg-secondary/60"
                  >
                    I
                  </button>
                  <button
                    type="button"
                    onClick={() => wrapSelection("~~", "~~", "riscado")}
                    title="Riscado"
                    className="flex h-7 w-8 items-center justify-center rounded border bg-background text-sm line-through transition-colors hover:bg-secondary/60"
                  >
                    S
                  </button>
                  <span className="ml-1 text-xs text-muted-foreground">
                    Selecione o texto e clique para formatar
                  </span>
                </div>
                <Textarea
                  ref={textareaRef}
                  rows={8}
                  placeholder={DEFAULT_TEMPLATE_CONTENT}
                  value={form.content}
                  onChange={(event) => setForm((prev) => ({ ...prev, content: event.target.value }))}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Placeholders Meli - clique para inserir no cursor
                </Label>
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <div className="flex flex-wrap gap-1.5">
                    {PLACEHOLDER_LEGEND.map((placeholder) => (
                      <button
                        key={placeholder.key}
                        type="button"
                        onClick={() => insertPlaceholder(placeholder.key)}
                        className="inline-flex items-center rounded-md border bg-background px-2 py-1 text-xs transition-colors hover:bg-secondary/50"
                        title={placeholder.description}
                      >
                        <code className="font-mono text-primary">{placeholder.key}</code>
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-0.5 border-t pt-1">
                    {PLACEHOLDER_LEGEND.map((placeholder) => (
                      <div key={`${placeholder.key}-legend`} className="flex gap-2 py-0.5 text-xs text-muted-foreground">
                        <code className="w-32 shrink-0 text-primary">{placeholder.key}</code>
                        <span>{placeholder.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-col space-y-3 overflow-hidden border-t bg-muted/20 px-6 py-5 md:border-l md:border-t-0">
              <div className="shrink-0">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Eye className="h-3 w-3" />
                  Preview em tempo real
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Render com dados de exemplo Mercado Livre.
                </p>
              </div>
              <pre
                className="flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-background p-3 text-sm leading-relaxed"
                dangerouslySetInnerHTML={{
                  __html: renderTemplatePreviewHtml(form.content || DEFAULT_TEMPLATE_CONTENT, PREVIEW_SAMPLE),
                }}
              />
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t px-6 py-4">
            <Button variant="outline" onClick={() => setShowModal(false)}>
              Cancelar
            </Button>
            <Button onClick={() => { void handleSave(); }} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {editing ? "Salvar alteracoes" : "Criar template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MercadoLivreScheduleModal
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

      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover template?</AlertDialogTitle>
            <AlertDialogDescription>
              O template <strong>{deleteTarget?.name || "-"}</strong> sera removido permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteId) {
                  void deleteTemplate(deleteId);
                }
                setDeleteId(null);
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
