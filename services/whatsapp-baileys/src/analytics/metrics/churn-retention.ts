// services/whatsapp-baileys/src/analytics/metrics/churn-retention.ts

import { getLatestSnapshot } from "../store.js";
import type { RetentionMetrics } from "../types.js";

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

export async function calculateRetention(
  groupId: string
): Promise<RetentionMetrics> {
  const snapshot = await getLatestSnapshot(groupId);

  if (!snapshot) {
    return createEmptyRetention();
  }

  const now = new Date();

  // Calculate tenure for each member
  const activeTenures: number[] = [];
  const departedTenures: number[] = [];
  const topStayers: RetentionMetrics["topStayers"] = [];
  const recentLeavers: RetentionMetrics["recentLeavers"] = [];
  const cohortMap = new Map<string, { joined: number; stillActive: number }>();

  for (const member of snapshot.members) {
    const joinedDate = member.joinedAt;
    const leftDate = member.leftAt;
    const daysInGroup = leftDate
      ? daysBetween(joinedDate, leftDate)
      : daysBetween(joinedDate, now.toISOString());

    const month = joinedDate.slice(0, 7); // YYYY-MM

    if (!cohortMap.has(month)) {
      cohortMap.set(month, { joined: 0, stillActive: 0 });
    }
    const cohort = cohortMap.get(month)!;
    cohort.joined += 1;
    if (!leftDate) cohort.stillActive += 1;

    const entry = {
      phone: member.phone,
      joinedAt: member.joinedAt,
      daysInGroup,
    };

    if (leftDate) {
      departedTenures.push(daysInGroup);
      recentLeavers.push({
        phone: member.phone,
        joinedAt: member.joinedAt,
        leftAt: leftDate,
        daysInGroup,
      });
    } else {
      activeTenures.push(daysInGroup);
      topStayers.push({
        ...entry,
        status: "active" as const,
      });
    }
  }

  // Sort and limit
  topStayers.sort((a, b) => b.daysInGroup - a.daysInGroup);
  recentLeavers.sort((a, b) => daysBetween(b.leftAt, now.toISOString()) - daysBetween(a.leftAt, now.toISOString()));

  const cohorts = Array.from(cohortMap.entries())
    .map(([month, data]) => ({
      month,
      joined: data.joined,
      stillActive: data.stillActive,
      retentionRate: parseFloat(
        ((data.stillActive / data.joined) * 100).toFixed(1)
      ),
    }))
    .sort((a, b) => b.month.localeCompare(a.month));

  return {
    current: {
      avgTenure: Math.round(mean(activeTenures)),
      medianTenure: Math.round(median(activeTenures)),
      maxTenure: Math.max(...activeTenures, 0),
      minTenure: Math.min(...activeTenures, 0),
    },
    departed: {
      avgTenure: Math.round(mean(departedTenures)),
      medianTenure: Math.round(median(departedTenures)),
      shortestStay: Math.min(...departedTenures, 0),
      longestStay: Math.max(...departedTenures, 0),
    },
    topStayers: topStayers.slice(0, 20),
    recentLeavers: recentLeavers.slice(0, 20),
    cohorts,
  };
}

function createEmptyRetention(): RetentionMetrics {
  return {
    current: { avgTenure: 0, medianTenure: 0, maxTenure: 0, minTenure: 0 },
    departed: { avgTenure: 0, medianTenure: 0, shortestStay: 0, longestStay: 0 },
    topStayers: [],
    recentLeavers: [],
    cohorts: [],
  };
}
