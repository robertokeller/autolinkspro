// services/whatsapp-baileys/src/analytics/metrics/health-score.ts

import type { HealthScoreResult } from "../types.js";
import { calculateComposition } from "./composition.js";
import { calculateDailyChurn } from "./churn-daily.js";
import { calculateRetention } from "./churn-retention.js";
import { calculateGeography } from "./geography.js";
import { calculateCrossGroup } from "./cross-group.js";

interface HealthScoreInput {
  growthRate: number;
  capacityUsage: number;
  stateDiversity: number;
  turnoverRate: number;
  retentionRate: number;
  netGrowthTrend: "up" | "down" | "stable";
  overlapRate: number;
}

export async function calculateHealthScore(
  groupId: string,
  days: number = 30
): Promise<HealthScoreResult> {
  const composition = await calculateComposition(groupId);
  const dailyChurn = await calculateDailyChurn(groupId, days);
  const retention = await calculateRetention(groupId);
  const geography = await calculateGeography(groupId);
  const crossGroup = await calculateCrossGroup();

  const totalMembers = composition.totalMembers || 1;

  // Calculate turnover rate
  const turnoverRate = (dailyChurn.summary.totalLeft / totalMembers) * 100;

  // Calculate retention rate
  const retentionRate = retention.cohorts.length > 0
    ? mean(retention.cohorts.map(c => c.retentionRate))
    : 50;

  // Calculate net growth trend
  const recentNet = dailyChurn.daily.slice(-7).reduce((sum, d) => sum + d.net, 0);
  const previousNet = dailyChurn.daily.slice(-14, -7).reduce((sum, d) => sum + d.net, 0);

  let netGrowthTrend: "up" | "down" | "stable" = "stable";
  if (recentNet > previousNet + 2) netGrowthTrend = "up";
  else if (recentNet < previousNet - 2) netGrowthTrend = "down";

  // Overlap rate for multi-group engagement
  const overlapRate = crossGroup.overlappingPercent;

  const input: HealthScoreInput = {
    growthRate: composition.growthRate.weekly,
    capacityUsage: composition.capacityPercent,
    stateDiversity: geography.stateDiversity,
    turnoverRate,
    retentionRate,
    netGrowthTrend,
    overlapRate,
  };

  return computeHealthScore(input);
}

function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  let score = 50; // Base neutra

  // Crescimento (15%)
  let growth = 0;
  if (input.growthRate > 0 && input.growthRate <= 10) growth = 15;
  else if (input.growthRate > 10) growth = 10;
  else if (input.growthRate >= 0) growth = 5;
  else growth = 0;

  // Capacidade (10%)
  let capacity = 0;
  if (input.capacityUsage >= 30 && input.capacityUsage <= 70) capacity = 10;
  else if (input.capacityUsage >= 10) capacity = 7;
  else capacity = 3;

  // Diversidade de Estados (5%)
  let diversity = 0;
  if (input.stateDiversity >= 10) diversity = 5;
  else if (input.stateDiversity >= 5) diversity = 3;
  else if (input.stateDiversity >= 2) diversity = 2;
  else diversity = 1;

  // Rotatividade (15%)
  let turnover = 0;
  if (input.turnoverRate < 2) turnover = 15;
  else if (input.turnoverRate < 5) turnover = 10;
  else if (input.turnoverRate < 10) turnover = 5;
  else turnover = 0;

  // Retencao (15%)
  let retention = 0;
  if (input.retentionRate >= 90) retention = 15;
  else if (input.retentionRate >= 80) retention = 12;
  else if (input.retentionRate >= 70) retention = 8;
  else if (input.retentionRate >= 50) retention = 4;
  else retention = 0;

  // Tendencia (10%)
  let trend = 0;
  if (input.netGrowthTrend === "up") trend = 10;
  else if (input.netGrowthTrend === "stable") trend = 5;
  else trend = 0;

  // Engajamento/Overlapping (20%)
  let overlap = 0;
  if (input.overlapRate >= 20 && input.overlapRate <= 40) overlap = 20;
  else if (input.overlapRate >= 10) overlap = 15;
  else if (input.overlapRate >= 5) overlap = 10;
  else if (input.overlapRate < 5) overlap = 5;
  else overlap = 10;

  score = growth + capacity + diversity + turnover + retention + trend + overlap;
  score = Math.max(0, Math.min(100, score));

  let label: string;
  if (score >= 80) label = "Excelente";
  else if (score >= 60) label = "Bom";
  else if (score >= 40) label = "Regular";
  else if (score >= 20) label = "Ruim";
  else label = "Critico";

  let grade: "A" | "B" | "C" | "D" | "F";
  if (score >= 90) grade = "A";
  else if (score >= 80) grade = "B";
  else if (score >= 70) grade = "C";
  else if (score >= 60) grade = "D";
  else grade = "F";

  let recommendation: string;
  if (score >= 80) recommendation = "Grupo saudavel - Continue assim!";
  else if (score >= 60) recommendation = "Grupo estavel - Atencao ao churn";
  else if (score >= 40) recommendation = "Grupo em risco - Acoes de retencao necessarias";
  else recommendation = "Grupo critico - Intervencao urgente";

  return {
    score,
    grade,
    label,
    breakdown: {
      crescimento: { score: growth + capacity + diversity, max: 30 },
      rotatividade: { score: turnover + retention, max: 30 },
      tendencia: { score: trend, max: 10 },
      engajamento: { score: overlap, max: 20 },
    },
    recommendation,
  };
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}
