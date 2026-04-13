import { LoadingState } from "@/components/ui/loading-state";

interface InlineLoadingStateProps {
  label?: string;
  className?: string;
}

export function InlineLoadingState({ label = "Carregando...", className = "py-8" }: InlineLoadingStateProps) {
  return <LoadingState variant="inline" label={label} className={className} />;
}