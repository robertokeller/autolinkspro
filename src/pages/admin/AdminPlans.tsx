import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
import { applyAccessLevelLimits, type ManagedPlan } from "@/lib/admin-control-plane";
import { appendAdminAudit, triggerGlobalResyncPulse } from "@/lib/admin-shared";
import { getPlanFeatureList, plans as staticPlans } from "@/lib/plans";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface NewPlanDraft {
  name: string;
  price: number;
  periodDays: number;
  accessLevelId: string;
  billingPeriod: "monthly" | "annual";
  monthlyEquivalentPrice: number | "";
  homeFeatureHighlightsText: string;
  isActive: boolean;
  visibleOnHome: boolean;
  visibleInAccount: boolean;
}

function parsePeriodDays(period: string): number {
  const raw = String(period || "").trim().toLowerCase();
  const match = raw.match(/(\d+)\s*(dia|dias|d)/i);
  if (match) {
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30;
  }
  if (raw.includes("/mes") || raw.includes("mes") || raw.includes("mês")) return 30;
  if (raw.includes("/ano") || raw.includes("ano")) return 365;
  return 30;
}

function toPeriodLabel(days: number): string {
  const safeDays = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 30;
  return `${safeDays} dias`;
}

function clonePlans(plans: ManagedPlan[]) {
  return plans.map((plan) => ({
    ...plan,
    limits: { ...plan.limits },
    homeFeatureHighlights: [...(plan.homeFeatureHighlights || [])],
  }));
}

function parseFeatureHighlightsText(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
}

export default function AdminPlans() {
  const { state, saveState } = useAdminControlPlane();
  const [draftPlans, setDraftPlans] = useState<ManagedPlan[]>(() => clonePlans(state.plans));
  const [draftDefaultSignupPlanId, setDraftDefaultSignupPlanId] = useState(state.defaultSignupPlanId);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [deletePlanTarget, setDeletePlanTarget] = useState<ManagedPlan | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newPlan, setNewPlan] = useState<NewPlanDraft>({
    name: "",
    price: 0,
    periodDays: 30,
    accessLevelId: state.accessLevels[0]?.id || "level-starter",
    billingPeriod: "monthly",
    monthlyEquivalentPrice: "",
    homeFeatureHighlightsText: "",
    isActive: true,
    visibleOnHome: true,
    visibleInAccount: true,
  });

  useEffect(() => {
    setDraftPlans(clonePlans(state.plans));
    setDraftDefaultSignupPlanId(state.defaultSignupPlanId);
  }, [state.defaultSignupPlanId, state.plans]);

  const hasChanges = useMemo(() => {
    if (JSON.stringify(draftPlans) !== JSON.stringify(state.plans)) return true;
    return draftDefaultSignupPlanId !== state.defaultSignupPlanId;
  }, [draftDefaultSignupPlanId, draftPlans, state.defaultSignupPlanId, state.plans]);

  const activePlan = useMemo(
    () => draftPlans.find((plan) => plan.id === activePlanId) || null,
    [activePlanId, draftPlans],
  );

  const updatePlan = (planId: string, updater: (plan: ManagedPlan) => ManagedPlan) => {
    setDraftPlans((prev) => prev.map((plan) => (plan.id === planId ? updater(plan) : plan)));
  };

  const getBaseLimitsForPlan = (plan: ManagedPlan) => {
    const staticPlan = staticPlans.find((item) => item.id === plan.id);
    return staticPlan?.limits || plan.limits;
  };

  const applyAccessLevelToPlan = (plan: ManagedPlan, accessLevelId: string): ManagedPlan => {
    const selectedLevel = state.accessLevels.find((level) => level.id === accessLevelId);
    if (!selectedLevel) {
      return { ...plan, accessLevelId };
    }

    const limits = applyAccessLevelLimits(getBaseLimitsForPlan(plan), selectedLevel.limitOverrides);
    const resourceItems = getPlanFeatureList({
      id: plan.id,
      name: plan.name,
      price: plan.price,
      period: plan.period,
      billingPeriod: plan.billingPeriod ?? "monthly",
      monthlyEquivalentPrice: plan.monthlyEquivalentPrice,
      limits,
      isActive: plan.isActive,
    }).slice(0, 10);

    return {
      ...plan,
      accessLevelId,
      limits,
      homeFeatureHighlights: resourceItems,
    };
  };

  const buildUniquePlanId = (name: string) => {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "custom";

    const prefix = `plan-${base}`;
    if (!draftPlans.some((plan) => plan.id === prefix)) return prefix;

    let index = 2;
    while (draftPlans.some((plan) => plan.id === `${prefix}-${index}`)) {
      index += 1;
    }

    return `${prefix}-${index}`;
  };

  const createPlan = () => {
    const name = newPlan.name.trim();
    if (!name) {
      toast.error("Informe o nome do plano");
      return;
    }

    if (!Number.isFinite(newPlan.price) || newPlan.price < 0) {
      toast.error("Informe um preço válido");
      return;
    }

    if (!Number.isFinite(newPlan.periodDays) || newPlan.periodDays < 1) {
      toast.error("Informe a duração em dias (mínimo 1)");
      return;
    }

    if (!state.accessLevels.some((level) => level.id === newPlan.accessLevelId)) {
      toast.error("Selecione um nível de acesso válido");
      return;
    }

    const id = buildUniquePlanId(name);
    const baselinePlan = draftPlans.find((plan) => plan.id === draftDefaultSignupPlanId) || draftPlans[0];
    if (!baselinePlan) {
      toast.error("Não foi possível criar o plano");
      return;
    }

    const createdPlan: ManagedPlan = {
      ...baselinePlan,
      id,
      name,
      price: Number(newPlan.price || 0),
      period: toPeriodLabel(newPlan.periodDays),
      billingPeriod: newPlan.billingPeriod,
      monthlyEquivalentPrice: newPlan.billingPeriod === "annual" && newPlan.monthlyEquivalentPrice !== ""
        ? Number(newPlan.monthlyEquivalentPrice)
        : undefined,
      accessLevelId: newPlan.accessLevelId,
      isActive: newPlan.isActive,
      visibleOnHome: newPlan.visibleOnHome,
      visibleInAccount: newPlan.visibleInAccount,
      homeTitle: name,
      accountTitle: name,
      homeDescription: "Recursos incluídos no plano.",
      homeFeatureHighlights: parseFeatureHighlightsText(newPlan.homeFeatureHighlightsText),
      accountDescription: "Recursos incluídos no plano.",
      homeCtaText: Number(newPlan.price || 0) === 0 ? "Começar grátis" : `Assinar ${name}`,
      sortOrder: draftPlans.length,
    };

    const hydratedPlan = applyAccessLevelToPlan(createdPlan, newPlan.accessLevelId);
    const withResources = hydratedPlan.homeFeatureHighlights.length > 0
      ? hydratedPlan
      : {
          ...hydratedPlan,
          homeFeatureHighlights: parseFeatureHighlightsText(newPlan.homeFeatureHighlightsText),
        };

    setDraftPlans((prev) => [...prev, withResources]);
    setShowCreateModal(false);
    setNewPlan({
      name: "",
      price: 0,
      periodDays: 30,
      accessLevelId: state.accessLevels[0]?.id || "level-starter",
      billingPeriod: "monthly",
      monthlyEquivalentPrice: "",
      homeFeatureHighlightsText: "",
      isActive: true,
      visibleOnHome: true,
      visibleInAccount: true,
    });
    toast.success("Plano adicionado ao rascunho");
  };

  const savePlans = async () => {
    const invalidPlan = draftPlans.find((plan) => {
      const priceOk = Number.isFinite(plan.price) && plan.price >= 0;
      const periodDays = parsePeriodDays(plan.period);
      const periodOk = Number.isFinite(periodDays) && periodDays >= 1;
      const accessOk = state.accessLevels.some((level) => level.id === plan.accessLevelId);
      return !priceOk || !periodOk || !accessOk;
    });

    if (invalidPlan) {
      toast.error(`Plano inválido: ${invalidPlan.name}. Revise preço, duração e nível de acesso.`);
      return;
    }

    const activePlans = draftPlans.filter((plan) => plan.isActive).length;
    const syncedPlans = draftPlans.map((plan) => {
      const normalized = {
        ...plan,
        price: Number(plan.price || 0),
        period: toPeriodLabel(parsePeriodDays(plan.period)),
      };
      return applyAccessLevelToPlan(normalized, normalized.accessLevelId);
    });

    saveState({
      ...state,
      plans: syncedPlans.map((plan, index) => ({
        ...plan,
        homeTitle: plan.name,
        accountTitle: plan.name,
        // Preserve admin-written descriptions; fall back only when empty.
        homeDescription: plan.homeDescription?.trim() || "Recursos incluídos no plano.",
        accountDescription: plan.accountDescription?.trim() || plan.homeDescription?.trim() || "Recursos incluídos no plano.",
        homeCtaText: plan.price === 0 ? "Começar grátis" : `Assinar ${plan.name}`,
        sortOrder: index,
      })),
      defaultSignupPlanId: draftDefaultSignupPlanId,
    });

    triggerGlobalResyncPulse("admin-plans-save");
    setActivePlanId(null);

    try {
      await appendAdminAudit("update_admin_plans", {
        total_plans: syncedPlans.length,
        active_plans: activePlans,
        default_signup_plan_id: draftDefaultSignupPlanId,
      });
    } catch {
      // Audit log should not block the main save operation.
    }

    toast.success("Planos atualizados");
  };

  const removePlan = (planId: string) => {
    if (draftPlans.length <= 1) {
      toast.error("Necessário manter ao menos um plano");
      return;
    }
    const targetPlan = draftPlans.find((plan) => plan.id === planId);
    if (!targetPlan) return;
    setDeletePlanTarget(targetPlan);
  };

  const confirmRemovePlan = () => {
    if (!deletePlanTarget) return;
    const planId = deletePlanTarget.id;

    const nextPlans = draftPlans.filter((plan) => plan.id !== planId);
    if (nextPlans.length === 0) {
      toast.error("Necessário manter ao menos um plano");
      setDeletePlanTarget(null);
      return;
    }

    setDraftPlans(nextPlans);
    setDeletePlanTarget(null);

    if (activePlanId === planId) setActivePlanId(null);

    if (draftDefaultSignupPlanId === planId) {
      setDraftDefaultSignupPlanId(nextPlans[0].id);
      toast.success("Plano removido. Plano inicial ajustado automaticamente.");
      return;
    }

    toast.success("Plano removido do rascunho");
  };

  return (
    <div className="admin-page">
      <PageHeader
        title="Planos"
        description="Defina período total, preço cobrado e visibilidade. Recursos e limites são importados do nível de acesso."
      />

      <Card className="admin-card">
        <CardHeader className="pb-3">
          <CardTitle className="admin-card-title">Plano Padrão de Cadastro</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Todo novo usuário criado via cadastro receberá automaticamente este plano inicial.
          </p>
          <Select value={draftDefaultSignupPlanId} onValueChange={setDraftDefaultSignupPlanId}>
            <SelectTrigger className="max-w-sm">
              <SelectValue placeholder="Selecione o plano padrão" />
            </SelectTrigger>
            <SelectContent>
              {draftPlans.map((plan) => (
                <SelectItem key={plan.id} value={plan.id}>
                  {plan.name} {plan.isActive ? "" : "(inativo)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-primary">
            Plano selecionado: {draftPlans.find((plan) => plan.id === draftDefaultSignupPlanId)?.name || "-"}
          </p>
        </CardContent>
      </Card>

      <div className="admin-toolbar justify-center sm:justify-start">
        <Badge variant="outline" className="text-xs">
          {draftPlans.length} plano{draftPlans.length !== 1 ? "s" : ""}
        </Badge>
        <Button variant="outline" onClick={() => setShowCreateModal(true)}>Novo Plano</Button>
        <Button onClick={savePlans} disabled={!hasChanges}>Salvar Alterações</Button>
      </div>

      {(["monthly", "annual"] as const).map((period) => {
        const group = draftPlans.filter((p) => (p.billingPeriod ?? "monthly") === period);
        if (group.length === 0) return null;
        return (
          <div key={period} className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {period === "monthly" ? "Planos Mensais" : "Planos Anuais"}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.map((plan) => {
          const isDefaultSignup = plan.id === draftDefaultSignupPlanId;
          const accessLevelName = state.accessLevels.find((level) => level.id === plan.accessLevelId)?.name || "Nível";
          return (
            <Card
              key={plan.id}
              className={`admin-card transition hover:border-primary/40 ${
                isDefaultSignup ? "border-primary ring-1 ring-primary/50" : ""
              }`}
            >
              <CardHeader className="pb-1">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-sm font-semibold">{plan.name}</CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">{accessLevelName}</p>
                  </div>
                  {isDefaultSignup && <Badge variant="default">Plano Inicial</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="admin-kpi">
                    <p className="text-xs text-muted-foreground">Preço</p>
                    <p className="font-medium">{plan.price === 0 ? "Grátis" : `R$${plan.price.toFixed(2).replace(".", ",")}`}</p>
                    {plan.billingPeriod === "annual" && plan.monthlyEquivalentPrice != null && (
                      <p className="mt-0.5 text-xs text-muted-foreground">≈ R${plan.monthlyEquivalentPrice.toFixed(2).replace(".", ",")}/mês</p>
                    )}
                  </div>
                  <div className="admin-kpi">
                    <p className="text-xs text-muted-foreground">Período</p>
                    <p className="font-medium">{plan.period}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Home: {plan.visibleOnHome ? "Visível" : "Oculto"}</span>
                  <span>Cliente: {plan.visibleInAccount ? "Visível" : "Oculto"}</span>
                </div>

                <div className="flex items-center justify-end gap-1 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setActivePlanId(plan.id)}
                    aria-label={`Editar plano ${plan.name}`}
                    title="Editar plano"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removePlan(plan.id)}
                    aria-label={`Excluir plano ${plan.name}`}
                    title="Excluir plano"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
            </div>
          </div>
        );
      })}

      <Dialog open={!!activePlan} onOpenChange={(open) => !open && setActivePlanId(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Plano</DialogTitle>
          </DialogHeader>
          {activePlan && (
            <div className="space-y-4">
              {activePlan.id === draftDefaultSignupPlanId ? (
                <div className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs text-primary">
                  Este é o plano inicial padrão para novos cadastros.
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setDraftDefaultSignupPlanId(activePlan.id)}
                >
                  Definir como Plano Inicial
                </Button>
              )}

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="admin-card-title">Dados Comerciais</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1 sm:col-span-2">
                      <Label>Nome do Plano</Label>
                      <Input
                        value={activePlan.name}
                        onChange={(event) => updatePlan(activePlan.id, (current) => ({ ...current, name: event.target.value }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Preço Cobrado na Assinatura</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={activePlan.price}
                        onChange={(event) => updatePlan(activePlan.id, (current) => ({ ...current, price: Number(event.target.value || 0) }))}
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Período Total do Plano (dias)</Label>
                      <Input
                        type="number"
                        min={1}
                        value={parsePeriodDays(activePlan.period)}
                        onChange={(event) => updatePlan(activePlan.id, (current) => ({
                          ...current,
                          period: toPeriodLabel(Number(event.target.value || 0)),
                        }))}
                        placeholder="Ex: 30"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Cobrança</Label>
                      <Select
                        value={activePlan.billingPeriod ?? "monthly"}
                        onValueChange={(value) => updatePlan(activePlan.id, (current) => ({
                          ...current,
                          billingPeriod: value as "monthly" | "annual",
                          period: value === "annual" ? "365 dias" : "30 dias",
                        }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="monthly">Mensal</SelectItem>
                          <SelectItem value="annual">Anual</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {(activePlan.billingPeriod ?? "monthly") === "annual" && (
                    <div className="space-y-1">
                      <Label>Preço Mensal Equivalente (exibido no card)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="Ex: 64.17"
                        value={activePlan.monthlyEquivalentPrice ?? ""}
                        onChange={(event) => updatePlan(activePlan.id, (current) => ({
                          ...current,
                          monthlyEquivalentPrice: event.target.value ? Number(event.target.value) : undefined,
                        }))}
                      />
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Nível de Acesso</Label>
                      <Select
                        value={activePlan.accessLevelId}
                        onValueChange={(value) => updatePlan(activePlan.id, (current) => applyAccessLevelToPlan(current, value))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {state.accessLevels.map((level) => (
                            <SelectItem key={level.id} value={level.id}>{level.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <Label>Plano Ativo</Label>
                  <Switch
                    checked={activePlan.isActive}
                    onCheckedChange={(checked) => updatePlan(activePlan.id, (current) => ({ ...current, isActive: checked }))}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <Label>Mostrar na Home</Label>
                  <Switch
                    checked={activePlan.visibleOnHome}
                    onCheckedChange={(checked) => updatePlan(activePlan.id, (current) => ({ ...current, visibleOnHome: checked }))}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <Label>Mostrar para Cliente</Label>
                  <Switch
                    checked={activePlan.visibleInAccount}
                    onCheckedChange={(checked) => updatePlan(activePlan.id, (current) => ({ ...current, visibleInAccount: checked }))}
                  />
                </div>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="admin-card-title">Textos Exibidos ao Cliente</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1">
                    <Label>Descrição do Plano (exibida na Home e na área do cliente)</Label>
                    <Textarea
                      rows={2}
                      placeholder="Ex: Ideal para quem está começando a automatizar suas vendas."
                      value={activePlan.homeDescription || ""}
                      onChange={(event) => updatePlan(activePlan.id, (current) => ({
                        ...current,
                        homeDescription: event.target.value,
                        accountDescription: event.target.value,
                      }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Itens de Recursos (Home e área do cliente, 1 por linha)</Label>
                    <Textarea
                      rows={6}
                      value={(activePlan.homeFeatureHighlights || []).join("\n")}
                      onChange={(event) => updatePlan(activePlan.id, (current) => ({
                        ...current,
                        homeFeatureHighlights: parseFeatureHighlightsText(event.target.value),
                      }))}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setActivePlanId(null)}>Fechar</Button>
            <Button onClick={savePlans} disabled={!hasChanges}>Salvar Alterações</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Criar Plano</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label>Nome do Plano</Label>
                <Input value={newPlan.name} onChange={(event) => setNewPlan((prev) => ({ ...prev, name: event.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Preço Cobrado na Assinatura</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={newPlan.price}
                  onChange={(event) => setNewPlan((prev) => ({ ...prev, price: Number(event.target.value || 0) }))}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>Período Total do Plano (dias)</Label>
                <Input
                  type="number"
                  min={1}
                  value={newPlan.periodDays}
                  onChange={(event) => setNewPlan((prev) => ({ ...prev, periodDays: Number(event.target.value || 0) }))}
                  placeholder="Ex: 30"
                />
              </div>
              <div className="space-y-1">
                <Label>Cobrança</Label>
                <Select
                  value={newPlan.billingPeriod}
                  onValueChange={(value) => setNewPlan((prev) => ({
                    ...prev,
                    billingPeriod: value as "monthly" | "annual",
                    periodDays: value === "annual" ? 365 : 30,
                  }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Mensal</SelectItem>
                    <SelectItem value="annual">Anual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Nível de Acesso</Label>
                <Select value={newPlan.accessLevelId} onValueChange={(value) => setNewPlan((prev) => ({ ...prev, accessLevelId: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {state.accessLevels.map((level) => (
                      <SelectItem key={level.id} value={level.id}>{level.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {newPlan.billingPeriod === "annual" && (
              <div className="space-y-1">
                <Label>Preço Mensal Equivalente (exibido no card)</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="Ex: 64.17"
                  value={newPlan.monthlyEquivalentPrice}
                  onChange={(event) => setNewPlan((prev) => ({
                    ...prev,
                    monthlyEquivalentPrice: event.target.value ? Number(event.target.value) : "",
                  }))}
                />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <Label>Plano Ativo</Label>
                <Switch checked={newPlan.isActive} onCheckedChange={(checked) => setNewPlan((prev) => ({ ...prev, isActive: checked }))} />
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <Label>Mostrar na Home</Label>
                <Switch checked={newPlan.visibleOnHome} onCheckedChange={(checked) => setNewPlan((prev) => ({ ...prev, visibleOnHome: checked }))} />
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <Label>Mostrar para Cliente</Label>
                <Switch checked={newPlan.visibleInAccount} onCheckedChange={(checked) => setNewPlan((prev) => ({ ...prev, visibleInAccount: checked }))} />
              </div>
            </div>

            <div className="space-y-1">
              <Label>Itens de recursos (Home e área do cliente, 1 por linha)</Label>
              <Textarea
                rows={6}
                value={newPlan.homeFeatureHighlightsText}
                onChange={(event) => setNewPlan((prev) => ({ ...prev, homeFeatureHighlightsText: event.target.value }))}
              />
              {newPlan.homeFeatureHighlightsText.split(/\r?\n/).filter(Boolean).length > 10 && (
                <p className="text-xs text-amber-500">Máximo de 10 itens. Os excedentes serão descartados ao salvar.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateModal(false)}>Fechar</Button>
            <Button onClick={createPlan}>Adicionar Plano</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deletePlanTarget} onOpenChange={(open) => !open && setDeletePlanTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Plano?</AlertDialogTitle>
            <AlertDialogDescription>
              O plano <strong>{deletePlanTarget?.name}</strong> será removido do rascunho. Esta ação não afeta usuários já vinculados até que você salve as alterações.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmRemovePlan}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
