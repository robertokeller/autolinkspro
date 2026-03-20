import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarDays, Clock, Send } from "lucide-react";
import { useTemplates } from "@/hooks/useTemplates";
import { useGrupos } from "@/hooks/useGrupos";
import { useSessoes } from "@/hooks/useSessoes";
import { useAgendamentos } from "@/hooks/useAgendamentos";
import { useSessionScopedGroups } from "@/hooks/useSessionScopedGroups";
import { applyMeliTemplatePlaceholders, buildMeliTemplatePlaceholderData } from "@/lib/meli-template-placeholders";
import type { ScheduledMediaAttachment, ScheduledPost } from "@/lib/types";
import { toast } from "sonner";
import { DateTimeField } from "@/components/scheduling/DateTimeField";
import { SessionSelect } from "@/components/selectors/SessionSelect";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";
import { formatBRT } from "@/lib/timezone";
import { extractMarketplaceLinks } from "@/lib/marketplace-utils";

interface MercadoLivreScheduleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTemplateId?: string;
  product?: {
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
  editingPost?: ScheduledPost;
}

const MAX_SCHEDULE_IMAGE_BYTES = 8 * 1024 * 1024;

function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
}

async function fetchImageAsAttachment(imageUrl: string): Promise<ScheduledMediaAttachment> {
  const target = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error("URL de imagem invalida para anexo");
  }

  const response = await fetch(target);
  if (!response.ok) {
    throw new Error("Falha ao baixar imagem da oferta");
  }

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("Arquivo retornado nao eh uma imagem");
  }
  if (blob.size > MAX_SCHEDULE_IMAGE_BYTES) {
    throw new Error("Imagem da oferta excede 8MB");
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Falha ao converter imagem"));
    reader.readAsDataURL(blob);
  });

  const base64 = dataUrlToBase64(dataUrl);
  if (!base64) {
    throw new Error("Conteudo da imagem invalido");
  }

  return {
    kind: "image",
    base64,
    mimeType: blob.type || "image/jpeg",
    fileName: "meli_offer.jpg",
  };
}

function formatProductPrice(value: number | null | undefined): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  return parsed.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  });
}

export function MercadoLivreScheduleModal({
  open,
  onOpenChange,
  initialTemplateId,
  product,
  editingPost,
}: MercadoLivreScheduleModalProps) {
  const {
    templates,
    defaultTemplate,
  } = useTemplates("meli");
  const { syncedGroups, masterGroups } = useGrupos();
  const { allSessions } = useSessoes();
  const { createPost, updatePost } = useAgendamentos();
  const isEditing = Boolean(editingPost);
  const onlineSessions = useMemo(
    () => allSessions.filter((session) => session.status === "online"),
    [allSessions],
  );
  const availableSessions = onlineSessions.length > 0 ? onlineSessions : allSessions;
  const hasSingleAvailableSession = availableSessions.length <= 1;
  const defaultSessionId = availableSessions[0]?.id || "";

  const [scheduleName, setScheduleName] = useState("");
  const [messageContent, setMessageContent] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const resolvedTemplateId = selectedTemplateId || (!isEditing ? defaultTemplate?.id || "" : "");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [selectedMasterGroups, setSelectedMasterGroups] = useState<string[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [imageAttachment, setImageAttachment] = useState<ScheduledMediaAttachment | null>(null);
  const [preparingImageAttachment, setPreparingImageAttachment] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const effectiveSessionId = selectedSessionId || defaultSessionId;

  const { filteredGroups, filteredMasterGroups } = useSessionScopedGroups({
    sessionId: effectiveSessionId,
    groups: syncedGroups,
    masterGroups,
  });

  const fallbackContent = editingPost?.content || product?.affiliateLink || product?.productUrl || "";
  const placeholderData = useMemo(() => buildMeliTemplatePlaceholderData(
    product ? {
      title: product.title,
      productUrl: product.productUrl,
      imageUrl: product.imageUrl,
      price: product.price,
      oldPrice: product.oldPrice,
      installmentsText: product.installmentsText,
      seller: product.seller,
      rating: product.rating,
      reviewsCount: product.reviewsCount,
    } : null,
    product?.affiliateLink || "",
  ), [product]);
  const baseTemplateData = useMemo(
    () => (editingPost?.templateData && Object.keys(editingPost.templateData).length > 0
      ? editingPost.templateData
      : placeholderData),
    [editingPost?.templateData, placeholderData],
  );
  const scheduleTemplateData = useMemo(
    () => ({ ...baseTemplateData, "{imagem}": "", "{{imagem}}": "" }),
    [baseTemplateData],
  );
  const templateContent = useMemo(() => {
    const template = templates.find((item) => item.id === resolvedTemplateId)
      || defaultTemplate
      || templates[0]
      || null;
    if (!template) return fallbackContent;
    return applyMeliTemplatePlaceholders(template.content, scheduleTemplateData);
  }, [defaultTemplate, fallbackContent, resolvedTemplateId, scheduleTemplateData, templates]);

  const requiresImageAttachment = useMemo(() => {
    if (product) return true;
    const policy = String(editingPost?.imagePolicy || "").trim().toLowerCase();
    const source = String(editingPost?.scheduleSource || "").trim().toLowerCase();
    return policy === "required" || source === "meli_vitrine";
  }, [editingPost?.imagePolicy, editingPost?.scheduleSource, product]);
  const preferredImageUrl = useMemo(() => {
    const fromProduct = String(product?.imageUrl || "").trim();
    if (/^https?:\/\//i.test(fromProduct)) return fromProduct;
    const fromPost = String(editingPost?.productImageUrl || "").trim();
    if (/^https?:\/\//i.test(fromPost)) return fromPost;
    return "";
  }, [editingPost?.productImageUrl, product?.imageUrl]);

  const prepareImageAttachment = useCallback(async () => {
    if (!preferredImageUrl || !requiresImageAttachment) return;

    setPreparingImageAttachment(true);
    try {
      const media = await fetchImageAsAttachment(preferredImageUrl);
      setImageAttachment(media);
    } catch {
      setImageAttachment(null);
      toast.error("Nao foi possivel preparar a imagem para esse agendamento");
    } finally {
      setPreparingImageAttachment(false);
    }
  }, [preferredImageUrl, requiresImageAttachment]);

  const handleSessionChange = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSelectedGroups([]);
    setSelectedMasterGroups([]);
  };

  useEffect(() => {
    if (!open) return;
    if (!editingPost) return;

    setScheduleName(editingPost.name || "");
    setMessageContent(editingPost.content || "");
    setSelectedTemplateId(editingPost.templateId || "");
    setSelectedGroups([...editingPost.destinationGroupIds]);
    setSelectedMasterGroups([...editingPost.masterGroupIds]);
    setSelectedSessionId(editingPost.sessionId || defaultSessionId);
    setScheduledAt(editingPost.scheduledAt ? formatBRT(editingPost.scheduledAt, "yyyy-MM-dd'T'HH:mm") : "");
    setImageAttachment(editingPost.media || null);
  }, [defaultSessionId, editingPost, open]);

  useEffect(() => {
    if (!open) return;
    if (selectedSessionId) return;
    if (!defaultSessionId) return;
    setSelectedSessionId(defaultSessionId);
  }, [defaultSessionId, open, selectedSessionId]);

  useEffect(() => {
    if (!open || editingPost || !product) return;
    if (!initialTemplateId) return;
    setSelectedTemplateId(initialTemplateId || "");
  }, [editingPost, initialTemplateId, open, product]);

  useEffect(() => {
    if (!open || editingPost || !product) return;

    const generatedName = product.title
      ? `Oferta ML: ${product.title.slice(0, 60)}`
      : "Oferta Mercado Livre";

    setScheduleName(generatedName);
    setMessageContent(templateContent || product.affiliateLink || product.productUrl || "");
  }, [editingPost, open, product, templateContent]);

  useEffect(() => {
    if (!open) return;
    if (!requiresImageAttachment) return;
    if (editingPost?.media) return;
    if (imageAttachment) return;
    void prepareImageAttachment();
  }, [editingPost?.media, imageAttachment, open, prepareImageAttachment, requiresImageAttachment]);

  const totalDestinations = useMemo(
    () => selectedGroups.length + selectedMasterGroups.length,
    [selectedGroups.length, selectedMasterGroups.length],
  );

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetForm();
    }
    onOpenChange(nextOpen);
  };

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find((item) => item.id === templateId) || null;
    const nextContent = template
      ? applyMeliTemplatePlaceholders(template.content, scheduleTemplateData)
      : fallbackContent;
    setMessageContent(nextContent || fallbackContent);
  };

  const handleSchedule = async () => {
    if (!scheduleName.trim()) {
      toast.error("Defina um nome para o agendamento");
      return;
    }
    if (!messageContent.trim()) {
      toast.error("Escreva o conteudo da mensagem");
      return;
    }
    if (!scheduledAt) {
      toast.error("Escolha a data e o horario");
      return;
    }
    if (selectedGroups.length === 0 && selectedMasterGroups.length === 0) {
      toast.error("Escolha pelo menos um grupo");
      return;
    }
    if (requiresImageAttachment && preparingImageAttachment) {
      toast.error("Aguarde, a imagem ainda esta sendo preparada");
      return;
    }
    if (requiresImageAttachment && !imageAttachment) {
      toast.error("Esse agendamento precisa de imagem e ela nao esta disponivel");
      return;
    }

    setSubmitting(true);
    try {
      const content = messageContent.trim();
      const detectedLinksFromContent = extractMarketplaceLinks(content).map((item) => item.url);
      const detectedLinks = detectedLinksFromContent.length > 0
        ? detectedLinksFromContent
        : (editingPost?.detectedLinks || []);
      const scheduleSource = editingPost?.scheduleSource || (product ? "meli_vitrine" : "");
      const imagePolicy = requiresImageAttachment ? "required" : (editingPost?.imagePolicy || "");
      const payload = {
        name: scheduleName.trim(),
        content,
        finalContent: content,
        scheduledAt,
        recurrence: "none" as const,
        destinationGroupIds: selectedGroups,
        masterGroupIds: selectedMasterGroups,
        templateId: resolvedTemplateId || undefined,
        sessionId: effectiveSessionId || undefined,
        weekDays: [],
        recurrenceTimes: [],
        messageType: detectedLinks.length > 0 || requiresImageAttachment ? "offer" : "text",
        detectedLinks,
        templateData: scheduleTemplateData,
        media: imageAttachment,
        imagePolicy: imagePolicy || undefined,
        scheduleSource: scheduleSource || undefined,
        productImageUrl: preferredImageUrl || String(editingPost?.productImageUrl || ""),
      };

      if (editingPost) {
        await updatePost(editingPost.id, payload);
      } else {
        await createPost(payload);
      }
      onOpenChange(false);
      resetForm();
    } catch {
      toast.error(editingPost ? "Nao foi possivel atualizar o agendamento" : "Nao foi possivel criar o agendamento");
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setScheduleName("");
    setMessageContent("");
    setSelectedGroups([]);
    setSelectedMasterGroups([]);
    setSelectedTemplateId("");
    setSelectedSessionId("");
    setScheduledAt("");
    setImageAttachment(null);
    setPreparingImageAttachment(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[min(calc(100vw-1rem),32rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            {isEditing ? "Editar agendamento ML" : "Agendar envio"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {product?.title && (
            <div className="flex gap-3 rounded-lg border bg-secondary/30 p-3">
              {product.imageUrl && (
                <img
                  src={product.imageUrl}
                  alt={product.title}
                  className="h-16 w-16 shrink-0 rounded object-cover bg-muted"
                  onError={(event) => { event.currentTarget.src = "/placeholder.svg"; }}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-medium">{product.title}</p>
                <div className="mt-1 flex items-center gap-2">
                  {product.price ? (
                    <span className="text-sm font-bold text-primary">{formatProductPrice(product.price)}</span>
                  ) : null}
                  {product.oldPrice && product.oldPrice > (product.price || 0) ? (
                    <span className="text-xs text-muted-foreground line-through">{formatProductPrice(product.oldPrice)}</span>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Nome *</Label>
            <Input
              placeholder="Ex: Oferta ML para grupos VIP"
              value={scheduleName}
              onChange={(event) => setScheduleName(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Template Meli</Label>
            <Select value={resolvedTemplateId} onValueChange={handleTemplateChange}>
              <SelectTrigger><SelectValue placeholder="Escolha um template..." /></SelectTrigger>
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

          <div className="space-y-2">
            <Label>Preview da mensagem *</Label>
            <Textarea
              placeholder="Escreva a mensagem aqui..."
              value={messageContent}
              onChange={(event) => setMessageContent(event.target.value)}
              className="min-h-[100px]"
            />
            <p className="text-xs text-muted-foreground">
              O texto ja vem pronto quando voce escolhe um template. Voce pode ajustar antes de agendar.
            </p>
          </div>

          <DateTimeField
            value={scheduledAt}
            onChange={setScheduledAt}
            label="Data e hora"
            required
          />

          <div className="space-y-2">
            <Label>Sessao *</Label>
            {hasSingleAvailableSession ? (
              <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                {availableSessions[0]?.label || "Nenhuma sessao conectada"}
              </div>
            ) : (
              <SessionSelect
                value={selectedSessionId}
                onValueChange={handleSessionChange}
                sessions={availableSessions}
                placeholder="Escolha uma sessao..."
                emptyLabel="Nenhuma sessao conectada"
              />
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Grupos</Label>
            {!effectiveSessionId ? (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                Selecione uma sessao para listar os grupos disponiveis.
              </div>
            ) : (
              <>
                <MultiOptionDropdown
                  value={selectedGroups}
                  onChange={setSelectedGroups}
                  items={filteredGroups.map((group) => ({
                    id: group.id,
                    label: group.name,
                    meta: group.platform,
                  }))}
                  placeholder="Escolher grupos"
                  selectedLabel={(count) => `${count} grupo(s)`}
                  emptyMessage="Nenhum grupo nessa sessao"
                  title="Grupos diretos"
                  maxHeightClassName="max-h-56"
                />

                <MultiOptionDropdown
                  value={selectedMasterGroups}
                  onChange={setSelectedMasterGroups}
                  items={filteredMasterGroups.map((master) => ({
                    id: master.id,
                    label: master.name,
                    meta: `${master.groupIds.length} grupo(s)`,
                  }))}
                  placeholder="Escolher grupos mestre"
                  selectedLabel={(count) => `${count} grupo(s) mestre(s)`}
                  emptyMessage="Nenhum grupo mestre nessa sessao"
                  title="Grupos mestre"
                  maxHeightClassName="max-h-56"
                />
              </>
            )}
          </div>

          <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Destinos selecionados: <span className="font-medium text-foreground">{totalDestinations}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleDialogOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={() => { void handleSchedule(); }} disabled={submitting}>
            {submitting ? (
              <>
                <Clock className="mr-1.5 h-4 w-4 animate-spin" />
                {isEditing ? "Salvando..." : "Agendando..."}
              </>
            ) : (
              <>
                <Send className="mr-1.5 h-4 w-4" />
                {isEditing ? "Salvar" : "Agendar"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
