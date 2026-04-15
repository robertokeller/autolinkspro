// src/components/metrics/ComposicaoVisaoGeral.tsx

import { useQuery } from "@tanstack/react-query";
import { fetchComposition, fetchGeography } from "@/integrations/analytics-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, TrendingUp, PieChart, MapPin } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { BrasilMap } from "./BrasilMap";

interface ComposicaoVisaoGeralProps {
  groupId: string;
}

export function ComposicaoVisaoGeral({ groupId }: ComposicaoVisaoGeralProps) {
  const { user } = useAuth();

  const compositionQuery = useQuery({
    queryKey: ["analytics-composition", user?.id, groupId],
    queryFn: () => fetchComposition(groupId),
    enabled: !!user && !!groupId,
  });

  const geographyQuery = useQuery({
    queryKey: ["analytics-geography", user?.id, groupId],
    queryFn: () => fetchGeography(groupId),
    enabled: !!user && !!groupId,
  });

  if (compositionQuery.isLoading || geographyQuery.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (compositionQuery.error || geographyQuery.error) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">
          Erro ao carregar dados de composição
        </CardContent>
      </Card>
    );
  }

  const composition = compositionQuery.data;
  const geography = geographyQuery.data;

  return (
    <div className="space-y-6">
      {/* Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          icon={<Users className="w-5 h-5" />}
          title="Membros Atuais"
          value={composition?.totalMembers || 0}
        />
        <MetricCard
          icon={<TrendingUp className="w-5 h-5" />}
          title="Crescimento Semanal"
          value={`${(composition?.growthRate?.weekly || 0) > 0 ? "+" : ""}${(composition?.growthRate?.weekly || 0).toFixed(1)}`}
        />
        <MetricCard
          icon={<PieChart className="w-5 h-5" />}
          title="Capacidade"
          value={`${(composition?.capacityPercent || 0).toFixed(1)}%`}
        />
        <MetricCard
          icon={<MapPin className="w-5 h-5" />}
          title="Estados"
          value={geography?.stateDiversity || 0}
        />
      </div>

      {/* Mapa + Ranking */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Distribuição Geográfica</CardTitle>
            </CardHeader>
            <CardContent>
              {geography?.mapData && geography.mapData.length > 0 ? (
                <BrasilMap data={geography.mapData} height={350} />
              ) : (
                <p className="text-center text-muted-foreground py-8">
                  Dados geográficos não disponíveis
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ranking por Estado</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {geography?.byState?.slice(0, 10).map((state) => (
                <div key={state.uf} className="flex items-center justify-between text-sm">
                  <span className="font-medium">{state.uf}</span>
                  <div className="text-right">
                    <span className="font-semibold">{state.count}</span>
                    <span className="text-muted-foreground ml-1">
                      ({state.percentage}%)
                    </span>
                  </div>
                </div>
              ))}
              {(!geography?.byState || geography.byState.length === 0) && (
                <p className="text-center text-muted-foreground text-sm py-4">
                  Sem dados
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  title,
  value,
}: {
  icon: React.ReactNode;
  title: string;
  value: string | number;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">{icon}</div>
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
