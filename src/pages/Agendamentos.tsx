import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { agendamentoSchema } from "@/lib/validations";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CalendarDays, Plus, Trash2, Clock, Edit, Link2, MessageSquare,
  ShoppingBag, Tag, Send, Users, Radio, Upload, Image as ImageIcon, X,
} from "lucide-react";
import type { ScheduledPost, RecurrenceType, MessageType, WeekDay, ScheduledMediaAttachment } from "@/lib/types";
import { toast } from "sonner";
import { formatBRT } from "@/lib/timezone";
import { extractMarketplaceLinks, getMarketplaceLabel } from "@/lib/marketplace-utils";
import { useAgendamentos } from "@/hooks/useAgendamentos";
import { useGrupos } from "@/hooks/useGrupos";
import { useShopeeLinkModule } from "@/contexts/ShopeeLinkModuleContext";
import { useSessoes } from "@/hooks/useSessoes";
import { useSessionScopedGroups } from "@/hooks/useSessionScopedGroups";
import { WEEK_DAYS, mergeDateWithScheduleTime, normalizeScheduleTime } from "@/lib/scheduling";
import { DateTimeField } from "@/components/scheduling/DateTimeField";
import { SessionSelect } from "@/components/selectors/SessionSelect";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";

const statusStyle: Record<string, string> = {
  scheduled: "bg-info/10 text-info", pending: "bg-info/10 text-info", sent: "bg-success/10 text-success",
  processing: "bg-warning/10 text-warning",
  failed: "bg-destructive/10 text-destructive", cancelled: "bg-muted text-muted-foreground",
};
const statusLabel: Record<string, string> = {
  scheduled: "Agendado",
  pending: "Agendado",
  processing: "Processando",
  sent: "Enviado",
  failed: "Falhou",
  cancelled: "Cancelado",
};
const recurrenceLabel: Record<string, string> = { none: "Único", once: "Único", daily: "Diário", weekly: "Semanal" };
const typeIcon: Record<MessageType, typeof MessageSquare> = { text: MessageSquare, offer: ShoppingBag, coupon: Tag };
type DestinationMode = "individual" | "master";

const queueStatuses = new Set<string>(["pending", "scheduled", "processing"]);

const weekDayToJsDay: Record<WeekDay, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

interface DraftPost {
  name: string;
  content: string; scheduledAt: string; destinationGroupIds: string[]; masterGroupIds: string[];
  sessionId: string; weekDays: WeekDay[];
  recurrenceTimes: string[];
  media: ScheduledMediaAttachment | null;
}

const emptyDraft: DraftPost = {
  name: "",
  content: "", scheduledAt: "", destinationGroupIds: [], masterGroupIds: [],
  sessionId: "", weekDays: [], recurrenceTimes: [], media: null,
};

const MAX_SCHEDULE_IMAGE_BYTES = 8 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Falha ao ler imagem"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function getTimeFromDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function parseTimeToParts(value: string): { hour: number; minute: number } | null {
  const normalized = normalizeScheduleTime(value);
  if (!normalized) return null;
  const [hourRaw, minuteRaw] = normalized.split(":");
  return { hour: Number(hourRaw), minute: Number(minuteRaw) };
}

function getNextDispatchAt(post: ScheduledPost, now: Date): Date {
  const fallback = new Date(post.scheduledAt);
  if (post.recurrence !== "weekly" || post.weekDays.length === 0 || post.recurrenceTimes.length === 0) {
    return Number.isNaN(fallback.getTime()) ? now : fallback;
  }

  const allowedDays = new Set(post.weekDays.map((day) => weekDayToJsDay[day]));
  let best: Date | null = null;

  for (let offset = 0; offset <= 14; offset += 1) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + offset);
    if (!allowedDays.has(day.getDay())) continue;

    for (const time of post.recurrenceTimes) {
      const parts = parseTimeToParts(time);
      if (!parts) continue;

      const candidate = new Date(day);
      candidate.setHours(parts.hour, parts.minute, 0, 0);
      if (candidate.getTime() < now.getTime()) continue;
      if (!best || candidate.getTime() < best.getTime()) {
        best = candidate;
      }
    }
  }

  return best || (Number.isNaN(fallback.getTime()) ? now : fallback);
}

export default function Schedules() {
  const { posts, isLoading, createPost, updatePost, deletePost } = useAgendamentos();
  const { syncedGroups: groups, masterGroups } = useGrupos();
  const { convertContentLinks } = useShopeeLinkModule();
  const { allSessions } = useSessoes();

  const [showModal, setShowModal] = useState(false);
  const [draft, setDraft] = useState<DraftPost>({ ...emptyDraft });
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [destinationMode, setDestinationMode] = useState<DestinationMode>("individual");
  const [recurrenceTimeInput, setRecurrenceTimeInput] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const detectedLinks = useMemo(() => extractMarketplaceLinks(draft.content), [draft.content]);
  const hasLinks = detectedLinks.length > 0;

  const { filteredGroups, filteredGroupIds, filteredMasterGroups } = useSessionScopedGroups({
    sessionId: draft.sessionId,
    groups,
    masterGroups,
  });

  const totalDestinations = useMemo(() => {
    if (destinationMode === "individual") return draft.destinationGroupIds.length;

    return draft.masterGroupIds.reduce((acc, mgId) => {
      const mg = filteredMasterGroups.find((m) => m.id === mgId);
      if (!mg) return acc;
      const count = mg.groupIds.filter((groupId) => filteredGroupIds.has(groupId)).length;
      return acc + count;
    }, 0);
  }, [destinationMode, draft.destinationGroupIds.length, draft.masterGroupIds, filteredGroupIds, filteredMasterGroups]);

  const openNew = () => {
    setDraft({ ...emptyDraft });
    setIsRecurring(false);
    setDestinationMode("individual");
    setRecurrenceTimeInput("");
    setEditingId(null);
    setShowModal(true);
  };

  const openEdit = (post: ScheduledPost) => {
    setDraft({
      name: post.name,
      content: post.content,
      scheduledAt: post.scheduledAt ? formatBRT(post.scheduledAt, "yyyy-MM-dd'T'HH:mm") : "",
      destinationGroupIds: [...post.destinationGroupIds], masterGroupIds: [...post.masterGroupIds],
      sessionId: post.sessionId || "",
      weekDays: [...post.weekDays],
      media: post.media,
      recurrenceTimes: post.recurrenceTimes.length > 0
        ? [...post.recurrenceTimes]
        : (post.recurrence !== "none" ? [getTimeFromDateTime(post.scheduledAt)].filter(Boolean) : []),
    });
    setIsRecurring(post.recurrence !== "none");
    setDestinationMode(post.masterGroupIds.length > 0 && post.destinationGroupIds.length === 0 ? "master" : "individual");
    setRecurrenceTimeInput("");
    setEditingId(post.id); setShowModal(true);
  };

  const savePost = async () => {
    const recurrence: RecurrenceType = isRecurring ? "weekly" : "none";
    const effectiveScheduledAt = recurrence === "weekly"
      ? mergeDateWithScheduleTime(draft.scheduledAt || new Date().toISOString(), draft.recurrenceTimes[0] || "")
      : draft.scheduledAt;

    const parsed = agendamentoSchema.safeParse({ content: draft.content, scheduledAt: effectiveScheduledAt });
    if (!parsed.success) { toast.error(parsed.error.errors[0].message); return; }
    if (!draft.name.trim()) { toast.error("Defina um nome para o agendamento"); return; }
    if (!draft.sessionId) { toast.error("Selecione a sessão de envio"); return; }
    if (destinationMode === "individual" && draft.destinationGroupIds.length === 0) { toast.error("Selecione ao menos um grupo de destino"); return; }
    if (destinationMode === "master" && draft.masterGroupIds.length === 0) { toast.error("Selecione ao menos um master group"); return; }
    if (recurrence !== "none" && draft.recurrenceTimes.length === 0) { toast.error("Defina ao menos um horário para recorrência"); return; }
    if (recurrence === "weekly" && draft.weekDays.length === 0) { toast.error("Selecione ao menos um dia da semana"); return; }

    let contentToSend = draft.content;
    let links = extractMarketplaceLinks(contentToSend);

    if (links.some((item) => item.marketplace === "shopee")) {
      try {
        const conversionResult = await convertContentLinks(contentToSend, {
          source: "agendamentos-save",
          verifyConnection: false,
        });
        contentToSend = conversionResult.convertedContent;
        links = extractMarketplaceLinks(contentToSend);
      } catch {
        toast.warning("Não foi possível converter links Shopee neste agendamento. Mantendo links originais.");
      }
    }

    const finalContent = contentToSend;

    const payload = {
      name: draft.name.trim(),
      content: contentToSend, scheduledAt: new Date(effectiveScheduledAt).toISOString(),
      destinationGroupIds: draft.destinationGroupIds, masterGroupIds: draft.masterGroupIds,
      sessionId: draft.sessionId || undefined,
      recurrence, weekDays: recurrence === "weekly" ? draft.weekDays : [],
      recurrenceTimes: recurrence === "none" ? [] : draft.recurrenceTimes,
      messageType: links.length > 0 ? "offer" : "text",
      detectedLinks: links.map((l) => l.url), finalContent,
      media: draft.media,
    };

    if (editingId) { await updatePost(editingId, payload); } else { await createPost(payload); }
    setShowModal(false);
  };

  const toggleWeekDay = (day: WeekDay) => setDraft((d) => ({ ...d, weekDays: d.weekDays.includes(day) ? d.weekDays.filter((x) => x !== day) : [...d.weekDays, day] }));
  const removeDraftMedia = () => setDraft((prev) => ({ ...prev, media: null }));
  const handleImageFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Selecione um arquivo de imagem válido");
      return;
    }
    if (file.size > MAX_SCHEDULE_IMAGE_BYTES) {
      toast.error("Imagem muito grande. Limite de 8MB");
      return;
    }

    setUploadingImage(true);
    try {
      const dataUrl = await fileToBase64(file);
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
      if (!base64) throw new Error("Arquivo de imagem inválido");

      setDraft((prev) => ({
        ...prev,
        media: {
          kind: "image",
          base64,
          mimeType: file.type || "image/jpeg",
          fileName: file.name || "schedule_image.jpg",
        },
      }));
      toast.success("Imagem anexada ao agendamento");
    } catch {
      toast.error("Erro ao processar imagem");
    } finally {
      setUploadingImage(false);
    }
  };
  const changeSession = (sessionId: string) => {
    setDraft((prev) => ({
      ...prev,
      sessionId,
      destinationGroupIds: [],
      masterGroupIds: [],
    }));
  };
  const addRecurrenceTime = () => {
    const normalized = normalizeScheduleTime(recurrenceTimeInput);
    if (!normalized) {
      toast.error("Horário inválido. Use HH:mm");
      return;
    }
    setDraft((d) => {
      if (d.recurrenceTimes.includes(normalized)) return d;
      return { ...d, recurrenceTimes: [...d.recurrenceTimes, normalized].sort() };
    });
    setRecurrenceTimeInput("");
  };
  const removeRecurrenceTime = (time: string) => {
    setDraft((d) => ({ ...d, recurrenceTimes: d.recurrenceTimes.filter((item) => item !== time) }));
  };
  const toggleRecurrence = () => {
    setIsRecurring((prev) => {
      const next = !prev;
      if (next) {
        setDraft((current) => {
          if (current.recurrenceTimes.length > 0) return current;
          const baseTime = normalizeScheduleTime(getTimeFromDateTime(current.scheduledAt));
          return baseTime ? { ...current, recurrenceTimes: [baseTime] } : current;
        });
      }
      return next;
    });
  };

  const deleteTarget = posts.find((p) => p.id === deleteId);
  const queuePosts = useMemo(() => {
    const now = new Date();
    return posts
      .filter((post) => queueStatuses.has(String(post.status)))
      .slice()
      .sort((a, b) => getNextDispatchAt(a, now).getTime() - getNextDispatchAt(b, now).getTime());
  }, [posts]);
  const archivedPosts = useMemo(() => {
    return posts
      .filter((post) => !queueStatuses.has(String(post.status)))
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [posts]);

  const renderPostCard = (post: ScheduledPost, position?: number) => {
    const TypeIcon = typeIcon[post.messageType] || MessageSquare;
    const destNames = post.destinationGroupIds.map((gid) => groups.find((g) => g.id === gid)?.name).filter(Boolean);
    const masterNames = post.masterGroupIds.map((mid) => masterGroups.find((m) => m.id === mid)?.name).filter(Boolean);
    const session = allSessions.find((s) => s.id === post.sessionId);
    const statusStr = post.status as string;
    const postStatus = statusStr === "pending" ? "scheduled" : post.status;
    const postStatusLabel = statusLabel[postStatus] || postStatus;
    const isQueue = statusStr === "pending" || statusStr === "scheduled" || statusStr === "processing";
    const rowAccent = postStatus === "sent"
      ? "bg-success"
      : postStatus === "failed"
        ? "bg-destructive"
        : postStatus === "processing"
          ? "bg-warning"
          : "bg-info";
    const destinationPreview = masterNames.length > 0
      ? masterNames.join(", ")
      : destNames.length > 0
        ? destNames.join(", ")
        : "-";

    return (
      <Card
        key={post.id}
        className={`glass overflow-hidden border-border/60 transition-all hover:border-primary/20 hover:shadow-md ${isQueue ? "ring-1 ring-info/20" : ""}`}
      >
        <div className={`h-0.5 w-full ${rowAccent}`} />
        <CardContent className="px-3 py-2.5 space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 flex items-center gap-1.5 overflow-hidden">
              {typeof position === "number" && (
                <Badge variant="outline" className="text-xs">#{position}</Badge>
              )}
              <TypeIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              <p className="text-sm font-semibold tracking-tight truncate">{post.name}</p>
              <Badge variant="secondary" className={`text-xs shrink-0 ${statusStyle[postStatus] || ""}`}>{postStatusLabel}</Badge>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-muted/35 p-0.5">
              {(statusStr === "pending" || statusStr === "scheduled") && (
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => openEdit(post)}>
                  <Edit className="h-3 w-3" />
                </Button>
              )}
              <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => setDeleteId(post.id)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="font-medium text-foreground">{formatBRT(post.scheduledAt, "dd/MM/yyyy HH:mm")}</span>
            <span className="text-muted-foreground/60">•</span>
            {session && <Radio className="h-3 w-3 shrink-0" />}
            <span className="truncate">{session?.label || "Sem sessão"}</span>
            <span className="text-muted-foreground/60">•</span>
            <Users className="h-3 w-3 shrink-0" />
            <span className="truncate">{destinationPreview}</span>
          </div>

          <p className="text-xs text-muted-foreground line-clamp-2">{post.content}</p>

          <div className="flex items-center gap-1 flex-wrap">
            {post.recurrence !== "none" && (
              <Badge variant="outline" className="text-2xs px-1.5 py-0">
                {recurrenceLabel[post.recurrence]}
                {post.recurrence === "weekly" && post.weekDays.length > 0 && ` (${post.weekDays.map((w) => WEEK_DAYS.find((d) => d.value === w)?.label).join(",")})`}
              </Badge>
            )}
            {post.recurrenceTimes.length > 0 && (
              <Badge variant="outline" className="text-2xs px-1.5 py-0">
                {post.recurrenceTimes.join(", ")}
              </Badge>
            )}
            {masterNames.map((n, i) => (
              <Badge key={`m-${i}`} variant="outline" className="text-2xs px-1.5 py-0 gap-0.5">
                <Users className="h-2.5 w-2.5" />{n}
              </Badge>
            ))}
            {post.detectedLinks.length > 0 && (
              <Badge variant="outline" className="text-2xs px-1.5 py-0 gap-0.5">
                <Link2 className="h-2.5 w-2.5" />{post.detectedLinks.length} links
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  if (isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Agendamentos" description="Programe envios para datas e horários específicos" />
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => (<Card key={i} className="glass"><CardContent className="py-4"><Skeleton className="h-16 w-full" /></CardContent></Card>))}</div>
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader title="Agendamentos" description="Programe envios para datas e horários específicos">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={openNew}><Plus className="h-4 w-4 mr-1.5" />Novo agendamento</Button>
        </div>
      </PageHeader>

      {posts.length > 0 ? (
        <div className="mx-auto max-w-5xl space-y-4">
          <Card className="glass border-info/30">
            <CardContent className="py-3 text-xs text-muted-foreground text-center">
              Fila ativa: <span className="font-medium text-foreground">{queuePosts.length}</span> agendamento(s) pendente(s), ordenados por envio mais próximo.
            </CardContent>
          </Card>

          {queuePosts.length > 0 && (
            <div className="space-y-3">
              {queuePosts.map((post, index) => renderPostCard(post, index + 1))}
            </div>
          )}

          {archivedPosts.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide text-center">Salvos (enviados/cancelados/falhos)</p>
              {archivedPosts.map((post) => renderPostCard(post))}
            </div>
          )}
        </div>
      ) : (
        <EmptyState icon={CalendarDays} title="Nenhum agendamento" description="Crie agendamentos para enviar mensagens em datas específicas." actionLabel="Novo agendamento" onAction={openNew} />
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir agendamento?</AlertDialogTitle>
            <AlertDialogDescription>O agendamento "{(deleteTarget?.name || deleteTarget?.content || "").slice(0, 50)}..." será excluído permanentemente.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (deleteId) deletePost(deleteId); setDeleteId(null); }}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Single-screen create/edit modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="sm:max-w-2xl max-h-[92dvh] overflow-hidden p-0">
          <div className="flex max-h-[92dvh] flex-col">
            <DialogHeader className="space-y-1.5 border-b px-5 pt-5 pb-4 sm:px-6 sm:pt-6 sm:pb-5">
              <DialogTitle>{editingId ? "Editar agendamento" : "Novo agendamento"}</DialogTitle>
              <DialogDescription>
                Configure conteúdo, programação e destinos da sua mensagem.
              </DialogDescription>
            </DialogHeader>

            <div className="overflow-y-auto px-5 py-4 max-h-[calc(92dvh-170px)] sm:px-6 sm:py-5">
              <div className="space-y-4">
                <Card className="bg-muted/30 border-dashed">
                  <CardContent className="p-3 text-xs text-muted-foreground text-center">
                    <span className="font-medium text-foreground">Resumo:</span> {isRecurring ? "recorrente" : "pontual"} • {totalDestinations} destino(s) selecionado(s)
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="space-y-4 p-4">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Conteúdo</Label>
                <div className="space-y-2">
                  <Label>Nome do agendamento *</Label>
                  <Input
                    placeholder="Ex: Oferta iPhone para grupos VIP"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Imagem (opcional)</Label>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={handleImageFileChange}
                  />
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" onClick={() => imageInputRef.current?.click()} disabled={uploadingImage}>
                      <Upload className="h-3.5 w-3.5 mr-1.5" />
                      {uploadingImage ? "Processando..." : (draft.media ? "Trocar imagem" : "Selecionar imagem")}
                    </Button>
                    {draft.media && (
                      <Button type="button" variant="ghost" size="sm" onClick={removeDraftMedia}>
                        <X className="h-3.5 w-3.5 mr-1" />Remover
                      </Button>
                    )}
                  </div>
                  {draft.media && (
                    <div className="rounded-lg border p-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <ImageIcon className="h-3.5 w-3.5" />
                      <span className="truncate">{draft.media.fileName}</span>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Conteúdo da mensagem *</Label>
                  <Textarea placeholder="Digite a mensagem ou cole um link de marketplace..." value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} className="min-h-[80px]" />
                  {hasLinks && (
                    <div className="flex flex-wrap gap-1.5">
                      {detectedLinks.map((l, i) => (<Badge key={i} variant="outline" className="text-xs gap-1"><Link2 className="h-3 w-3" />{getMarketplaceLabel(l.marketplace)}</Badge>))}
                      <span className="text-xs text-muted-foreground ml-1">Links serão convertidos automaticamente</span>
                    </div>
                  )}
                </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="space-y-4 p-4">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Programação</Label>
                <div className="space-y-2">
                  <Label>Recorrência</Label>
                  <div className="flex items-center gap-2">
                    <Switch id="is-recurring" checked={isRecurring} onCheckedChange={toggleRecurrence} />
                    <Label htmlFor="is-recurring">Ativar recorrência</Label>
                  </div>
                </div>

                {!isRecurring && (
                  <DateTimeField
                    value={draft.scheduledAt}
                    onChange={(value) => setDraft({ ...draft, scheduledAt: value })}
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
                          <Checkbox checked={draft.weekDays.includes(d.value)} onCheckedChange={() => toggleWeekDay(d.value)} />
                          <span className="text-sm">{d.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {isRecurring && (
                  <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
                    <Label>Horários da recorrência *</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        step={60}
                        value={recurrenceTimeInput}
                        onChange={(event) => setRecurrenceTimeInput(event.target.value.slice(0, 5))}
                        className="flex-1"
                      />
                      <Button type="button" variant="outline" onClick={addRecurrenceTime}>Adicionar</Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {draft.recurrenceTimes.map((time) => (
                        <Badge key={time} variant="secondary" className="cursor-pointer" onClick={() => removeRecurrenceTime(time)}>
                          {time} x
                        </Badge>
                      ))}
                      {draft.recurrenceTimes.length === 0 && <span className="text-xs text-muted-foreground">Escolha um horário e adicione outros se necessário</span>}
                    </div>
                  </div>
                )}

                {isRecurring && (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Quando ativada, a data/hora fixa deixa de ser usada e o envio segue os dias e horários selecionados.</Label>
                  </div>
                )}
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="space-y-4 p-4">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Destino</Label>
                <div className="space-y-2">
                  <Label>Sessão de envio *</Label>
                  <SessionSelect
                    value={draft.sessionId}
                    onValueChange={changeSession}
                    sessions={allSessions}
                    placeholder="Selecione uma sessão..."
                    emptyLabel="Nenhuma sessão disponível"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tipo de destino</Label>
                  <Select
                    value={destinationMode}
                    onValueChange={(value: DestinationMode) => {
                      setDestinationMode(value);
                      setDraft((prev) => (value === "individual"
                        ? { ...prev, masterGroupIds: [] }
                        : { ...prev, destinationGroupIds: [] }));
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="individual">Grupos individuais</SelectItem>
                      <SelectItem value="master">Master Groups</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {!draft.sessionId && (
                  <div className="text-xs text-muted-foreground p-2 rounded-lg bg-muted/30">
                    Selecione a sessão de envio para carregar os destinos disponíveis.
                  </div>
                )}

                {draft.sessionId && destinationMode === "individual" && (
                  <div className="space-y-2">
                    <Label>Grupos destino *</Label>
                    {filteredGroups.length > 0 ? (
                      <MultiOptionDropdown
                        value={draft.destinationGroupIds}
                        onChange={(ids) => setDraft((prev) => ({ ...prev, destinationGroupIds: ids }))}
                        items={filteredGroups.map((group) => ({
                          id: group.id,
                          label: group.name,
                          meta: `${group.memberCount}`,
                        }))}
                        placeholder="Selecionar grupos individuais"
                        selectedLabel={(count) => `${count} grupo(s) selecionado(s)`}
                        emptyMessage="Nenhum grupo associado a esta sessão"
                        title="Grupos de destino"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">Nenhum grupo associado a esta sessão</span>
                    )}
                  </div>
                )}

                {draft.sessionId && destinationMode === "master" && (
                  <div className="space-y-2">
                    <Label>Master Groups *</Label>
                    {filteredMasterGroups.length > 0 ? (
                      <MultiOptionDropdown
                        value={draft.masterGroupIds}
                        onChange={(ids) => setDraft((prev) => ({ ...prev, masterGroupIds: ids }))}
                        items={filteredMasterGroups.map((masterGroup) => ({
                          id: masterGroup.id,
                          label: masterGroup.name,
                          meta: `${masterGroup.groupIds.filter((groupId) => filteredGroupIds.has(groupId)).length} grupos`,
                        }))}
                        placeholder="Selecionar master groups"
                        selectedLabel={(count) => `${count} master group(s) selecionado(s)`}
                        emptyMessage="Nenhum master group associado a esta sessão"
                        title="Grupos mestre"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">Nenhum master group associado a esta sessão</span>
                    )}
                  </div>
                )}
                  </CardContent>
                </Card>

                {totalDestinations > 0 && (
                  <div className="text-xs text-muted-foreground flex items-center justify-center gap-1 p-2 rounded-lg bg-muted/30 text-center"><Send className="h-3 w-3" /> {totalDestinations} grupo(s) receberão a mensagem</div>
                )}
              </div>
            </div>

            <DialogFooter className="border-t px-5 py-4 sm:px-6">
              <Button variant="outline" onClick={() => setShowModal(false)}>Cancelar</Button>
              <Button onClick={savePost}>{editingId ? "Salvar" : "Criar agendamento"}</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}


