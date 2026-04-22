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
import type { ScheduledMediaAttachment, ScheduledPost, TemplateScope } from "@/lib/types";
import { getMarketplaceTemplateModule } from "@/lib/marketplace-template-modules";
import { templateRequestsImageAttachment } from "@/lib/template-placeholders";
import { toast } from "sonner";
import { DateTimeField } from "@/components/scheduling/DateTimeField";
import { SessionSelect } from "@/components/selectors/SessionSelect";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";
import { formatBRT } from "@/lib/timezone";
import { extractMarketplaceLinks } from "@/lib/marketplace-utils";

type MarketplaceTemplateScope = Extract<TemplateScope, "meli" | "amazon">;
type DestinationMode = "individual" | "master";

interface MercadoLivreScheduleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTemplateId?: string;
  templateScope?: MarketplaceTemplateScope;
  marketplaceLabel?: string;
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
    discountText?: string;
    badgeText?: string;
    asin?: string;
  };
  editingPost?: ScheduledPost;
}

const MAX_SCHEDULE_IMAGE_BYTES = 8 * 1024 * 1024;

function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
}

async function fetchImageAsAttachment(imageUrl: string, fileName: string): Promise<ScheduledMediaAttachment> {
  const target = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error("URL de imagem inválida para anexo");
  }

  const response = await fetch(target);
  if (!response.ok) {
    throw new Error("Falha ao baixar imagem da oferta");
  }

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("Arquivo retornado não é uma imagem");
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
    throw new Error("Conteúdo da imagem inválido");
  }

  return {
    kind: "image",
    base64,
    mimeType: blob.type || "image/jpeg",
    fileName,
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
  templateScope = "meli",
  marketplaceLabel,
  product,
  editingPost,
}: MercadoLivreScheduleModalProps) {
  const resolvedScope: MarketplaceTemplateScope = templateScope === "amazon" ? "amazon" : "meli";
  const marketplaceShortLabel = String(marketplaceLabel || "").trim() || (resolvedScope === "amazon" ? "Amazon" : "ML");
  const defaultScheduleName = resolvedScope === "amazon" ? "Agendamento Amazon" : "Oferta Mercado Livre";
  const defaultSchedulePrefix = resolvedScope === "amazon" ? "" : "Oferta ML: ";
  const templateFieldLabel = resolvedScope === "amazon" ? "Template Amazon" : "Template Meli";
  const defaultScheduleSource = `${resolvedScope}_vitrine`;
  const defaultImageFileName = `${resolvedScope}_offer.jpg`;
  const templateModule = useMemo(() => getMarketplaceTemplateModule(resolvedScope), [resolvedScope]);

  const { templates, defaultTemplate } = useTemplates(resolvedScope);
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
  const [destinationMode, setDestinationMode] = useState<DestinationMode>("individual");
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
  const placeholderData = useMemo(() => {
    return templateModule.buildPlaceholderData(
      product ? {
        title: product.title,
        productUrl: product.productUrl,
        imageUrl: product.imageUrl,
        price: product.price,
        oldPrice: product.oldPrice,
        discountText: product.discountText,
        installmentsText: product.installmentsText,
        seller: product.seller,
        badgeText: product.badgeText,
        asin: product.asin,
        rating: product.rating,
        reviewsCount: product.reviewsCount,
      } : null,
      product?.affiliateLink || "",
    );
  }, [product, templateModule]);
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
  const selectedTemplate = useMemo(
    () => (resolvedTemplateId
      ? templates.find((item) => item.id === resolvedTemplateId) || null
      : null)
      || defaultTemplate
      || templates[0]
      || null,
    [defaultTemplate, resolvedTemplateId, templates],
  );
  const templateRequiresImageAttachment = useMemo(
    () => templateRequestsImageAttachment(selectedTemplate?.content || ""),
    [selectedTemplate?.content],
  );
  const templateContent = useMemo(() => {
    const template = selectedTemplate;
    if (!template) return fallbackContent;
    return templateModule.applyPlaceholders(template.content, scheduleTemplateData);
  }, [fallbackContent, scheduleTemplateData, selectedTemplate, templateModule]);

  const requiresImageAttachment = useMemo(() => {
    if (product) {
      if (resolvedScope === "amazon") return templateRequiresImageAttachment;
      return true;
    }
    const policy = String(editingPost?.imagePolicy || "").trim().toLowerCase();
    const source = String(editingPost?.scheduleSource || "").trim().toLowerCase();
    return policy === "required" || source === defaultScheduleSource;
  }, [
    defaultScheduleSource,
    editingPost?.imagePolicy,
    editingPost?.scheduleSource,
    product,
    resolvedScope,
    templateRequiresImageAttachment,
  ]);
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
      const media = await fetchImageAsAttachment(preferredImageUrl, defaultImageFileName);
      setImageAttachment(media);
    } catch {
      setImageAttachment(null);
      toast.error("Não foi possível preparar a imagem para esse agendamento");
    } finally {
      setPreparingImageAttachment(false);
    }
  }, [defaultImageFileName, preferredImageUrl, requiresImageAttachment]);

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
    setDestinationMode(
      editingPost.masterGroupIds.length > 0 && editingPost.destinationGroupIds.length === 0
        ? "master"
        : "individual",
    );
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
      ? `${defaultSchedulePrefix}${product.title.slice(0, 60)}`
      : defaultScheduleName;

    setScheduleName(generatedName);
    setMessageContent(templateContent || product.affiliateLink || product.productUrl || "");
  }, [defaultScheduleName, defaultSchedulePrefix, editingPost, open, product, templateContent]);

  useEffect(() => {
    if (!open) return;
    if (!requiresImageAttachment) return;
    if (editingPost?.media) return;
    if (imageAttachment) return;
    void prepareImageAttachment();
  }, [editingPost?.media, imageAttachment, open, prepareImageAttachment, requiresImageAttachment]);

  const totalDestinations = useMemo(
    () => (destinationMode === "individual" ? selectedGroups.length : selectedMasterGroups.length),
    [destinationMode, selectedGroups.length, selectedMasterGroups.length],
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
      ? templateModule.applyPlaceholders(template.content, scheduleTemplateData)
      : fallbackContent;
    setMessageContent(nextContent || fallbackContent);
  };

  const handleSchedule = async () => {
    if (!scheduleName.trim()) {
      toast.error("Defina um nome para o agendamento");
      return;
    }
    if (!messageContent.trim()) {
      toast.error("Escreva o conteúdo da mensagem");
      return;
    }
    if (!scheduledAt) {
      toast.error("Escolha a data e o horário");
      return;
    }
    if (destinationMode === "individual" && selectedGroups.length === 0) {
      toast.error("Escolha pelo menos um grupo");
      return;
    }
    if (destinationMode === "master" && selectedMasterGroups.length === 0) {
      toast.error("Escolha pelo menos um grupo mestre");
      return;
    }
    if (requiresImageAttachment && preparingImageAttachment) {
      toast.error("Aguarde, a imagem ainda está sendo preparada");
      return;
    }
    if (requiresImageAttachment && !imageAttachment) {
      toast.error("Esse agendamento precisa de imagem e ela não está disponível");
      return;
    }

    setSubmitting(true);
    try {
      const content = messageContent.trim();
      const detectedLinksFromContent = extractMarketplaceLinks(content).map((item) => item.url);
      const detectedLinks = detectedLinksFromContent.length > 0
        ? detectedLinksFromContent
        : (editingPost?.detectedLinks || []);
      const scheduleSource = editingPost?.scheduleSource || (product ? (requiresImageAttachment ? defaultScheduleSource : `${resolvedScope}_templates`) : "");
      const imagePolicy = requiresImageAttachment ? "required" : (editingPost?.imagePolicy || "");
      const payloadMedia = requiresImageAttachment ? imageAttachment : null;
      const destinationGroupIds = destinationMode === "individual" ? selectedGroups : [];
      const masterGroupIds = destinationMode === "master" ? selectedMasterGroups : [];
      const payload = {
        name: scheduleName.trim(),
        content,
        finalContent: content,
        scheduledAt,
        recurrence: "none" as const,
        destinationGroupIds,
        masterGroupIds,
        templateId: resolvedTemplateId || undefined,
        sessionId: effectiveSessionId || undefined,
        weekDays: [],
        recurrenceTimes: [],
        messageType: detectedLinks.length > 0 || requiresImageAttachment ? "offer" : "text",
        detectedLinks,
        templateData: scheduleTemplateData,
        media: payloadMedia,
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
      toast.error(editingPost ? "Não foi possível atualizar o agendamento" : "Não foi possível criar o agendamento");
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setScheduleName("");
    setMessageContent("");
    setSelectedGroups([]);
    setSelectedMasterGroups([]);
    setDestinationMode("individual");
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
            {isEditing ? `Editar agendamento ${marketplaceShortLabel}` : "Agendar envio"}
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
              placeholder={resolvedScope === "amazon" ? "Ex: Produto Amazon para grupos VIP" : "Ex: Oferta ML para grupos VIP"}
              value={scheduleName}
              onChange={(event) => setScheduleName(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>{templateFieldLabel}</Label>
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
              O texto já vem pronto quando você escolhe um template. Você pode ajustar antes de agendar.
            </p>
          </div>

          <DateTimeField
            value={scheduledAt}
            onChange={setScheduledAt}
            label="Data e hora"
            required
          />

          <div className="space-y-2">
            <Label>Sessão *</Label>
            {hasSingleAvailableSession ? (
                <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                {availableSessions[0]?.label || "Nenhuma sessão conectada"}
              </div>
            ) : (
                <SessionSelect
                value={selectedSessionId}
                onValueChange={handleSessionChange}
                sessions={availableSessions}
                placeholder="Escolha uma sessão..."
                emptyLabel="Nenhuma sessão conectada"
              />
            )}
          </div>

          <div className="space-y-2">
            <Label>Enviar para</Label>
            <Select
              value={destinationMode}
              onValueChange={(value: DestinationMode) => {
                setDestinationMode(value);
                if (value === "individual") {
                  setSelectedMasterGroups([]);
                } else {
                  setSelectedGroups([]);
                }
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="individual">Grupos individuais</SelectItem>
                <SelectItem value="master">Grupos mestres</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Destinos</Label>
            {!effectiveSessionId ? (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                Selecione uma sessão para listar os grupos disponíveis.
              </div>
            ) : (
              <>
                {destinationMode === "individual" ? (
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
                    emptyMessage="Nenhum grupo nessa sessão"
                    title="Grupos diretos"
                    maxHeightClassName="max-h-56"
                  />
                ) : (
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
                    emptyMessage="Nenhum grupo mestre nessa sessão"
                    title="Grupos mestre"
                    maxHeightClassName="max-h-56"
                  />
                )}
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
