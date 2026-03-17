import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { StatusIndicator } from "@/components/StatusIndicator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquareText,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  SquarePen,
  Trash2,
  Unplug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPhoneDisplay, validatePhone } from "@/lib/phone-utils";
import type { SessionStatus, TelegramSession } from "@/lib/types";
import { formatBRT } from "@/lib/timezone";
import { InputTelefone } from "@/components/conexoes/InputTelefone";
import { toast } from "sonner";
import { InlineLoadingState } from "@/components/InlineLoadingState";

interface CreateSessionPayload {
  name: string;
  phone: string;
}

interface VerifyCodePayload {
  sessionId: string;
  code: string;
}

interface VerifyPasswordPayload {
  sessionId: string;
  password: string;
}

interface Props {
  sessions: TelegramSession[];
  isLoading?: boolean;
  isCreating?: boolean;
  isSendingCode?: boolean;
  isVerifyingCode?: boolean;
  isVerifyingPassword?: boolean;
  isDisconnecting?: boolean;
  isUpdatingName?: boolean;
  isDeleting?: boolean;
  onCreateSession: (payload: CreateSessionPayload) => Promise<string>;
  onConnect: (sessionId: string) => Promise<unknown>;
  onVerifyCode: (payload: VerifyCodePayload) => Promise<unknown>;
  onVerifyPassword: (payload: VerifyPasswordPayload) => Promise<unknown>;
  onDisconnect: (sessionId: string) => Promise<unknown>;
  onUpdateName: (sessionId: string, name: string) => Promise<unknown>;
  onDeleteSession: (sessionId: string) => Promise<unknown>;
  onRefresh: () => void;
}

type SessionFlowStep = "form" | "auth";

export function SessoesTelegram({
  sessions,
  isLoading,
  isCreating,
  isSendingCode,
  isVerifyingCode,
  isVerifyingPassword,
  isDisconnecting,
  isUpdatingName,
  isDeleting,
  onCreateSession,
  onConnect,
  onVerifyCode,
  onVerifyPassword,
  onDisconnect,
  onUpdateName,
  onDeleteSession,
  onRefresh,
}: Props) {
  const [isSessionFlowOpen, setIsSessionFlowOpen] = useState(false);
  const [sessionFlowStep, setSessionFlowStep] = useState<SessionFlowStep>("form");

  const [sessionName, setSessionName] = useState("");
  const [sessionPhone, setSessionPhone] = useState("");
  const [authSessionId, setAuthSessionId] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [authPassword, setAuthPassword] = useState("");

  const [editSessionId, setEditSessionId] = useState<string | null>(null);
  const [editSessionName, setEditSessionName] = useState("");
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);

  const previousStatusRef = useRef<Record<string, SessionStatus>>({});

  const phoneValidation = validatePhone(sessionPhone);
  const canCreate = sessionName.trim().length > 0 && phoneValidation.valid && !isCreating;

  const authSession = useMemo(
    () => sessions.find((s) => s.id === authSessionId) || null,
    [sessions, authSessionId],
  );

  const editSession = useMemo(
    () => sessions.find((s) => s.id === editSessionId) || null,
    [sessions, editSessionId],
  );

  const deleteSession = useMemo(
    () => sessions.find((s) => s.id === deleteSessionId) || null,
    [sessions, deleteSessionId],
  );

  // Toast on disconnect
  useEffect(() => {
    for (const session of sessions) {
      const previous = previousStatusRef.current[session.id];
      if (previous === "online" && ["warning", "offline"].includes(session.status)) {
        toast.warning(`Sessão ${session.name} perdeu conexão. Verifique a autenticação.`);
      }
      previousStatusRef.current[session.id] = session.status;
    }
    for (const knownId of Object.keys(previousStatusRef.current)) {
      if (!sessions.some((s) => s.id === knownId)) {
        delete previousStatusRef.current[knownId];
      }
    }
  }, [sessions]);

  // Poll while waiting for auth
  useEffect(() => {
    if (!(isSessionFlowOpen && sessionFlowStep === "auth" && authSession)) return;
    const shouldPoll = authSession.status !== "online";
    if (!shouldPoll) return;
    const interval = window.setInterval(() => onRefresh(), 1500);
    return () => window.clearInterval(interval);
  }, [isSessionFlowOpen, sessionFlowStep, authSession, onRefresh]);

  const resetSessionFlow = () => {
    setSessionFlowStep("form");
    setSessionName("");
    setSessionPhone("");
    setAuthSessionId(null);
    setAuthCode("");
    setAuthPassword("");
  };

  const openCreateFlow = () => {
    resetSessionFlow();
    setIsSessionFlowOpen(true);
  };

  const openAuthFlowForSession = async (session: TelegramSession) => {
    setAuthSessionId(session.id);
    setSessionFlowStep("auth");
    setIsSessionFlowOpen(true);
    if (["offline", "warning"].includes(session.status)) {
      await onConnect(session.id).catch(() => undefined);
    }
    onRefresh();
  };

  const handleCreateSession = async () => {
    if (!canCreate) return;
    try {
      const createdId = await onCreateSession({
        name: sessionName.trim(),
        phone: sessionPhone,
      });
      setAuthSessionId(createdId);
      setSessionFlowStep("auth");
      await onConnect(createdId);
      onRefresh();
    } catch {
      // handled by mutation toast
    }
  };

  const handleVerifyCode = async () => {
    if (!authSessionId || !authCode.trim()) return;
    try {
      await onVerifyCode({ sessionId: authSessionId, code: authCode.trim() });
      setAuthCode("");
      onRefresh();
    } catch {
      // handled by mutation toast
    }
  };

  const handleVerifyPassword = async () => {
    if (!authSessionId || !authPassword.trim()) return;
    try {
      await onVerifyPassword({ sessionId: authSessionId, password: authPassword });
      setAuthPassword("");
      onRefresh();
    } catch {
      // handled by mutation toast
    }
  };

  const handleReconnect = async () => {
    if (!authSessionId) return;
    try {
      await onConnect(authSessionId);
      onRefresh();
    } catch {
      // handled by mutation toast
    }
  };

  const openEditDialog = (session: TelegramSession) => {
    setEditSessionId(session.id);
    setEditSessionName(session.name);
  };

  const handleUpdateSessionName = async () => {
    if (!editSession) return;
    const nextName = editSessionName.trim();
    if (!nextName) {
      toast.error("Informe um nome válido");
      return;
    }
    if (nextName === editSession.name) {
      setEditSessionId(null);
      return;
    }
    try {
      await onUpdateName(editSession.id, nextName);
      setEditSessionId(null);
    } catch {
      // handled by mutation toast
    }
  };

  const handleDeleteSession = async () => {
    if (!deleteSessionId) return;
    try {
      await onDeleteSession(deleteSessionId);
      if (authSessionId === deleteSessionId) {
        setIsSessionFlowOpen(false);
        resetSessionFlow();
      }
      setDeleteSessionId(null);
    } catch {
      // handled by mutation toast
    }
  };

  // ── Auth step content ──────────────────────────────────────────────────────
  const renderAuthStep = () => {
    if (!authSession) return null;

    if (authSession.status === "online") {
      return (
        <div className="flex flex-col items-center gap-5 py-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-success/15">
            <CheckCircle2 className="h-10 w-10 text-success" />
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold">Sessão conectada!</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {authSession.name} está autenticada e monitorada automaticamente.
            </p>
            {authSession.connectedAt && (
              <p className="mt-2 flex items-center justify-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                Conectado desde {formatBRT(authSession.connectedAt, "dd/MM 'às' HH:mm")}
              </p>
            )}
          </div>
        </div>
      );
    }

    if (authSession.status === "warning") {
      return (
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-warning/15">
            <AlertTriangle className="h-8 w-8 text-warning" />
          </div>
          <div className="text-center">
            <p className="font-semibold">Não foi possível iniciar a autenticação</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Verifique se o número está correto e tente novamente.
            </p>
          </div>
        </div>
      );
    }

    if (authSession.status === "awaiting_code") {
      return (
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-info/15">
            <MessageSquareText className="h-8 w-8 text-info" />
          </div>
          <div className="w-full space-y-3">
            <div className="text-center">
              <p className="font-semibold">Código enviado via SMS / Telegram</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Verifique suas mensagens e cole o código abaixo.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tg-auth-code">Código de autenticação</Label>
              <Input
                id="tg-auth-code"
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
                placeholder="Ex: 12345"
                className="h-10 text-center text-lg tracking-widest"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && authCode.trim() && void handleVerifyCode()}
              />
            </div>
          </div>
        </div>
      );
    }

    if (authSession.status === "awaiting_password") {
      return (
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-8 w-8 text-primary" />
          </div>
          <div className="w-full space-y-3">
            <div className="text-center">
              <p className="font-semibold">Verificação em duas etapas</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Sua conta tem 2FA ativado. Informe a senha para concluir.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tg-auth-password">Senha 2FA</Label>
              <Input
                id="tg-auth-password"
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder="Senha de verificação em duas etapas"
                className="h-10"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && authPassword.trim() && void handleVerifyPassword()}
              />
            </div>
          </div>
        </div>
      );
    }

    // connecting / offline / fallback → spinner
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <div className="text-center">
          <p className="font-semibold">Enviando código via SMS…</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Aguardando resposta do Telegram. Isso pode levar alguns segundos.
          </p>
        </div>
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* Header bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-relaxed text-muted-foreground sm:max-w-[70%]">
          Conecte sessões Telegram por SMS/código. Se sua conta tiver 2FA, o campo de senha aparece automaticamente.
        </p>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={onRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
            Atualizar
          </Button>
          <Button size="sm" className="h-9 gap-1.5" onClick={openCreateFlow}>
            <Plus className="h-3.5 w-3.5" />
            Nova Sessão
          </Button>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <InlineLoadingState label="Carregando sessões Telegram..." />
      )}

      {/* Empty */}
      {!isLoading && sessions.length === 0 && (
        <EmptyState
          icon={MessageSquareText}
          title="Nenhuma sessão Telegram"
          description="Crie uma sessão para autenticar por código SMS e 2FA (quando habilitado)."
          actionLabel="Nova Sessão"
          onAction={openCreateFlow}
        />
      )}

      {/* Sessions list */}
      {!isLoading && sessions.length > 0 && (
        <div className="space-y-4">
          {sessions.map((session) => {
            const isOnline = session.status === "online";
            const isBusy = ["connecting", "awaiting_code", "awaiting_password"].includes(session.status);

            return (
              <Card
                key={session.id}
                className={cn(
                  "overflow-hidden border-border/70 bg-card/90 transition-all",
                  isOnline && "ring-1 ring-success/30",
                )}
              >
                <div
                  className={cn(
                    "h-1 w-full",
                    isOnline
                      ? "bg-success"
                      : isBusy
                        ? "bg-info"
                        : session.status === "warning"
                          ? "bg-warning"
                          : "bg-muted-foreground/20",
                  )}
                />

                <CardContent className="p-4 sm:p-5">
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-5">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center justify-center gap-2 md:justify-start">
                        <p className="truncate text-base font-semibold">{session.name}</p>
                        {isOnline ? (
                          <Badge variant="success" className="text-2xs">
                            <Clock className="mr-1 h-3 w-3" />
                            {session.connectedAt
                              ? `Conectado desde ${formatBRT(session.connectedAt, "dd/MM 'às' HH:mm")}`
                              : "Conectado"}
                          </Badge>
                        ) : (
                          <StatusIndicator status={session.status} />
                        )}
                        {session.status === "awaiting_code" && (
                          <Badge variant="info" className="text-2xs">
                            Aguardando código
                          </Badge>
                        )}
                        {session.status === "awaiting_password" && (
                          <Badge className="border-primary/20 bg-primary/10 text-2xs text-primary">
                            Aguardando 2FA
                          </Badge>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground md:justify-start">
                        <p>
                          {session.phoneNumber
                            ? formatPhoneDisplay(session.phoneNumber)
                            : "Número não informado"}
                        </p>
                      </div>

                      {session.errorMessage && (
                        <p className="flex items-center justify-center gap-1 text-center text-xs text-destructive md:justify-start md:text-left">
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          {session.errorMessage}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col items-stretch gap-2 md:items-end">
                      <div className="flex flex-wrap items-center justify-center gap-2 md:justify-end">
                        {!isOnline && (
                          <Button
                            size="sm"
                            className="h-8 min-w-[120px] gap-1.5 text-xs"
                            onClick={() => void openAuthFlowForSession(session)}
                            disabled={isSendingCode}
                          >
                            {isSendingCode ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Phone className="h-3 w-3" />
                            )}
                            {isBusy ? "Ver autenticação" : "Conectar"}
                          </Button>
                        )}

                        {(isOnline || isBusy) && (
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-8 min-w-[120px] gap-1.5 text-xs"
                            onClick={() => void onDisconnect(session.id).catch(() => undefined)}
                            disabled={isDisconnecting}
                          >
                            {isDisconnecting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Unplug className="h-3 w-3" />
                            )}
                            Desconectar
                          </Button>
                        )}
                      </div>

                      <div className="flex items-center justify-center gap-1 md:justify-end">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => openEditDialog(session)}
                          title="Editar nome"
                        >
                          <SquarePen className="h-3.5 w-3.5" />
                        </Button>

                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive"
                          onClick={() => setDeleteSessionId(session.id)}
                          title="Apagar sessão"
                          disabled={isDeleting}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Nova Sessão / Auth modal ──────────────────────────────────────── */}
      <Dialog
        open={isSessionFlowOpen}
        onOpenChange={(open) => {
          setIsSessionFlowOpen(open);
          if (!open) resetSessionFlow();
        }}
      >
        <DialogContent className="max-h-[92dvh] max-w-md overflow-y-auto">
          {sessionFlowStep === "form" ? (
            <>
              <DialogHeader>
                <DialogTitle>Nova sessão Telegram</DialogTitle>
                <DialogDescription>
                  Informe o nome e o número de telefone. Um código será enviado via SMS para autenticação.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="tg-session-name">Nome da sessão</Label>
                  <Input
                    id="tg-session-name"
                    value={sessionName}
                    onChange={(e) => setSessionName(e.target.value)}
                    placeholder="Ex: Telegram principal"
                    className="h-10"
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && sessionPhone && canCreate && void handleCreateSession()}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Telefone (com DDD e código do país)</Label>
                  <InputTelefone
                    value={sessionPhone}
                    onChange={setSessionPhone}
                    placeholder="+55 11 99999-9999"
                  />
                  {!phoneValidation.valid && sessionPhone.length > 3 && (
                    <p className="text-xs text-destructive">{phoneValidation.error}</p>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsSessionFlowOpen(false);
                    resetSessionFlow();
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={() => void handleCreateSession()}
                  disabled={!canCreate || isSendingCode}
                >
                  {isCreating || isSendingCode ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Enviar código SMS"
                  )}
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {authSession?.status === "online"
                    ? "Sessão conectada com sucesso"
                    : authSession?.status === "awaiting_password"
                      ? "Verificação em duas etapas"
                      : "Autentique sua conta"}
                </DialogTitle>
                <DialogDescription>
                  {authSession?.status === "online"
                    ? `${authSession.name} está pronta para uso.`
                    : authSession?.status === "awaiting_password"
                      ? "Informe a senha do 2FA para concluir a conexão."
                      : "Cole o código recebido via SMS ou pelo aplicativo Telegram."}
                </DialogDescription>
              </DialogHeader>

              {renderAuthStep()}

              <div className="flex justify-end gap-2 pt-2">
                {authSession?.status === "online" ? (
                  <Button
                    className="w-full"
                    onClick={() => {
                      setIsSessionFlowOpen(false);
                      resetSessionFlow();
                      onRefresh();
                    }}
                  >
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Concluir
                  </Button>
                ) : authSession?.status === "awaiting_code" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => void handleReconnect()}
                      disabled={isSendingCode}
                    >
                      {isSendingCode ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reenviar SMS"}
                    </Button>
                    <Button
                      onClick={() => void handleVerifyCode()}
                      disabled={!authCode.trim() || isVerifyingCode}
                    >
                      {isVerifyingCode ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Validar código"
                      )}
                    </Button>
                  </>
                ) : authSession?.status === "awaiting_password" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setIsSessionFlowOpen(false);
                        resetSessionFlow();
                      }}
                    >
                      Cancelar
                    </Button>
                    <Button
                      onClick={() => void handleVerifyPassword()}
                      disabled={!authPassword.trim() || isVerifyingPassword}
                    >
                      {isVerifyingPassword ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Validar 2FA"
                      )}
                    </Button>
                  </>
                ) : authSession?.status === "warning" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setIsSessionFlowOpen(false);
                        resetSessionFlow();
                      }}
                    >
                      Fechar
                    </Button>
                    <Button
                      onClick={() => void handleReconnect()}
                      disabled={isSendingCode}
                    >
                      {isSendingCode ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Tentar novamente"
                      )}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsSessionFlowOpen(false);
                      resetSessionFlow();
                    }}
                  >
                    Cancelar
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Editar nome ───────────────────────────────────────────────────── */}
      <Dialog open={!!editSession} onOpenChange={(open) => !open && setEditSessionId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Editar sessão</DialogTitle>
            <DialogDescription>
              Apenas o nome pode ser editado para não quebrar a autenticação.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Nome da sessão</Label>
              <Input
                className="h-10"
                value={editSessionName}
                onChange={(e) => setEditSessionName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleUpdateSessionName()}
              />
            </div>
            <div className="space-y-2">
              <Label>Telefone</Label>
              <Input
                className="h-10"
                value={
                  editSession?.phoneNumber
                    ? formatPhoneDisplay(editSession.phoneNumber)
                    : "Não informado"
                }
                readOnly
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditSessionId(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleUpdateSessionName()} disabled={isUpdatingName}>
              {isUpdatingName ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Confirmar exclusão ────────────────────────────────────────────── */}
      <AlertDialog open={!!deleteSession} onOpenChange={(open) => !open && setDeleteSessionId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar sessão?</AlertDialogTitle>
            <AlertDialogDescription>
              A sessão <strong>{deleteSession?.name}</strong> será removida junto com os grupos vinculados. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleDeleteSession()}
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apagar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
