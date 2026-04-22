import { invokeBackendRpc } from "@/integrations/backend/rpc";

export interface AnalyticsAdminGroup {
  id: string;
  name: string;
  externalId: string;
  memberCount: number;
  sessionId: string;
  isAdmin: boolean;
  ownerJid: string;
  inviteCode: string;
  inviteLink: string | null;
}

export interface AnalyticsSyncAllResult {
  success: boolean;
  sessionsSynced: number;
  totalGroups: number;
  errors: string[];
  sessionsEvaluated?: number;
  runtimeOnline?: number;
}

export interface CompositionMetrics {
  totalMembers: number;
  capacityPercent: number;
  growthRate: {
    daily: number;
    weekly: number;
  };
}

export interface GeographyMetrics {
  byState: Array<{
    uf: string;
    ibgeCode: number;
    count: number;
    percentage: number;
    ddds: string[];
  }>;
  byDDD: Array<{
    ddd: string;
    state: string;
    count: number;
    percentage: number;
  }>;
  topState: string;
  topDDD: string;
  stateDiversity: number;
  dddDiversity: number;
  mapData: Array<{
    codIbge: number;
    fillColor: string;
    strokeColor: string;
    strokeWidth: number;
    count: number;
    percentage: number;
    state: string;
  }>;
}

export interface DailyChurnMetrics {
  daily: Array<{
    date: string;
    joined: number;
    left: number;
    removed: number;
    net: number;
    totalMembers: number;
  }>;
  summary: {
    totalJoined: number;
    totalLeft: number;
    totalRemoved: number;
    netGrowth: number;
    avgDailyGrowth: number;
  };
}

export interface CrossGroupMetrics {
  totalUniqueMembers: number;
  overlappingMembers: number;
  overlappingPercent: number;
  overlapDetails: Array<{
    phone: string;
    groups: string[];
    groupCount: number;
  }>;
  exclusiveMembers: number;
}

export interface HealthScoreMetrics {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  label: string;
  breakdown: {
    crescimento: { score: number; max: number };
    rotatividade: { score: number; max: number };
    tendencia: { score: number; max: number };
    engajamento: { score: number; max: number };
  };
  recommendation: string;
}

export interface ChurnTrendsMetrics {
  byDayOfWeek: Array<{
    day: string;
    joined: number;
    left: number;
  }>;
  byHour: Array<{
    hour: number;
    joined: number;
    left: number;
  }>;
  anomalies: Array<{
    date: string;
    type: "spike_joined" | "spike_left";
    value: number;
    average: number;
    deviation: number;
  }>;
}

export interface RetentionMetrics {
  current: {
    avgTenure: number;
    medianTenure: number;
    maxTenure: number;
    minTenure: number;
  };
  departed: {
    avgTenure: number;
    medianTenure: number;
    shortestStay: number;
    longestStay: number;
  };
  topStayers: Array<{
    phone: string;
    joinedAt: string;
    daysInGroup: number;
    status: "active";
  }>;
  recentLeavers: Array<{
    phone: string;
    joinedAt: string;
    leftAt: string;
    daysInGroup: number;
  }>;
  cohorts: Array<{
    month: string;
    joined: number;
    stillActive: number;
    retentionRate: number;
  }>;
}

export interface GroupSummaryMetrics {
  composition: CompositionMetrics;
  geography: GeographyMetrics;
  churn: DailyChurnMetrics;
  trends: ChurnTrendsMetrics;
  retention: RetentionMetrics;
  health: HealthScoreMetrics;
}

export interface MembersEvolutionMetrics {
  scope: "all" | "group";
  groupId: string | null;
  days: number;
  fromDate: string;
  toDate: string;
  series: Array<{
    date: string;
    members: number;
    groupsRepresented: number;
  }>;
  summary: {
    groupsCount: number;
    snapshotsInWindow: number;
    daysWithData: number;
    coveragePercent: number;
    startMembers: number;
    endMembers: number;
    delta: number;
    deltaPercent: number;
  };
}

function unwrapRpcPayload<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    const wrapped = payload as { data?: unknown };
    return (wrapped.data ?? payload) as T;
  }
  return payload as T;
}

function normalizeAdminGroupsPayload(payload: unknown): AnalyticsAdminGroup[] {
  const unwrapped = unwrapRpcPayload<unknown>(payload);
  if (Array.isArray(unwrapped)) return unwrapped as AnalyticsAdminGroup[];
  if (!unwrapped || typeof unwrapped !== "object") return [];

  const row = unwrapped as { groups?: unknown };
  return Array.isArray(row.groups) ? (row.groups as AnalyticsAdminGroup[]) : [];
}

export async function fetchAdminGroups(): Promise<AnalyticsAdminGroup[]> {
  const payload = await invokeBackendRpc<unknown>("analytics-admin-groups", { body: {} });
  return normalizeAdminGroupsPayload(payload);
}

export async function syncAllWhatsAppGroups(): Promise<AnalyticsSyncAllResult> {
  const payload = await invokeBackendRpc<unknown>("analytics-sync-all-groups", { body: {} });
  const result = unwrapRpcPayload<Partial<AnalyticsSyncAllResult>>(payload) ?? {};

  return {
    success: result.success === true,
    sessionsSynced: Number(result.sessionsSynced ?? 0),
    totalGroups: Number(result.totalGroups ?? 0),
    errors: Array.isArray(result.errors) ? result.errors.map((item) => String(item)) : [],
    sessionsEvaluated: Number.isFinite(Number(result.sessionsEvaluated)) ? Number(result.sessionsEvaluated) : undefined,
    runtimeOnline: Number.isFinite(Number(result.runtimeOnline)) ? Number(result.runtimeOnline) : undefined,
  };
}

export async function fetchGroupSummary(groupId: string, days = 30): Promise<GroupSummaryMetrics> {
  const payload = await invokeBackendRpc<unknown>("analytics-group-summary", { body: { groupId, days } });
  return unwrapRpcPayload<GroupSummaryMetrics>(payload);
}

export async function fetchMembersEvolution(input: {
  scope: string;
  days: number;
  scopeGroupIds?: string[];
}): Promise<MembersEvolutionMetrics> {
  const payload = await invokeBackendRpc<unknown>("analytics-members-evolution", {
    body: {
      scope: input.scope,
      days: input.days,
      scopeGroupIds: Array.isArray(input.scopeGroupIds) ? input.scopeGroupIds : [],
    },
  });
  return unwrapRpcPayload<MembersEvolutionMetrics>(payload);
}

// ── Movement history ─────────────────────────────────────────────────────────

export interface CrossGroupOverlapMetrics {
  overlapCount: number;
  maxGroupsPerMember: number;
  avgGroupsPerMember: number;
  totalPhonesAnalyzed: number;
  analyzedGroups: number;
  hasData: boolean;
}

export async function fetchCrossGroupOverlap(input: {
  days: number;
  scopeGroupIds: string[];
}): Promise<CrossGroupOverlapMetrics> {
  const payload = await invokeBackendRpc<unknown>("analytics-cross-group-overlap", {
    body: {
      days: input.days,
      scopeGroupIds: Array.isArray(input.scopeGroupIds) ? input.scopeGroupIds : [],
    },
  });
  return unwrapRpcPayload<CrossGroupOverlapMetrics>(payload);
}

export interface MovementRecord {
  id: string;
  groupId: string;
  eventType: "member_joined" | "member_left" | "member_removed";
  memberPhone: string;
  authorPhone: string | null;
  eventTimestamp: string;
  timePermanenceMinutes: number | null;
  entryEventId: string | null;
  sessionId: string | null;
}

export interface MovementHistoryResult {
  items: MovementRecord[];
  total: number;
  page: number;
  limit: number;
}

export interface MovementKpisResult {
  totalJoins: number;
  totalLeaves: number;
  avgPermanenceMinutes: number | null;
  avgPermanenceFormatted: string | null;
  medianPermanenceMinutes: number | null;
  maxPermanenceMinutes: number | null;
  exitsUnder24h: number;
  exitsUnder7d: number;
}

export async function fetchMovementHistory(
  groupId: string,
  days = 30,
  eventType: "all" | "member_joined" | "left" = "all",
  page = 0,
  limit = 50,
): Promise<MovementHistoryResult> {
  const payload = await invokeBackendRpc<unknown>("analytics-movement-history", {
    body: { groupId, days, eventType, page, limit },
  });
  return unwrapRpcPayload<MovementHistoryResult>(payload);
}

export async function fetchMovementKpis(groupId: string, days = 30): Promise<MovementKpisResult> {
  const payload = await invokeBackendRpc<unknown>("analytics-movement-kpis", {
    body: { groupId, days },
  });
  return unwrapRpcPayload<MovementKpisResult>(payload);
}

// ── Recapture ────────────────────────────────────────────────────────────────

export interface RecaptureRule {
  id: string;
  groupId: string;
  delayHours: number;
  messageTemplate: string;
  active: boolean;
  sessionWaId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecaptureQueueItem {
  id: string;
  groupId: string;
  movementId: string;
  memberPhone: string;
  scheduledAt: string;
  sentAt: string | null;
  status: "pending" | "sent" | "failed";
  errorMessage: string;
}

export interface RecaptureQueueResult {
  rule: RecaptureRule | null;
  pending: RecaptureQueueItem[];
  recent: RecaptureQueueItem[];
}

export async function fetchRecaptureQueue(groupId: string): Promise<RecaptureQueueResult> {
  const payload = await invokeBackendRpc<unknown>("analytics-recapture-queue", {
    body: { groupId },
  });
  return unwrapRpcPayload<RecaptureQueueResult>(payload);
}

export async function saveRecaptureRule(
  groupId: string,
  delayHours: number,
  messageTemplate: string,
  active: boolean,
  sessionWaId: string | null = null,
): Promise<RecaptureRule> {
  const payload = await invokeBackendRpc<unknown>("analytics-recapture-rule-save", {
    body: { groupId, delayHours, messageTemplate, active, sessionWaId },
  });
  return unwrapRpcPayload<RecaptureRule>(payload);
}
