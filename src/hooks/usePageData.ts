import { useEffect, useCallback, useState } from "react";
import { usePageLoadingContext } from "@/contexts/PageLoadingContext";

interface UsePageDataOptions {
  skipAutoReset?: boolean;
}

/**
 * Hook para gerenciar loading de dados em páginas com lazy loading.
 * Automaticamente liga e desliga o estado de loading durante o carregamento de dados.
 *
 * @example
 * ```tsx
 * export default function MyPage() {
 *   const { setLoading } = usePageData();
 *   const [data, setData] = useState(null);
 *
 *   useEffect(() => {
 *     const loadData = async () => {
 *       setLoading(true);
 *       const result = await fetchData();
 *       setData(result);
 *       setLoading(false);
 *     };
 *     loadData();
 *   }, [setLoading]);
 *
 *   return <div>{data}</div>;
 * }
 * ```
 */
export function usePageData(options: UsePageDataOptions = {}) {
  const { setLoading, resetLoading } = usePageLoadingContext();
  const [isLoading, setIsLoadingLocal] = useState(false);

  const startLoading = useCallback((message?: string) => {
    setIsLoadingLocal(true);
    setLoading(true, message);
  }, [setLoading]);

  const stopLoading = useCallback(() => {
    setIsLoadingLocal(false);
    setLoading(false);
  }, [setLoading]);

  // Auto-reset ao desmontar (se ativado)
  useEffect(() => {
    return () => {
      if (!options.skipAutoReset) {
        resetLoading();
        setIsLoadingLocal(false);
      }
    };
  }, [options.skipAutoReset, resetLoading]);

  return {
    isLoading,
    startLoading,
    stopLoading,
  };
}
