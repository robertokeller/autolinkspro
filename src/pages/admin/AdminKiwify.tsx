import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Users,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────

interface KiwifyConfig {
  account_id: string;
  client_id_set: boolean;
  client_secret_set: boolean;
  webhook_secret_set: boolean;
  affiliate_enabled: boolean;
  grace_period_days: number;
}

interface KiwifyTransaction {
  id: string;
  kiwify_order_id: string;
  event_type: string;
  status: string;
  plan_id: string | null;
  customer_name: string;
  customer_email: string;
  amount_cents: number;
  created_at: string;
  processed_at: string | null;
  user_id: string | null;
}

interface KiwifyWebhookLog {
  id: string;
  order_id: string | null;
  event_type: string;
  status: string;
  error_message: string | null;
  created_at: string;
}

interface KiwifyAffiliate {
  id: string;
  name: string;
  email: string;
  status: string;
  commission_percent: number;
  sales_count: number;
  total_earned_cents: number;
}

// ─── Tab: Configuração ───────────────────────────────────────────────────────

function ConfigTab() {
  const [config, setConfig] = useState<KiwifyConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Form fields
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [accountId, setAccountId] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [affiliateEnabled, setAffiliateEnabled] = useState(false);
  const [gracePeriodDays, setGracePeriodDays] = useState(3);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invokeBackendRpc<{ config: KiwifyConfig | null }>("admin-kiwify", {
        body: { action: "get_config" },
      });
      if (res?.config) {
        setConfig(res.config);
        setAccountId(res.config.account_id ?? "");
        setAffiliateEnabled(res.config.affiliate_enabled ?? false);
        setGracePeriodDays(res.config.grace_period_days ?? 3);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao carregar configuração");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleSave = async () => {
    if (!clientId && !config?.client_id_set) {
      toast.error("Client ID é obrigatório");
      return;
    }
    if (!clientSecret && !config?.client_secret_set) {
      toast.error("Client Secret é obrigatório");
      return;
    }
    if (!accountId) {
      toast.error("Account ID é obrigatório");
      return;
    }
    setSaving(true);
    try {
      await invokeBackendRpc("admin-kiwify", {
        body: {
          action: "save_config",
          client_id: clientId || undefined,
          client_secret: clientSecret || undefined,
          account_id: accountId,
          webhook_secret: webhookSecret || undefined,
          affiliate_enabled: affiliateEnabled,
          grace_period_days: gracePeriodDays,
        },
      });
      toast.success("Configuração salva com sucesso");
      setClientId("");
      setClientSecret("");
      setWebhookSecret("");
      await loadConfig();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar configuração");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await invokeBackendRpc<{ success: boolean; account: unknown }>("admin-kiwify", {
        body: { action: "test_connection" },
      });
      if (res?.success) {
        toast.success("Conexão com Kiwify estabelecida com sucesso!");
      } else {
        toast.error("Falha na conexão com Kiwify");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao testar conexão");
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status da Integração</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: "Client ID", set: config?.client_id_set },
              { label: "Client Secret", set: config?.client_secret_set },
              { label: "Account ID", set: !!(config?.account_id) },
              { label: "Webhook Secret", set: config?.webhook_secret_set },
            ].map(({ label, set }) => (
              <div key={label} className="flex items-center gap-2">
                {set ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-yellow-500" />
                )}
                <span className="text-sm">{label}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Credenciais Kiwify</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="kw-account-id">Account ID *</Label>
              <Input
                id="kw-account-id"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="Seu Kiwify Account ID"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kw-client-id">
                Client ID {config?.client_id_set && <span className="text-xs text-muted-foreground">(já configurado)</span>}
              </Label>
              <Input
                id="kw-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={config?.client_id_set ? "Deixe em branco para manter" : "Seu Kiwify Client ID"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kw-client-secret">
                Client Secret {config?.client_secret_set && <span className="text-xs text-muted-foreground">(já configurado)</span>}
              </Label>
              <Input
                id="kw-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={config?.client_secret_set ? "Deixe em branco para manter" : "Seu Kiwify Client Secret"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kw-webhook-secret">
                Webhook Secret {config?.webhook_secret_set && <span className="text-xs text-muted-foreground">(já configurado)</span>}
              </Label>
              <Input
                id="kw-webhook-secret"
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={config?.webhook_secret_set ? "Deixe em branco para manter" : "Token secreto dos webhooks"}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="kw-grace">Período de Graça (dias)</Label>
              <Input
                id="kw-grace"
                type="number"
                min={0}
                max={30}
                value={gracePeriodDays}
                onChange={(e) => setGracePeriodDays(Math.max(0, Math.min(30, Number(e.target.value) || 0)))}
              />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <Switch
                id="kw-affiliate"
                checked={affiliateEnabled}
                onCheckedChange={setAffiliateEnabled}
              />
              <Label htmlFor="kw-affiliate">Habilitar sistema de afiliados</Label>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar Configuração
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !config?.client_id_set}>
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Testar Conexão
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">URL do Webhook</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Configure no painel Kiwify para receber notificações de pagamento:
          </p>
          <code className="block rounded bg-muted px-3 py-2 text-sm font-mono">
            {import.meta.env.VITE_API_URL}/webhooks/kiwify
          </code>
          {/localhost|127\.0\.0\.1/.test(import.meta.env.VITE_API_URL ?? "") && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Ambiente local — esta URL não é acessível pela Kiwify. Em produção (deploy), a URL usará o domínio configurado em{" "}
                <code>VITE_API_URL</code> e funcionará normalmente.
              </span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Eventos: <code>compra_aprovada</code>, <code>compra_reembolsada</code>, <code>chargeback</code>, <code>subscription_renewed</code>, <code>subscription_canceled</code>, <code>subscription_late</code>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Tab: Transações ─────────────────────────────────────────────────────────

function TransactionsTab() {
  const [transactions, setTransactions] = useState<KiwifyTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [emailFilter, setEmailFilter] = useState("");

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const res = await invokeBackendRpc<{ transactions: KiwifyTransaction[]; total: number }>("admin-kiwify", {
        body: {
          action: "list_transactions",
          page: p,
          limit: 25,
          customer_email: emailFilter || undefined,
        },
      });
      setTransactions(res?.transactions ?? []);
      setTotal(res?.total ?? 0);
      setPage(p);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao carregar transações");
    } finally {
      setLoading(false);
    }
  }, [emailFilter]);

  useEffect(() => { load(1); }, [load]);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      activated: "bg-green-100 text-green-700",
      pending_activation: "bg-yellow-100 text-yellow-700",
      refunded: "bg-red-100 text-red-700",
      chargeback: "bg-red-100 text-red-700",
      canceled: "bg-gray-100 text-gray-700",
    };
    return (
      <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${map[status] ?? "bg-muted text-muted-foreground"}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="Filtrar por email..."
          value={emailFilter}
          onChange={(e) => setEmailFilter(e.target.value)}
        />
        <Button variant="outline" size="sm" onClick={() => load(1)}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Filtrar
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {["Data", "Evento", "Status", "Cliente", "Plano", "Valor"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted-foreground">
                      Nenhuma transação encontrada
                    </td>
                  </tr>
                ) : transactions.map((t) => (
                  <tr key={t.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(t.created_at).toLocaleDateString("pt-BR")}</td>
                    <td className="px-3 py-2 font-mono text-xs">{t.event_type}</td>
                    <td className="px-3 py-2">{statusBadge(t.status)}</td>
                    <td className="px-3 py-2">
                      <div>{t.customer_name}</div>
                      <div className="text-xs text-muted-foreground">{t.customer_email}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{t.plan_id ?? "—"}</td>
                    <td className="px-3 py-2">
                      {t.amount_cents != null
                        ? (t.amount_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{total} transação(ões) no total</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => load(page - 1)}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" disabled={page * 25 >= total} onClick={() => load(page + 1)}>
                Próxima
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Tab: Afiliados ───────────────────────────────────────────────────────────

function AffiliatesTab() {
  const [affiliates, setAffiliates] = useState<KiwifyAffiliate[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invokeBackendRpc<{ data: KiwifyAffiliate[] }>("admin-kiwify", {
        body: { action: "list_affiliates" },
      });
      setAffiliates(res?.data ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao carregar afiliados");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      active: "bg-green-100 text-green-700",
      blocked: "bg-red-100 text-red-700",
      refused: "bg-gray-100 text-gray-700",
    };
    return (
      <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${map[status] ?? "bg-muted text-muted-foreground"}`}>
        {status}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{affiliates.length} afiliado(s) encontrado(s)</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Atualizar
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {["Afiliado", "Status", "Comissão", "Vendas", "Total Ganho"].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {affiliates.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-muted-foreground">
                  Nenhum afiliado registrado ainda
                </td>
              </tr>
            ) : affiliates.map((a) => (
              <tr key={a.id} className="border-b last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">{a.email}</div>
                </td>
                <td className="px-3 py-2">{statusBadge(a.status)}</td>
                <td className="px-3 py-2">{a.commission_percent}%</td>
                <td className="px-3 py-2">{a.sales_count}</td>
                <td className="px-3 py-2">
                  {((a.total_earned_cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Tab: Webhooks (Logs) ─────────────────────────────────────────────────────

function WebhooksTab() {
  const [logs, setLogs] = useState<KiwifyWebhookLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [setupUrl, setSetupUrl] = useState("");
  const [settingUp, setSettingUp] = useState(false);

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const res = await invokeBackendRpc<{ logs: KiwifyWebhookLog[]; total: number }>("admin-kiwify", {
        body: { action: "list_webhook_logs", page: p, limit: 25 },
      });
      setLogs(res?.logs ?? []);
      setTotal(res?.total ?? 0);
      setPage(p);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao carregar logs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(1); }, [load]);

  const handleSetupWebhook = async () => {
    const url = setupUrl.trim() || `${import.meta.env.VITE_API_URL}/webhooks/kiwify`;
    setSettingUp(true);
    try {
      await invokeBackendRpc("admin-kiwify", {
        body: { action: "setup_webhook", webhook_url: url, webhook_name: "AutoLinks" },
      });
      toast.success("Webhook configurado na Kiwify com sucesso!");
      setSetupUrl("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao configurar webhook");
    } finally {
      setSettingUp(false);
    }
  };

  const statusBadge = (status: string) => {
    const isOk = status === "processed" || status === "ignored";
    return (
      <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${isOk ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configurar Webhook na Kiwify</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Registre automaticamente o endpoint de webhook no seu painel Kiwify.
          </p>
          <div className="flex gap-3">
            <Input
              className="flex-1"
              value={setupUrl}
              onChange={(e) => setSetupUrl(e.target.value)}
              placeholder={`${import.meta.env.VITE_API_URL}/webhooks/kiwify`}
            />
            <Button onClick={handleSetupWebhook} disabled={settingUp}>
              {settingUp ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Webhook className="mr-2 h-4 w-4" />}
              Configurar
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Log de Webhooks Recebidos</p>
        <Button variant="outline" size="sm" onClick={() => load(1)}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Atualizar
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {["Data", "Evento", "Order ID", "Status", "Erro"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-muted-foreground">
                      Nenhum webhook recebido ainda
                    </td>
                  </tr>
                ) : logs.map((l) => (
                  <tr key={l.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(l.created_at).toLocaleString("pt-BR")}</td>
                    <td className="px-3 py-2 font-mono text-xs">{l.event_type}</td>
                    <td className="px-3 py-2 font-mono text-xs">{l.order_id ?? "—"}</td>
                    <td className="px-3 py-2">{statusBadge(l.status)}</td>
                    <td className="px-3 py-2 text-xs text-red-600">{l.error_message ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{total} evento(s) no total</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => load(page - 1)}>Anterior</Button>
              <Button variant="outline" size="sm" disabled={page * 25 >= total} onClick={() => load(page + 1)}>Próxima</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Panel (embeddable, no PageHeader) ───────────────────────────────────────

export function KiwifyPanel() {
  return (
    <Tabs defaultValue="config">
      <TabsList className="mb-4">
        <TabsTrigger value="config">Configuração</TabsTrigger>
        <TabsTrigger value="transactions">Transações</TabsTrigger>
        <TabsTrigger value="affiliates">
          <Users className="mr-1.5 h-3.5 w-3.5" />
          Afiliados
        </TabsTrigger>
        <TabsTrigger value="webhooks">
          <Webhook className="mr-1.5 h-3.5 w-3.5" />
          Webhooks
        </TabsTrigger>
      </TabsList>

      <TabsContent value="config"><ConfigTab /></TabsContent>
      <TabsContent value="transactions"><TransactionsTab /></TabsContent>
      <TabsContent value="affiliates"><AffiliatesTab /></TabsContent>
      <TabsContent value="webhooks"><WebhooksTab /></TabsContent>
    </Tabs>
  );
}

// ─── Main Page (standalone, kept for direct access) ───────────────────────────

export default function AdminKiwify() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Kiwify"
        description="Configuração de credenciais, transações, afiliados e logs de webhooks Kiwify"
      />
      <KiwifyPanel />
    </div>
  );
}
