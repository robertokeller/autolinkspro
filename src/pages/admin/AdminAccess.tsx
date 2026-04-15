import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
import {
  applyAccessLevelLimits,
  emptyLimitOverrides,
  type AccessLevel,
  type AccessLimitOverrides,
  type AppFeature,
  type FeatureAccessMap,
  type FeatureAccessMode,
} from "@/lib/admin-control-plane";
import { appendAdminAudit, triggerGlobalResyncPulse } from "@/lib/admin-shared";
import { getPlanFeatureList } from "@/lib/plans";

const FEATURE_OPTIONS: Array<{ id: AppFeature; label: string }> = [
  { id: "telegramConnections", label: "Conexões Telegram" },
  { id: "mercadoLivre", label: "Mercado Livre" },
  { id: "amazon", label: "Amazon" },
  { id: "shopeeAutomations", label: "Automações Shopee" },
  { id: "templates", label: "Templates" },
  { id: "routes", label: "Rotas" },
  { id: "schedules", label: "Agendamentos" },
  { id: "linkHub", label: "Link Hub" },
];

// Limit fields organized in 3 sections for the edit dialog.
// Each entry: key = AccessLimitOverrides field, label = UI label, hint = optional inline example.
const RESOURCE_LIMIT_SECTIONS: Array<{
  heading: string;
  subtext?: string;
  cols: 2 | 3;
  fields: Array<{ key: keyof AccessLimitOverrides; label: string; hint?: string }>;
}> = [
  {
    heading: "Sessões",
    cols: 2,
    fields: [
      { key: "whatsappSessions", label: "WhatsApp" },
      { key: "telegramSessions", label: "Telegram" },
    ],
  },
  {
    heading: "Contadores",
    cols: 3,
    fields: [
      { key: "automations", label: "Automações" },
      { key: "routes", label: "Rotas" },
      { key: "schedules", label: "Agendamentos" },
    ],
  },
  {
    heading: "Grupos de destino",
    subtext: "Total de grupos somando todas as automações ou rotas do usuário (não é por item). O limite de cadastro vem do maior valor entre os dois.",
    cols: 2,
    fields: [
      {
        key: "groupsPerAutomation",
        label: "Cota em Automações",
        hint: "Ex: 6 permite 3 automações × 2 grupos, ou 6 automações × 1 grupo.",
      },
      {
        key: "groupsPerRoute",
        label: "Cota em Rotas",
        hint: "Ex: 4 permite 2 rotas × 2 grupos, ou 4 rotas × 1 grupo.",
      },
    ],
  },
];

function cloneLevels(levels: AccessLevel[]) {
  return levels.map((level) => ({
    ...level,
    permissions: [...level.permissions],
    featureRules: JSON.parse(JSON.stringify(level.featureRules)) as FeatureAccessMap,
    limitOverrides: JSON.parse(JSON.stringify(level.limitOverrides)) as AccessLimitOverrides,
  }));
}

function buildFeatureRules(mode: FeatureAccessMode): FeatureAccessMap {
  return FEATURE_OPTIONS.reduce((acc, feature) => {
    acc[feature.id] = {
      mode,
      blockedMessage: "Esse recurso não tá liberado pro seu nível. Peça pra mudar o nível pra ter acesso.",
    };
    return acc;
  }, {} as FeatureAccessMap);
}

function permissionsFromRules(featureRules: FeatureAccessMap): AppFeature[] {
  return FEATURE_OPTIONS
    .filter((feature) => featureRules[feature.id]?.mode === "enabled")
    .map((feature) => feature.id);
}

function newAccessLevel(): AccessLevel {
  return {
    id: `level-${crypto.randomUUID().slice(0, 8)}`,
    name: "Novo Nível",
    description: "",
    featureRules: buildFeatureRules("hidden"),
    limitOverrides: emptyLimitOverrides(),
    permissions: [],
    isSystem: false,
  };
}

export default function AdminAccess() {
  const { state, saveState } = useAdminControlPlane();
  const [draftLevels, setDraftLevels] = useState<AccessLevel[]>(() => cloneLevels(state.accessLevels));
  const [activeLevelId, setActiveLevelId] = useState<string | null>(null);
  const [deleteLevelTarget, setDeleteLevelTarget] = useState<AccessLevel | null>(null);

  useEffect(() => {
    setDraftLevels(cloneLevels(state.accessLevels));
  }, [state.accessLevels]);

  const hasChanges = useMemo(
    () => JSON.stringify(draftLevels) !== JSON.stringify(state.accessLevels),
    [draftLevels, state.accessLevels],
  );

  const activeLevel = useMemo(
    () => draftLevels.find((level) => level.id === activeLevelId) || null,
    [activeLevelId, draftLevels],
  );

  const updateLevel = (levelId: string, updater: (level: AccessLevel) => AccessLevel) => {
    setDraftLevels((prev) => prev.map((level) => (level.id === levelId ? updater(level) : level)));
  };

  const setFeatureMode = (levelId: string, feature: AppFeature, mode: FeatureAccessMode) => {
    updateLevel(levelId, (current) => {
      const featureRules: FeatureAccessMap = {
        ...current.featureRules,
        [feature]: {
          ...current.featureRules[feature],
          mode,
        },
      };
      return {
        ...current,
        featureRules,
        permissions: permissionsFromRules(featureRules),
      };
    });
  };

  const setFeatureBlockedMessage = (levelId: string, feature: AppFeature, blockedMessage: string) => {
    updateLevel(levelId, (current) => {
      const featureRules: FeatureAccessMap = {
        ...current.featureRules,
        [feature]: {
          ...current.featureRules[feature],
          blockedMessage,
        },
      };
      return {
        ...current,
        featureRules,
        permissions: permissionsFromRules(featureRules),
      };
    });
  };

  const setLimitNumber = (levelId: string, key: keyof AccessLimitOverrides, value: string) => {
    updateLevel(levelId, (current) => {
      const parsed = Number(value);
      return {
        ...current,
        limitOverrides: {
          ...current.limitOverrides,
          [key]: Number.isFinite(parsed) ? parsed : 0,
        },
      };
    });
  };

  const addLevel = () => {
    const level = newAccessLevel();
    setDraftLevels((prev) => [...prev, level]);
    setActiveLevelId(level.id);
  };

  const removeLevel = (levelId: string) => {
    if (draftLevels.length <= 1) {
      toast.error("Precisa ter pelo menos um nível");
      return;
    }
    const target = draftLevels.find((level) => level.id === levelId);
    if (target) setDeleteLevelTarget(target);
  };

  const confirmRemoveLevel = () => {
    if (!deleteLevelTarget) return;
    setDraftLevels((prev) => prev.filter((level) => level.id !== deleteLevelTarget.id));
    if (activeLevelId === deleteLevelTarget.id) setActiveLevelId(null);
    setDeleteLevelTarget(null);
    toast.success("Nível removido! Os planos ligados a ele vão mudar quando salvar.");
  };

  const saveLevels = async () => {
    const safeLevels = draftLevels.length > 0 ? draftLevels : [newAccessLevel()];
    const fallbackLevelId = safeLevels[0].id;
    const safeLevelById = new Map(safeLevels.map((level) => [level.id, level]));

    const syncedPlans = state.plans.map((plan) => {
      const boundLevel = safeLevelById.get(plan.accessLevelId) || safeLevels[0];
      const effectiveAccessLevelId = boundLevel.id;
      const baseLimits = plan.baseLimits || plan.limits;
      const limits = applyAccessLevelLimits(baseLimits, boundLevel.limitOverrides);
      const features = getPlanFeatureList({
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
        accessLevelId: effectiveAccessLevelId,
        limits,
        homeFeatureHighlights: features,
      };
    });

    const enabledFeatures = safeLevels.reduce((acc, level) => {
      return acc + Object.values(level.featureRules || {}).filter((rule) => rule.mode === "enabled").length;
    }, 0);

    try {
      await saveState({
        ...state,
        accessLevels: safeLevels.map((level) => ({
          ...level,
          permissions: permissionsFromRules(level.featureRules),
        })),
        plans: syncedPlans.map((plan) => ({
          ...plan,
          accessLevelId: safeLevels.some((level) => level.id === plan.accessLevelId)
            ? plan.accessLevelId
            : fallbackLevelId,
        })),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível salvar níveis de acesso");
      return;
    }

    triggerGlobalResyncPulse("admin-access-save");
    setActiveLevelId(null);

    try {
      await appendAdminAudit("update_access_levels", {
        levels: safeLevels.length,
        enabled_feature_rules: enabledFeatures,
      });
    } catch {
      // Audit log should not block the main save operation.
    }

    toast.success("Níveis salvos!");
  };

  const summarizeLevel = (level: AccessLevel) => {
    const rules = Object.values(level.featureRules || {});
    const enabled = rules.filter((rule) => rule.mode === "enabled").length;
    const hidden = rules.filter((rule) => rule.mode === "hidden").length;
    const blocked = rules.filter((rule) => rule.mode === "blocked").length;
    return { enabled, hidden, blocked };
  };

  return (
    <div className="admin-page">
      <PageHeader
        title="Controle de Acesso"
        description="Defina o que cada nível pode fazer e seus limites. Na aba Planos, é só vincular o nível."
      />

      <div className="admin-toolbar justify-center sm:justify-start">
        <Badge variant="outline">{draftLevels.length} níveis</Badge>
        <Button variant="outline" onClick={addLevel}>Novo Nível</Button>
        <Button onClick={saveLevels} disabled={!hasChanges}>Salvar Níveis</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {draftLevels.map((level) => {
          const summary = summarizeLevel(level);
          return (
            <Card
              key={level.id}
              className="admin-card transition hover:border-primary/40"
            >
              <CardHeader className="pb-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm font-semibold">{level.name}</CardTitle>
                  {level.isSystem && <Badge variant="default">Sistema</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="admin-kpi">
                    <p className="text-xs text-muted-foreground">Liberado</p>
                    <p className="font-medium">{summary.enabled}</p>
                  </div>
                  <div className="admin-kpi">
                    <p className="text-xs text-muted-foreground">Oculto</p>
                    <p className="font-medium">{summary.hidden}</p>
                  </div>
                  <div className="admin-kpi">
                    <p className="text-xs text-muted-foreground">Bloqueado</p>
                    <p className="font-medium">{summary.blocked}</p>
                  </div>
                </div>

                {(() => {
                  const ov = level.limitOverrides;
                  const fmt = (n: number | null) => n == null ? "—" : n === -1 ? "∞" : String(n);
                  return (
                    <p className="text-xs text-muted-foreground/70">
                      Auto: {fmt(ov.automations)} · Rotas: {fmt(ov.routes)} · G.auto: {fmt(ov.groupsPerAutomation)} · G.rota: {fmt(ov.groupsPerRoute)}
                    </p>
                  );
                })()}

                <div className="flex items-center justify-end gap-1 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setActiveLevelId(level.id)}
                    aria-label={`Editar nível ${level.name}`}
                    title="Editar nível"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeLevel(level.id)}
                    aria-label={`Excluir nível ${level.name}`}
                    title="Excluir nível"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={!!activeLevel} onOpenChange={(open) => !open && setActiveLevelId(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Ajustar Nível de Acesso</DialogTitle>
          </DialogHeader>
          {activeLevel && (
            <div className="space-y-4">
              {/* Nome */}
              <div className="space-y-1">
                <Label>Nome do Nível</Label>
                <Input
                  value={activeLevel.name}
                  onChange={(event) => updateLevel(activeLevel.id, (current) => ({ ...current, name: event.target.value }))}
                />
              </div>

              {/* Limites de recurso */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="admin-card-title">Limites</CardTitle>
                  <p className="text-xs text-muted-foreground">Use <strong>-1</strong> pra ilimitado · <strong>0</strong> bloqueia. O sistema usa o menor valor entre o plano e o que tá aqui.</p>
                </CardHeader>
                <CardContent className="space-y-5">
                  {RESOURCE_LIMIT_SECTIONS.map((section) => (
                    <div key={section.heading}>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{section.heading}</p>
                      {section.subtext && (
                        <p className="mb-2 text-2xs leading-snug text-muted-foreground/80">{section.subtext}</p>
                      )}
                      <div className={`grid items-end gap-3 ${section.cols === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
                        {section.fields.map((field) => {
                          const currentValue = activeLevel.limitOverrides[field.key];
                          return (
                            <div key={field.key} className="space-y-1">
                              <Label className="text-xs font-medium">{field.label}</Label>
                              {field.hint && (
                                <p className="text-2xs leading-tight text-muted-foreground">{field.hint}</p>
                              )}
                              <Input
                                type="number"
                                className="h-8"
                                placeholder="0"
                                value={String(currentValue == null ? 0 : currentValue)}
                                onChange={(event) => setLimitNumber(activeLevel.id, field.key, event.target.value)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}


                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="admin-card-title">Funcionalidades</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {FEATURE_OPTIONS.map((feature) => {
                    const rule = activeLevel.featureRules[feature.id];
                    return (
                      <div key={feature.id} className="space-y-2 rounded-md border px-3 py-2">
                        <div className="grid gap-2 sm:grid-cols-[1fr_160px] sm:items-center">
                          <p className="text-sm font-medium leading-tight">{feature.label}</p>
                          <Select
                            value={rule.mode}
                            onValueChange={(value) => setFeatureMode(activeLevel.id, feature.id, value as FeatureAccessMode)}
                          >
                            <SelectTrigger className="h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="enabled">Liberado</SelectItem>
                              <SelectItem value="hidden">Oculto</SelectItem>
                              <SelectItem value="blocked">Bloqueado</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {rule.mode === "blocked" && (
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Aviso de bloqueio</Label>
                            <Textarea
                              rows={2}
                              value={rule.blockedMessage}
                              onChange={(event) => setFeatureBlockedMessage(activeLevel.id, feature.id, event.target.value)}
                              placeholder="Ex: Peça pra mudar o nível pra liberar isso."
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setActiveLevelId(null)}>Fechar</Button>
            <Button onClick={saveLevels} disabled={!hasChanges}>Salvar Níveis</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteLevelTarget} onOpenChange={(open) => !open && setDeleteLevelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar nível?</AlertDialogTitle>
            <AlertDialogDescription>
              O nível <strong>{deleteLevelTarget?.name}</strong> vai ser removido.
              {(() => {
                const affected = state.plans.filter((plan) => plan.accessLevelId === deleteLevelTarget?.id);
                if (affected.length === 0) return " Nenhum plano ligado a esse nível.";
                return (
                  <span>
                    {" "}Esses planos vão pro primeiro nível disponível quando salvar:{" "}
                    <strong>{affected.map((plan) => plan.name).join(", ")}</strong>.
                  </span>
                );
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmRemoveLevel}
            >
              Apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
