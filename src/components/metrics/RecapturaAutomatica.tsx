import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatPhoneDisplay } from "@/lib/phone-utils";
import {
  type AnalyticsAdminGroup,
  type RecaptureQueueItem,
  fetchRecaptureQueue,
  saveRecaptureRule,
} from "@/integrations/analytics-client";
import { useWhatsAppSessions } from "@/hooks/useWhatsAppSessions";
import { 
  BellRing, 
  BellOff, 
  Clock, 
  Loader2, 
  Send, 
  Settings2, 
  Smartphone,
  ChevronLeft,
  ChevronRight,
  History,
  CheckCircle2,
  AlertCircle,
  FileText
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Props {
  groups: AnalyticsAdminGroup[];
  selectedGroupIds: string[];
}

// ── Constants ──
const ITEMS_PER_PAGE = 5;

// ── Formatters ────────────────────────────────────────────────────────────────

function formatDatetime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const DELAY_OPTIONS = [
  { value: "0",   label: "Imediatamente" },
  { value: "1",   label: "1 hora" },
  { value: "6",   label: "6 horas" },
  { value: "24",  label: "1 dia" },
  { value: "72",  label: "3 dias" },
  { value: "168", label: "7 dias" },
];

const DEFAULT_TEMPLATE = `Olá! 👋

Notamos que você saiu do nosso grupo recentemente.

Se quiser voltar, será sempre bem-vindo(a)! 😊`;

function StatusBadge({ status }: { status: RecaptureQueueItem["status"] }) {
  if (status === "pending") {
    return (
      <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 font-medium">
        <Clock className="mr-1.5 h-3 w-3" />
        Agendado
      </Badge>
    );
  }
  if (status === "sent") {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 font-medium">
        <CheckCircle2 className="mr-1.5 h-3 w-3" />
        Enviado
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive font-medium">
      <AlertCircle className="mr-1.5 h-3 w-3" />
      Falhou
    </Badge>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function RecapturaAutomatica({ groups, selectedGroupIds }: Props) {
  const qc = useQueryClient();
  const { sessions } = useWhatsAppSessions();

  const onlineSessions = useMemo(
    () => sessions.filter((s) => s.status === "online"),
    [sessions],
  );

  const displayGroups = useMemo(
    () => selectedGroupIds.length > 0
      ? groups.filter((g) => selectedGroupIds.includes(g.id))
      : groups,
    [groups, selectedGroupIds],
  );

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

  const primaryGroup = useMemo(() => {
    if (activeGroupId) {
      const found = displayGroups.find((g) => g.id === activeGroupId);
      if (found) return found;
    }
    return displayGroups[0] ?? null;
  }, [activeGroupId, displayGroups]);

  const primaryGroupId = primaryGroup?.id ?? null;

  // Local form state
  const [delayHours, setDelayHours] = useState<string>("24");
  const [messageTemplate, setMessageTemplate] = useState(DEFAULT_TEMPLATE);
  const [active, setActive] = useState(true);
  const [sessionWaId, setSessionWaId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formDirty, setFormDirty] = useState(false);

  // Pagination state
  const [pendingPage, setPendingPage] = useState(1);
  const [recentPage, setRecentPage] = useState(1);

  const queueQuery = useQuery({
    queryKey: ["analytics-recapture-queue", primaryGroupId],
    enabled: !!primaryGroupId,
    staleTime: 60_000,
    queryFn: async () => {
      const result = await fetchRecaptureQueue(primaryGroupId!);
      if (result.rule && !formDirty) {
        setDelayHours(String(result.rule.delayHours));
        setMessageTemplate(result.rule.messageTemplate || DEFAULT_TEMPLATE);
        setActive(result.rule.active);
        setSessionWaId(result.rule.sessionWaId ?? null);
      }
      return result;
    },
  });

  const handleSave = useCallback(async () => {
    if (!primaryGroupId) return;
    setIsSaving(true);
    try {
      await saveRecaptureRule(primaryGroupId, Number(delayHours), messageTemplate, active, sessionWaId);
      await qc.invalidateQueries({ queryKey: ["analytics-recapture-queue", primaryGroupId] });
      setFormDirty(false);
      toast.success("Configurações atualizadas com sucesso");
    } catch (err) {
      toast.error(`Erro ao salvar: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }, [primaryGroupId, delayHours, messageTemplate, active, sessionWaId, qc]);

  if (!primaryGroupId) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border/40 bg-muted/10 py-24 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Settings2 className="h-8 w-8 text-primary opacity-60" />
        </div>
        <p className="text-base font-semibold text-foreground">Configuração de Recaptura</p>
        <p className="mt-1 text-sm text-muted-foreground max-w-xs">
          Selecione um grupo na lista lateral para ativar automações de saída.
        </p>
      </div>
    );
  }

  const allPending = queueQuery.data?.pending ?? [];
  const allRecent = queueQuery.data?.recent ?? [];

  // Paged data
  const pagedPending = allPending.slice((pendingPage - 1) * ITEMS_PER_PAGE, pendingPage * ITEMS_PER_PAGE);
  const pagedRecent = allRecent.slice((recentPage - 1) * ITEMS_PER_PAGE, recentPage * ITEMS_PER_PAGE);
  const totalPendingPages = Math.ceil(allPending.length / ITEMS_PER_PAGE);
  const totalRecentPages = Math.ceil(allRecent.length / ITEMS_PER_PAGE);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* ── Header Area ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between px-1">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Recaptura de Membros</h2>
          <p className="text-sm text-muted-foreground">Envie convites automáticos para quem deixou seu grupo.</p>
        </div>
        {displayGroups.length > 1 && (
          <Select
            value={primaryGroupId}
            onValueChange={(v) => { setActiveGroupId(v); setFormDirty(false); setPendingPage(1); setRecentPage(1); }}
          >
            <SelectTrigger className="h-10 w-full sm:w-[240px] bg-background shadow-sm border-border/60">
              <SelectValue placeholder="Selecione o grupo" />
            </SelectTrigger>
            <SelectContent>
              {displayGroups.map((g) => (
                <SelectItem key={g.id} value={g.id} className="cursor-pointer">
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-6">
        {/* ── Configuration Row (Full Width) ── */}
        <Card className="border-border/60 shadow-lg shadow-black/5 overflow-hidden">
          <CardHeader className="pb-4 border-b border-border/40 bg-muted/10">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle className="text-base font-bold flex items-center gap-2">
                  <Settings2 className="h-4.5 w-4.5 text-primary" />
                  Regras de Automatação
                </CardTitle>
                <CardDescription>Defina como e quando enviar as mensagens de recaptura</CardDescription>
              </div>
              <div 
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all",
                  active ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600" : "bg-muted border-border text-muted-foreground"
                )}
              >
                <span className="text-[11px] font-bold uppercase tracking-wider">{active ? "Ativa" : "Pausada"}</span>
                <Switch
                  checked={active}
                  onCheckedChange={(v) => { setActive(v); setFormDirty(true); }}
                  className="scale-75 data-[state=checked]:bg-emerald-500"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {/* Delay */}
              <div className="space-y-2.5">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5" />
                  Tempo de Espera
                </Label>
                <Select
                  value={delayHours}
                  onValueChange={(v) => { setDelayHours(v); setFormDirty(true); }}
                >
                  <SelectTrigger className="h-10 border-border/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DELAY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Session */}
              <div className="space-y-2.5">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <Smartphone className="h-3.5 w-3.5" />
                  Canal de Disparo
                </Label>
                <Select
                  value={sessionWaId ?? "__auto__"}
                  onValueChange={(v) => {
                    setSessionWaId(v === "__auto__" ? null : v);
                    setFormDirty(true);
                  }}
                >
                  <SelectTrigger className="h-10 border-border/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">Padrão do Grupo</SelectItem>
                    {onlineSessions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                          <span className="truncate max-w-[150px]">{s.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Tips/Info */}
              <div className="bg-primary/[0.03] border border-primary/10 rounded-xl p-4 flex gap-3 items-start">
                <FileText className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-[11px] font-bold text-primary uppercase">Nota sobre envios</p>
                  <p className="text-xs text-muted-foreground leading-snug">
                    Mensagens são enviadas individualmente (PV) usando a sessão escolhida.
                  </p>
                </div>
              </div>
            </div>

            <Separator className="bg-border/40" />

            {/* Message */}
            <div className="space-y-3">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <Send className="h-3.5 w-3.5" />
                Conteúdo da Mensagem
              </Label>
              <Textarea
                className="min-h-[140px] resize-none border-border/60 focus:ring-primary/20 bg-muted/5 leading-relaxed"
                placeholder="Escreva sua mensagem aqui..."
                value={messageTemplate}
                onChange={(e) => { setMessageTemplate(e.target.value); setFormDirty(true); }}
              />
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={isSaving || !messageTemplate.trim() || !formDirty}
                className={cn(
                  "h-11 px-8 font-bold transition-all w-full md:w-auto",
                  formDirty ? "shadow-md shadow-primary/20" : ""
                )}
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                )}
                {isSaving ? "Salvando..." : "Salvar Configurações"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Logs Row (Side by Side) ── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Pending Queue */}
          <Card className="border-border/60 shadow-md">
            <CardHeader className="py-4 px-5 border-b border-border/40 bg-amber-500/[0.03]">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold flex items-center gap-2 text-amber-600">
                  <Clock className="h-4 w-4" />
                  Envios Agendados
                </CardTitle>
                {allPending.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] font-bold h-5">{allPending.length}</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {queueQuery.isLoading ? (
                <div className="p-4 space-y-3">
                  <Skeleton className="h-12 w-full rounded-lg" />
                </div>
              ) : allPending.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground/30">
                  <Clock className="h-8 w-8 mb-2" />
                  <p className="text-xs font-medium">Nenhum envio pendente</p>
                </div>
              ) : (
                <div className="divide-y divide-border/30">
                  {pagedPending.map((item) => (
                    <div key={item.id} className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors">
                      <div className="space-y-1">
                        <div className="text-xs font-bold tracking-tight">{formatPhoneDisplay(item.memberPhone)}</div>
                        <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" />
                          Disparo em {formatDatetime(item.scheduledAt)}
                        </div>
                      </div>
                      <StatusBadge status={item.status} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
            {totalPendingPages > 1 && (
              <div className="p-3 bg-muted/10 border-t border-border/30 flex items-center justify-between">
                <p className="text-[10px] text-muted-foreground font-medium">Página {pendingPage} de {totalPendingPages}</p>
                <div className="flex gap-1">
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-7 w-7" 
                    onClick={() => setPendingPage(p => Math.max(1, p - 1))}
                    disabled={pendingPage === 1}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-7 w-7" 
                    onClick={() => setPendingPage(p => Math.min(totalPendingPages, p + 1))}
                    disabled={pendingPage === totalPendingPages}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* History */}
          <Card className="border-border/60 shadow-md">
            <CardHeader className="py-4 px-5 border-b border-border/40">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold flex items-center gap-2 text-muted-foreground">
                  <History className="h-4 w-4" />
                  Histórico Recente
                </CardTitle>
                {allRecent.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] font-bold h-5">{allRecent.length}</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {queueQuery.isLoading ? (
                <div className="p-4 space-y-3">
                  <Skeleton className="h-12 w-full rounded-lg" />
                </div>
              ) : allRecent.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground/30">
                  <History className="h-8 w-8 mb-2" />
                  <p className="text-xs font-medium">Nenhuma atividade registrada</p>
                </div>
              ) : (
                <div className="divide-y divide-border/30">
                  {pagedRecent.map((item) => (
                    <div key={item.id} className="flex items-center justify-between p-4 hover:bg-muted/10 transition-colors">
                      <div className="space-y-1">
                        <div className="text-xs font-bold text-foreground/80">{formatPhoneDisplay(item.memberPhone)}</div>
                        <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          {item.sentAt ? `Finalizado em ${formatDatetime(item.sentAt)}` : `Processado em ${formatDatetime(item.scheduledAt)}`}
                        </div>
                      </div>
                      <StatusBadge status={item.status} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
            {totalRecentPages > 1 && (
              <div className="p-3 bg-muted/10 border-t border-border/30 flex items-center justify-between">
                <p className="text-[10px] text-muted-foreground font-medium">Página {recentPage} de {totalRecentPages}</p>
                <div className="flex gap-1">
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-7 w-7" 
                    onClick={() => setRecentPage(p => Math.max(1, p - 1))}
                    disabled={recentPage === 1}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-7 w-7" 
                    onClick={() => setRecentPage(p => Math.min(totalRecentPages, p + 1))}
                    disabled={recentPage === totalRecentPages}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}