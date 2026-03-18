import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { CalendarDays, Clock, Send } from "lucide-react";
import { useTemplateModule } from "@/contexts/TemplateModuleContext";
import { useGrupos } from "@/hooks/useGrupos";
import { useSessoes } from "@/hooks/useSessoes";
import { useAgendamentos } from "@/hooks/useAgendamentos";
import { useSessionScopedGroups } from "@/hooks/useSessionScopedGroups";
import { buildTemplatePlaceholderData } from "@/lib/template-placeholders";
import type { RecurrenceType, WeekDay, ScheduledMediaAttachment } from "@/lib/types";
import { toast } from "sonner";
import { WEEK_DAYS, mergeDateWithScheduleTime, normalizeScheduleTime } from "@/lib/scheduling";
import { DateTimeField } from "@/components/scheduling/DateTimeField";
import { SessionSelect } from "@/components/selectors/SessionSelect";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";

interface ScheduleProductModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
}

const MAX_SCHEDULE_IMAGE_BYTES = 8 * 1024 * 1024;

function templateRequestsImageAttachment(content: string): boolean {
  const normalized = String(content || "").toLowerCase();
  return normalized.includes("{imagem}") || normalized.includes("{{imagem}}");
}

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

export function ScheduleProductModal({ open, onOpenChange, product }: ScheduleProductModalProps) {
  const { templates, defaultTemplate, applyTemplate } = useTemplateModule();
  const { syncedGroups, masterGroups } = useGrupos();
  const { allSessions } = useSessoes();
  const { createPost } = useAgendamentos();

  const [scheduleName, setScheduleName] = useState("");
  const [messageContent, setMessageContent] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const effectiveTemplateId = selectedTemplateId || defaultTemplate?.id || "";
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [selectedMasterGroups, setSelectedMasterGroups] = useState<string[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [isRecurring, setIsRecurring] = useState(false);
  const [weekDays, setWeekDays] = useState<WeekDay[]>([]);
  const [recurrenceTimes, setRecurrenceTimes] = useState<string[]>([]);
  const [recurrenceTimeInput, setRecurrenceTimeInput] = useState("");
  const [imageAttachment, setImageAttachment] = useState<ScheduledMediaAttachment | null>(null);
  const [preparingImageAttachment, setPreparingImageAttachment] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { filteredGroups, filteredMasterGroups } = useSessionScopedGroups({
    sessionId: selectedSessionId,
    groups: syncedGroups,
    masterGroups,
  });

  // Reset group selections when session changes
  const handleSessionChange = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSelectedGroups([]);
    setSelectedMasterGroups([]);
  };

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
  const scheduleTemplateData = useMemo(
    () => ({ ...placeholderData, "{imagem}": "", "{{imagem}}": "" }),
    [placeholderData],
  );
  const resolvedTemplate = useMemo(
    () => ((effectiveTemplateId
      ? templates.find((item) => item.id === effectiveTemplateId) || null
      : null)
      || defaultTemplate
      || templates[0]
      || null),
    [defaultTemplate, effectiveTemplateId, templates],
  );
  const requiresImageAttachment = useMemo(
    () => Boolean(resolvedTemplate && templateRequestsImageAttachment(resolvedTemplate.content)),
    [resolvedTemplate],
  );

  const prepareImageAttachment = useCallback(async () => {
    if (!product?.imageUrl || !requiresImageAttachment) {
      setImageAttachment(null);
      return;
    }

    setPreparingImageAttachment(true);
    try {
      const media = await fetchImageAsAttachment(product.imageUrl);
      setImageAttachment(media);
    } catch {
      setImageAttachment(null);
      toast.error("Não deu pra preparar a imagem pra esse agendamento");
    } finally {
      setPreparingImageAttachment(false);
    }
  }, [product?.imageUrl, requiresImageAttachment]);

  useEffect(() => {
    if (!open) return;
    void prepareImageAttachment();
  }, [open, prepareImageAttachment]);

  const templateContent = applyTemplate({
    templateId: effectiveTemplateId,
    fallbackContent: product?.affiliateLink || "",
    placeholderData: scheduleTemplateData,
  });

  const totalDestinations = useMemo(
    () => selectedGroups.length + selectedMasterGroups.length,
    [selectedGroups.length, selectedMasterGroups.length],
  );

  useEffect(() => {
    if (!open) return;
    if (!product) return;

    const generatedName = product.title
      ? `Oferta: ${product.title.slice(0, 60)}`
      : "Oferta Shopee";

    setScheduleName(generatedName);
    setMessageContent(templateContent || product.affiliateLink || "");
  }, [open, product, templateContent]);

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
      fallbackContent: product?.affiliateLink || "",
      placeholderData: scheduleTemplateData,
    });
    setMessageContent(nextContent || product?.affiliateLink || "");
  };

  const toggleWeekDay = (day: WeekDay) =>
    setWeekDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));

  const addRecurrenceTime = () => {
    const normalized = normalizeScheduleTime(recurrenceTimeInput);
    if (!normalized) {
      toast.error("Horário inválido — use o formato HH:mm");
      return;
    }
    setRecurrenceTimes((prev) => (prev.includes(normalized) ? prev : [...prev, normalized].sort()));
    setRecurrenceTimeInput("");
  };

  const removeRecurrenceTime = (time: string) => {
    setRecurrenceTimes((prev) => prev.filter((item) => item !== time));
  };

  const toggleRecurrence = () => {
    setIsRecurring((prev) => {
      const next = !prev;
      if (next && recurrenceTimes.length === 0) {
        const base = normalizeScheduleTime(scheduledAt.slice(11, 16));
        if (base) setRecurrenceTimes([base]);
      }
      return next;
    });
  };

  const handleSchedule = async () => {
    if (!scheduleName.trim()) {
      toast.error("Dê um nome pro agendamento");
      return;
    }
    if (!messageContent.trim()) {
      toast.error("Escreva o conteúdo da mensagem");
      return;
    }
    if (!isRecurring && !scheduledAt) {
      toast.error("Escolha a data e o horário");
      return;
    }
    if (isRecurring && weekDays.length === 0) {
      toast.error("Escolha pelo menos um dia da semana");
      return;
    }
    if (isRecurring && recurrenceTimes.length === 0) {
      toast.error("Adicione pelo menos um horário");
      return;
    }
    if (selectedGroups.length === 0 && selectedMasterGroups.length === 0) {
      toast.error("Escolha pelo menos um grupo");
      return;
    }
    if (requiresImageAttachment && preparingImageAttachment) {
      toast.error("Espera só um pouco, a imagem ainda tá sendo preparada");
      return;
    }
    if (requiresImageAttachment && !imageAttachment) {
      toast.error("O template precisa de uma imagem, mas ela não tá disponível");
      return;
    }

    const recurrence: RecurrenceType = isRecurring ? "weekly" : "none";
    const effectiveScheduledAt = recurrence === "weekly"
      ? mergeDateWithScheduleTime(scheduledAt || new Date().toISOString(), recurrenceTimes[0] || "")
      : scheduledAt;

    setSubmitting(true);
    try {
      const content = messageContent.trim();
      await createPost({
        name: scheduleName.trim(),
        content,
        finalContent: content,
        scheduledAt: effectiveScheduledAt,
        recurrence,
        destinationGroupIds: selectedGroups,
        masterGroupIds: selectedMasterGroups,
        templateId: effectiveTemplateId || undefined,
        sessionId: selectedSessionId || undefined,
        weekDays: recurrence === "weekly" ? weekDays : [],
        recurrenceTimes: recurrence === "weekly" ? recurrenceTimes : [],
        messageType: "offer",
        detectedLinks: product?.affiliateLink ? [product.affiliateLink] : [],
        templateData: scheduleTemplateData,
        media: requiresImageAttachment ? imageAttachment : null,
      });
      onOpenChange(false);
      resetForm();
    } catch {
      toast.error("Não deu pra criar o agendamento");
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
    setIsRecurring(false);
    setWeekDays([]);
    setRecurrenceTimes([]);
    setRecurrenceTimeInput("");
    setImageAttachment(null);
    setPreparingImageAttachment(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-lg max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            Agendar envio
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Product preview */}
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
              placeholder="Ex: Oferta pra grupos VIP"
              value={scheduleName}
              onChange={(e) => setScheduleName(e.target.value)}
            />
          </div>

          {/* Template */}
          <div className="space-y-2">
            <Label>Template</Label>
            <Select value={effectiveTemplateId} onValueChange={handleTemplateChange}>
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
              Quando você escolhe um template, o texto já vem pronto. Pode editar à vontade.
            </p>
          </div>

          {/* Date/time + recurrence */}
          <div className="space-y-2">
            <Label>Repetir envio</Label>
            <div className="flex items-center gap-2">
              <Switch id="is-recurring-offer" checked={isRecurring} onCheckedChange={toggleRecurrence} />
              <Label htmlFor="is-recurring-offer">Repetir nos dias escolhidos</Label>
            </div>
          </div>

          {!isRecurring && (
            <DateTimeField
              value={scheduledAt}
              onChange={setScheduledAt}
              label="Data e hora"
              required
            />
          )}

          {isRecurring && (
            <div className="space-y-2">
              <Label>Dias da semana *</Label>
              <div className="flex flex-wrap gap-2">
                {WEEK_DAYS.map((d) => (
                  <label key={d.value} className="flex items-center gap-1.5 cursor-pointer">
                    <Checkbox checked={weekDays.includes(d.value)} onCheckedChange={() => toggleWeekDay(d.value)} />
                    <span className="text-sm">{d.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {isRecurring && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <Label>Horários *</Label>
                <div className="flex items-center gap-2">
                  <Input type="time" value={recurrenceTimeInput} onChange={(e) => setRecurrenceTimeInput(e.target.value)} />
                  <Button type="button" variant="outline" onClick={addRecurrenceTime}>Adicionar</Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {recurrenceTimes.map((time) => (
                    <Badge key={time} variant="secondary" className="cursor-pointer" onClick={() => removeRecurrenceTime(time)}>
                      {time} x
                    </Badge>
                  ))}
                  {recurrenceTimes.length === 0 && (
                    <span className="text-xs text-muted-foreground">Escolha um horário e adicione outros se necessário</span>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {isRecurring && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Se ligar a repetição, o envio segue os dias e horários que você escolher (ignora a data fixa).</Label>
            </div>
          )}

          {/* Session */}
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

          {/* Groups */}
          <div className="space-y-2">
            <Label className="text-xs">Grupos</Label>
            {!selectedSessionId ? (
              <p className="text-xs text-muted-foreground p-2 rounded-lg bg-muted/30">
                Escolha a sessão primeiro pra ver os grupos.
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
                emptyMessage="Nenhum grupo nessa sessão"
                title="Grupos"
              />
            )}
          </div>

          {/* Master groups */}
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
                emptyMessage="Nenhum grupo mestre nessa sessão"
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
            {submitting ? "Agendando..." : "Agendar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


