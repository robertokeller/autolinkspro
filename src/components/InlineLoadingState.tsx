import { Loader2 } from "lucide-react";

interface InlineLoadingStateProps {
  label?: string;
  className?: string;
}

export function InlineLoadingState({ label = "Carregando...", className = "py-8" }: InlineLoadingStateProps) {
  return (
    <div className={`flex items-center justify-center gap-2 text-muted-foreground ${className}`}>
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}