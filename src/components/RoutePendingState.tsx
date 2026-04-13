import { LoadingState } from "@/components/ui/loading-state";

interface RoutePendingStateProps {
  label?: string;
}

export function RoutePendingState({ label = "Carregando..." }: RoutePendingStateProps) {
  return <LoadingState variant="page" label={label} />;
}