import { useQuery } from "@tanstack/react-query";
import { fetchChurnTrends } from "@/integrations/analytics-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";

interface ChurnTrendsProps {
  groupId: string;
}

const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i);

export function ChurnTrends({ groupId }: ChurnTrendsProps) {
  const { user } = useAuth();

  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics-churn-trends", user?.id, groupId],
    queryFn: () => fetchChurnTrends(groupId),
    enabled: !!user && !!groupId,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">
          Erro ao carregar tendências de churn
        </CardContent>
      </Card>
    );
  }

  // Fill missing hours with 0
  const hourMap = new Map(data.byHour.map((h) => [h.hour, h]));
  const hourData = ALL_HOURS.map((hour) => ({
    label: `${String(hour).padStart(2, "0")}h`,
    Entradas: hourMap.get(hour)?.joined ?? 0,
    Saidas: hourMap.get(hour)?.left ?? 0,
  }));

  const dayData = data.byDayOfWeek.map((d) => ({
    label: d.day,
    Entradas: d.joined,
    Saidas: d.left,
  }));

  const hasAnomalies = data.anomalies.length > 0;

  return (
    <div className="space-y-6">
      {/* Anomalias */}
      {hasAnomalies && (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
              Anomalias detectadas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {data.anomalies.slice(0, 8).map((a, i) => {
                const isSpikeJoined = a.type === "spike_joined";
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm"
                  >
                    {isSpikeJoined ? (
                      <TrendingUp className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    ) : (
                      <TrendingDown className="h-3.5 w-3.5 text-rose-500 shrink-0" />
                    )}
                    <span className="text-muted-foreground">
                      {new Date(a.date).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
                    </span>
                    <Badge
                      variant={isSpikeJoined ? "success" : "destructive"}
                      className="text-xs"
                    >
                      {isSpikeJoined ? "+" : "−"}{a.value} {isSpikeJoined ? "entradas" : "saídas"}
                    </Badge>
                    <span className="text-xs text-muted-foreground/70">
                      {a.deviation}σ
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Gráfico por dia da semana */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Movimentação por dia da semana</CardTitle>
        </CardHeader>
        <CardContent>
          {dayData.every((d) => d.Entradas === 0 && d.Saidas === 0) ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sem dados suficientes para este período
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dayData} barCategoryGap="30%">
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Entradas" fill="#10B981" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="Saidas" fill="#EF4444" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Gráfico por hora do dia */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Movimentação por horário do dia</CardTitle>
        </CardHeader>
        <CardContent>
          {hourData.every((h) => h.Entradas === 0 && h.Saidas === 0) ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sem dados suficientes para este período
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={hourData} barCategoryGap="10%">
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  interval={1}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="Entradas" fill="#10B981" radius={[3, 3, 0, 0]} maxBarSize={16} />
                <Bar dataKey="Saidas" fill="#EF4444" radius={[3, 3, 0, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
