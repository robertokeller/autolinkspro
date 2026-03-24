import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Ban,
  Calendar,
  CheckCircle2,
  Clock,
  Eye,
  Filter,
  Image,
  Loader2,
  MessageSquare,
  Paperclip,
  Phone,
  QrCode,
  RefreshCw,
  Send,
  Trash2,
  Unplug,
  Users,
  Wifi,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAdminWhatsAppSession } from "@/hooks/useAdminWhatsAppSession";
import { useAdminBroadcast, type BroadcastMediaAttachment, type BroadcastRecord, type BroadcastRecipient } from "@/hooks/useAdminBroadcast";
import { formatPhoneDisplay } from "@/lib/phone-utils";
import { formatBRT } from "@/lib/timezone";
import { InlineLoadingState } from "@/components/InlineLoadingState";
import { plans } from "@/lib/plans";
import type { SessionStatus } from "@/lib/types";

// ── Status badge helper ────────────────────────────────────────────────────
function broadcastStatusBadge(status: string) {
  switch (status) {
    case "sent":      return <Badge variant="success"  className="gap-1"><CheckCircle2 className="h-3 w-3" />Enviado</Badge>;
    case "partial":   return <Badge variant="warning"  className="gap-1"><AlertTriangle className="h-3 w-3" />Parcial</Badge>;
    case "failed":    return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Falhou</Badge>;
    case "processing":return <Badge variant="secondary" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" />Enviando</Badge>;
    case "scheduled": return <Badge variant="secondary" className="gap-1"><Calendar className="h-3 w-3" />Agendado</Badge>;
    case "cancelled": return <Badge variant="secondary" className="gap-1"><Ban className="h-3 w-3" />Cancelado</Badge>;
    default:          return <Badge variant="secondary">{status}</Badge>;
  }
}

export default function AdminWhatsApp() {
  // ── WA Session ─────────────────────────────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    session,
    isLoading,
    createSession,
    connectSession,
    disconnectSession,
    deleteSession,
    refresh,
    isCreating,
    isConnecting,
    isDisconnecting,
    isDeleting,
    isRefreshing,
  } = useAdminWhatsAppSession();

  // ── Broadcast ──────────────────────────────────────────────────────────────
  const {
    broadcasts,
    isLoadingHistory,
    refetchHistory,
    previewRecipients,
    isPreviewing,
    previewData,
    sendBroadcast,
    isSending,
    scheduleBroadcast,
    isScheduling,
    cancelBroadcast,
    isCancelling,
  } = useAdminBroadcast();

  // Connection state
  const [showQrDialog, setShowQrDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const previousStatusRef = useRef<SessionStatus | null>(null);

  // Broadcast form state
  const [message, setMessage] = useState("");
  const [broadcastMedia, setBroadcastMedia] = useState<BroadcastMediaAttachment | null>(null);
  const broadcastFileInputRef = useRef<HTMLInputElement>(null);
  const [filterPlan, setFilterPlan] = useState<string[]>([]);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterUserIds, setFilterUserIds] = useState<string[]>([]);
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [showPreviewList, setShowPreviewList] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("connection");

  const ACTIVE_PLANS = plans.filter((p) => p.isActive);

  // ── Initialize from URL params ──────────────────────────────────────────────
  useEffect(() => {
    const usersParam = searchParams.get("users");
    if (usersParam) {
      const ids = usersParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) {
        setFilterUserIds(ids);
        setActiveTab("broadcast");
        // Clean URL param without replacing history
        setSearchParams(new URLSearchParams(), { replace: true });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Session effects ─────────────────────────────────────────────────────────
  useEffect(() => {
    previousStatusRef.current = session?.status ?? null;
  }, [session]);

  useEffect(() => {
    if (!showQrDialog || !session) return;
    const shouldPoll = session.status === "connecting" || session.status === "qr_code";
    if (!shouldPoll) return;
    const interval = window.setInterval(() => refresh({ silent: true }), 1500);
    return () => window.clearInterval(interval);
  }, [showQrDialog, session, refresh]);

  // ── Handlers: connection ────────────────────────────────────────────────────
  const handleCreateAndConnect = useCallback(async () => {
    try {
      const id = await createSession();
      setShowQrDialog(true);
      await connectSession(id);
      refresh({ silent: true });
    } catch { /* toast handled */ }
  }, [createSession, connectSession, refresh]);

  const handleConnect = useCallback(async () => {
    if (!session) return;
    setShowQrDialog(true);
    try {
      await connectSession(session.id);
      refresh({ silent: true });
    } catch { /* toast handled */ }
  }, [session, connectSession, refresh]);

  const handleDisconnect = useCallback(async () => {
    if (!session) return;
    try { await disconnectSession(session.id); } catch { /* toast handled */ }
  }, [session, disconnectSession]);

  const handleDelete = useCallback(async () => {
    if (!session) return;
    try {
      await deleteSession(session.id);
      setShowDeleteConfirm(false);
      setShowQrDialog(false);
    } catch { /* toast handled */ }
  }, [session, deleteSession]);

  // ── Handlers: broadcast ─────────────────────────────────────────────────────
  const getFilters = () => ({ filterPlan, filterStatus, filterUserIds });

  const handlePreview = async () => {
    setShowPreviewList(false);
    await previewRecipients(getFilters());
  };

  const handleSend = async () => {
    if (!message.trim() && !broadcastMedia) return;
    if (sendMode === "now") {
      await sendBroadcast({ message, ...(broadcastMedia ? { media: broadcastMedia } : {}), ...getFilters() });
      setMessage("");
      setBroadcastMedia(null);
    } else {
      if (!scheduledAt) return;
      await scheduleBroadcast({ message, scheduledAt, ...getFilters() });
      setMessage("");
      setScheduledAt("");
    }
    refetchHistory();
  };

  const togglePlan = (planId: string) => {
    setFilterPlan((prev) =>
      prev.includes(planId) ? prev.filter((p) => p !== planId) : [...prev, planId],
    );
  };

  // ── QR dialog renderer ──────────────────────────────────────────────────────
  const renderQrContent = () => {
    if (!session) return null;
    if (session.status === "online") {
      return (
        <div className="flex flex-col items-center gap-5 py-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-success/15">
            <CheckCircle2 className="h-10 w-10 text-success" />
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold">Conectado!</p>
            <p className="mt-1 text-sm text-muted-foreground">O WhatsApp do sistema está online e pronto para uso.</p>
            {session.connectedAt && (
              <p className="mt-2 flex items-center justify-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                Conectado desde {formatBRT(session.connectedAt, "dd/MM 'às' HH:mm")}
              </p>
            )}
          </div>
        </div>
      );
    }
    if (session.status === "warning") {
      return (
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-warning/15">
            <AlertTriangle className="h-8 w-8 text-warning" />
          </div>
          <div className="text-center">
            <p className="font-semibold">Não foi possível gerar o QR Code</p>
            <p className="mt-1 text-sm text-muted-foreground">O serviço WhatsApp pode estar fora do ar.</p>
          </div>
        </div>
      );
    }
    if (session.status === "qr_code" && session.qrCode) {
      return (
        <div className="flex flex-col items-center gap-4 py-2">
          <img
            src={session.qrCode}
            alt="QR Code do WhatsApp Admin"
            className="aspect-square w-full max-w-[280px] rounded-xl border bg-white p-2 shadow-md"
          />
          <p className="text-center text-sm text-muted-foreground">
            Abra o WhatsApp no celular → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> e leia o código acima.
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <div className="text-center">
          <p className="font-semibold">Gerando QR Code...</p>
          <p className="mt-1 text-sm text-muted-foreground">Aguardando resposta do WhatsApp. Pode levar alguns segundos.</p>
        </div>
      </div>
    );
  };

  const isOnline = session?.status === "online";
  const isBusy = session ? ["connecting", "qr_code"].includes(session.status) : false;
  const hasNowContent = message.trim().length > 0 || !!broadcastMedia;
  const hasScheduleContent = message.trim().length > 0;
  const canSend = isOnline && (sendMode === "now" ? hasNowContent : hasScheduleContent) && (sendMode === "now" || scheduledAt !== "");
  const recipientCount = previewData?.count ?? null;

  const handleBroadcastFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      const { toast: toastFn } = await import("sonner");
      toastFn.error("Arquivo muito grande. Máximo 10 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf(",");
      const base64 = idx >= 0 ? result.slice(idx + 1) : result;
      setBroadcastMedia({ base64, mimeType: file.type || "image/jpeg", fileName: file.name });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Page header */}
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">WhatsApp do Sistema</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Conexão oficial do administrador para comunicação em massa com clientes.
          </p>
        </div>
      </div>

      {/* Initial loading */}
      {isLoading && <InlineLoadingState label="Carregando sessão do WhatsApp..." />}

      {/* No session – full-width CTA, no tabs needed yet */}
      {!isLoading && !session && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-5 py-16">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted">
              <QrCode className="h-10 w-10 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold">Nenhum WhatsApp conectado</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Conecte o WhatsApp do sistema para começar a enviar mensagens aos clientes.
              </p>
            </div>
            <Button
              size="lg"
              className="gap-2 px-8"
              onClick={() => void handleCreateAndConnect()}
              disabled={isCreating || isConnecting}
            >
              {isCreating || isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
              Conectar WhatsApp
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Session exists – show tabs */}
      {!isLoading && session && (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="connection" className="gap-1.5">
              <Phone className="h-4 w-4" />
              Conexão
            </TabsTrigger>
            <TabsTrigger value="broadcast" className="gap-1.5" disabled={!isOnline}>
              <Send className="h-4 w-4" />
              <span className="hidden sm:inline">Envio em Massa</span>
              <span className="sm:hidden">Envio</span>
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-1.5">
              <Clock className="h-4 w-4" />
              Histórico
              {broadcasts.filter((b) => b.status === "scheduled" || b.status === "processing").length > 0 && (
                <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1 text-xs font-medium text-primary">
                  {broadcasts.filter((b) => b.status === "scheduled" || b.status === "processing").length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ── Tab: Conexão ────────────────────────────────────────────── */}
          <TabsContent value="connection" className="mt-5 space-y-4">
            {/* Status card */}
            <Card className={isOnline ? "ring-1 ring-success/30" : undefined}>
              <div className={`h-1.5 w-full rounded-t-lg ${isOnline ? "bg-success" : isBusy ? "bg-blue-500" : session.status === "warning" ? "bg-warning" : "bg-muted-foreground/20"}`} />
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Phone className="h-5 w-5 shrink-0" />
                      <span className="truncate">{session.name}</span>
                    </CardTitle>
                    <CardDescription className="mt-0.5 font-medium tabular-nums">
                      {session.phoneNumber ? formatPhoneDisplay(session.phoneNumber) : "Número detectado após conexão"}
                    </CardDescription>
                  </div>
                  <Badge
                    variant={isOnline ? "success" : session.status === "warning" ? "warning" : "secondary"}
                    className="shrink-0 gap-1"
                  >
                    {isOnline ? <Wifi className="h-3 w-3" /> : isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <WifiOff className="h-3 w-3" />}
                    {isOnline ? "Online" : isBusy ? "Conectando" : session.status === "warning" ? "Alerta" : "Offline"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {isOnline && session.connectedAt && (
                  <div className="flex items-center gap-2 rounded-lg bg-success/5 px-3 py-2 text-sm text-success">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Conectado desde {formatBRT(session.connectedAt, "dd/MM/yyyy 'às' HH:mm")}
                  </div>
                )}
                {session.errorMessage && (
                  <div className="flex items-center gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {session.errorMessage}
                  </div>
                )}
                {!isOnline && (
                  <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
                    WhatsApp offline — as funcionalidades de envio em massa ficam indisponíveis até reconectar.
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => refresh()} disabled={isRefreshing}>
                    {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Atualizar
                  </Button>
                  {!isOnline && (
                    <Button size="sm" className="gap-1.5" onClick={() => void handleConnect()} disabled={isConnecting}>
                      {isConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <QrCode className="h-3.5 w-3.5" />}
                      {isBusy ? "Ver QR Code" : "Conectar"}
                    </Button>
                  )}
                  {(isOnline || isBusy) && (
                    <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => void handleDisconnect()} disabled={isDisconnecting}>
                      {isDisconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
                      Desconectar
                    </Button>
                  )}
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setShowDeleteConfirm(true)} disabled={isDeleting}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Remover
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="border-dashed bg-muted/20">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Como funciona
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <ul className="space-y-1 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2"><span className="mt-0.5 text-muted-foreground/50">•</span>Conecte via QR Code — o número fica como linha oficial do sistema.</li>
                  <li className="flex items-start gap-2"><span className="mt-0.5 text-muted-foreground/50">•</span>Use <strong className="text-foreground">Envio em Massa</strong> para notificar clientes por plano ou status.</li>
                  <li className="flex items-start gap-2"><span className="mt-0.5 text-muted-foreground/50">•</span>Agende mensagens para datas futuras na mesma aba.</li>
                  <li className="flex items-start gap-2"><span className="mt-0.5 text-muted-foreground/50">•</span>A conexão é monitorada automaticamente. Se cair, basta ler o QR Code novamente.</li>
                </ul>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Tab: Envio em Massa ─────────────────────────────────────── */}
          <TabsContent value="broadcast" className="mt-5 space-y-4">
            {/* Recipient filters */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Filter className="h-4 w-4" />
                  Filtros de destinatários
                </CardTitle>
                <CardDescription>Defina quem vai receber a mensagem. Apenas usuários com telefone cadastrado são elegíveis.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Pre-selected users from Admin Users page */}
                {filterUserIds.length > 0 && (
                  <div className="rounded-lg border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 px-3 py-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-green-700 dark:text-green-400">
                        {filterUserIds.length} {filterUserIds.length === 1 ? "usuário específico selecionado" : "usuários específicos selecionados"} da página de usuários
                      </p>
                      <button
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setFilterUserIds([])}
                      >
                        Remover filtro
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">Os filtros de plano e status abaixo serão ignorados para esses destinatários.</p>
                  </div>
                )}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Planos</Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {ACTIVE_PLANS.map((p) => (
                      <label
                        key={p.id}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/50 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5"
                      >
                        <Checkbox
                          checked={filterPlan.includes(p.id)}
                          onCheckedChange={() => togglePlan(p.id)}
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                  {filterPlan.length === 0 && (
                    <p className="text-xs text-muted-foreground">Nenhum plano selecionado = todos os planos.</p>
                  )}
                </div>

                {/* Status filter */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Status do plano</Label>
                  <Select value={filterStatus} onValueChange={setFilterStatus}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos os usuários ativos</SelectItem>
                      <SelectItem value="active_plan">Plano vigente (não expirado)</SelectItem>
                      <SelectItem value="expired_plan">Plano expirado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Preview */}
                <div className="flex items-center gap-3">
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={handlePreview} disabled={isPreviewing}>
                    {isPreviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                    Pré-visualizar destinatários
                  </Button>
                  {recipientCount !== null && (
                    <div className="flex items-center gap-1.5 text-sm">
                      <Users className="h-4 w-4 text-muted-foreground" />
                      <span className="font-semibold text-foreground">{recipientCount}</span>
                      <span className="text-muted-foreground">destinatário{recipientCount !== 1 ? "s" : ""}</span>
                      {previewData && previewData.users.length > 0 && (
                        <button
                          className="ml-1 text-xs text-primary underline-offset-2 hover:underline"
                          onClick={() => setShowPreviewList((v) => !v)}
                        >
                          {showPreviewList ? "ocultar" : "ver lista"}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Preview user list */}
                {showPreviewList && previewData && previewData.users.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-lg border divide-y text-sm">
                    {previewData.users.map((u) => (
                      <div key={u.user_id} className="flex items-center justify-between px-3 py-2">
                        <div>
                          <span className="font-medium">{u.name || u.email}</span>
                          {u.phone && <span className="ml-2 text-muted-foreground">{formatPhoneDisplay(u.phone)}</span>}
                        </div>
                        <Badge variant="secondary" className="text-xs">{u.plan_id.replace("plan-", "")}</Badge>
                      </div>
                    ))}
                    {recipientCount !== null && recipientCount > previewData.users.length && (
                      <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                        +{recipientCount - previewData.users.length} mais (exibindo primeiros 300)
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Message composer */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <MessageSquare className="h-4 w-4" />
                  Mensagem
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Media preview */}
                {broadcastMedia && (
                  <div className="relative overflow-hidden rounded-lg border bg-muted/30">
                    {broadcastMedia.mimeType.startsWith("image/") ? (
                      <img
                        src={`data:${broadcastMedia.mimeType};base64,${broadcastMedia.base64}`}
                        alt={broadcastMedia.fileName}
                        className="max-h-48 w-full object-contain"
                      />
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-2.5">
                        <Paperclip className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm truncate">{broadcastMedia.fileName}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setBroadcastMedia(null)}
                      className="absolute right-2 top-2 rounded-full bg-background/80 p-1 hover:bg-background transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                <div className="space-y-2">
                  <Textarea
                    placeholder="Digite aqui a mensagem que será enviada para os clientes selecionados..."
                    className="min-h-32 resize-none"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => broadcastFileInputRef.current?.click()}
                      disabled={sendMode === "schedule"}
                      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:pointer-events-none disabled:opacity-40"
                    >
                      <Image className="h-4 w-4" />
                      {broadcastMedia ? "Trocar imagem" : "Anexar imagem"}
                    </button>
                    <p className="text-right text-xs text-muted-foreground">{message.length} caracteres</p>
                  </div>
                  <input
                    ref={broadcastFileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => void handleBroadcastFileSelect(e)}
                  />
                </div>

                {/* Send mode */}
                <div className="space-y-3">
                  <Label className="text-sm font-medium">Quando enviar</Label>
                  {sendMode === "schedule" && broadcastMedia && (
                    <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                      Imagens não são suportadas em envios agendados — apenas mensagens de texto.
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/50 ${sendMode === "now" ? "border-primary/50 bg-primary/5" : ""}`}>
                      <input type="radio" className="sr-only" checked={sendMode === "now"} onChange={() => setSendMode("now")} />
                      <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${sendMode === "now" ? "border-primary" : "border-muted-foreground/40"}`}>
                        {sendMode === "now" && <div className="h-2 w-2 rounded-full bg-primary" />}
                      </div>
                      <Send className="h-3.5 w-3.5" />
                      Enviar agora
                    </label>
    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/50 ${sendMode === "schedule" ? "border-primary/50 bg-primary/5" : ""}`}>
                      <input type="radio" className="sr-only" checked={sendMode === "schedule"} onChange={() => { setSendMode("schedule"); setBroadcastMedia(null); }} />
                      <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${sendMode === "schedule" ? "border-primary" : "border-muted-foreground/40"}`}>
                        {sendMode === "schedule" && <div className="h-2 w-2 rounded-full bg-primary" />}
                      </div>
                      <Calendar className="h-3.5 w-3.5" />
                      Agendar
                    </label>
                  </div>

                  {sendMode === "schedule" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Data e hora do envio</Label>
                      <Input
                        type="datetime-local"
                        value={scheduledAt}
                        onChange={(e) => setScheduledAt(e.target.value)}
                        min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                      />
                    </div>
                  )}
                </div>

                {/* Warning when offline */}
                {!isOnline && (
                  <div className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-sm text-warning">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    WhatsApp offline. Conecte na aba <strong>Conexão</strong> antes de enviar.
                  </div>
                )}

                <Button
                  className="w-full gap-2"
                  onClick={() => void handleSend()}
                  disabled={!canSend || isSending || isScheduling}
                >
                  {isSending || isScheduling ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : sendMode === "now" ? (
                    <Send className="h-4 w-4" />
                  ) : (
                    <Calendar className="h-4 w-4" />
                  )}
                  {isSending ? "Enviando..." : isScheduling ? "Agendando..." : sendMode === "now" ? "Enviar agora" : "Agendar envio"}
                  {recipientCount !== null && ` (${recipientCount} dest.)`}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Tab: Histórico ───────────────────────────────────────────── */}
          <TabsContent value="history" className="mt-5">
            <Card>
              <CardHeader className="flex-row items-center justify-between pb-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Clock className="h-4 w-4" />
                    Histórico de envios
                  </CardTitle>
                  <CardDescription>Últimos 50 broadcasts criados</CardDescription>
                </div>
                <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => refetchHistory()} disabled={isLoadingHistory}>
                  {isLoadingHistory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Atualizar
                </Button>
              </CardHeader>
              <CardContent>
                {isLoadingHistory && <InlineLoadingState label="Carregando histórico..." />}

                {!isLoadingHistory && broadcasts.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <MessageSquare className="h-10 w-10 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">Nenhum broadcast enviado ainda.</p>
                  </div>
                )}

                {!isLoadingHistory && broadcasts.length > 0 && (
                  <div className="divide-y">
                    {broadcasts.map((b) => (
                      <div key={b.id} className="py-3.5 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1 space-y-1.5">
                            {b.message ? (
                              <p className="line-clamp-2 text-sm leading-snug">{b.message}</p>
                            ) : (
                              <p className="text-sm italic text-muted-foreground">Somente mídia</p>
                            )}
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Users className="h-3 w-3" />
                                <strong className="text-foreground">{b.sent_count ?? 0}</strong>/{b.total_recipients ?? 0}
                                {b.failed_count > 0 && (
                                  <span className="text-destructive">({b.failed_count} falhas)</span>
                                )}
                              </span>
                              <span>
                                {b.status === "scheduled" && b.scheduled_at
                                  ? `Agendado: ${new Date(b.scheduled_at).toLocaleString("pt-BR")}`
                                  : b.completed_at
                                    ? new Date(b.completed_at).toLocaleString("pt-BR")
                                    : new Date(b.created_at).toLocaleString("pt-BR")}
                              </span>
                            </div>
                            {b.filter_plan && b.filter_plan.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {b.filter_plan.map((pid) => (
                                  <Badge key={pid} variant="outline" className="h-4 px-1.5 text-[10px]">
                                    {pid.replace("plan-", "")}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            {broadcastStatusBadge(b.status)}
                            {b.status === "scheduled" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => setCancelConfirmId(b.id)}
                                disabled={isCancelling}
                              >
                                <Ban className="h-3 w-3" />
                                Cancelar
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {/* ── QR Dialog ───────────────────────────────────────────────────────── */}
      <Dialog open={showQrDialog} onOpenChange={setShowQrDialog}>
        <DialogContent className="max-h-[92dvh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{session?.status === "online" ? "WhatsApp conectado!" : "Escanear QR Code"}</DialogTitle>
            <DialogDescription>
              {session?.status === "online" ? "O WhatsApp do sistema está online." : "Use o WhatsApp no celular para ler o QR Code abaixo."}
            </DialogDescription>
          </DialogHeader>
          {renderQrContent()}
          <div className="flex justify-end gap-2 pt-2">
            {session?.status === "online" ? (
              <Button className="w-full" onClick={() => setShowQrDialog(false)}>
                <CheckCircle2 className="mr-2 h-4 w-4" />Concluir
              </Button>
            ) : session?.status === "warning" ? (
              <>
                <Button variant="outline" onClick={() => setShowQrDialog(false)}>Fechar</Button>
                <Button onClick={() => void handleConnect()} disabled={isConnecting}>
                  {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Tentar novamente"}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setShowQrDialog(false)}>Cancelar</Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ──────────────────────────────────────────────────── */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover WhatsApp do sistema?</AlertDialogTitle>
            <AlertDialogDescription>
              A sessão será desconectada e removida. Você poderá conectar novamente depois.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleDelete()}
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Cancel broadcast confirm ────────────────────────────────────────── */}
      <AlertDialog open={cancelConfirmId !== null} onOpenChange={(open) => { if (!open) setCancelConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar broadcast agendado?</AlertDialogTitle>
            <AlertDialogDescription>
              O envio agendado será cancelado. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (cancelConfirmId) {
                  await cancelBroadcast(cancelConfirmId);
                  setCancelConfirmId(null);
                }
              }}
            >
              {isCancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cancelar broadcast"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
