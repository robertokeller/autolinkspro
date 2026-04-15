// services/whatsapp-baileys/src/analytics/metrics/churn-trends.ts

import { loadAllEvents, loadSnapshots } from "../store.js";
import type { ChurnTrends } from "../types.js";
import { calculateDailyChurn } from "./churn-daily.js";

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

export async function calculateChurnTrends(
  groupId: string
): Promise<ChurnTrends> {
  const allEvents = await loadAllEvents();
  const groupEvents = allEvents.filter(e => e.groupId === groupId);

  const days = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const dayOfWeekCount = new Map<string, { joined: number; left: number }>();
  const hourCount = new Map<number, { joined: number; left: number }>();

  for (const event of groupEvents) {
    const date = new Date(event.timestamp);
    const dayName = days[date.getDay()];
    const hour = date.getHours();

    if (!dayOfWeekCount.has(dayName)) {
      dayOfWeekCount.set(dayName, { joined: 0, left: 0 });
    }
    if (!hourCount.has(hour)) {
      hourCount.set(hour, { joined: 0, left: 0 });
    }

    const dayData = dayOfWeekCount.get(dayName)!;
    const hourData = hourCount.get(hour)!;

    if (event.type === "member_joined") {
      dayData.joined += 1;
      hourData.joined += 1;
    } else {
      dayData.left += 1;
      hourData.left += 1;
    }
  }

  // Detect anomalies using daily churn data
  const dailyChurn = await calculateDailyChurn(groupId, 90);
  const joinedValues = dailyChurn.daily.map(d => d.joined);
  const leftValues = dailyChurn.daily.map(d => d.left + d.removed);

  const avgJoined = mean(joinedValues);
  const stdJoined = stdDev(joinedValues);
  const avgLeft = mean(leftValues);
  const stdLeft = stdDev(leftValues);

  const anomalies: ChurnTrends["anomalies"] = [];

  for (const day of dailyChurn.daily) {
    if (stdJoined > 0 && day.joined > avgJoined + 2 * stdJoined) {
      anomalies.push({
        date: day.date,
        type: "spike_joined",
        value: day.joined,
        average: avgJoined,
        deviation: parseFloat(((day.joined - avgJoined) / stdJoined).toFixed(1)),
      });
    }
    if (stdLeft > 0 && (day.left + day.removed) > avgLeft + 2 * stdLeft) {
      anomalies.push({
        date: day.date,
        type: "spike_left",
        value: day.left + day.removed,
        average: avgLeft,
        deviation: parseFloat(
          ((day.left + day.removed - avgLeft) / stdLeft).toFixed(1)
        ),
      });
    }
  }

  const byDayOfWeek = days.map(day => ({
    day,
    joined: dayOfWeekCount.get(day)?.joined || 0,
    left: dayOfWeekCount.get(day)?.left || 0,
  }));

  const byHour = Array.from(hourCount.entries())
    .map(([hour, data]) => ({ hour, ...data }))
    .sort((a, b) => (b.joined + b.left) - (a.joined + a.left));

  return {
    byDayOfWeek,
    byHour,
    anomalies: anomalies.sort((a, b) => b.deviation - a.deviation),
  };
}
