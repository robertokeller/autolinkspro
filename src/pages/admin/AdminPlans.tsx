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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Loader2, Save } from "lucide-react";
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

      <div className="flex min-w-48 flex-1 items-center gap-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">URL Kiwify</span>
        <Input
          className="h-7 text-sm"
          value={period.kiwifyCheckoutUrl ?? ""}
          onChange={(e) => onChange({ ...period, kiwifyCheckoutUrl: e.target.value })}
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
    return existing ?? { type, price: 0, isActive: false };
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
                  Períodos de Cobrança &amp; Links Kiwify
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
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
  const mainTab = searchParams.get("tab") === "kiwify" ? "kiwify" : "plans";
  const { state, saveState } = useAdminControlPlane();
  const [draftPlans, setDraftPlans] = useState<ManagedPlan[]>(() => clonePlans(state.plans));
  const [draftDefaultPlanId, setDraftDefaultPlanId] = useState(state.defaultSignupPlanId);
  const [savingPlanId, setSavingPlanId] = useState<string | null>(null);
  const [globalSaving, setGlobalSaving] = useState(false);
  const [mappingsLoaded, setMappingsLoaded] = useState(false);

  // Sync state on external changes
  useEffect(() => {
    setDraftPlans(clonePlans(state.plans));
    setDraftDefaultPlanId(state.defaultSignupPlanId);
  }, [state.plans, state.defaultSignupPlanId]);

  // Load Kiwify DB mappings into draft periods on tab open
  useEffect(() => {
    if (mainTab !== "plans" || mappingsLoaded) return;
    const load = async () => {
      try {
        const res = await invokeBackendRpc<{
          mappings: Array<{
            plan_id: string;
            period_type: string;
            kiwify_checkout_url: string;
            kiwify_product_id: string;
            is_active: boolean;
          }>;
        }>("admin-kiwify", { body: { action: "list_mappings" } });
        const rows = res?.mappings ?? [];
        if (rows.length === 0) return;
        setDraftPlans((prev) =>
          prev.map((plan) => {
            const planRows = rows.filter((r) => r.plan_id === plan.id);
            if (planRows.length === 0) return plan;
            const updatedPeriods = (plan.periods ?? []).map((period) => {
              const m = planRows.find((r) => r.period_type === period.type);
              if (!m) return period;
              return {
                ...period,
                kiwifyCheckoutUrl: m.kiwify_checkout_url || period.kiwifyCheckoutUrl,
                kiwifyProductId: m.kiwify_product_id || period.kiwifyProductId,
                isActive: m.is_active,
              };
            });
            return { ...plan, periods: updatedPeriods };
          })
        );
        setMappingsLoaded(true);
      } catch {
        // Kiwify may not be configured yet
      }
    };
    load();
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
    toast.success(`Período ${PERIOD_LABELS[period.type]} salvo no banco!`);
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
    <div className="min-h-full">
      <PageHeader
        title="Planos & Kiwify"
        description="Configure os planos, períodos de cobrança e links de checkout Kiwify."
      />
      <div className="container max-w-5xl py-6">
        <Tabs
          value={mainTab}
          onValueChange={(v) => setSearchParams(v === "kiwify" ? { tab: "kiwify" } : {})}
        >
          <TabsList className="mb-6">
            <TabsTrigger value="plans">Planos</TabsTrigger>
            <TabsTrigger value="kiwify">Kiwify</TabsTrigger>
          </TabsList>

          {/* ── Plans tab ── */}
          <TabsContent value="plans" className="space-y-4">
            {/* Global config */}
            <Card>
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
          <TabsContent value="kiwify">
            <KiwifyPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
