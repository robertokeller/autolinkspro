import { invokeBackendRpc } from "@/integrations/backend/rpc";

export interface UserUsageSnapshot {
  routesTotal: number;
  routesActive: number;
  automationsTotal: number;
  automationsActive: number;
  groupsTotal: number;
  groupsWhatsapp: number;
  groupsTelegram: number;
  waSessionsTotal: number;
  waSessionsOnline: number;
  tgSessionsTotal: number;
  tgSessionsOnline: number;
  meliSessionsTotal: number;
  meliSessionsActive: number;
  schedulesTotal: number;
  schedulesPending: number;
  schedulesActiveRecurring: number;
  history24h: number;
  history7d: number;
  history24hExpectedFrom7dAvg: number;
  history24hGrowthRatio: number;
  errors24h: number;
  errors7d: number;
  errors24hExpectedFrom7dAvg: number;
  errors24hGrowthRatio: number;
  lastActivityAt: string | null;
}

export interface UserObservabilityRow {
  user_id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  account_status: "active" | "inactive" | "blocked" | "archived" | string;
  plan_id: string;
  created_at: string;
  usage: UserUsageSnapshot;
}

export interface GlobalObservabilitySnapshot {
  usersTotal: number;
  usersActive: number;
  usersInactive: number;
  usersBlocked: number;
  usersArchived: number;
  routesTotal: number;
  routesActive: number;
  automationsTotal: number;
  automationsActive: number;
  groupsTotal: number;
  groupsWhatsapp: number;
  groupsTelegram: number;
  waSessionsTotal: number;
  waSessionsOnline: number;
  tgSessionsTotal: number;
  tgSessionsOnline: number;
  meliSessionsTotal: number;
  meliSessionsActive: number;
  schedulesTotal: number;
  schedulesPending: number;
  history24h: number;
  history7d: number;
  history24hExpectedFrom7dAvg: number;
  history24hGrowthRatio: number;
  errors24h: number;
  errors7d: number;
  errors24hExpectedFrom7dAvg: number;
  errors24hGrowthRatio: number;
}

export interface WorkerQueueSnapshot {
  route: { active: number; pending: number; limit: number };
  dispatch: { active: number; pending: number; limit: number };
  automation: { active: number; pending: number; limit: number };
  convert: { active: number; pending: number; limit: number };
}

export interface UserObservabilityRankingRow {
  user_id: string;
  name: string;
  email: string;
  score: number;
  usage: UserUsageSnapshot;
}

export interface ObservabilityAnomaly {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  user_id?: string;
  metric?: string;
  value?: number;
  threshold?: number;
}

export interface AdminSystemObservability {
  ok: boolean;
  checkedAt: string;
  global: GlobalObservabilitySnapshot;
  users: UserObservabilityRow[];
  rankings: {
    byErrors: UserObservabilityRankingRow[];
    byLoad: UserObservabilityRankingRow[];
    bySpike: UserObservabilityRankingRow[];
  };
  anomalies: ObservabilityAnomaly[];
  workers: {
    ops: {
      online: boolean;
      url: string;
      error: string | null;
      system: Record<string, unknown> | null;
      services: Array<Record<string, unknown>>;
    };
    queues: WorkerQueueSnapshot;
  };
}

const OBS_CACHE_WINDOW_MS = 1500;
let lastObsAt = 0;
let lastObsSnapshot: AdminSystemObservability | null = null;
let inFlightObs: Promise<AdminSystemObservability> | null = null;

export async function loadAdminSystemObservability(options?: { force?: boolean }) {
  const now = Date.now();
  if (!options?.force && lastObsSnapshot && now - lastObsAt <= OBS_CACHE_WINDOW_MS) {
    return lastObsSnapshot;
  }

  if (!options?.force && inFlightObs) {
    return inFlightObs;
  }

  inFlightObs = invokeBackendRpc<AdminSystemObservability>("admin-system-observability")
    .then((snapshot) => {
      lastObsSnapshot = snapshot;
      lastObsAt = Date.now();
      return snapshot;
    })
    .finally(() => {
      inFlightObs = null;
    });

  return inFlightObs;
}
