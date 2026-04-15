import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";
import { type AnalyticsAdminGroup } from "@/integrations/analytics-client";

interface Props {
  groups: AnalyticsAdminGroup[];
  capacity?: number; // WhatsApp group capacity, defaults to 1024
}

const DEFAULT_CAPACITY = 1024;

function getCapacityColor(percentage: number): string {
  if (percentage >= 80) return "bg-amber-500";
  if (percentage >= 60) return "bg-emerald-500";
  if (percentage >= 40) return "bg-orange-500";
  return "bg-blue-500";
}

function getCapacityTextColor(percentage: number): string {
  if (percentage >= 80) return "text-amber-500 font-bold";
  if (percentage >= 60) return "text-emerald-500 font-bold";
  if (percentage >= 40) return "text-orange-500 font-bold";
  return "text-blue-500 font-bold";
}

/**
 * CapacidadePorGrupo
 *
 * Exibe todos os grupos ordenados do mais cheio para o menos cheio,
 * com barras de progresso indicando a ocupação de cada um.
 * Limite: 1024 membros por grupo (padrão WhatsApp).
 */
export function CapacidadePorGrupo({ groups, capacity = DEFAULT_CAPACITY }: Props) {
  // Calculate capacity for each group and sort descending
  const groupsWithCapacity = useMemo(() => {
    return groups
      .map((group) => {
        const memberCount = Math.max(0, group.memberCount || 0);
        const percentage = Math.min(100, (memberCount / capacity) * 100);
        return {
          ...group,
          memberCount,
          percentage: Number(percentage.toFixed(1)),
        };
      })
      .sort((a, b) => b.percentage - a.percentage); // Most full to least full
  }, [groups, capacity]);

  if (groups.length === 0) {
    return (
      <Card className="glass ring-1 ring-primary/20 shadow-sm">
        <CardHeader className="pb-2 shrink-0">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            Capacidade por Grupo
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Limite: {capacity.toLocaleString()} membros
          </p>
        </CardHeader>
        <CardContent className="p-4">
          <div className="flex min-h-[200px] items-center justify-center text-xs text-muted-foreground">
            Nenhum grupo disponível
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass ring-1 ring-primary/20 shadow-sm">
      <CardHeader className="pb-3 shrink-0">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          Capacidade por Grupo
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Limite: {capacity.toLocaleString()} membros • Ordenado do mais cheio para o menos cheio
        </p>
      </CardHeader>

      <CardContent className="p-4">
        <div className="space-y-3.5">
          {groupsWithCapacity.map((group) => {
            const textColor = getCapacityTextColor(group.percentage);

            return (
              <div key={group.id} className="flex flex-col gap-1.5">
                {/* Header: Name and stats inline */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate">
                      {group.name}
                    </p>
                  </div>
                  <span className={`shrink-0 text-xs ${textColor} whitespace-nowrap`}>
                    {group.memberCount} / {capacity} — {group.percentage.toFixed(0)}%
                  </span>
                </div>

                {/* Progress bar */}
                <div className="h-2.5 rounded-full bg-muted/60 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${getCapacityColor(group.percentage)}`}
                    style={{ width: `${Math.min(100, group.percentage)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
