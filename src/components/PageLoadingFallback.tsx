import { LoadingState } from "@/components/ui/loading-state";
import { usePageLoadingContext } from "@/contexts/PageLoadingContext";

interface PageLoadingFallbackProps {
  label?: string;
  minHeight?: string;
}

/**
 * Componente de fallback para Suspense dentro de páginas.
 * Usa o LoadingState com variante "page".
 */
export function PageLoadingFallback({ label = "Carregando página..." }: PageLoadingFallbackProps) {
  return <LoadingState variant="page" label={label} />;
}

/**
 * Componente de loading para operações dentro da página.
 * Por exemplo: clique em botão, carregamento de dados adicionais, etc.
 */
export function InlinePageLoading({ label = "Carregando..." }: { label?: string }) {
  return <LoadingState variant="inline" label={label} />;
}

/**
 * Hook para acessar o estado de loading da página.
 * Útil para mostrar loading indicators baseado no contexto global.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePageLoadingState() {
  return usePageLoadingContext();
}
