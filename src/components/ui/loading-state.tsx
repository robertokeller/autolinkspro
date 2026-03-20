import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

type LoadingStateVariant = "screen" | "page" | "inline";

interface LoadingStateProps {
  label?: string;
  variant?: LoadingStateVariant;
  className?: string;
}

const variantContainerClass: Record<LoadingStateVariant, string> = {
  screen: "min-h-[100dvh] w-full bg-background px-4",
  page: "min-h-[40vh] w-full px-4",
  inline: "w-full py-8",
};

const variantIconClass: Record<LoadingStateVariant, string> = {
  screen: "h-8 w-8",
  page: "h-5 w-5",
  inline: "h-5 w-5",
};

export function LoadingState({
  label = "Carregando...",
  variant = "inline",
  className,
}: LoadingStateProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 text-muted-foreground animate-in fade-in-0 duration-300",
        variantContainerClass[variant],
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <Loader2 className={cn("animate-spin", variantIconClass[variant])} />
      <span className="text-sm">{label}</span>
    </div>
  );
}
