// src/components/metrics/HealthScoreCard.tsx

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";

interface HealthScoreData {
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

interface HealthScoreCardProps {
  data: HealthScoreData;
}

function getGradeColor(grade: string): string {
  const colors: Record<string, string> = {
    A: "bg-green-500 text-white",
    B: "bg-blue-500 text-white",
    C: "bg-yellow-500 text-black",
    D: "bg-orange-500 text-white",
    F: "bg-red-500 text-white",
  };
  return colors[grade] || "bg-gray-500 text-white";
}

function getScoreColor(score: number): string {
  if (score >= 80) return "text-green-500";
  if (score >= 60) return "text-blue-500";
  if (score >= 40) return "text-yellow-500";
  if (score >= 20) return "text-orange-500";
  return "text-red-500";
}

function getProgressBarColor(score: number): string {
  if (score >= 80) return "bg-green-500";
  if (score >= 60) return "bg-blue-500";
  if (score >= 40) return "bg-yellow-500";
  if (score >= 20) return "bg-orange-500";
  return "bg-red-500";
}

function getAlertStyle(score: number): string {
  if (score >= 80) return "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200";
  if (score >= 60) return "bg-yellow-50 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200";
  if (score >= 40) return "bg-orange-50 text-orange-800 dark:bg-orange-950 dark:text-orange-200";
  return "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200";
}

export function HealthScoreCard({ data }: HealthScoreCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldCheck className="w-5 h-5" />
          Health Score do Grupo
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Score principal */}
        <div className="flex items-center gap-6">
          <div className="relative w-24 h-24 flex-shrink-0">
            <svg className="w-full h-full" viewBox="0 0 36 36">
              <path
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="#E5E7EB"
                strokeWidth="3"
              />
              <path
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke={data.score >= 60 ? "#10B981" : "#EF4444"}
                strokeWidth="3"
                strokeDasharray={`${data.score}, 100`}
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`text-2xl font-bold ${getScoreColor(data.score)}`}>
                {data.score}
              </span>
              <Badge className={`text-xs px-2 py-0.5 ${getGradeColor(data.grade)}`}>
                {data.grade}
              </Badge>
            </div>
          </div>

          <div className="flex-1 space-y-2">
            <MetricBar label="Crescimento" score={data.breakdown.crescimento.score} max={data.breakdown.crescimento.max} />
            <MetricBar label="Rotatividade" score={data.breakdown.rotatividade.score} max={data.breakdown.rotatividade.max} />
            <MetricBar label="Tendência" score={data.breakdown.tendencia.score} max={data.breakdown.tendencia.max} />
            <MetricBar label="Engajamento" score={data.breakdown.engajamento.score} max={data.breakdown.engajamento.max} />
          </div>
        </div>

        {/* Recomendação */}
        <div className={`p-3 rounded-lg text-sm font-medium ${getAlertStyle(data.score)}`}>
          {data.recommendation}
        </div>
      </CardContent>
    </Card>
  );
}

function MetricBar({ label, score, max }: { label: string; score: number; max: number }) {
  const percent = max > 0 ? (score / max) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className={score > 0 ? "text-green-600" : "text-red-600"}>
          {score}/{max}
        </span>
      </div>
      <Progress value={percent} className={`h-1.5 ${getProgressBarColor(percent)}`} />
    </div>
  );
}
