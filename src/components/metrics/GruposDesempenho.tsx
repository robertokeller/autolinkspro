import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3 } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type AnalyticsAdminGroup,
  fetchMembersEvolution,
} from "@/integrations/analytics-client";

interface Props {
  groups: AnalyticsAdminGroup[];
  selectedScope: string;
  days: number;
}

const TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "10px",
  fontSize: "11px",
};

function compactDate(isoDate: string): string {
  const parts = String(isoDate || "").split("-");
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}`;
}

function formatSigned(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe > 0 ? "+" : ""}${safe.toLocaleString("pt-BR")}`;
}

/**
 * GruposDesempenho
 *
 * Evolucao de membros por periodo e escopo selecionados na pagina de metricas.
 * Fonte: snapshots diarios salvos no banco durante a sincronizacao de grupos.
 */
export function GruposDesempenho({ groups, selectedScope, days }: Props) {
  const { user } = useAuth();

  const scopeGroupIds = groups.map((group) => group.id).sort();
  const scopeGroupIdsKey = scopeGroupIds.join(",");

  const evolutionQuery = useQuery({
    queryKey: [
      "analytics-grupos-desempenho-evolution",
      user?.id,
      selectedScope,
      days,
      scopeGroupIdsKey,
    ],
    enabled: !!user && (selectedScope !== "all" || groups.length > 0),
    staleTime: 3 * 60 * 1000,
    queryFn: () => fetchMembersEvolution({
      scope: selectedScope,
      days,
      scopeGroupIds,
    }),
  });

  const data = evolutionQuery.data;
  const summary = data?.summary;
  const chartData = (data?.series ?? []).map((point) => ({
    date: compactDate(point.date),
    dateIso: point.date,
    members: point.members,
    groupsRepresented: point.groupsRepresented,
  }));

  const hasUsefulData = chartData.some((point) => point.members > 0 || point.groupsRepresented > 0);
  const title = selectedScope === "all"
    ? "Evolucao de membros (escopo atual)"
    : groups.length === 1
      ? `Evolucao de membros - ${groups[0]?.name || "Grupo"}`
      : `Evolucao de membros (${groups.length} grupos selecionados)`;

  const subtitle = summary
    ? `${summary.startMembers.toLocaleString("pt-BR")} -> ${summary.endMembers.toLocaleString("pt-BR")} (${formatSigned(summary.delta)}). Cobertura ${summary.coveragePercent.toFixed(1)}% no periodo.`
    : undefined;

  return (
    <Card className="glass ring-1 ring-primary/20 shadow-sm flex flex-col">
      <CardHeader className="pb-2 shrink-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
        {!evolutionQuery.isLoading && subtitle && (
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col min-h-0">
        {evolutionQuery.isLoading ? (
          <Skeleton className="min-h-[240px] w-full flex-1" />
        ) : groups.length === 0 ? (
          <div className="flex min-h-[180px] items-center justify-center text-xs text-muted-foreground">
            Nenhum grupo disponivel para o escopo selecionado.
          </div>
        ) : !data || chartData.length === 0 || !hasUsefulData ? (
          <div className="flex min-h-[180px] items-center justify-center text-xs text-muted-foreground text-center px-4">
            Ainda nao ha historico suficiente para evolucao neste escopo. Conecte e sincronize os grupos para iniciar a coleta.
          </div>
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            <div className="flex-1 min-h-[240px]">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    className="fill-muted-foreground"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    className="fill-muted-foreground"
                    allowDecimals={false}
                  />
                  <Tooltip
                    labelFormatter={(value, payload) => {
                      const row = Array.isArray(payload) && payload.length > 0
                        ? payload[0]?.payload as { dateIso?: string }
                        : null;
                      return row?.dateIso || String(value || "");
                    }}
                    formatter={(value: number, key: string, item) => {
                      if (key === "members") {
                        return [Number(value || 0).toLocaleString("pt-BR"), "Total membros"];
                      }
                      const represented = Number((item?.payload as { groupsRepresented?: number })?.groupsRepresented || 0);
                      return [represented.toLocaleString("pt-BR"), "Grupos com snapshot"];
                    }}
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                  />
                  <Line
                    type="linear"
                    dataKey="members"
                    stroke="hsl(var(--primary))"
                    strokeWidth={3}
                    dot={false}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-primary" />
                Total membros
              </span>
              <span className="text-muted-foreground">
                {summary?.daysWithData ?? 0}/{data?.days ?? days} dias com dados
              </span>
              <span className="text-muted-foreground">
                {summary?.groupsCount ?? 0} grupo(s)
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
