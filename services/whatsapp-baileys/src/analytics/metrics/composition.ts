// services/whatsapp-baileys/src/analytics/metrics/composition.ts

import { getLatestSnapshot, loadSnapshots } from "../store.js";
import type { CompositionMetrics } from "../types.js";

const MAX_WHATSAPP_GROUP = 1024;

function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const ms = d2.getTime() - d1.getTime();
  return Math.max(1, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export async function calculateComposition(
  groupId: string
): Promise<CompositionMetrics> {
  const latest = await getLatestSnapshot(groupId);

  if (!latest) {
    return {
      totalMembers: 0,
      capacityPercent: 0,
      growthRate: { daily: 0, weekly: 0 },
    };
  }

  const snapshots = await loadSnapshots(groupId, 30);

  let growthDaily = 0;
  let growthWeekly = 0;

  if (snapshots.length >= 2) {
    const oldest = snapshots[0];
    const newest = snapshots[snapshots.length - 1];
    const days = daysBetween(oldest.date, newest.date);
    const diff = newest.totalMembers - oldest.totalMembers;

    growthDaily = diff / days;
    growthWeekly = (diff / days) * 7;
  }

  return {
    totalMembers: latest.totalMembers,
    capacityPercent: parseFloat(
      ((latest.totalMembers / MAX_WHATSAPP_GROUP) * 100).toFixed(1)
    ),
    growthRate: {
      daily: parseFloat(growthDaily.toFixed(2)),
      weekly: parseFloat(growthWeekly.toFixed(2)),
    },
  };
}
