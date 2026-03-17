import { Loader2 } from "lucide-react";

interface RoutePendingStateProps {
  label?: string;
}

export function RoutePendingState({ label = "Carregando..." }: RoutePendingStateProps) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}