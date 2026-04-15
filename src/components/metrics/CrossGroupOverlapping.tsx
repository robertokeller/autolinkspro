// src/components/metrics/CrossGroupOverlapping.tsx

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchCrossGroupOverlapping,
  fetchAdminGroups,
  fetchGroupSummary,
} from "@/integrations/analytics-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { Users, Layers, User } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export function CrossGroupOverlapping() {
  const { user } = useAuth();
  const crossQuery = useQuery({
    queryKey: ["analytics-cross-group", user?.id],
    queryFn: () => fetchCrossGroupOverlapping(),
    enabled: !!user,
    staleTime: 3 * 60 * 1000,
  });

  const groupsQuery = useQuery({
    queryKey: ["analytics-admin-groups", user?.id],
    queryFn: fetchAdminGroups,
    enabled: !!user,
    staleTime: 2 * 60 * 1000,
  });

  const groups = groupsQuery.data ?? [];

  const totalMembersSum = useMemo(() => groups.reduce((s, g) => s + Math.max(0, Number(g.memberCount || 0)), 0), [groups]);
  const adminCount = useMemo(() => groups.filter((g) => g.isAdmin).length, [groups]);

  const topN = 8;
  const topGroups = useMemo(() => [...groups].sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0)).slice(0, topN), [groups]);
  const topIdsKey = topGroups.map((g) => g.id).join(",");

  const summariesQuery = useQuery({
    queryKey: ["analytics-multi-summary", user?.id, topIdsKey],
    enabled: !!user && topGroups.length > 0,
    staleTime: 3 * 60 * 1000,
    queryFn: async () => {
      const settled = await Promise.allSettled(topGroups.map((g) => fetchGroupSummary(g.id, 30)));
      return settled.map((res, i) => {
        const group = topGroups[i];
        if (res.status === "fulfilled") {
          const s = res.value;
          return {
            id: group.id,
            name: group.name,
            membros: s.composition?.totalMembers ?? group.memberCount,
            entradas: s.churn?.summary?.totalJoined ?? 0,
            saidas: s.churn?.summary?.totalLeft ?? 0,
            score: s.health?.score ?? 0,
          };
        }
        return {
          id: group.id,
          name: group.name,
          membros: group.memberCount,
          entradas: 0,
          saidas: 0,
          score: 0,
        };
      });
    },
  });

  // Loading state: show skeleton until at least groups data is ready
  if (groupsQuery.isLoading && crossQuery.isLoading) return <Skeleton className="h-64 w-full" />;

  const cross = crossQuery.data;

  // If the backend provides real cross-group data, render the original detailed view
  if (cross && Array.isArray(cross.overlapDetails) && cross.overlapDetails.length > 0) {
    return (
      <div className="space-y-6">
        {/* Cards */}
        <div className="grid grid-cols-3 gap-4">
          <MetricCard
            icon={<Users className="w-5 h-5" />}
            title="Membros Unicos"
            value={cross?.totalUniqueMembers || 0}
            subtitle="Total em todos os grupos"
          />
          <MetricCard
            icon={<Layers className="w-5 h-5" />}
            title="Em Multiplos Grupos"
            value={cross?.overlappingMembers || 0}
            subtitle={`${cross?.overlappingPercent || 0}% do total`}
          />
          <MetricCard
            icon={<User className="w-5 h-5" />}
            title="Exclusivos"
            value={cross?.exclusiveMembers || 0}
            subtitle="Presentes em apenas 1 grupo"
          />
        </div>

        {/* Tabela */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Membros em Multiplos Grupos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {cross.overlapDetails.slice(0, 30).map((item) => (
                <div
                  key={item.phone}
                  className="flex items-center justify-between p-2 rounded-lg bg-muted/50 text-sm"
                >
                  <span className="font-mono">+{item.phone}</span>
                  <Badge variant="outline">{item.groupCount} grupos</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Fallback: construct a multi-group overview using admin groups and summaries
  const topData = summariesQuery.data ?? topGroups.map((g) => ({ name: g.name, membros: g.memberCount }));

  const chartData = topData.map((g: any) => ({ name: g.name.length > 18 ? `${g.name.slice(0, 15)}…` : g.name, membros: g.membros }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-4">
        <MetricCard icon={<Users className="w-5 h-5" />} title="Grupos totais" value={groups.length} subtitle="Total de grupos administrados" />
        <MetricCard icon={<Users className="w-5 h-5" />} title="Membros (soma)" value={totalMembersSum} subtitle="Soma dos membros por grupo" />
        <MetricCard icon={<Layers className="w-5 h-5" />} title="Admin" value={adminCount} subtitle="Grupos com perfil admin" />
        <MetricCard icon={<User className="w-5 h-5" />} title="Tamanho médio" value={groups.length ? Math.round(totalMembersSum / groups.length) : 0} subtitle="Membros por grupo (média)" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top {chartData.length} grupos por membros</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">Nenhum grupo disponível</p>
          ) : (
            <div style={{ height: Math.min(60 * chartData.length, 480) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={chartData} margin={{ top: 10, right: 24, left: 8, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value: number) => value.toLocaleString("pt-BR")} />
                  <Bar dataKey="membros" fill="hsl(var(--primary))" radius={[4, 4, 4, 4]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Detalhes (Top grupos)</CardTitle>
        </CardHeader>
        <CardContent>
          {summariesQuery.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="space-y-2">
              {(summariesQuery.data ?? topGroups).map((g: any) => (
                <div key={g.id ?? g.name} className="flex items-center justify-between p-2 rounded-lg bg-muted/50 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium line-clamp-1">{g.name}</p>
                    <p className="text-xs text-muted-foreground">{(g.membros ?? g.memberCount)?.toLocaleString?.("pt-BR") ?? g.membros} membros</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">Entradas {g.entradas ?? 0}</Badge>
                    <Badge variant="outline">Saídas {g.saidas ?? 0}</Badge>
                    <Badge variant="outline">Score {g.score ?? 0}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
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
  value: number;
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
