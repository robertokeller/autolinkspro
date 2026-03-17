import {
  applyAccessLevelLimits,
  emptyLimitOverrides,
  loadAdminControlPlaneState,
  type AccessLimitOverrides,
  type FeatureAccessMode,
  type AppFeature,
} from "@/lib/admin-control-plane";
import type { PlanLimits } from "@/lib/plans";

export type { AppFeature } from "@/lib/admin-control-plane";

export interface FeatureAccessPolicy {
  mode: FeatureAccessMode;
  blockedMessage: string;
  hasCapacity: boolean;
  enabled: boolean;
}

export interface EffectiveOperationalLimits {
  whatsappSessions: number;
  telegramSessions: number;
  automations: number;
  routes: number;
  schedules: number;
  whatsappGroups: number;
  telegramGroups: number;
}

function applyOperationalNumericLimit(baseValue: number, overrideValue: number | null | undefined): number {
  if (overrideValue == null) return baseValue;
  if (baseValue === -1) return overrideValue;
  if (overrideValue === -1) return baseValue;
  return Math.min(baseValue, overrideValue);
}

function resolvePlatformGroupLimit(baseGroupLimit: number, overrides: AccessLimitOverrides, platform: "whatsapp" | "telegram") {
  const overrideValue = platform === "whatsapp"
    ? overrides.whatsappGroups
    : overrides.telegramGroups;

  // If no explicit per-platform override, derive from the destination pools:
  // the user needs at most max(poolAuto, poolRoute) registered groups.
  if (overrideValue == null) {
    const poolAuto = overrides.groupsPerAutomation;
    const poolRoute = overrides.groupsPerRoute;
    if (poolAuto != null || poolRoute != null) {
      if (poolAuto === -1 || poolRoute === -1) return baseGroupLimit; // unlimited pools → use plan base
      const derived = Math.max(poolAuto ?? 0, poolRoute ?? 0);
      return applyOperationalNumericLimit(baseGroupLimit, derived);
    }
  }

  return applyOperationalNumericLimit(baseGroupLimit, overrideValue);
}

function hasPositiveLimit(limit: number) {
  return limit === -1 || limit > 0;
}

function hasFeatureCapacity(feature: AppFeature, limits: PlanLimits) {
  switch (feature) {
    case "telegramConnections":
      return hasPositiveLimit(limits.telegramSessions);
    case "mercadoLivre":
      return hasPositiveLimit(limits.meliSessions);
    case "shopeeAutomations":
      return hasPositiveLimit(limits.automations);
    case "templates":
      return hasPositiveLimit(limits.templates);
    case "routes":
      return hasPositiveLimit(limits.routes);
    case "schedules":
      return hasPositiveLimit(limits.schedules);
    case "linkHub":
      return limits.linkHub;
    default:
      return false;
  }
}

export function resolveEffectiveLimitsByPlanId(planId?: string | null): PlanLimits | null {
  const state = loadAdminControlPlaneState();
  const activePlans = state.plans.filter((plan) => plan.isActive);
  const catalog = activePlans.length > 0 ? activePlans : state.plans;
  const plan = catalog.find((item) => item.id === planId) || catalog[0];
  if (!plan) return null;
  const accessLevel = state.accessLevels.find((level) => level.id === plan.accessLevelId);
  if (!accessLevel) return plan.limits;
  return applyAccessLevelLimits(plan.limits, accessLevel.limitOverrides);
}

export function resolveEffectiveOperationalLimitsByPlanId(planId?: string | null): EffectiveOperationalLimits | null {
  const state = loadAdminControlPlaneState();
  const activePlans = state.plans.filter((plan) => plan.isActive);
  const catalog = activePlans.length > 0 ? activePlans : state.plans;
  const plan = catalog.find((item) => item.id === planId) || catalog[0];
  if (!plan) return null;

  const accessLevel = state.accessLevels.find((level) => level.id === plan.accessLevelId);
  const overrides = accessLevel?.limitOverrides;
  const base = plan.limits;

  return {
    whatsappSessions: applyOperationalNumericLimit(base.whatsappSessions, overrides?.whatsappSessions),
    telegramSessions: applyOperationalNumericLimit(base.telegramSessions, overrides?.telegramSessions),
    automations: applyOperationalNumericLimit(base.automations, overrides?.automations),
    routes: applyOperationalNumericLimit(base.routes, overrides?.routes),
    schedules: applyOperationalNumericLimit(base.schedules, overrides?.schedules),
    whatsappGroups: resolvePlatformGroupLimit(base.groups, overrides || emptyLimitOverrides(), "whatsapp"),
    telegramGroups: resolvePlatformGroupLimit(base.groups, overrides || emptyLimitOverrides(), "telegram"),
  };
}

export function resolvePlan(planId?: string | null) {
  const state = loadAdminControlPlaneState();
  const activePlans = state.plans.filter((plan) => plan.isActive);
  const catalog = activePlans.length > 0 ? activePlans : state.plans;
  return catalog.find((plan) => plan.id === planId) || catalog[0];
}

export function isFeatureEnabledByPlan(feature: AppFeature, planId?: string | null) {
  return getFeatureAccessPolicyByPlan(feature, planId).enabled;
}

export function getFeatureAccessPolicyByPlan(feature: AppFeature, planId?: string | null): FeatureAccessPolicy {
  const state = loadAdminControlPlaneState();
  const plan = resolvePlan(planId);
  if (!plan) {
    return {
      mode: "hidden",
      blockedMessage: "Este recurso não está disponível para sua conta.",
      hasCapacity: false,
      enabled: false,
    };
  }

  const effectiveLimits = resolveEffectiveLimitsByPlanId(planId);
  const hasCapacity = hasFeatureCapacity(feature, effectiveLimits || plan.limits);

  const accessLevel = state.accessLevels.find((level) => level.id === plan.accessLevelId);
  const featureRule = accessLevel?.featureRules?.[feature];

  if (!featureRule) {
    return {
      mode: "hidden",
      blockedMessage: "Este recurso não está disponível para sua conta.",
      hasCapacity,
      enabled: false,
    };
  }

  // If the access level explicitly grants the feature, respect that decision.
  // hasCapacity is returned for informational use but does not veto an intentional
  // admin grant — the admin knows the plan's limits when they configure the level.
  const enabled = featureRule.mode === "enabled";

  return {
    mode: featureRule.mode,
    blockedMessage: featureRule.blockedMessage,
    hasCapacity,
    enabled,
  };
}
