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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ShoppingCart, Loader2, Trash2, RefreshCw, CheckCircle2, AlertCircle, Clock, Plus, Download, PlugZap, ChevronDown } from "lucide-react";
import { useMercadoLivreSessions, type MeliSession, type MeliSessionStatus } from "@/hooks/useMercadoLivreSessions";
import { useServiceHealth } from "@/hooks/useServiceHealth";
import { useAuth } from "@/contexts/AuthContext";
import { backend } from "@/integrations/backend/client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
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

type BridgeCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  expires?: number;
  sameSite?: "None" | "Lax" | "Strict";
};

const MAX_BRIDGE_COOKIES = 200;
const MAX_BRIDGE_COOKIE_NAME_LENGTH = 128;
const MAX_BRIDGE_COOKIE_VALUE_LENGTH = 8192;
const MAX_BRIDGE_COOKIE_DOMAIN_LENGTH = 255;
const MAX_BRIDGE_COOKIE_PATH_LENGTH = 512;
const BRIDGE_COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BRIDGE_COOKIE_DOMAIN_PATTERN = /^[A-Za-z0-9.-]+$/;
const BRIDGE_ALLOWED_MELI_DOMAINS = new Set([
  "mercadolivre.com.br",
  "www.mercadolivre.com.br",
  "myaccount.mercadolivre.com.br",
  "auth.mercadolivre.com.br",
  "mercadopago.com.br",
  "www.mercadopago.com.br",
  "mercadolibre.com",
  "www.mercadolibre.com",
  "auth.mercadolibre.com",
  "meli.la",
  "www.meli.la",
]);

function normalizeCookieDomain(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

function isAllowedBridgeCookieDomain(domain: string): boolean {
  const host = normalizeCookieDomain(domain).replace(/^www\./, "");
  if (!host) return false;
  if (BRIDGE_ALLOWED_MELI_DOMAINS.has(host)) return true;
  for (const allowed of BRIDGE_ALLOWED_MELI_DOMAINS) {
    if (host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

function normalizeBridgeCookieSameSite(raw: unknown): "None" | "Lax" | "Strict" | undefined {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return undefined;
  if (value === "none") return "None";
  if (value === "strict") return "Strict";
  return "Lax";
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasForbiddenCookieValueChars(value: string): boolean {
  return value.includes(";") || value.includes("\r") || value.includes("\n") || value.includes("\0");
}

function parseIncomingCookies(rawCookies: unknown): BridgeCookie[] {
  const parsed = typeof rawCookies === "string" ? JSON.parse(rawCookies) : rawCookies;
  const rawArray = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies))
      ? (parsed as { cookies: unknown[] }).cookies
      : null;
  if (!rawArray) {
    throw new Error("Formato de cookies invalido. Use { cookies: [...] } ou [...].");
  }
  if (rawArray.length === 0) {
    throw new Error("Nenhum cookie recebido.");
  }
  if (rawArray.length > MAX_BRIDGE_COOKIES) {
    throw new Error(`Quantidade de cookies acima do limite (${MAX_BRIDGE_COOKIES}).`);
  }

  const dedupe = new Set<string>();
  const normalized: BridgeCookie[] = [];
  for (const entry of rawArray) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = String(row.name ?? "").trim();
    const value = String(row.value ?? "");
    const domain = normalizeCookieDomain(row.domain);
    const cookiePath = String(row.path ?? "/").trim() || "/";

    if (!name || !value || !domain) continue;
    if (name.length > MAX_BRIDGE_COOKIE_NAME_LENGTH || !BRIDGE_COOKIE_NAME_PATTERN.test(name)) continue;
    if (value.length > MAX_BRIDGE_COOKIE_VALUE_LENGTH || hasForbiddenCookieValueChars(value)) continue;
    if (hasControlChars(value)) continue;
    if (domain.length > MAX_BRIDGE_COOKIE_DOMAIN_LENGTH || !BRIDGE_COOKIE_DOMAIN_PATTERN.test(domain)) continue;
    if (!isAllowedBridgeCookieDomain(domain)) continue;
    if (
      !cookiePath.startsWith("/")
      || cookiePath.length > MAX_BRIDGE_COOKIE_PATH_LENGTH
      || hasControlChars(cookiePath)
    ) {
      continue;
    }

    const dedupeKey = `${name}::${domain}::${cookiePath}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    const normalizedCookie: BridgeCookie = {
      name,
      value,
      domain,
      path: cookiePath,
      httpOnly: row.httpOnly === true,
      secure: row.secure === true,
    };
    const expires = Number(row.expires);
    if (Number.isFinite(expires) && expires > 0) {
      normalizedCookie.expires = expires;
    }
    const sameSite = normalizeBridgeCookieSameSite(row.sameSite);
    if (sameSite) {
      normalizedCookie.sameSite = sameSite;
    }
    normalized.push(normalizedCookie);
  }

  if (normalized.length === 0) {
    throw new Error("Nao foi possivel extrair cookies validos do Mercado Livre.");
  }

  return normalized;
}

function statusBadge(status: MeliSessionStatus) {
  switch (status) {
    case "active": return <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />Ativa</Badge>;
    case "expired": return <Badge variant="destructive"><AlertCircle className="mr-1 h-3 w-3" />Expirada</Badge>;
    case "untested": return <Badge variant="secondary"><Clock className="mr-1 h-3 w-3" />Ainda não testada</Badge>;
    case "no_affiliate": return <Badge variant="warning"><AlertCircle className="mr-1 h-3 w-3" />Sem afiliado ativo</Badge>;
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
      <Card className="glass">
        <CardContent className="pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <ShoppingCart className="h-4 w-4 shrink-0 text-warning" />
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
                <p className="text-xs text-destructive">{session.errorMessage}</p>
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
            <AlertDialogTitle>Apagar conta?</AlertDialogTitle>
            <AlertDialogDescription>
              A conta <strong>{session.name}</strong> e os cookies salvos vÃ£o ser apagados. NÃ£o hÃ¡ como desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmDelete(false); onDelete(); }} className="bg-destructive">Apagar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function MercadoLivreConfiguracoes() {
  const { sessions, isLoading, testAllSessions, deleteSession, saveSession, refreshSessions } = useMercadoLivreSessions({ enableAutoMonitor: false });
  const { health, isRefreshing: isHealthRefreshing, refresh: refreshHealth } = useServiceHealth("meli");
  const { user } = useAuth();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isRefreshingView, setIsRefreshingView] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [cookiesJson, setCookiesJson] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
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

  const resolveConversionProbeUrl = async (): Promise<string> => {
    const listProbeProduct = async () => {
      const payload = await invokeBackendRpc<{ items?: Array<{ productUrl?: string }> }>("meli-vitrine-list", {
        body: {
          tab: "destaques",
          page: 1,
          limit: 1,
        },
      });
      return String(payload.items?.[0]?.productUrl || "").trim();
    };

    const existingProductUrl = await listProbeProduct();
    if (existingProductUrl) return existingProductUrl;

    await invokeBackendRpc("meli-vitrine-sync", {
      body: {
        source: "meli-configuracoes-test",
      },
    });

    const syncedProductUrl = await listProbeProduct();
    if (syncedProductUrl) return syncedProductUrl;

    throw new Error("NÃ£o foi possÃ­vel obter um produto da vitrine para validar a conversÃ£o.");
  };

  const validateLinkConversion = async () => {
    const productUrl = await resolveConversionProbeUrl();
    const conversion = await invokeBackendRpc<{ affiliateLink?: string }>("meli-convert-link", {
      body: {
        url: productUrl,
        source: "meli-configuracoes-test",
      },
    });

    const affiliateLink = String(conversion.affiliateLink || "").trim();
    if (!affiliateLink) {
      throw new Error("ConversÃ£o de link retornou vazio.");
    }
  };

  const handleRefreshView = async () => {
    setIsRefreshingView(true);
    try {
      await refreshSessions();
      const status = await refreshHealth();

      if (status?.online === false && status.error) {
        toast.warning("PÃ¡gina atualizada com alerta", {
          description: status.error,
        });
      } else {
        toast.success("PÃ¡gina atualizada", {
          description: "Contas e status recarregados sem recarregar a pÃ¡gina inteira.",
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "NÃ£o foi possÃ­vel atualizar os dados da pÃ¡gina");
    } finally {
      setIsRefreshingView(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTestingConnection(true);
    try {
      const status = await refreshHealth();
      if (!status?.online) {
        toast.error(status?.error || "ServiÃ§o Mercado Livre fora do ar");
        return;
      }

      if (sessions.length === 0) {
        toast.error("ConexÃ£o incompleta", {
          description: "ServiÃ§o online, mas nÃ£o hÃ¡ nenhuma conta de cookies. Adicione uma para continuar.",
        });
        return;
      }

      const results = await testAllSessions({ silent: false });
      const activeCount = results.filter((result) => result.status === "active").length;
      const noAffiliateCount = results.filter((result) => result.status === "no_affiliate").length;
      const problemCount = results.filter((result) => ["expired", "error", "not_found"].includes(result.status)).length;

      if (activeCount === 0) {
        const details = noAffiliateCount > 0
          ? "Conta encontrada, mas sem acesso ao programa de afiliados."
          : "Conta de cookies encontrada, mas nÃ£o estÃ¡ funcionando.";
        toast.error("ConexÃ£o incompleta", {
          description: `${details} Atualize os cookies em ConfiguraÃ§Ãµes ML.`,
        });
        return;
      }

      try {
        await validateLinkConversion();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao validar conversÃ£o";
        toast.error("ConexÃ£o parcial", {
          description: `Cookies autenticam, mas a conversÃ£o de link falhou: ${message}`,
        });
        return;
      }

      if (problemCount > 0) {
        toast.warning("ConexÃ£o testada com alertas", {
          description: `${activeCount} ativa(s), ${problemCount} com problema. ConversÃ£o validada.`,
        });
      } else if (noAffiliateCount > 0) {
        toast.warning("ConexÃ£o testada com alertas", {
          description: `${activeCount} ativa(s), ${noAffiliateCount} sem programa de afiliados. ConversÃ£o validada.`,
        });
      } else {
        toast.success("ConexÃ£o OK!", {
          description: `${activeCount} conta(s) ativa(s) e conversÃ£o de link validada.`,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "NÃ£o foi possÃ­vel testar a conexÃ£o");
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleCreateSession = async () => {
    if (!sessionName.trim()) {
      toast.error("DÃª um nome para a conta");
      return;
    }
    if (!cookiesJson.trim()) {
      toast.error("Cole o JSON de cookies");
      return;
    }

    setIsCreating(true);
    try {
      const targetSessionId = String(sessions[0]?.id || "").trim() || buildSessionId();
      await saveSession({
        sessionId: targetSessionId,
        name: sessionName.trim(),
        cookies: cookiesJson.trim(),
      });
      toast.success("Conta adicionada!");
      setIsCreateOpen(false);
      resetCreateForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "NÃ£o foi possÃ­vel adicionar a conta");
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
        // Security: do NOT include bridgeToken in the PING response.
        // Any JS on the same origin can listen to window.message and capture tokens
        // from PING responses â€” the extension already holds the token from the initial
        // bootstrap handshake and must include it in every subsequent request.
        postBridgeResponse({
          source: "autolinks-page-bridge",
          type: "AUTOLINKS_PING_RESULT",
          requestId: data.requestId,
          ok: true,
          message: "Bridge ativo na pÃ¡gina de ConfiguraÃ§Ãµes ML.",
          payload: { path: window.location.pathname },
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
          message: "Canal da extensÃ£o invÃ¡lido. Reabra ConfiguraÃ§Ãµes ML e tente novamente.",
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
            ? `Login confirmado para ${user?.email || "usuÃ¡rio"}.`
            : "FaÃ§a login no Autolinks antes de importar cookies pela extensÃ£o.",
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
          message: "VocÃª precisa estar logado no Autolinks para enviar cookies.",
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
              "Os cookies parecem ser de outra conta Mercado Livre. Remova a sessÃ£o atual antes de conectar outra conta.",
            );
          }

          const suggestedName = String(data.payload?.suggestedName || "").trim();
          const finalName = suggestedName || "Conta principal";
          const sessionId = String(sessions[0]?.id || "").trim() || buildSessionId();

          await saveSession({
            sessionId,
            name: finalName,
            cookies: JSON.stringify({ cookies: cookieArray }),
          });

          toast.success("Cookies recebidos da extensÃ£o", {
            description: "SessÃ£o salva com sucesso. VocÃª jÃ¡ pode testar a conexÃ£o.",
          });

          postBridgeResponse({
            source: "autolinks-page-bridge",
            type: "AUTOLINKS_PUSH_COOKIES_RESULT",
            requestId: data.requestId,
            ok: true,
            message: "SessÃ£o salva com sucesso no Autolinks.",
            payload: { sessionId },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Falha ao salvar sessÃ£o enviada pela extensÃ£o.";
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
        title="ConfiguraÃ§Ãµes ML"
        description="Conecte e veja sua conta do Mercado Livre"
      >
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void handleRefreshView()} disabled={isRefreshingView}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isRefreshingView ? "animate-spin" : ""}`} />
            Atualizar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleTestConnection()}
            disabled={isHealthRefreshing || isTestingConnection}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${(isHealthRefreshing || isTestingConnection) ? "animate-spin" : ""}`} />
            Testar conexÃ£o
          </Button>
        </div>
      </PageHeader>

      {health && !health.online && health.error ? (
        <Card className="glass border-destructive/30">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{health.error}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card className="glass">
        <CardHeader>
          <div>
            <CardTitle>Contas</CardTitle>
            <CardDescription>SÃ³ pode ter 1 conta ativa por vez</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <InlineLoadingState label="Carregando contas Mercado Livre..." className="py-10" />
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
              <ShoppingCart className="h-10 w-10 opacity-40" />
              <p className="text-sm">Nenhuma conta conectada</p>
              <p className="text-xs">Use a extensÃ£o AutoLinks para conectar sua conta.</p>
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

      {/* Guide Instructions */}
      <Collapsible open={guideOpen} onOpenChange={setGuideOpen}>
        <Card className="glass">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer select-none hover:bg-muted/40 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <PlugZap className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle className="text-base">ExtensÃ£o AutoLinks - Mercado Livre</CardTitle>
                    <CardDescription className="text-xs mt-0.5">
                      FaÃ§a login na extensÃ£o e envie os cookies direto para sua conta, sem copiar e colar JSON
                    </CardDescription>
                  </div>
                </div>
                <ChevronDown
                  className={`h-5 w-5 text-muted-foreground transition-transform duration-300 shrink-0 ${
                    guideOpen ? "rotate-180" : ""
                  }`}
                />
              </div>
            </CardHeader>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="border-t space-y-6 pt-6 bg-muted/20">
              <Button asChild className="w-full">
                <a href="/downloads/autolinks-mercado-livre.zip" download="AutoLinks - Mercado Livre.zip">
                  <Download className="mr-1.5 h-4 w-4" />
                  Baixar extensÃ£o (.zip)
                </a>
              </Button>

              <div className="relative flex gap-5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                  1
                </div>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p className="text-sm font-semibold">Baixe a extensÃ£o</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Clique no botÃ£o acima para fazer o download do arquivo da extensÃ£o AutoLinks.
                  </p>
                </div>
              </div>

              <div className="relative flex gap-5">
                <div className="absolute left-4 top-0 bottom-12 w-px bg-border/40" />
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                  2
                </div>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p className="text-sm font-semibold">Extraia o arquivo</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Extraia o arquivo .zip em uma pasta do seu computador. SerÃ¡ criada uma pasta com os arquivos da extensÃ£o.
                  </p>
                </div>
              </div>

              <div className="relative flex gap-5">
                <div className="absolute left-4 top-0 bottom-12 w-px bg-border/40" />
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                  3
                </div>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p className="text-sm font-semibold">Ative o Modo do Desenvolvedor</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Abra <code className="bg-muted px-1 py-0.5 rounded text-xs">chrome://extensions</code> no navegador e ative o <strong>Modo do desenvolvedor</strong> no canto superior direito.
                  </p>
                </div>
              </div>

              <div className="relative flex gap-5">
                <div className="absolute left-4 top-0 bottom-12 w-px bg-border/40" />
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                  4
                </div>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p className="text-sm font-semibold">Carregue a extensÃ£o</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Clique em <strong>Carregar sem compactaÃ§Ã£o</strong> e selecione a pasta onde vocÃª extraiu a extensÃ£o.
                  </p>
                </div>
              </div>

              <div className="relative flex gap-5">
                <div className="absolute left-4 top-0 bottom-12 w-px bg-border/40" />
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                  5
                </div>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p className="text-sm font-semibold">Abra o Mercado Livre</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Abra uma nova aba do Mercado Livre e faÃ§a login na conta que vocÃª deseja conectar ao AutoLinks.
                  </p>
                </div>
              </div>

              <div className="relative flex gap-5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                  6
                </div>
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <p className="text-sm font-semibold">Envie os cookies</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Na extensÃ£o, clique em <strong>Entrar</strong> e depois em <strong>Capturar e enviar cookies</strong>. Pronto! Sua conta serÃ¡ adicionada automaticamente aqui.
                  </p>
                </div>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

    </div>
  );
}

