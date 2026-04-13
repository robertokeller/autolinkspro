import { useState, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Loader2, CheckCircle, XCircle, ExternalLink,
  AlertTriangle, Wifi, WifiOff, Clock, Info, ChevronDown,
  Key, Eye, EyeOff, RotateCw,
} from "lucide-react";
import { useShopeeCredentials } from "@/hooks/useShopeeCredentials";
import { useServiceHealth } from "@/hooks/useServiceHealth";
import { toast } from "sonner";
import { formatBRT } from "@/lib/timezone";

const TUTORIAL_STEPS = [
  {
    step: 1,
    title: "Cadastre-se como Afiliado",
    description: "Acesse affiliate.shopee.com.br e crie sua conta no Programa de Afiliados Shopee. Se já é afiliado, pule para o passo 2.",
    link: "https://affiliate.shopee.com.br",
    linkLabel: "Ir para Shopee Affiliate",
  },
  {
    step: 2,
    title: 'Acesse a página "Open API"',
    description: 'No painel de afiliado, acesse a seção Open API. Se você não encontrar essa opção, significa que precisa solicitar acesso (próximo passo).',
    link: "https://affiliate.shopee.com.br/open_api",
    linkLabel: "Abrir Open API",
  },
  {
    step: 3,
    title: "Solicite acesso a API via Central de Ajuda",
    description: 'Na página Open API, clique em "Central de Ajuda" (canto superior direito). Role até o final e clique em "E-mail (Fale conosco por e-mail)". Preencha o formulário:',
    details: [
      { campo: "Já é Afiliado da Shopee?", valor: "Sim" },
      { campo: "Problemas com login?", valor: "Não, estou com outras dificuldades" },
      { campo: "ID de Afiliado", valor: "Seu ID numérico (no painel de afiliado)" },
      { campo: "Tema da dificuldade", valor: "Dúvidas com cadastro/conta" },
      { campo: "Cenário", valor: "Quero ativar a API" },
    ],
  },
  {
    step: 4,
    title: "Aguarde a aprovação (1-3 dias úteis)",
    description: "A equipe da Shopee analisará e enviará um e-mail com as credenciais. O prazo costuma ser de 1 a 3 dias úteis.",
  },
  {
    step: 5,
    title: "Copie App ID e Secret",
    description: 'Após aprovação, acesse novamente a página Open API. Na aba "API List", você verá seu App ID e Secret Key. Copie e cole nos campos abaixo.',
    link: "https://affiliate.shopee.com.br/open_api",
    linkLabel: "Abrir Open API",
  },
];

type CombinedStatus = "testing" | "service_offline" | "connected" | "error" | "unknown";

const CONNECTION_CARD_BY_STATUS = {
  connected: { barClass: "bg-success", iconWrapClass: "bg-success/10 text-success", icon: CheckCircle, title: "Tudo certo! API conectada" },
  error: { barClass: "bg-destructive", iconWrapClass: "bg-destructive/10 text-destructive", icon: XCircle, title: "Não conseguiu conectar" },
  testing: { barClass: "bg-primary animate-pulse", iconWrapClass: "bg-primary/10 text-primary", icon: Loader2, title: "Testando..." },
  unknown: { barClass: "bg-muted-foreground/30", iconWrapClass: "bg-muted text-muted-foreground", icon: Wifi, title: "Ainda não testou a conexão" },
  service_offline: { barClass: "bg-destructive", iconWrapClass: "bg-destructive/10 text-destructive", icon: WifiOff, title: "Serviço Shopee fora do ar" },
} as const;

export default function ShopeeConfiguracoes() {
  const { appId, isConfigured, hasSecret, connectionInfo, save, testConnection } = useShopeeCredentials();
  const {
    health: serviceHealth,
    isRefreshing: isServiceHealthRefreshing,
    refresh: refreshServiceHealth,
  } = useServiceHealth("shopee");
  const [form, setForm] = useState({ appId: "", secret: "" });
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);

  useEffect(() => {
    setForm((prev) => ({ ...prev, appId }));
  }, [appId]);

  const handleSave = async () => {
    if (!form.appId.trim()) {
      toast.error("Cole o App ID");
      return;
    }
    if (!form.secret.trim()) {
      toast.error(isConfigured ? "Cole a Secret Key para atualizar" : "Cole a Secret Key");
      return;
    }
    setSaving(true);
    try {
      await save({ appId: form.appId.trim(), secret: form.secret.trim() });
      toast.success("Credenciais salvas!");
      setForm((prev) => ({ ...prev, secret: "" }));
      const ok = await testConnection();
      if (ok) {
        toast.success("Conexão OK!");
      } else {
        toast.error("Credenciais salvas, mas a conexão falhou — confira os dados");
      }
    } catch (err) {
      console.error("Erro ao salvar credenciais:", err);
      const message = err instanceof Error ? err.message : "Não foi possível salvar as credenciais";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleTestAll = async () => {
    try {
      const status = await refreshServiceHealth();
      if (!status?.online) {
        toast.error(status?.error || "Serviço Shopee fora do ar");
        return;
      }
      const ok = await testConnection();
      if (ok) {
        toast.success("Conexão OK!");
      } else {
        toast.error("Credenciais inválidas — confira os dados");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível testar a conexão");
    }
  };

  const isTesting = connectionInfo.status === "testing";
  const isBusy = saving || isTesting || isServiceHealthRefreshing;
  const combinedStatus: CombinedStatus =
    isServiceHealthRefreshing || isTesting ? "testing" :
    (serviceHealth && !serviceHealth.online) ? "service_offline" :
    connectionInfo.status === "connected" ? "connected" :
    connectionInfo.status === "error" ? "error" :
    "unknown";
  const cardConfig = CONNECTION_CARD_BY_STATUS[combinedStatus];
  const CardStatusIcon = cardConfig.icon;

  return (
    <div className="ds-page">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <PageHeader title="Configurações Shopee" description="Conecte sua conta de afiliado da Shopee" />
        {/* Connection Status - unified card */}
        <Card className="glass overflow-hidden">
          <div className={`h-1 w-full ${cardConfig.barClass}`} />
          <CardContent className="p-5 sm:p-6">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${cardConfig.iconWrapClass}`}>
                <CardStatusIcon className={`h-6 w-6 ${combinedStatus === "testing" ? "animate-spin" : ""}`} />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-sm font-semibold leading-snug">{cardConfig.title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-3 sm:gap-y-1.5">
                  {combinedStatus === "service_offline" && (
                    <span className="text-xs text-destructive/80">
                      {serviceHealth?.error ?? "Porta 3113 não responde — inicie com npm run svc:shopee:dev"}
                    </span>
                  )}
                  {connectionInfo.lastTestedAt && combinedStatus !== "service_offline" && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      Último teste: {formatBRT(connectionInfo.lastTestedAt, "dd/MM HH:mm")}
                    </span>
                  )}
                  {connectionInfo.errorMessage && combinedStatus === "error" && (
                    <span className="text-xs text-destructive">{connectionInfo.errorMessage}</span>
                  )}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => void handleTestAll()} disabled={isBusy} className="mt-1 w-full shrink-0 sm:mt-0 sm:w-auto">
                {combinedStatus === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RotateCw className="h-3.5 w-3.5 mr-1.5" />}
                Testar conexão
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Credentials Card */}
        <Card className="glass">
          <CardHeader className="pb-3 sm:pb-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Key className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">Suas credenciais</CardTitle>
                <CardDescription className="text-sm leading-relaxed">
                  {isConfigured
                    ? "Só preencha de novo se quiser trocar."
                    : "Cole aqui o App ID e Secret da API Shopee Affiliate."}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6 pt-2 sm:space-y-7">
            <div className="space-y-4 sm:space-y-5">
              <div className="space-y-2">
                <Label className="text-sm font-medium">App ID</Label>
                <Input
                  placeholder="Cole seu App ID aqui"
                  value={form.appId}
                  onChange={(e) => setForm({ ...form, appId: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Secret Key</Label>
                <div className="relative">
                  <Input
                    type={showSecret ? "text" : "password"}
                    placeholder={isConfigured ? "*** salvo com segurança ***" : "Cole seu Secret Key aqui"}
                    value={form.secret}
                    onChange={(e) => setForm({ ...form, secret: e.target.value })}
                    className="font-mono text-sm pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 p-0 sm:h-7 sm:w-7"
                    onClick={() => setShowSecret(!showSecret)}
                  >
                    {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </div>

            <Button onClick={handleSave} disabled={isBusy} className="mt-2 w-full sm:mt-3">
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Key className="h-4 w-4 mr-2" />
              )}
              {isConfigured ? "Atualizar credenciais" : "Salvar e conectar"}
            </Button>
          </CardContent>
        </Card>

        {/* Tutorial */}
        <Collapsible open={tutorialOpen} onOpenChange={setTutorialOpen}>
          <Card className="glass">
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none hover:bg-muted/30 transition-colors rounded-t-xl">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Info className="h-4 w-4" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Como conseguir suas credenciais</CardTitle>
                      <CardDescription className="text-xs">
                        Passo a passo para pedir acesso à API
                      </CardDescription>
                    </div>
                  </div>
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${tutorialOpen ? "rotate-180" : ""}`} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <CardContent className="space-y-0 pt-1">
                <div className="relative">
                  {TUTORIAL_STEPS.map((step, idx) => (
                    <div key={step.step} className="relative flex gap-4 pb-7 last:pb-0 sm:gap-5 sm:pb-8">
                      {idx < TUTORIAL_STEPS.length - 1 && (
                        <div className="absolute left-[15px] top-8 bottom-0 w-px bg-border" />
                      )}
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold border border-primary/20">
                        {step.step}
                      </div>
                      <div className="min-w-0 flex-1 space-y-2.5 pt-1">
                        <p className="text-sm font-medium leading-snug">{step.title}</p>
                        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{step.description}</p>

                        {step.details && (
                          <div className="space-y-2 rounded-lg border bg-secondary/30 p-3 sm:p-4">
                            {step.details.map((d) => (
                              <div key={d.campo} className="flex flex-col gap-1 text-sm sm:flex-row sm:gap-2">
                                <span className="shrink-0 text-muted-foreground sm:min-w-[170px]">{d.campo}:</span>
                                <span className="font-medium leading-relaxed">{d.valor}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {step.link && (
                          <Button variant="outline" size="sm" className="h-8 text-xs gap-1" asChild>
                            <a href={step.link} target="_blank" rel="noopener noreferrer">
                              {step.linkLabel} <ExternalLink className="h-3 w-3" />
                            </a>
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <Separator className="my-4" />

                <div className="grid grid-cols-[auto,1fr] gap-3 rounded-lg border border-warning/20 bg-warning/5 p-3.5 sm:p-4">
                  <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-warning">Dica importante</p>
                    <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                      A Shopee pode levar de <strong>1 a 3 dias úteis</strong> para aprovar sua solicitação.
                      Caso não receba resposta, entre novamente na Central de Ajuda e reenvie a solicitação.
                    </p>
                  </div>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      </div>
    </div>
  );
}


