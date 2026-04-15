import { useQuery } from "@tanstack/react-query";
import { fetchChurnRetention } from "@/integrations/analytics-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import {
  Clock,
  TrendingUp,
  Users,
  BarChart2,
} from "lucide-react";

interface RetencaoPanelProps {
  groupId: string;
}

function maskPhone(phone: string): string {
  if (!phone || phone.length < 6) return phone;
  const clean = phone.replace(/\D/g, "");
  if (clean.length < 8) return phone;
  return `+${clean.slice(0, 4)}****${clean.slice(-4)}`;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function StatCard({
  icon,
  label,
  value,
  subtitle,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">{icon}</div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold tabular-nums">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground/70">{subtitle}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function RetencaoPanel({ groupId }: RetencaoPanelProps) {
  const { user } = useAuth();

  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics-churn-retention", user?.id, groupId],
    queryFn: () => fetchChurnRetention(groupId),
    enabled: !!user && !!groupId,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">
          Erro ao carregar dados de retenção
        </CardContent>
      </Card>
    );
  }

  const retentionRate =
    data.cohorts.length > 0
      ? (
          data.cohorts.reduce((sum, c) => sum + c.retentionRate, 0) /
          data.cohorts.length
        ).toFixed(1)
      : "—";

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label="Tempo médio (ativos)"
          value={`${data.current.avgTenure} dias`}
          subtitle={`mediana ${data.current.medianTenure}d`}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Permanência (saídas)"
          value={`${data.departed.avgTenure} dias`}
          subtitle={`mediana ${data.departed.medianTenure}d`}
        />
        <StatCard
          icon={<Users className="h-4 w-4" />}
          label="Retenção média"
          value={`${retentionRate}%`}
          subtitle="média dos cohorts"
        />
        <StatCard
          icon={<BarChart2 className="h-4 w-4" />}
          label="Cohorts acompanhados"
          value={data.cohorts.length}
          subtitle="meses com dados"
        />
      </div>

      {/* Tabela de cohorts */}
      {data.cohorts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Retenção por cohort mensal</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Mês</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Entraram</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Ainda ativos</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Retenção</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cohorts.map((cohort) => (
                    <tr key={cohort.month} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5 font-medium">
                        {new Date(`${cohort.month}-01`).toLocaleDateString("pt-BR", {
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{cohort.joined}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{cohort.stillActive}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Badge
                          variant={
                            cohort.retentionRate >= 70
                              ? "success"
                              : cohort.retentionRate >= 40
                              ? "warning"
                              : "destructive"
                          }
                          className="text-xs tabular-nums"
                        >
                          {cohort.retentionRate}%
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top permanentes + Saídas recentes */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Top stayers */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Membros mais antigos</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.topStayers.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Sem dados</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="px-4 py-2 text-left font-medium text-muted-foreground">#</th>
                      <th className="px-4 py-2 text-left font-medium text-muted-foreground">Telefone</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">Dias no grupo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topStayers.slice(0, 10).map((m, i) => (
                      <tr key={m.phone} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2 text-muted-foreground/60 tabular-nums">{i + 1}</td>
                        <td className="px-4 py-2 font-mono text-xs">{maskPhone(m.phone)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium">{m.daysInGroup}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Saídas recentes */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Saídas recentes</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.recentLeavers.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Sem saídas registradas</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="px-4 py-2 text-left font-medium text-muted-foreground">Telefone</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">Saiu em</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">Ficou</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentLeavers.slice(0, 10).map((m) => (
                      <tr key={`${m.phone}-${m.leftAt}`} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2 font-mono text-xs">{maskPhone(m.phone)}</td>
                        <td className="px-4 py-2 text-right text-xs text-muted-foreground">{formatDate(m.leftAt)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">{m.daysInGroup}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
