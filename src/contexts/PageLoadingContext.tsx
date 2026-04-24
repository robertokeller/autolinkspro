import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface PageLoadingContextType {
  isLoading: boolean;
  loadingMessage: string;
  setLoading: (isLoading: boolean, message?: string) => void;
  resetLoading: () => void;
}

const PageLoadingContext = createContext<PageLoadingContextType | undefined>(undefined);

export function PageLoadingProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoadingState] = useState(false);
  const [loadingMessage, setLoadingMessageState] = useState("Carregando...");

  const setLoading = useCallback((isLoading: boolean, message = "Carregando...") => {
    setIsLoadingState(isLoading);
    setLoadingMessageState(message);
  }, []);

  const resetLoading = useCallback(() => {
    setIsLoadingState(false);
    setLoadingMessageState("Carregando...");
  }, []);

  return (
    <PageLoadingContext.Provider value={{ isLoading, loadingMessage, setLoading, resetLoading }}>
      {children}
    </PageLoadingContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePageLoadingContext() {
  const context = useContext(PageLoadingContext);
  if (!context) {
    throw new Error("usePageLoadingContext must be used within PageLoadingProvider");
  }
  return context;
}
