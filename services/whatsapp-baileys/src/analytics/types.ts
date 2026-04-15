// services/whatsapp-baileys/src/analytics/types.ts

export interface GroupEvent {
  type: 'member_joined' | 'member_left' | 'member_removed';
  groupId: string;
  groupName: string;
  participantPhone: string;
  participantDDD: string;
  participantState: string;
  authorPhone?: string;
  timestamp: string;
}

export interface GroupSnapshot {
  groupId: string;
  groupName: string;
  date: string;
  totalMembers: number;
  members: Array<{
    phone: string;
    ddd: string;
    state: string;
    isAdmin: boolean;
    joinedAt: string;
    leftAt?: string;
  }>;
}

export interface CompositionMetrics {
  totalMembers: number;
  capacityPercent: number;
  growthRate: {
    daily: number;
    weekly: number;
  };
}

export interface StateDistribution {
  uf: string;
  ibgeCode: number;
  count: number;
  percentage: number;
  ddds: string[];
}

export interface GeographyMetrics {
  byState: StateDistribution[];
  byDDD: Array<{ ddd: string; state: string; count: number; percentage: number }>;
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

export interface DailyChurnEntry {
  date: string;
  joined: number;
  left: number;
  removed: number;
  net: number;
  totalMembers: number;
}

export interface DailyChurnMetrics {
  daily: DailyChurnEntry[];
  summary: {
    totalJoined: number;
    totalLeft: number;
    totalRemoved: number;
    netGrowth: number;
    avgDailyGrowth: number;
  };
}

export interface ChurnTrends {
  byDayOfWeek: Array<{ day: string; joined: number; left: number }>;
  byHour: Array<{ hour: number; joined: number; left: number }>;
  anomalies: Array<{
    date: string;
    type: 'spike_joined' | 'spike_left';
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
    status: 'active' | 'departed';
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

export interface HealthScoreResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  label: string;
  breakdown: {
    crescimento: { score: number; max: number };
    rotatividade: { score: number; max: number };
    tendencia: { score: number; max: number };
    engajamento: { score: number; max: number };
  };
  recommendation: string;
}

// ── Movement history (granular events stored in group_member_movements) ─────

export interface GroupMovementRecord {
  id: string;
  groupId: string;
  eventType: 'member_joined' | 'member_left' | 'member_removed';
  memberPhone: string;
  authorPhone?: string;
  eventTimestamp: string; // ISO
  timePermanenceMinutes: number | null;
  entryEventId: string | null;
  sessionId: string | null;
}

export interface MovementHistoryResult {
  items: GroupMovementRecord[];
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
}

// ── Recapture automation ─────────────────────────────────────────────────────

export interface RecaptureRule {
  id: string;
  groupId: string;
  delayHours: number;
  messageTemplate: string;
  active: boolean;
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
  status: 'pending' | 'sent' | 'failed';
  errorMessage: string;
}

export interface RecaptureQueueResult {
  rule: RecaptureRule | null;
  pending: RecaptureQueueItem[];
  recent: RecaptureQueueItem[];
}

// Payload forwarded from API → Baileys dispatcher
export interface RecaptureDispatchItem {
  queueId: string;
  memberPhone: string;
  messageTemplate: string;
  groupExternalId: string;
  sessionId: string | null;
  timePermanenceMinutes: number | null;
}
