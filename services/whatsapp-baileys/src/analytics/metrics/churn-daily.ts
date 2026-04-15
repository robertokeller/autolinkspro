// services/whatsapp-baileys/src/analytics/metrics/churn-daily.ts

import { loadEventsForDays, loadSnapshots } from "../store.js";
import type { DailyChurnMetrics, DailyChurnEntry } from "../types.js";

export async function calculateDailyChurn(
  groupId: string,
  days: number = 30
): Promise<DailyChurnMetrics> {
  const events = await loadEventsForDays(days);
  const snapshots = await loadSnapshots(groupId, days);

  // Filter events for this group
  const groupEvents = events.filter(e => e.groupId === groupId);

  const dailyMap = new Map<string, { joined: number; left: number; removed: number }>();

  for (const event of groupEvents) {
    const date = event.timestamp.slice(0, 10);
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { joined: 0, left: 0, removed: 0 });
    }
    const day = dailyMap.get(date)!;
    if (event.type === "member_joined") day.joined += 1;
    else if (event.type === "member_left") day.left += 1;
    else if (event.type === "member_removed") day.removed += 1;
  }

  // Create snapshot map for total members per day
  const snapshotMap = new Map<string, number>();
  for (const snap of snapshots) {
    snapshotMap.set(snap.date, snap.totalMembers);
  }

  // Generate complete daily series
  const daily: DailyChurnEntry[] = [];
  const today = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);

    const dayData = dailyMap.get(dateStr) || { joined: 0, left: 0, removed: 0 };
    const totalMembers = snapshotMap.get(dateStr) || 0;

    daily.push({
      date: dateStr,
      joined: dayData.joined,
      left: dayData.left,
      removed: dayData.removed,
      net: dayData.joined - dayData.left - dayData.removed,
      totalMembers,
    });
  }

  const totalJoined = daily.reduce((sum, d) => sum + d.joined, 0);
  const totalLeft = daily.reduce((sum, d) => sum + d.left + d.removed, 0);

  return {
    daily,
    summary: {
      totalJoined,
      totalLeft,
      totalRemoved: daily.reduce((sum, d) => sum + d.removed, 0),
      netGrowth: totalJoined - totalLeft,
      avgDailyGrowth: parseFloat(((totalJoined - totalLeft) / days).toFixed(2)),
    },
  };
}
