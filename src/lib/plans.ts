/**
 * Static plan configuration - not stored in DB.
 * Used by Configuracoes.tsx, Admin pages, and Index.tsx.
 * When plans become dynamic, replace this with a DB table + hook.
 */
export interface PlanLimits {
  whatsappSessions: number;
  telegramSessions: number;
  meliSessions: number;
  meliAutomations: number;
  groups: number;
  routes: number;
  automations: number;
  schedules: number;
  templates: number;
  masterGroups: number;
  /** Total group destination slots allowed across ALL automations combined (-1 = unlimited) */
  groupsPerAutomation: number;
  /** Total group destination slots allowed across ALL routes combined (-1 = unlimited) */
  groupsPerRoute: number;
  bulkSend: boolean;
  linkHub: boolean;
}

/** All supported billing period types */
export type BillingPeriodType = "monthly" | "quarterly" | "semiannual" | "annual";

/** Days in each billing cycle */
export const PERIOD_DAYS: Record<BillingPeriodType, number> = {
  monthly: 30,
  quarterly: 90,
  semiannual: 180,
  annual: 365,
};

/** Human-readable label for each period */
export const PERIOD_LABELS: Record<BillingPeriodType, string> = {
  monthly: "Mensal",
  quarterly: "Trimestral",
  semiannual: "Semestral",
  annual: "Anual",
};

/** Per-period pricing and Kiwify config for a plan */
export interface PlanPeriodConfig {
  type: BillingPeriodType;
  /** Total price for this billing period */
  price: number;
  /** Monthly equivalent (for display — calculated automatically if not set) */
  monthlyEquivalentPrice?: number;
  /** Kiwify product ID for this period */
  kiwifyProductId?: string;
  /** Kiwify checkout URL for this period */
  kiwifyCheckoutUrl?: string;
  /** Whether this period variant is available for purchase */
  isActive: boolean;
}

export interface Plan {
  id: string;
  name: string;
  price: number;
  period: string;
  /** Primary billing period (kept for backward compat) */
  billingPeriod: BillingPeriodType;
  /** For annual plans: the monthly equivalent price to show in the UI */
  monthlyEquivalentPrice?: number;
  limits: PlanLimits;
  isActive: boolean;
  /** Kiwify product ID linked to this plan (set via admin mapping) */
  kiwifyProductId?: string;
  /** Kiwify checkout URL for purchasing this plan */
  kiwifyCheckoutUrl?: string;
  /** Per-period pricing configs (new model — 4 periods per plan) */
  periods?: PlanPeriodConfig[];
}

// ─── Shared limit sets ─────────────────────────────────────────────────────────

const TRIAL_LIMITS: PlanLimits = {
  whatsappSessions: 5, telegramSessions: 5, meliSessions: 1, meliAutomations: -1,
  groups: -1, routes: -1, automations: -1, schedules: -1, templates: -1, masterGroups: -1,
  groupsPerAutomation: -1, groupsPerRoute: -1, bulkSend: false, linkHub: true,
};

const START_LIMITS: PlanLimits = {
  whatsappSessions: 1, telegramSessions: 0, meliSessions: 0, meliAutomations: 0,
  groups: 15, routes: 2, automations: 2, schedules: -1, templates: 3, masterGroups: 0,
  // 2 automations × 3 groups = 6 total slots; 2 routes × 3 groups = 6 total slots
  groupsPerAutomation: 6, groupsPerRoute: 6, bulkSend: false, linkHub: true,
};

const PRO_LIMITS: PlanLimits = {
  whatsappSessions: 2, telegramSessions: 1, meliSessions: 0, meliAutomations: 0,
  groups: -1, routes: 10, automations: 5, schedules: -1, templates: 10, masterGroups: 3,
  // 5 automations × 5 groups = 25 total; 10 routes × 5 groups = 50 total
  groupsPerAutomation: 25, groupsPerRoute: 50, bulkSend: false, linkHub: true,
};

const BUSINESS_LIMITS: PlanLimits = {
  whatsappSessions: 5, telegramSessions: 5, meliSessions: 1, meliAutomations: -1,
  groups: -1, routes: -1, automations: -1, schedules: -1, templates: -1, masterGroups: -1,
  groupsPerAutomation: -1, groupsPerRoute: -1, bulkSend: false, linkHub: true,
};

// ─── Plan catalog ──────────────────────────────────────────────────────────────

export const plans: Plan[] = [
  // ── Trial (default for new signups — 7 days with everything unlocked) ─────────
  {
    id: "plan-starter", name: "Trial", price: 0, period: "7 dias",
    billingPeriod: "monthly",
    limits: TRIAL_LIMITS,
    isActive: true,
    periods: [],
  },

  // ── Start ─────────────────────────────────────────────────────────────────────
  {
    id: "plan-start", name: "Start", price: 77, period: "30 dias",
    billingPeriod: "monthly",
    limits: START_LIMITS,
    isActive: true,
    periods: [
      { type: "monthly",    price: 77,   isActive: true },
      { type: "quarterly",  price: 207,  monthlyEquivalentPrice: 69.00,  isActive: true },
      { type: "semiannual", price: 390,  monthlyEquivalentPrice: 65.00,  isActive: true },
      { type: "annual",     price: 770,  monthlyEquivalentPrice: 64.17,  isActive: true },
    ],
  },

  // ── Pro ───────────────────────────────────────────────────────────────────────
  {
    id: "plan-pro", name: "Pro", price: 147, period: "30 dias",
    billingPeriod: "monthly",
    limits: PRO_LIMITS,
    isActive: true,
    periods: [
      { type: "monthly",    price: 147,  isActive: true },
      { type: "quarterly",  price: 396,  monthlyEquivalentPrice: 132.00, isActive: true },
      { type: "semiannual", price: 750,  monthlyEquivalentPrice: 125.00, isActive: true },
      { type: "annual",     price: 1470, monthlyEquivalentPrice: 122.50, isActive: true },
    ],
  },

  // ── Business ──────────────────────────────────────────────────────────────────
  {
    id: "plan-business", name: "Business", price: 197, period: "30 dias",
    billingPeriod: "monthly",
    limits: BUSINESS_LIMITS,
    isActive: true,
    periods: [
      { type: "monthly",    price: 197,  isActive: true },
      { type: "quarterly",  price: 531,  monthlyEquivalentPrice: 177.00, isActive: true },
      { type: "semiannual", price: 1002, monthlyEquivalentPrice: 167.00, isActive: true },
      { type: "annual",     price: 1970, monthlyEquivalentPrice: 164.17, isActive: true },
    ],
  },

  {
    id: "plan-start-annual", name: "Start Anual", price: 770, period: "365 dias",
    billingPeriod: "annual", monthlyEquivalentPrice: 64.17,
    limits: START_LIMITS,
    isActive: true,
  },
  {
    id: "plan-pro-annual", name: "Pro Anual", price: 1470, period: "365 dias",
    billingPeriod: "annual", monthlyEquivalentPrice: 122.50,
    limits: PRO_LIMITS,
    isActive: true,
  },
  {
    id: "plan-business-annual", name: "Business Anual", price: 1970, period: "365 dias",
    billingPeriod: "annual", monthlyEquivalentPrice: 164.17,
    limits: BUSINESS_LIMITS,
    isActive: true,
  },
];

function formatLimit(label: string, value: number): string {
  if (value === 0) return `${label}: indisponível`;
  if (value === -1) return `${label}: ilimitado`;
  return `${label}: ${value}`;
}

export function getPlanFeatureList(plan: Plan): string[] {
  const { limits } = plan;
  return [
    formatLimit("Sessões WhatsApp", limits.whatsappSessions),
    formatLimit("Sessões Telegram", limits.telegramSessions),
    formatLimit("Sessões Mercado Livre", limits.meliSessions),
    formatLimit("Grupos", limits.groups),
    formatLimit("Rotas", limits.routes),
    formatLimit("Automações", limits.automations),
    formatLimit("Agendamentos", limits.schedules),
    formatLimit("Master Groups", limits.masterGroups),
    `Link Hub: ${limits.linkHub ? "incluído" : "indisponível"}`,
  ];
}
