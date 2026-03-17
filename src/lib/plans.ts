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

export interface Plan {
  id: string;
  name: string;
  price: number;
  period: string;
  /** Whether this is a monthly or annual plan */
  billingPeriod: "monthly" | "annual";
  /** For annual plans: the monthly equivalent price to show in the UI */
  monthlyEquivalentPrice?: number;
  limits: PlanLimits;
  isActive: boolean;
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
  },

  // ── Monthly paid plans ────────────────────────────────────────────────────────
  {
    id: "plan-start", name: "Start", price: 77, period: "30 dias",
    billingPeriod: "monthly",
    limits: START_LIMITS,
    isActive: true,
  },
  {
    id: "plan-pro", name: "Pro", price: 147, period: "30 dias",
    billingPeriod: "monthly",
    limits: PRO_LIMITS,
    isActive: true,
  },
  {
    id: "plan-business", name: "Business", price: 197, period: "30 dias",
    billingPeriod: "monthly",
    limits: BUSINESS_LIMITS,
    isActive: true,
  },

  // ── Annual paid plans (2 months free = 10× monthly price) ────────────────────
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

  // ── Legacy (kept for backward compat; hidden from UI) ─────────────────────────
  {
    id: "plan-enterprise", name: "Enterprise", price: 249.90, period: "30 dias",
    billingPeriod: "monthly",
    limits: BUSINESS_LIMITS,
    isActive: false,
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
