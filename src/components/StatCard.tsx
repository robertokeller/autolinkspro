import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ComponentType } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: ComponentType<{ className?: string }>;
  trend?: { value: number; label: string };
  className?: string;
}

export function StatCard({ title, value, description, icon: Icon, trend, className }: StatCardProps) {
  return (
    <Card className={cn("glass glass-hover animate-card-in", className)}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-2xs font-semibold text-muted-foreground uppercase tracking-widest leading-none mb-1.5">{title}</p>
            <p className="text-2xl font-bold tracking-tight">{value}</p>
            {description && <p className="text-xs text-muted-foreground/80 mt-1 line-clamp-1">{description}</p>}
            {trend && (
              <p className={cn("text-xs font-semibold mt-2.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md", 
                trend.value >= 0 ? "text-success bg-success/10" : "text-destructive bg-destructive/10")}>
                {trend.value >= 0 ? "+" : ""}{trend.value}%
              </p>
            )}
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 text-primary shadow-sm border border-primary/10">
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
