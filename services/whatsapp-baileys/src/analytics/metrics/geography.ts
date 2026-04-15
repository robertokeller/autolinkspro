// services/whatsapp-baileys/src/analytics/metrics/geography.ts

import { getLatestSnapshot } from "../store.js";
import { DDD_TO_STATE, STATE_TO_IBGE, interpolateColor } from "../ddd-to-state.js";
import type { GeographyMetrics, StateDistribution } from "../types.js";

export async function calculateGeography(groupId: string): Promise<GeographyMetrics> {
  const snapshot = await getLatestSnapshot(groupId);

  if (!snapshot || snapshot.totalMembers === 0) {
    return {
      byState: [],
      byDDD: [],
      topState: "N/A",
      topDDD: "N/A",
      stateDiversity: 0,
      dddDiversity: 0,
      mapData: [],
    };
  }

  const stateCount = new Map<string, { count: number; ddds: Set<string> }>();
  const dddCount = new Map<string, { count: number; state: string }>();

  for (const member of snapshot.members) {
    const state = member.state || "Desconhecido";
    const ddd = member.ddd || "";

    if (!stateCount.has(state)) {
      stateCount.set(state, { count: 0, ddds: new Set() });
    }
    const stateData = stateCount.get(state)!;
    stateData.count += 1;
    if (ddd) stateData.ddds.add(ddd);

    if (!dddCount.has(ddd)) {
      dddCount.set(ddd, { count: 0, state });
    }
    dddCount.get(ddd)!.count += 1;
  }

  const byState: StateDistribution[] = Array.from(stateCount.entries())
    .map(([state, data]) => ({
      uf: state,
      ibgeCode: STATE_TO_IBGE[state] || 0,
      count: data.count,
      percentage: parseFloat(
        ((data.count / snapshot.totalMembers) * 100).toFixed(1)
      ),
      ddds: Array.from(data.ddds).sort(),
    }))
    .sort((a, b) => b.count - a.count);

  const byDDD = Array.from(dddCount.entries())
    .map(([ddd, data]) => ({
      ddd,
      state: data.state,
      count: data.count,
      percentage: parseFloat(
        ((data.count / snapshot.totalMembers) * 100).toFixed(1)
      ),
    }))
    .filter(d => d.ddd !== "")
    .sort((a, b) => b.count - a.count);

  // Generate heatmap data for mapa-brasil
  const maxCount = Math.max(...byState.map(s => s.count), 1);
  const mapData = byState.map(s => {
    const intensity = s.count / maxCount;
    const fillColor = interpolateColor("#E5E7EB", "#3B82F6", intensity);

    return {
      codIbge: s.ibgeCode,
      fillColor,
      strokeColor: "#1F1A17",
      strokeWidth: 1,
      count: s.count,
      percentage: s.percentage,
      state: s.uf,
    };
  });

  return {
    byState,
    byDDD,
    topState: byState[0]?.uf || "N/A",
    topDDD: byDDD[0]?.ddd || "N/A",
    stateDiversity: byState.length,
    dddDiversity: byDDD.length,
    mapData,
  };
}
