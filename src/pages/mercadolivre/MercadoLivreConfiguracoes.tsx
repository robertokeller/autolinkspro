import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ShoppingCart, Loader2, Trash2, RefreshCw, CheckCircle2, AlertCircle, Clock, Plus, Download, PlugZap } from "lucide-react";
import { useMercadoLivreSessions, type MeliSession, type MeliSessionStatus } from "@/hooks/useMercadoLivreSessions";
import { useServiceHealth } from "@/hooks/useServiceHealth";
import { useAuth } from "@/contexts/AuthContext";
import { backend } from "@/integrations/backend/client";
import { formatBRT } from "@/lib/timezone";
import { toast } from "sonner";
import { InlineLoadingState } from "@/components/InlineLoadingState";

type ExtensionBridgeRequest = {
  source: "autolinks-extension";
  type: "AUTOLINKS_PING" | "AUTOLINKS_CHECK_AUTH" | "AUTOLINKS_EXTENSION_LOGIN" | "AUTOLINKS_PUSH_COOKIES";
  requestId: string;
  payload?: {
    cookies?: unknown;
    suggestedName?: string;
    email?: string;
    password?: string;
    bridgeToken?: string;
  };
};

type ExtensionBridgeResponse = {
  source: "autolinks-page-bridge";
  type: "AUTOLINKS_PING_RESULT" | "AUTOLINKS_CHECK_AUTH_RESULT" | "AUTOLINKS_EXTENSION_LOGIN_RESULT" | "AUTOLINKS_PUSH_COOKIES_RESULT";
  requestId: string;
  ok: boolean;
  message: string;
  payload?: Record<string, unknown>;
};

function parseIncomingCookies(rawCookies: unknown): unknown[] {
  const parsed = typeof rawCookies === "string" ? JSON.parse(rawCookies) : rawCookies;
  if (Array.isArray(parsed)) return parsed;

  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies)) {
    return (parsed as { cookies: unknown[] }).cookies;
  }

  throw new Error("Formato de cookies inválido. Use { cookies: [...] } ou [...].");
}

function statusBadge(status: MeliSessionStatus) {
  switch (status) {
    case "active": return <Badge className="bg-green-500 text-white"><CheckCircle2 className="mr-1 h-3 w-3" />Ativa</Badge>;
    case "expired": return <Badge variant="destructive"><AlertCircle className="mr-1 h-3 w-3" />Expirada</Badge>;
    case "untested": return <Badge variant="secondary"><Clock className="mr-1 h-3 w-3" />Não testada</Badge>;
    case "no_affiliate": return <Badge className="bg-orange-500 text-white"><AlertCircle className="mr-1 h-3 w-3" />Sem programa afiliado</Badge>;
    default: return <Badge variant="destructive"><AlertCircle className="mr-1 h-3 w-3" />Erro</Badge>;
  }
}

function SessionCard({ session, onDelete }: {
  session: MeliSession;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <ShoppingCart className="h-4 w-4 shrink-0 text-yellow-500" />
                <span className="truncate font-semibold">{session.name}</span>
                {statusBadge(session.status)}
              </div>
              {session.accountName && (
                <p className="text-sm text-muted-foreground">Conta: <strong>{session.accountName}</strong></p>
              )}
              {session.mlUserId && (
                <p className="font-mono text-xs text-muted-foreground">ID: {session.mlUserId}</p>
              )}
              {session.lastCheckedAt && (
                <p className="text-xs text-muted-foreground">
                  Verificado em: {formatBRT(session.lastCheckedAt, "dd/MM/yyyy HH:mm:ss")}
                </p>
              )}
              {session.errorMessage && session.status !== "active" && (
                <p className="text-xs text-red-500">{session.errorMessage}</p>
              )}
            </div>
            <div className="ml-2 flex shrink-0 gap-2">
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover sessão?</AlertDialogTitle>
            <AlertDialogDescription>
              A sessão <strong>{session.name}</strong> e seus cookies salvos serão removidos permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmDelete(false); onDelete(); }} className="bg-destructive">Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function MercadoLivreConfiguracoes() {
  const { sessions, isLoading, testAllSessions, deleteSession, saveSession } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const { health, isRefreshing: isHealthRefreshing, refresh: refreshHealth } = useServiceHealth("meli");
  const { user } = useAuth();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [cookiesJson, setCookiesJson] = useState("");
  const bridgeTokenRef = useRef("");

  const getBridgeToken = () => {
    if (!bridgeTokenRef.current) {
      bridgeTokenRef.current = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
    return bridgeTokenRef.current;
  };

  const resetCreateForm = () => {
    setSessionName("");
    setCookiesJson("");
  };

  const buildSessionId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // RFC4122-ish fallback for older runtimes.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const randomNibble = Math.floor(Math.random() * 16);
      const value = char === "x" ? randomNibble : ((randomNibble & 0x3) | 0x8);
      return value.toString(16);
    });
  };

  const handleTestConnection = async () => {
    try {
      const status = await refreshHealth();
      if (!status?.online) {
        toast.error(status?.error || "Serviço Mercado Livre indisponível");
        return;
      }

      if (sessions.length === 0) {
        toast.error("Conexão incompleta", {
          description: "Serviço online, mas não há sessão de cookies disponível. Adicione uma sessão para concluir o teste.",
        });
        return;
      }

      const results = await testAllSessions({ silent: false });
      const activeCount = results.filter((result) => result.status === "active").length;
      const noAffiliateCount = results.filter((result) => result.status === "no_affiliate").length;
      const problemCount = results.filter((result) => ["expired", "error", "not_found"].includes(result.status)).length;

      if (activeCount === 0) {
        const details = noAffiliateCount > 0
          ? "Sessão encontrada, mas sem acesso ao programa de afiliados."
          : "Sessão de cookies encontrada, mas não está utilizável.";
        toast.error("Conexão incompleta", {
          description: `${details} Atualize os cookies em Configurações ML.`,
        });
        return;
      }

      if (problemCount > 0) {
        toast.warning("Conexão testada com alertas", {
          description: `${activeCount} ativa(s), ${problemCount} com problema.`,
        });
      } else if (noAffiliateCount > 0) {
        toast.warning("Conexão testada com alertas", {
          description: `${activeCount} ativa(s), ${noAffiliateCount} sem programa de afiliados.`,
        });
      } else {
        toast.success("Conexão validada com sucesso", {
          description: `${activeCount} sessão(ões) ativa(s).`,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao testar conexão");
    }
  };

  const handleCreateSession = async () => {
    if (!sessionName.trim()) {
      toast.error("Informe o nome da sessão");
      return;
    }
    if (!cookiesJson.trim()) {
      toast.error("Cole o JSON de cookies");
      return;
    }

    setIsCreating(true);
    try {
      await saveSession({
        sessionId: buildSessionId(),
        name: sessionName.trim(),
        cookies: cookiesJson.trim(),
      });
      toast.success("Sessão adicionada com sucesso");
      setIsCreateOpen(false);
      resetCreateForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao adicionar sessão");
    } finally {
      setIsCreating(false);
    }
  };

  useEffect(() => {
    const postBridgeResponse = (response: ExtensionBridgeResponse) => {
      window.postMessage(response, window.location.origin);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;

      const data = event.data as ExtensionBridgeRequest | undefined;
      if (!data || data.source !== "autolinks-extension") return;

      if (data.type === "AUTOLINKS_PING") {
        postBridgeResponse({
          source: "autolinks-page-bridge",
          type: "AUTOLINKS_PING_RESULT",
          requestId: data.requestId,
          ok: true,
          message: "Bridge ativo na página de Configurações ML.",
          payload: { path: window.location.pathname, bridgeToken: getBridgeToken() },
        });
        return;
      }

      const incomingToken = String(data.payload?.bridgeToken || "").trim();
      if (!incomingToken || incomingToken !== getBridgeToken()) {
        postBridgeResponse({
          source: "autolinks-page-bridge",
          type: data.type === "AUTOLINKS_CHECK_AUTH"
            ? "AUTOLINKS_CHECK_AUTH_RESULT"
            : data.type === "AUTOLINKS_EXTENSION_LOGIN"
              ? "AUTOLINKS_EXTENSION_LOGIN_RESULT"
              : "AUTOLINKS_PUSH_COOKIES_RESULT",
          requestId: data.requestId,
          ok: false,
          message: "Canal da extensão inválido. Reabra Configurações ML e tente novamente.",
        });
        return;
      }

      if (data.type === "AUTOLINKS_CHECK_AUTH") {
        const loggedIn = !!user?.id;
        postBridgeResponse({
          source: "autolinks-page-bridge",
          type: "AUTOLINKS_CHECK_AUTH_RESULT",
          requestId: data.requestId,
          ok: loggedIn,
          message: loggedIn
            ? `Login confirmado para ${user?.email || "usuário"}.`
            : "Faça login no Autolinks antes de importar cookies pela extensão.",
          payload: loggedIn ? { email: user?.email || "", userId: user?.id || "" } : undefined,
        });
        return;
      }

      if (data.type === "AUTOLINKS_EXTENSION_LOGIN") {
        const email = String(data.payload?.email || "").trim();
        const password = String(data.payload?.password || "");

        if (!email || !password) {
          postBridgeResponse({
            source: "autolinks-page-bridge",
            type: "AUTOLINKS_EXTENSION_LOGIN_RESULT",
            requestId: data.requestId,
            ok: false,
            message: "Informe e-mail e senha para continuar.",
          });
          return;
        }

        const login = async () => {
          const { data: loginData, error } = await backend.auth.signInWithPassword({ email, password });
          if (error) {
            const raw = String(error.message || "");
            const message = raw === "Invalid login credentials" ? "E-mail ou senha incorretos." : raw;
            postBridgeResponse({
              source: "autolinks-page-bridge",
              type: "AUTOLINKS_EXTENSION_LOGIN_RESULT",
              requestId: data.requestId,
              ok: false,
              message,
            });
            return;
          }

          postBridgeResponse({
            source: "autolinks-page-bridge",
            type: "AUTOLINKS_EXTENSION_LOGIN_RESULT",
            requestId: data.requestId,
            ok: true,
            message: "Login validado com sucesso.",
            payload: {
              email: loginData.user?.email || "",
              userId: loginData.user?.id || "",
            },
          });
        };

        void login();
        return;
      }

      if (data.type !== "AUTOLINKS_PUSH_COOKIES") return;

      if (!user?.id) {
        postBridgeResponse({
          source: "autolinks-page-bridge",
          type: "AUTOLINKS_PUSH_COOKIES_RESULT",
          requestId: data.requestId,
          ok: false,
          message: "Você precisa estar logado no Autolinks para enviar cookies.",
        });
        return;
      }

      const process = async () => {
        try {
          const cookieArray = parseIncomingCookies(data.payload?.cookies);

          const orgUserIdCookie = (cookieArray as Array<{ name?: string; value?: string }>).find((c) => c.name === "orguseridp");
          const incomingMlUserId = String(orgUserIdCookie?.value || "").trim();
          const existingMlUserId = String(sessions[0]?.mlUserId || "").trim();

          if (existingMlUserId && incomingMlUserId && existingMlUserId !== incomingMlUserId) {
            throw new Error(
              "Os cookies parecem ser de outra conta Mercado Livre. Remova a sessão atual antes de conectar outra conta.",
            );
          }

          const suggestedName = String(data.payload?.suggestedName || "").trim();
          const finalName = suggestedName || "Conta principal";
          const sessionId = buildSessionId();

          await saveSession({
            sessionId,
            name: finalName,
            cookies: JSON.stringify({ cookies: cookieArray }),
          });

          toast.success("Cookies recebidos da extensão", {
            description: "Sessão salva com sucesso. Você já pode testar a conexão.",
          });

          postBridgeResponse({
            source: "autolinks-page-bridge",
            type: "AUTOLINKS_PUSH_COOKIES_RESULT",
            requestId: data.requestId,
            ok: true,
            message: "Sessão salva com sucesso no Autolinks.",
            payload: { sessionId },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Falha ao salvar sessão enviada pela extensão.";
          postBridgeResponse({
            source: "autolinks-page-bridge",
            type: "AUTOLINKS_PUSH_COOKIES_RESULT",
            requestId: data.requestId,
            ok: false,
            message,
          });
        }
      };

      void process();
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [saveSession, sessions, user?.email, user?.id]);

  return (
    <div className="ds-page">
      <PageHeader
        title="Configurações ML"
        description="Conecte e gerencie sua conta do Mercado Livre"
      >
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void handleTestConnection()} disabled={isHealthRefreshing}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isHealthRefreshing ? "animate-spin" : ""}`} />
            Testar conexão
          </Button>
        </div>
      </PageHeader>

      {health && !health.online && health.error ? (
        <Card className="border-destructive/30">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{health.error}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <PlugZap className="h-4 w-4 text-primary" />
                Extensão AutoLinks - Mercado Livre
              </CardTitle>
              <CardDescription>
                Capture os cookies automaticamente e envie direto para esta página, sem copiar e colar JSON.
              </CardDescription>
            </div>
            <Button asChild>
              <a href="/downloads/autolinks-mercado-livre.zip" download="AutoLinks - Mercado Livre.zip">
                <Download className="mr-1.5 h-4 w-4" />
                Baixar extensão (.zip)
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p><strong>Como usar (2 minutos):</strong></p>
          <p>1. Baixe o arquivo .zip e extraia em uma pasta do seu computador.</p>
          <p>2. Abra <strong>chrome://extensions</strong> e ative o <strong>Modo do desenvolvedor</strong>.</p>
          <p>3. Clique em <strong>Carregar sem compactação</strong> e selecione a pasta da extensão.</p>
          <p>4. Com esta página de Configurações ML aberta e logada, clique no ícone da extensão.</p>
          <p>5. Na extensão, use <strong>Entrar e validar</strong> e depois <strong>Capturar e enviar cookies</strong>.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Contas</CardTitle>
            <CardDescription>Apenas 1 conta ativa por vez</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <InlineLoadingState label="Carregando contas Mercado Livre..." className="py-10" />
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
              <ShoppingCart className="h-10 w-10 opacity-40" />
              <p className="text-sm">Nenhuma conta conectada</p>
              <p className="text-xs">Use a extensão AutoLinks para conectar sua conta.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onDelete={() => deleteSession(session.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
