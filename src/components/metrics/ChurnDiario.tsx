// src/components/metrics/ChurnDiario.tsx

import { useQuery } from "@tanstack/react-query";
import { fetchChurnDaily } from "@/integrations/analytics-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { UserPlus, UserMinus, TrendingUp, Calendar } from "lucide-react";

interface ChurnDiarioProps {
  groupId: string;
  days: number;
}

export function ChurnDiario({ groupId, days }: ChurnDiarioProps) {
  const { user } = useAuth();

  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics-churn-daily", user?.id, groupId, days],
    queryFn: () => fetchChurnDaily(groupId, days),
    enabled: !!user && !!groupId,
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">
          Erro ao carregar dados de churn diario
        </CardContent>
      </Card>
    );
  }

  const churn = data;
  const chartData = churn?.daily.map((d) => ({
    date: new Date(d.date).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
    }),
    Entradas: d.joined,
    Saidas: d.left + d.removed,
  }));
  const avgJoinedPerDay = days > 0 ? (churn?.summary.totalJoined ?? 0) / days : 0;

  return (
    <div className="space-y-6">
      {/* Cards resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          icon={<UserPlus className="w-5 h-5 text-green-500" />}
          title="Total Entradas"
          value={churn?.summary.totalJoined || 0}
          subtitle={`Media ${avgJoinedPerDay.toFixed(1)}/dia`}
        />
        <MetricCard
          icon={<UserMinus className="w-5 h-5 text-red-500" />}
          title="Total Saidas"
          value={churn?.summary.totalLeft || 0}
          subtitle={`${churn?.summary.totalRemoved || 0} removidos`}
        />
        <MetricCard
          icon={<TrendingUp className="w-5 h-5 text-blue-500" />}
          title="Cresc. Liquido"
          value={`${(churn?.summary.netGrowth || 0) > 0 ? "+" : ""}${churn?.summary.netGrowth || 0}`}
        />
        <MetricCard
          icon={<Calendar className="w-5 h-5" />}
          title="Media Diaria"
          value={`${(churn?.summary.avgDailyGrowth || 0).toFixed(1)}`}
          subtitle="membros/dia"
        />
      </div>

      {/* Grafico */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Entradas e Saidas por Dia</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData || []}>
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="Entradas" fill="#10B981" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Saidas" fill="#EF4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  icon,
  title,
  value,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">{icon}</div>
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
