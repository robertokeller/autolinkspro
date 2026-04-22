import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { KiwifyPanel } from "@/pages/admin/AdminKiwify";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
import { appendAdminAudit, triggerGlobalResyncPulse } from "@/lib/admin-shared";
import {
  PERIOD_LABELS,
  type BillingPeriodType,
  type PlanLimits,
  type PlanPeriodConfig,
} from "@/lib/plans";
import { type ManagedPlan } from "@/lib/admin-control-plane";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight, CheckCircle2, Loader2, Save, XCircle } from "lucide-react";
import { toast } from "sonner";

const PERIOD_ORDER: BillingPeriodType[] = ["monthly", "quarterly", "semiannual", "annual"];
const PAID_PLAN_IDS = ["plan-start", "plan-pro", "plan-business"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clonePlan(plan: ManagedPlan): ManagedPlan {
  return {
    ...plan,
    limits: { ...plan.limits },
    baseLimits: plan.baseLimits ? { ...plan.baseLimits } : undefined,
    homeFeatureHighlights: [...(plan.homeFeatureHighlights ?? [])],
    periods: (plan.periods ?? []).map((p) => ({ ...p })),
  };
}

function clonePlans(plans: ManagedPlan[]) {
  return plans.map(clonePlan);
}

function parseFeatureText(value: string) {
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10);
}

// ─── Period row ────────────────────────────────────────────────────────────────

interface PeriodRowProps {
  period: PlanPeriodConfig;
  onChange: (updated: PlanPeriodConfig) => void;
  onSave: (period: PlanPeriodConfig) => Promise<void>;
}

function PeriodRow({ period, onChange, onSave }: PeriodRowProps) {
  const [saving, setSaving] = useState(false);
  const label = PERIOD_LABELS[period.type];

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(period);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="w-24 shrink-0 text-sm font-medium">{label}</span>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">R$</span>
        <Input
          className="h-7 w-24 text-sm"
          type="number"
          min={0}
          value={period.price}
          onChange={(e) => onChange({ ...period, price: Number(e.target.value) || 0 })}
          placeholder="Preço"
        />
      </div>

      <div className="flex min-w-52 flex-1 items-center gap-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">URL Checkout</span>
        <Input
          className="h-7 text-sm"
          value={period.kiwifyCheckoutUrl ?? ""}
          onChange={(e) => onChange({ ...period, kiwifyCheckoutUrl: e.target.value, checkoutProvider: "kiwify" })}
          placeholder="https://pay.kiwify.com/..."
        />
      </div>

      <div className="flex items-center gap-1.5">
        <Switch
          checked={period.isActive}
          onCheckedChange={(v) => onChange({ ...period, isActive: v })}
        />
        <span className="text-xs">{period.isActive ? "Ativo" : "Inativo"}</span>
      </div>

      <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
        Salvar
      </Button>
    </div>
  );
}

// ─── Plan card ─────────────────────────────────────────────────────────────────

interface PlanCardProps {
  plan: ManagedPlan;
  accessLevels: { id: string; name: string }[];
  onUpdate: (updater: (plan: ManagedPlan) => ManagedPlan) => void;
  onSavePlan: () => Promise<void>;
  onSavePeriod: (period: PlanPeriodConfig) => Promise<void>;
  saving: boolean;
}

function PlanCard({ plan, accessLevels, onUpdate, onSavePlan, onSavePeriod, saving }: PlanCardProps) {
  const displayPeriods = PERIOD_ORDER.map((type) => {
    const existing = (plan.periods ?? []).find((p) => p.type === type);
    return existing ?? {
      type,
      price: 0,
      isActive: false,
      checkoutProvider: "kiwify",
      kiwifyCheckoutUrl: "",
    };
  });

  const updatePeriod = (updated: PlanPeriodConfig) => {
    onUpdate((p) => ({
      ...p,
      periods: displayPeriods.map((dp) => (dp.type === updated.type ? updated : dp)),
    }));
  };

  const activePeriods = (plan.periods ?? []).filter((p) => p.isActive).length;

  return (
    <Card className="overflow-hidden border">
      <Accordion type="single" collapsible>
        <AccordionItem value={plan.id} className="border-0">
          <AccordionTrigger className="px-4 py-3 hover:no-underline">
            <div className="flex flex-1 items-center gap-3 text-left">
              <span className="font-semibold">{plan.homeTitle || plan.name}</span>
              <Badge variant={plan.isActive ? "default" : "secondary"} className="text-xs">
                {plan.isActive ? "Ativo" : "Inativo"}
              </Badge>
              <span className="ml-auto mr-4 text-sm text-muted-foreground">
                {activePeriods} período{activePeriods !== 1 ? "s" : ""} ativo{activePeriods !== 1 ? "s" : ""}
              </span>
            </div>
          </AccordionTrigger>

          <AccordionContent>
            <div className="space-y-6 px-4 pb-4">
              {/* Period rows */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Períodos de Cobrança e Checkouts
                </Label>
                {displayPeriods.map((period) => (
                  <PeriodRow
                    key={period.type}
                    period={period}
                    onChange={updatePeriod}
                    onSave={onSavePeriod}
                  />
                ))}
              </div>

              {/* Metadata */}
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Nome do Plano</Label>
                  <Input
                    value={plan.homeTitle || plan.name}
                    onChange={(e) =>
                      onUpdate((p) => ({ ...p, homeTitle: e.target.value, name: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Texto do botão CTA</Label>
                  <Input
                    value={plan.homeCtaText}
                    onChange={(e) => onUpdate((p) => ({ ...p, homeCtaText: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs">Descrição</Label>
                  <Input
                    value={plan.homeDescription}
                    onChange={(e) => onUpdate((p) => ({ ...p, homeDescription: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs">Destaques (um por linha, máx. 10)</Label>
                  <Textarea
                    rows={4}
                    value={(plan.homeFeatureHighlights ?? []).join("\n")}
                    onChange={(e) =>
                      onUpdate((p) => ({ ...p, homeFeatureHighlights: parseFeatureText(e.target.value) }))
                    }
                  />
                </div>
              </div>

              {/* Toggles + access level */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={plan.isActive}
                    onCheckedChange={(v) => onUpdate((p) => ({ ...p, isActive: v }))}
                  />
                  <Label className="text-xs">Plano ativo</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={plan.visibleOnHome}
                    onCheckedChange={(v) => onUpdate((p) => ({ ...p, visibleOnHome: v }))}
                  />
                  <Label className="text-xs">Visível na Home</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={plan.visibleInAccount}
                    onCheckedChange={(v) => onUpdate((p) => ({ ...p, visibleInAccount: v }))}
                  />
                  <Label className="text-xs">Visível na Conta</Label>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Nível de Acesso</Label>
                  <Select
                    value={plan.accessLevelId}
                    onValueChange={(v) => onUpdate((p) => ({ ...p, accessLevelId: v }))}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {accessLevels.map((level) => (
                        <SelectItem key={level.id} value={level.id}>
                          {level.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Base limits */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Limites Base
                </Label>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {(
                    [
                      ["whatsappSessions", "WhatsApp"],
                      ["telegramSessions", "Telegram"],
                      ["meliSessions", "Meli sessões"],
                      ["groups", "Grupos"],
                      ["routes", "Rotas"],
                      ["automations", "Automações"],
                      ["schedules", "Agendamentos"],
                      ["masterGroups", "Master Groups"],
                    ] as [keyof PlanLimits, string][]
                  ).map(([key, lbl]) => (
                    <div key={key} className="space-y-0.5">
                      <Label className="text-xs text-muted-foreground">{lbl}</Label>
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={(plan.baseLimits ?? plan.limits)[key] as number}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          onUpdate((p) => ({
                            ...p,
                            baseLimits: { ...(p.baseLimits ?? p.limits), [key]: val },
                            limits: { ...p.limits, [key]: val },
                          }));
                        }}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">-1 = ilimitado · 0 = bloqueado</p>
              </div>

              <div className="flex justify-end border-t pt-4">
                <Button size="sm" onClick={onSavePlan} disabled={saving} className="gap-1.5">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Salvar plano
                </Button>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function AdminPlans() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const mainTab = requestedTab === "kiwify" ? requestedTab : "plans";
  const { state, saveState } = useAdminControlPlane();
  const [draftPlans, setDraftPlans] = useState<ManagedPlan[]>(() => clonePlans(state.plans));
  const [draftDefaultPlanId, setDraftDefaultPlanId] = useState(state.defaultSignupPlanId);
  const [savingPlanId, setSavingPlanId] = useState<string | null>(null);
  const [globalSaving, setGlobalSaving] = useState(false);
  const [mappingsLoaded, setMappingsLoaded] = useState(false);
  const [kiwifyOk, setKiwifyOk] = useState<boolean | null>(null);

  // Sync state on external changes
  useEffect(() => {
    setDraftPlans(clonePlans(state.plans));
    setDraftDefaultPlanId(state.defaultSignupPlanId);
  }, [state.plans, state.defaultSignupPlanId]);

  // Load gateway config status for tab indicators
  useEffect(() => {
    const checkGateways = async () => {
      const kwRes = await invokeBackendRpc<{ config: { client_id_set: boolean; client_secret_set: boolean } | null }>(
        "admin-kiwify",
        { body: { action: "get_config" } },
      );
      const kwConfig = kwRes?.config ?? null;
      setKiwifyOk(!!(kwConfig?.client_id_set && kwConfig?.client_secret_set));
    };
    void checkGateways().catch(() => setKiwifyOk(false));
  }, []);

  // Load Kiwify DB mappings into draft periods on tab open
  useEffect(() => {
    if (mainTab !== "plans" || mappingsLoaded) return;
    const load = async () => {
      try {
        const kiwifyResult = await invokeBackendRpc<{
          mappings: Array<{
            plan_id: string;
            period_type: string;
            kiwify_checkout_url: string;
            kiwify_product_id: string;
            is_active: boolean;
          }>;
        }>("admin-kiwify", { body: { action: "list_mappings" } });
        const kiwifyRows = kiwifyResult?.mappings ?? [];
        setDraftPlans((prev) =>
          prev.map((plan) => {
            const planKiwifyRows = kiwifyRows.filter((r) => r.plan_id === plan.id);
            if (planKiwifyRows.length === 0) return plan;
            const updatedPeriods = (plan.periods ?? []).map((period) => {
              const kiwifyMap = planKiwifyRows.find((r) => r.period_type === period.type);
              return {
                ...period,
                kiwifyCheckoutUrl: kiwifyMap?.kiwify_checkout_url || period.kiwifyCheckoutUrl,
                kiwifyProductId: kiwifyMap?.kiwify_product_id || period.kiwifyProductId,
                checkoutProvider: "kiwify",
                isActive: typeof kiwifyMap?.is_active === "boolean"
                  ? kiwifyMap.is_active
                  : period.isActive,
              };
            });
            return { ...plan, periods: updatedPeriods };
          }),
        );
        setMappingsLoaded(true);
      } catch {
        // integrations may not be configured yet
        setMappingsLoaded(true);
      }
    };
    void load();
  }, [mainTab, mappingsLoaded]);

  const paidPlans = useMemo(
    () => draftPlans.filter((p) => PAID_PLAN_IDS.includes(p.id)),
    [draftPlans]
  );

  const updatePlan = (planId: string, updater: (plan: ManagedPlan) => ManagedPlan) => {
    setDraftPlans((prev) => prev.map((p) => (p.id === planId ? updater(p) : p)));
  };

  const savePlan = async (planId: string) => {
    setSavingPlanId(planId);
    try {
      await saveState({ ...state, plans: draftPlans, defaultSignupPlanId: draftDefaultPlanId });
      await appendAdminAudit("plan_update", { plan_id: planId });
      triggerGlobalResyncPulse("admin-plans");
      toast.success("Plano salvo!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar plano");
    } finally {
      setSavingPlanId(null);
    }
  };

  const savePeriodToDb = async (planId: string, period: PlanPeriodConfig) => {
    try {
      await invokeBackendRpc("admin-kiwify", {
        body: {
          action: "save_mapping",
          plan_id: planId,
          period_type: period.type,
          kiwify_product_id: period.kiwifyProductId ?? "",
          kiwify_product_name: "",
          kiwify_checkout_url: period.kiwifyCheckoutUrl ?? "",
          affiliate_enabled: false,
          affiliate_commission_percent: 0,
          is_active: period.isActive,
        },
      });

      await saveState({ ...state, plans: draftPlans, defaultSignupPlanId: draftDefaultPlanId });
      triggerGlobalResyncPulse("admin-plans-period-save");
      toast.success(`Periodo ${PERIOD_LABELS[period.type]} salvo e sincronizado!`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao salvar periodo");
      throw error;
    }
  };

  const saveGlobal = async () => {
    setGlobalSaving(true);
    try {
      await saveState({ ...state, plans: draftPlans, defaultSignupPlanId: draftDefaultPlanId });
      triggerGlobalResyncPulse("admin-plans");
      toast.success("Configuração salva!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setGlobalSaving(false);
    }
  };

  return (
    <div className="admin-page">
      <PageHeader
        title="Planos e Kiwify"
        description="Central unica para gerir periodos, checkouts e mapeamentos de faturamento."
      />
      <Tabs
          value={mainTab}
          onValueChange={(v) => setSearchParams(v === "plans" ? {} : { tab: v })}
        >
          <TabsList className="admin-toolbar h-auto w-full justify-start overflow-x-auto mb-2">
            <TabsTrigger value="plans">Planos</TabsTrigger>
            <TabsTrigger value="kiwify" className="gap-1.5">
              Kiwify
              {kiwifyOk === true && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
              {kiwifyOk === false && <XCircle className="h-3.5 w-3.5 text-yellow-500" />}
            </TabsTrigger>
          </TabsList>

          {/* ── Plans tab ── */}
          <TabsContent value="plans" className="space-y-6">
            {/* Gateway status summary */}
            <Card className="admin-card">
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="text-sm">Status dos Gateways de Pagamento</CardTitle>
                <CardDescription className="text-xs">Configure as credenciais antes de vincular planos. Clique para gerenciar cada gateway.</CardDescription>
              </CardHeader>
              <CardContent className="pb-3">
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setSearchParams({ tab: "kiwify" })}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    {kiwifyOk === true ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : kiwifyOk === false ? (
                      <XCircle className="h-4 w-4 text-yellow-500" />
                    ) : (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                    <span className="font-medium">Kiwify</span>
                    <span className="text-xs text-muted-foreground">
                      {kiwifyOk === true ? "Configurado" : kiwifyOk === false ? "Pendente" : ""}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
              </CardContent>
            </Card>

            {/* Global config */}
            <Card className="admin-card">
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="text-sm">Configuração Global</CardTitle>
              </CardHeader>
              <CardContent className="pb-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Label className="shrink-0 text-sm">Plano padrão para novos usuários</Label>
                  <Select value={draftDefaultPlanId} onValueChange={setDraftDefaultPlanId}>
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {draftPlans.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" onClick={saveGlobal} disabled={globalSaving} className="gap-1.5">
                    {globalSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Salvar
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Plan cards */}
            <div className="space-y-3">
              {paidPlans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  accessLevels={state.accessLevels}
                  onUpdate={(updater) => updatePlan(plan.id, updater)}
                  onSavePlan={() => savePlan(plan.id)}
                  onSavePeriod={(period) => savePeriodToDb(plan.id, period)}
                  saving={savingPlanId === plan.id}
                />
              ))}
            </div>
          </TabsContent>
          {/* ── Kiwify tab ── */}
          <TabsContent value="kiwify" className="space-y-6">
            <div className="flex flex-col gap-1.5">
              <nav className="flex items-center gap-2 text-sm text-muted-foreground font-medium">
                <button
                  type="button"
                  onClick={() => setSearchParams({})}
                  className="hover:text-foreground transition-colors"
                >
                  Planos
                </button>
                <span>/</span>
                <span className="text-foreground">Kiwify</span>
              </nav>
              <h2 className="text-2xl font-semibold tracking-tight">Kiwify — Integração</h2>
              <p className="text-muted-foreground text-sm">
                Gerencie configurações de gateway, comissões de afiliados e histórico completo de transações e webhooks.
              </p>
            </div>
            <KiwifyPanel />
          </TabsContent>
        </Tabs>
    </div>
  );
}


