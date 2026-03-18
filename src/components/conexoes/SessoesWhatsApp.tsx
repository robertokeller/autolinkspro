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
  Plus,
  QrCode,
  RefreshCw,
  SquarePen,
  Trash2,
  Unplug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPhoneDisplay } from "@/lib/phone-utils";
import type { AuthMethod, SessionStatus, WhatsAppSession } from "@/lib/types";
import { formatBRT } from "@/lib/timezone";
import { toast } from "sonner";
import { InlineLoadingState } from "@/components/InlineLoadingState";

interface CreateSessionPayload {
  name: string;
  phone?: string;
  authMethod: AuthMethod;
}

interface Props {
  sessions: WhatsAppSession[];
  isLoading?: boolean;
  isCreating?: boolean;
  isConnecting?: boolean;
  isDisconnecting?: boolean;
  isUpdatingName?: boolean;
  isDeleting?: boolean;
  onCreateSession: (payload: CreateSessionPayload) => Promise<string>;
  onConnect: (sessionId: string) => Promise<void>;
  onDisconnect: (sessionId: string) => Promise<void>;
  onUpdateName: (sessionId: string, name: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onRefresh: () => void;
}

type SessionFlowStep = "form" | "auth";

export function SessoesWhatsApp({
  sessions,
  isLoading,
  isCreating,
  isConnecting,
  isDisconnecting,
  isUpdatingName,
  isDeleting,
  onCreateSession,
  onConnect,
  onDisconnect,
  onUpdateName,
  onDeleteSession,
  onRefresh,
}: Props) {
  const [isSessionFlowOpen, setIsSessionFlowOpen] = useState(false);
  const [sessionFlowStep, setSessionFlowStep] = useState<SessionFlowStep>("form");

  const [sessionName, setSessionName] = useState("");
  const [authSessionId, setAuthSessionId] = useState<string | null>(null);

  const [editSessionId, setEditSessionId] = useState<string | null>(null);
  const [editSessionName, setEditSessionName] = useState("");

  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);

  const previousStatusRef = useRef<Record<string, SessionStatus>>({});

  const canCreate = sessionName.trim().length > 0 && !isCreating;

  const authSession = useMemo(
    () => sessions.find((session) => session.id === authSessionId) || null,
    [sessions, authSessionId],
  );

  const editSession = useMemo(
    () => sessions.find((session) => session.id === editSessionId) || null,
    [sessions, editSessionId],
  );

  const deleteSession = useMemo(
    () => sessions.find((session) => session.id === deleteSessionId) || null,
    [sessions, deleteSessionId],
  );

  useEffect(() => {
    for (const session of sessions) {
      const previous = previousStatusRef.current[session.id];

      if (previous === "online" && ["warning", "offline"].includes(session.status)) {
        toast.warning(`Sessão ${session.name} desconectou. Confira se está tudo certo.`);
      }

      previousStatusRef.current[session.id] = session.status;
    }

    for (const knownId of Object.keys(previousStatusRef.current)) {
      if (!sessions.some((session) => session.id === knownId)) {
        delete previousStatusRef.current[knownId];
      }
    }
  }, [sessions]);

  // Poll while waiting for QR / connecting
  useEffect(() => {
    if (!(isSessionFlowOpen && sessionFlowStep === "auth" && authSession)) return;

    const shouldPoll =
      authSession.status === "connecting" ||
      authSession.status === "qr_code" ||
      authSession.status === "pairing_code";

    if (!shouldPoll) return;

    const interval = window.setInterval(() => onRefresh(), 1500);
    return () => window.clearInterval(interval);
  }, [isSessionFlowOpen, sessionFlowStep, authSession, onRefresh]);

  const resetSessionFlow = () => {
    setSessionFlowStep("form");
    setSessionName("");
    setAuthSessionId(null);
  };

  const openCreateFlow = () => {
    resetSessionFlow();
    setIsSessionFlowOpen(true);
  };

  const openAuthFlowForSession = async (session: WhatsAppSession) => {
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
        authMethod: "qr",
      });

      setAuthSessionId(createdId);
      setSessionFlowStep("auth");

      await onConnect(createdId);
      onRefresh();
    } catch {
      // handled by mutation toast
    }
  };

  const handleReconnectForAuthSession = async () => {
    if (!authSessionId) return;
    try {
      await onConnect(authSessionId);
      onRefresh();
    } catch {
      // handled by mutation toast
    }
  };

  const openEditDialog = (session: WhatsAppSession) => {
    setEditSessionId(session.id);
    setEditSessionName(session.name);
  };

  const handleUpdateSessionName = async () => {
    if (!editSession) return;

    const nextName = editSessionName.trim();
    if (!nextName) {
      toast.error("Coloque um nome válido");
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
  const renderQrStep = () => {
    if (!authSession) return null;

    if (authSession.status === "online") {
      return (
        <div className="flex flex-col items-center gap-5 py-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-success/15">
            <CheckCircle2 className="h-10 w-10 text-success" />
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold">Tudo certo!</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {authSession.name} está conectada e funcionando.
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
            <p className="font-semibold">Não deu pra gerar o QR Code</p>
            <p className="mt-1 text-sm text-muted-foreground">
              O serviço WhatsApp parece estar fora do ar.
            </p>
          </div>
        </div>
      );
    }

    if (authSession.status === "qr_code" && authSession.qrCode) {
      return (
        <div className="flex flex-col items-center gap-4 py-2">
          <img
            src={authSession.qrCode}
            alt={`QR Code da sessão ${authSession.name}`}
            className="aspect-square w-full max-w-[260px] rounded-xl border bg-white p-2 shadow-md"
          />
          <p className="text-center text-sm text-muted-foreground">
            Abra o WhatsApp no celular → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> e leia o código.
          </p>
        </div>
      );
    }

    // connecting / pairing_code / offline / fallback → loading
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <div className="text-center">
          <p className="font-semibold">Gerando QR Code…</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Esperando resposta do WhatsApp. Pode levar alguns segundos.
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
          Conecte contas WhatsApp por QR Code. A conexão fica sendo monitorada o tempo todo.
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
        <InlineLoadingState label="Carregando contas WhatsApp..." />
      )}

      {/* Empty */}
      {!isLoading && sessions.length === 0 && (
        <EmptyState
          icon={QrCode}
          title="Nenhuma conta WhatsApp"
          description="Crie uma conta e conecte por QR Code."
          actionLabel="Nova conta"
          onAction={openCreateFlow}
        />
      )}

      {/* Sessions list */}
      {!isLoading && sessions.length > 0 && (
        <div className="space-y-4">
          {sessions.map((session) => {
            const isOnline = session.status === "online";
            const isBusy = ["connecting", "qr_code", "pairing_code"].includes(session.status);

            return (
              <Card
                key={session.id}
                className={cn(
                  "glass overflow-hidden transition-all",
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
                    {/* Info */}
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center justify-center gap-2 md:justify-start">
                        <p className="truncate text-base font-semibold">{session.name}</p>
                        {session.isDefault && (
                          <Badge className="border-primary/20 bg-primary/10 text-2xs text-primary">
                            Padrão
                          </Badge>
                        )}
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

                    {/* Actions */}
                    <div className="flex flex-col items-stretch gap-2 md:items-end">
                      <div className="flex flex-wrap items-center justify-center gap-2 md:justify-end">
                        {!isOnline && (
                          <Button
                            size="sm"
                            className="h-8 min-w-[120px] gap-1.5 text-xs"
                            onClick={() => void openAuthFlowForSession(session)}
                            disabled={isConnecting}
                          >
                            {isConnecting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <QrCode className="h-3 w-3" />
                            )}
                            {isBusy ? "Ver QR Code" : "Conectar"}
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

      {/* ── Nova Sessão modal ─────────────────────────────────────────────── */}
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
                <DialogTitle>Nova conta WhatsApp</DialogTitle>
                <DialogDescription>
                  Dê um nome e vamos gerar o QR Code pra você conectar.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="wa-session-name">Nome da sessão</Label>
                  <Input
                    id="wa-session-name"
                    value={sessionName}
                    onChange={(e) => setSessionName(e.target.value)}
                    placeholder="Ex: Celular principal"
                    className="h-10"
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && canCreate && void handleCreateSession()}
                  />
                  <p className="text-xs text-muted-foreground">
                    O número do celular aparece sozinho depois que você conectar pelo QR Code.
                  </p>
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
                  disabled={!canCreate || isConnecting}
                >
                  {isCreating || isConnecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Avançar"
                  )}
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {authSession?.status === "online"
                    ? "Conta conectada!"
                    : "Leia o QR Code"}
                </DialogTitle>
                <DialogDescription>
                  {authSession?.status === "online"
                    ? `${authSession.name} está pronta.`
                    : "Use o WhatsApp no celular pra ler o código."}
                </DialogDescription>
              </DialogHeader>

              {renderQrStep()}

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
                      onClick={() => void handleReconnectForAuthSession()}
                      disabled={isConnecting}
                    >
                      {isConnecting ? (
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
              Só dá pra mudar o nome. O resto fica do jeito que está pra não perder a conexão.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Nome da sessão</Label>
              <Input
                className="h-10"
                value={editSessionName}
                onChange={(e) => setEditSessionName(e.target.value)}
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
            <AlertDialogTitle>Apagar conta?</AlertDialogTitle>
            <AlertDialogDescription>
              A conta <strong>{deleteSession?.name}</strong> e os grupos dela vão ser removidos. Não tem como desfazer.
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
