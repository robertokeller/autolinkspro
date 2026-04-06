import { getPlanFeatureList, plans as staticPlans, type Plan, type PlanLimits } from "@/lib/plans";
import { loadAdminConfig, saveAdminConfig, subscribeLocalDbChanges } from "@/integrations/backend/local-core";

export type AppFeature =
  | "telegramConnections"
  | "mercadoLivre"
  | "amazon"
  | "shopeeAutomations"
  | "templates"
  | "routes"
  | "schedules"
  | "linkHub";

export type FeatureAccessMode = "enabled" | "hidden" | "blocked";

export interface FeatureAccessRule {
  mode: FeatureAccessMode;
  blockedMessage: string;
}

export type FeatureAccessMap = Record<AppFeature, FeatureAccessRule>;

export interface AccessLimitOverrides {
  whatsappSessions: number | null;
  telegramSessions: number | null;
  whatsappGroups: number | null;
  telegramGroups: number | null;
  routes: number | null;
  automations: number | null;
  schedules: number | null;
  groupsPerAutomation: number | null;
  groupsPerRoute: number | null;
}

export interface AccessLevel {
  id: string;
  name: string;
  description: string;
  featureRules: FeatureAccessMap;
  limitOverrides: AccessLimitOverrides;
  permissions: AppFeature[];
  isSystem?: boolean;
}

export interface ManagedPlan extends Plan {
  accessLevelId: string;
  visibleOnHome: boolean;
  visibleInAccount: boolean;
  sortOrder: number;
  homeTitle: string;
  homeDescription: string;
  homeCtaText: string;
  homeFeatureHighlights: string[];
  accountTitle: string;
  accountDescription: string;
  // billingPeriod and monthlyEquivalentPrice are inherited from Plan
  /** Base limits before access level caps are applied. Admin-editable. */
  baseLimits?: PlanLimits;
}

export interface AdminControlPlaneState {
  version: number;
  updatedAt: string;
  accessLevels: AccessLevel[];
  plans: ManagedPlan[];
  defaultSignupPlanId: string;
}

// STORAGE_KEY removed — admin config is now embedded in the unified LocalDatabase (autolinks_local_db_v2).

const DEFAULT_FEATURES: AppFeature[] = [
  "telegramConnections",
  "mercadoLivre",
  "amazon",
  "shopeeAutomations",
  "templates",
  "routes",
  "schedules",
  "linkHub",
];

const DEFAULT_BLOCKED_MESSAGE = "Este recurso não está disponível no seu nível de acesso atual. Solicite ajuste de nível para liberar o acesso.";

function defaultFeatureRule(mode: FeatureAccessMode = "hidden"): FeatureAccessRule {
  return {
    mode,
    blockedMessage: DEFAULT_BLOCKED_MESSAGE,
  };
}

function buildFeatureAccessMap(enabled: AppFeature[]): FeatureAccessMap {
  const enabledSet = new Set(enabled);
  return DEFAULT_FEATURES.reduce((acc, feature) => {
    acc[feature] = defaultFeatureRule(enabledSet.has(feature) ? "enabled" : "hidden");
    return acc;
  }, {} as FeatureAccessMap);
}

export function emptyLimitOverrides(): AccessLimitOverrides {
  return {
    whatsappSessions: null,
    telegramSessions: null,
    whatsappGroups: null,
    telegramGroups: null,
    routes: null,
    automations: null,
    schedules: null,
    groupsPerAutomation: null,
    groupsPerRoute: null,
  };
}

function normalizeLimitNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < -1) return -1;
  return parsed;
}

function normalizeLimitOverrides(input: unknown): AccessLimitOverrides {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

  // Backward compatibility: old state had a single `groups` limit.
  const legacyGroups = normalizeLimitNumber(source.groups);

  return {
    whatsappSessions: normalizeLimitNumber(source.whatsappSessions),
    telegramSessions: normalizeLimitNumber(source.telegramSessions),
    whatsappGroups: normalizeLimitNumber(source.whatsappGroups) ?? legacyGroups,
    telegramGroups: normalizeLimitNumber(source.telegramGroups) ?? legacyGroups,
    routes: normalizeLimitNumber(source.routes),
    automations: normalizeLimitNumber(source.automations),
    schedules: normalizeLimitNumber(source.schedules),
    groupsPerAutomation: normalizeLimitNumber(source.groupsPerAutomation),
    groupsPerRoute: normalizeLimitNumber(source.groupsPerRoute),
  };
}

function applyNumericLimit(planValue: number, overrideValue: number | null): number {
  if (overrideValue == null) return planValue;
  if (planValue === -1) return overrideValue;
  if (overrideValue === -1) return planValue;
  return Math.min(planValue, overrideValue);
}

export function applyAccessLevelLimits(baseLimits: PlanLimits, overrides: AccessLimitOverrides): PlanLimits {
  // Registration cap: prefer explicit WA/TG overrides; otherwise derive from the destination pools.
  // Using max(poolAuto, poolRoute) because the same groups can serve both purposes.
  const mergedGroupOverride = (() => {
    const wa = overrides.whatsappGroups;
    const tg = overrides.telegramGroups;
    if (wa != null || tg != null) {
      // Explicit override provided
      if (wa == null) return tg;
      if (tg == null) return wa;
      if (wa === -1) return tg;
      if (tg === -1) return wa;
      return Math.min(wa, tg);
    }
    // No explicit override — derive from pools
    const poolAuto = overrides.groupsPerAutomation;
    const poolRoute = overrides.groupsPerRoute;
    if (poolAuto == null && poolRoute == null) return null;
    if (poolAuto === -1 || poolRoute === -1) return null; // unlimited pools → no registration cap
    return Math.max(poolAuto ?? 0, poolRoute ?? 0);
  })();

  return {
    whatsappSessions: applyNumericLimit(baseLimits.whatsappSessions, overrides.whatsappSessions),
    telegramSessions: applyNumericLimit(baseLimits.telegramSessions, overrides.telegramSessions),
    meliSessions: baseLimits.meliSessions,
    meliAutomations: baseLimits.meliAutomations,
    groups: applyNumericLimit(baseLimits.groups, mergedGroupOverride),
    routes: applyNumericLimit(baseLimits.routes, overrides.routes),
    automations: applyNumericLimit(baseLimits.automations, overrides.automations),
    schedules: applyNumericLimit(baseLimits.schedules, overrides.schedules),
    templates: baseLimits.templates,
    masterGroups: baseLimits.masterGroups,
    groupsPerAutomation: applyNumericLimit(baseLimits.groupsPerAutomation, overrides.groupsPerAutomation),
    groupsPerRoute: applyNumericLimit(baseLimits.groupsPerRoute, overrides.groupsPerRoute),
    bulkSend: baseLimits.bulkSend,
    linkHub: baseLimits.linkHub,
  };
}

function normalizeFeatureAccessMap(input: unknown, fallbackPermissions: AppFeature[]): FeatureAccessMap {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

  const fallback = buildFeatureAccessMap(fallbackPermissions);

  return DEFAULT_FEATURES.reduce((acc, feature) => {
    const raw = source[feature];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      // Backward compat: if 'amazon' rule is not stored, inherit from 'mercadoLivre'.
      if (feature === "amazon") {
        const mlRaw = source["mercadoLivre"];
        if (mlRaw && typeof mlRaw === "object" && !Array.isArray(mlRaw)) {
          const mlRow = mlRaw as Record<string, unknown>;
          const derivedMode = mlRow.mode === "enabled" || mlRow.mode === "hidden" || mlRow.mode === "blocked"
            ? mlRow.mode
            : fallback[feature].mode;
          acc[feature] = { mode: derivedMode, blockedMessage: DEFAULT_BLOCKED_MESSAGE };
          return acc;
        }
      }
      acc[feature] = fallback[feature];
      return acc;
    }

    const row = raw as Record<string, unknown>;
    const mode = row.mode === "enabled" || row.mode === "hidden" || row.mode === "blocked"
      ? row.mode
      : fallback[feature].mode;
    const blockedMessage = typeof row.blockedMessage === "string" && row.blockedMessage.trim()
      ? row.blockedMessage.trim()
      : DEFAULT_BLOCKED_MESSAGE;

    acc[feature] = { mode, blockedMessage };
    return acc;
  }, {} as FeatureAccessMap);
}

const DEFAULT_ACCESS_LEVELS: AccessLevel[] = [
  {
    id: "level-starter",
    name: "Starter",
    description: "WhatsApp + Shopee (sem Telegram e sem Mercado Livre)",
    featureRules: buildFeatureAccessMap(["shopeeAutomations", "routes", "templates", "schedules", "linkHub"]),
    limitOverrides: emptyLimitOverrides(),
    permissions: ["shopeeAutomations", "routes", "templates", "schedules", "linkHub"],
    isSystem: true,
  },
  {
    id: "level-pro",
    name: "Pro",
    description: "WhatsApp + Telegram + Shopee (sem Mercado Livre)",
    featureRules: buildFeatureAccessMap(["telegramConnections", "shopeeAutomations", "templates", "routes", "schedules", "linkHub"]),
    limitOverrides: emptyLimitOverrides(),
    permissions: ["telegramConnections", "shopeeAutomations", "templates", "routes", "schedules", "linkHub"],
    isSystem: true,
  },
  {
    id: "level-business",
    name: "Business",
    description: "Todos os recursos incluindo Mercado Livre e Amazon",
    featureRules: buildFeatureAccessMap(["telegramConnections", "mercadoLivre", "amazon", "shopeeAutomations", "templates", "routes", "schedules", "linkHub"]),
    limitOverrides: emptyLimitOverrides(),
    permissions: ["telegramConnections", "mercadoLivre", "amazon", "shopeeAutomations", "templates", "routes", "schedules", "linkHub"],
    isSystem: true,
  },
];

function nowIso() {
  return new Date().toISOString();
}

function ensureUniqueFeatures(features: AppFeature[]): AppFeature[] {
  const set = new Set<AppFeature>();
  for (const feature of features) {
    if (DEFAULT_FEATURES.includes(feature)) {
      set.add(feature);
    }
  }
  return [...set];
}

function pickDefaultAccessForPlan(planId: string) {
  if (planId === "plan-starter") return "level-business"; // trial gets all features
  if (planId === "plan-start" || planId === "plan-start-annual") return "level-starter";
  if (planId === "plan-pro" || planId === "plan-pro-annual") return "level-pro";
  if (planId === "plan-business" || planId === "plan-business-annual") return "level-business";
  return "level-business";
}

const DEFAULT_PLAN_HIGHLIGHTS: Record<string, string[]> = {
  "plan-starter": [
    "Todos os recursos desbloqueados por 7 dias",
    "WhatsApp + Telegram + Shopee + Mercado Livre",
    "Sem cartão de crédito necessário",
    "Cancele quando quiser",
  ],
  "plan-start": [
    "1 número WhatsApp conectado",
    "Automações Shopee (2 auto × 3 grupos)",
    "Rotas de monitoramento (2 rotas × 3 grupos)",
    "Conversor Universal de links afiliados",
    "Agendamentos ilimitados",
    "Link Hub incluso",
  ],
  "plan-pro": [
    "2 WhatsApp + 1 Telegram conectados",
    "Automações Shopee (5 auto × 5 grupos)",
    "Rotas de monitoramento (10 rotas × 5 grupos)",
    "Vitrine + Pesquisa de Ofertas Shopee",
    "Master Groups (até 3)",
    "Templates e Agendamentos ilimitados",
  ],
  "plan-business": [
    "5 WhatsApp + 5 Telegram conectados",
    "Automações e Rotas ilimitadas",
    "Mercado Livre integrado (automatizações ∞)",
    "Master Groups ilimitados",
    "Templates ilimitados",
    "Operação sem limites",
  ],
};

const DEFAULT_PLAN_DESCRIPTIONS: Record<string, string> = {
  "plan-starter": "Teste todos os recursos gratuitamente. Sem cartão de crédito necessário.",
  "plan-start": "Para afiliados começando. WhatsApp + automações Shopee no piloto automático.",
  "plan-start-annual": "Para afiliados começando. WhatsApp + Shopee no automático. Economize 2 meses pagando anualmente.",
  "plan-pro": "Para afiliados sérios. WhatsApp, Telegram e Shopee em um painel completo.",
  "plan-pro-annual": "WhatsApp, Telegram e Shopee em um painel completo. Economize 2 meses pagando anualmente.",
  "plan-business": "Operação profissional. Todos os canais, Mercado Livre e sem limites.",
  "plan-business-annual": "Operação profissional completa. Todos os canais e recursos. Economize 2 meses pagando anualmente.",
};

function defaultManagedPlans(): ManagedPlan[] {
  return staticPlans.map((plan, index) => {
    // Annual plans reuse the highlights from their monthly counterpart
    const highlightKey = plan.id.replace("-annual", "");
    const highlights = DEFAULT_PLAN_HIGHLIGHTS[highlightKey] || getPlanFeatureList(plan).slice(0, 6);
    const description = DEFAULT_PLAN_DESCRIPTIONS[plan.id] || "Plano ideal para sua operacao atual.";
    // Trial and annual plans are not shown on home or in account selection
    const isTrial = plan.id === "plan-starter";
    const isAnnual = plan.billingPeriod === "annual";
    return {
      ...plan,
      accessLevelId: pickDefaultAccessForPlan(plan.id),
      visibleOnHome: plan.isActive && !isTrial,
      visibleInAccount: plan.isActive && !isTrial,
      sortOrder: index,
      homeTitle: plan.name,
      homeDescription: description,
      homeCtaText: plan.price === 0 ? "Criar conta grátis" : `Assinar ${plan.name}`,
      homeFeatureHighlights: isAnnual
        ? [...highlights, "✓ 2 meses grátis (economia de 17%)"]
        : highlights,
      accountTitle: plan.name,
      accountDescription: description,
      baseLimits: { ...plan.limits },
    };
  });
}

export function defaultAdminControlPlaneState(): AdminControlPlaneState {
  const plans = defaultManagedPlans();
  const defaultSignupPlan = plans.find((plan) => plan.isActive) || plans[0];
  return {
    version: 1,
    updatedAt: nowIso(),
    accessLevels: DEFAULT_ACCESS_LEVELS,
    plans,
    defaultSignupPlanId: defaultSignupPlan?.id || "plan-starter",
  };
}

function normalizeLimits(limits: Partial<PlanLimits> | undefined, fallback: PlanLimits): PlanLimits {
  return {
    whatsappSessions: Number(limits?.whatsappSessions ?? fallback.whatsappSessions),
    telegramSessions: Number(limits?.telegramSessions ?? fallback.telegramSessions),
    meliSessions: Number(limits?.meliSessions ?? fallback.meliSessions),
    meliAutomations: Number(limits?.meliAutomations ?? fallback.meliAutomations),
    groups: Number(limits?.groups ?? fallback.groups),
    routes: Number(limits?.routes ?? fallback.routes),
    automations: Number(limits?.automations ?? fallback.automations),
    schedules: Number(limits?.schedules ?? fallback.schedules),
    templates: Number(limits?.templates ?? fallback.templates),
    masterGroups: Number(limits?.masterGroups ?? fallback.masterGroups),
    groupsPerAutomation: Number(limits?.groupsPerAutomation ?? fallback.groupsPerAutomation),
    groupsPerRoute: Number(limits?.groupsPerRoute ?? fallback.groupsPerRoute),
    bulkSend: Boolean(limits?.bulkSend ?? fallback.bulkSend),
    linkHub: Boolean(limits?.linkHub ?? fallback.linkHub),
  };
}

export function normalizeAdminControlPlaneState(input: AdminControlPlaneState | null | undefined): AdminControlPlaneState {
  const fallback = defaultAdminControlPlaneState();
  if (!input) return fallback;

  const levels = Array.isArray(input.accessLevels)
    ? input.accessLevels
      .filter((level) => level && typeof level.id === "string" && level.id.trim())
      .map((level) => {
        const legacyPermissions = ensureUniqueFeatures(Array.isArray(level.permissions) ? level.permissions : []);
        const featureRules = normalizeFeatureAccessMap(level.featureRules, legacyPermissions);
        const permissions = DEFAULT_FEATURES.filter((feature) => featureRules[feature].mode === "enabled");
        return {
          id: String(level.id),
          name: String(level.name || "Nível"),
          description: String(level.description || ""),
          permissions,
          featureRules,
          limitOverrides: normalizeLimitOverrides(level.limitOverrides),
          isSystem: level.isSystem === true,
        };
      })
    : [];

  const safeLevels = levels.length > 0 ? levels : fallback.accessLevels;
  const safeLevelIds = new Set(safeLevels.map((level) => level.id));

  const plans = Array.isArray(input.plans)
    ? input.plans
      .filter((plan) => plan && typeof plan.id === "string" && plan.id.trim())
      .map((plan, index) => {
        const basePlan = staticPlans.find((item) => item.id === plan.id) || staticPlans[0];
        const storedBaseLimits = (plan as { baseLimits?: Partial<PlanLimits> }).baseLimits;
        const baseLimits = normalizeLimits(storedBaseLimits ?? plan.limits, basePlan.limits);
        return {
          id: String(plan.id),
          name: String(plan.name || basePlan.name),
          price: Number(plan.price ?? basePlan.price),
          period: String(plan.period || basePlan.period),
          limits: normalizeLimits(plan.limits, basePlan.limits),
          isActive: Boolean(plan.isActive ?? basePlan.isActive),
          accessLevelId: safeLevelIds.has(String(plan.accessLevelId))
            ? String(plan.accessLevelId)
            : pickDefaultAccessForPlan(String(plan.id)),
          visibleOnHome: Boolean(plan.visibleOnHome ?? true),
          visibleInAccount: Boolean(plan.visibleInAccount ?? true),
          sortOrder: Number(plan.sortOrder ?? index),
          homeTitle: String(plan.homeTitle || plan.name || basePlan.name),
          homeDescription: String(plan.homeDescription || "Plano ideal para sua operacao atual."),
          homeCtaText: String(plan.homeCtaText || (Number(plan.price ?? basePlan.price) === 0 ? "Comecar gratis" : `Assinar ${String(plan.name || basePlan.name)}`)),
          homeFeatureHighlights: Array.isArray(plan.homeFeatureHighlights)
            ? plan.homeFeatureHighlights
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 10)
            : getPlanFeatureList({
                id: String(plan.id || basePlan.id),
                name: String(plan.name || basePlan.name),
                price: Number(plan.price ?? basePlan.price),
                period: String(plan.period || basePlan.period),
                billingPeriod: (plan.billingPeriod === "monthly" || plan.billingPeriod === "annual")
                  ? plan.billingPeriod
                  : (basePlan.billingPeriod ?? "monthly"),
                monthlyEquivalentPrice: typeof plan.monthlyEquivalentPrice === "number"
                  ? plan.monthlyEquivalentPrice
                  : basePlan.monthlyEquivalentPrice,
                limits: normalizeLimits(plan.limits, basePlan.limits),
                isActive: Boolean(plan.isActive ?? basePlan.isActive),
              }).slice(0, 6),
          accountTitle: String(plan.accountTitle || plan.name || basePlan.name),
          accountDescription: String(plan.accountDescription || "Seu plano atual e os limites disponiveis para uso."),
          billingPeriod: (plan.billingPeriod === "monthly" || plan.billingPeriod === "annual")
            ? plan.billingPeriod
            : (basePlan.billingPeriod ?? "monthly"),
          monthlyEquivalentPrice: typeof plan.monthlyEquivalentPrice === "number"
            ? plan.monthlyEquivalentPrice
            : basePlan.monthlyEquivalentPrice,
          baseLimits,
        };
      })
    : [];

  const safePlans = plans.length > 0 ? plans : fallback.plans;
  const safeDefaultSignupPlanId = (() => {
    const candidate = typeof input.defaultSignupPlanId === "string" ? input.defaultSignupPlanId : "";
    if (candidate && safePlans.some((plan) => plan.id === candidate)) return candidate;
    const firstActive = safePlans.find((plan) => plan.isActive);
    return firstActive?.id || safePlans[0]?.id || "plan-starter";
  })();

  return {
    version: 1,
    updatedAt: input.updatedAt || nowIso(),
    accessLevels: safeLevels,
    plans: [...safePlans].sort((a, b) => a.sortOrder - b.sortOrder),
    defaultSignupPlanId: safeDefaultSignupPlanId,
  };
}

export function loadAdminControlPlaneState(): AdminControlPlaneState {
  // F08 NOTE: The admin config lives in the unified local database (autolinks_local_db_v2).
  // There is no separate localStorage key — everything is in one place.
  const config = loadAdminConfig();
  return normalizeAdminControlPlaneState(config as unknown as AdminControlPlaneState | null | undefined);
}

export async function saveAdminControlPlaneState(state: AdminControlPlaneState): Promise<AdminControlPlaneState> {
  const normalized = normalizeAdminControlPlaneState({ ...state, updatedAt: new Date().toISOString() });
  await saveAdminConfig(normalized as unknown as Record<string, unknown>);
  return normalized;
}

export function subscribeAdminControlPlane(onChange: () => void) {
  // Delegates to the unified DB event system — one event covers all changes.
  return subscribeLocalDbChanges(onChange);
}
