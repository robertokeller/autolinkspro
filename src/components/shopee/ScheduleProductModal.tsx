import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarDays, Clock, Send } from "lucide-react";
import { useTemplateModule } from "@/contexts/TemplateModuleContext";
import { useGrupos } from "@/hooks/useGrupos";
import { useSessoes } from "@/hooks/useSessoes";
import { useAgendamentos } from "@/hooks/useAgendamentos";
import { useSessionScopedGroups } from "@/hooks/useSessionScopedGroups";
import { buildTemplatePlaceholderData } from "@/lib/template-placeholders";
import type { ScheduledMediaAttachment, ScheduledPost } from "@/lib/types";
import { toast } from "sonner";
import { DateTimeField } from "@/components/scheduling/DateTimeField";
import { SessionSelect } from "@/components/selectors/SessionSelect";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";
import { formatBRT } from "@/lib/timezone";
import { extractMarketplaceLinks } from "@/lib/marketplace-utils";

interface ScheduleProductModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTemplateId?: string;
  product?: {
    title?: string;
    affiliateLink: string;
    imageUrl?: string;
    salePrice?: number;
    originalPrice?: number;
    discount?: number;
    sales?: number;
    commission?: number;
    shopName?: string;
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
    fileName: "shopee_offer.jpg",
  };
}

export function ScheduleProductModal({ open, onOpenChange, initialTemplateId, product, editingPost }: ScheduleProductModalProps) {
  const { templates, defaultTemplate, applyTemplate } = useTemplateModule();
  const { syncedGroups, masterGroups } = useGrupos();
  const { allSessions } = useSessoes();
  const { createPost, updatePost } = useAgendamentos();
  const isEditing = Boolean(editingPost);

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

  const { filteredGroups, filteredMasterGroups } = useSessionScopedGroups({
    sessionId: selectedSessionId,
    groups: syncedGroups,
    masterGroups,
  });

  const fallbackContent = editingPost?.content || product?.affiliateLink || "";
  const placeholderData = useMemo(() => buildTemplatePlaceholderData(
    product ? {
      title: product.title,
      salePrice: product.salePrice,
      originalPrice: product.originalPrice,
      discount: product.discount,
      imageUrl: product.imageUrl,
      commission: product.commission,
      sales: product.sales,
      shopName: product.shopName,
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
  const templateContent = applyTemplate({
    templateId: resolvedTemplateId,
    fallbackContent,
    placeholderData: scheduleTemplateData,
  });

  const requiresImageAttachment = useMemo(() => {
    if (product) return true;
    const policy = String(editingPost?.imagePolicy || "").trim().toLowerCase();
    const source = String(editingPost?.scheduleSource || "").trim().toLowerCase();
    return policy === "required" || source === "shopee_catalog";
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
      toast.error("Não foi possível preparar a imagem para esse agendamento");
    } finally {
      setPreparingImageAttachment(false);
    }
  }, [preferredImageUrl, requiresImageAttachment]);

  // Reset group selections when session changes.
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
    setSelectedSessionId(editingPost.sessionId || "");
    setScheduledAt(editingPost.scheduledAt ? formatBRT(editingPost.scheduledAt, "yyyy-MM-dd'T'HH:mm") : "");
    setImageAttachment(editingPost.media || null);
  }, [editingPost, open]);

  useEffect(() => {
    if (!open || editingPost || !product) return;
    if (!initialTemplateId) return;
    setSelectedTemplateId(initialTemplateId || "");
  }, [editingPost, initialTemplateId, open, product]);

  useEffect(() => {
    if (!open || editingPost || !product) return;

    const generatedName = product.title
      ? `Oferta: ${product.title.slice(0, 60)}`
      : "Oferta Shopee";

    setScheduleName(generatedName);
    setMessageContent(templateContent || product.affiliateLink || "");
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
    const nextContent = applyTemplate({
      templateId,
      fallbackContent,
      placeholderData: scheduleTemplateData,
    });
    setMessageContent(nextContent || fallbackContent);
  };

  const handleSchedule = async () => {
    if (!scheduleName.trim()) {
      toast.error("Dê um nome para o agendamento");
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
    if (selectedGroups.length === 0 && selectedMasterGroups.length === 0) {
      toast.error("Escolha pelo menos um grupo");
      return;
    }
    if (requiresImageAttachment && preparingImageAttachment) {
      toast.error("Aguarde, a imagem ainda está sendo preparada");
      return;
    }
    if (requiresImageAttachment && !imageAttachment) {
      toast.error("Este agendamento precisa de imagem e ela não está disponível");
      return;
    }

    setSubmitting(true);
    try {
      const content = messageContent.trim();
      const detectedLinksFromContent = extractMarketplaceLinks(content).map((item) => item.url);
      const detectedLinks = detectedLinksFromContent.length > 0
        ? detectedLinksFromContent
        : (editingPost?.detectedLinks || []);
      const scheduleSource = editingPost?.scheduleSource || (product ? "shopee_catalog" : "");
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
        sessionId: selectedSessionId || undefined,
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
    setSelectedTemplateId("");
    setSelectedSessionId("");
    setScheduledAt("");
    setImageAttachment(null);
    setPreparingImageAttachment(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-lg max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            {isEditing ? "Editar agendamento Shopee" : "Agendar envio"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {product?.title && (
            <div className="flex gap-3 p-3 rounded-lg bg-secondary/30 border">
              {product.imageUrl && (
                <img
                  src={product.imageUrl}
                  alt={product.title}
                  className="h-16 w-16 rounded object-cover bg-muted shrink-0"
                  onError={(e) => { e.currentTarget.src = "/placeholder.svg"; }}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium line-clamp-2">{product.title}</p>
                <div className="flex items-center gap-2 mt-1">
                  {product.salePrice && (
                    <span className="text-sm font-bold text-primary">
                      R${Number(product.salePrice).toFixed(2)}
                    </span>
                  )}
                  {product.discount && product.discount > 0 && (
                    <Badge variant="secondary" className="text-xs">{product.discount}% OFF</Badge>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Nome *</Label>
            <Input
              placeholder="Ex: Oferta para grupos VIP"
              value={scheduleName}
              onChange={(e) => setScheduleName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Template</Label>
            <Select value={resolvedTemplateId} onValueChange={handleTemplateChange}>
              <SelectTrigger><SelectValue placeholder="Escolha um template..." /></SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}{t.isDefault ? " *" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Mensagem *</Label>
            <Textarea
              placeholder="Escreva a mensagem aqui..."
              value={messageContent}
              onChange={(e) => setMessageContent(e.target.value)}
              className="min-h-[100px]"
            />
            <p className="text-xs text-muted-foreground">
              Quando você escolhe um template, o texto já vem pronto. Você pode editar à vontade.
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
            <SessionSelect
              value={selectedSessionId}
              onValueChange={handleSessionChange}
              sessions={allSessions}
              placeholder="Escolha uma sessão..."
              emptyLabel="Nenhuma sessão conectada"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Grupos</Label>
            {!selectedSessionId ? (
              <p className="text-xs text-muted-foreground p-2 rounded-lg bg-muted/30">
                Escolha a sessão primeiro para ver os grupos.
              </p>
            ) : (
              <MultiOptionDropdown
                value={selectedGroups}
                onChange={setSelectedGroups}
                items={filteredGroups.map((group) => ({
                  id: group.id,
                  label: group.name,
                  meta: `${group.memberCount}`,
                }))}
                placeholder="Escolher grupos"
                selectedLabel={(count) => `${count} grupo(s)`}
                emptyMessage="Nenhum grupo nesta sessão"
                title="Grupos"
              />
            )}
          </div>

          {selectedSessionId && filteredMasterGroups.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs">Grupos mestres</Label>
              <MultiOptionDropdown
                value={selectedMasterGroups}
                onChange={setSelectedMasterGroups}
                items={filteredMasterGroups.map((masterGroup) => ({
                  id: masterGroup.id,
                  label: masterGroup.name,
                  meta: `${masterGroup.groupIds.length} grupos`,
                }))}
                placeholder="Escolher grupos mestres"
                selectedLabel={(count) => `${count} grupo(s) mestre`}
                emptyMessage="Nenhum grupo mestre nesta sessão"
                title="Grupos mestres"
              />
            </div>
          )}

          {totalDestinations > 0 && (
            <div className="text-xs text-muted-foreground flex items-center gap-1 p-2 rounded-lg bg-muted/30">
              <Send className="h-3 w-3" />
              {totalDestinations} grupo(s) vão receber
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleDialogOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSchedule} disabled={submitting}>
            <Clock className="h-4 w-4 mr-1.5" />
            {submitting ? (isEditing ? "Salvando..." : "Agendando...") : (isEditing ? "Salvar" : "Agendar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
