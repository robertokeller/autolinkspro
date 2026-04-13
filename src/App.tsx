import { AuthProvider } from "@/contexts/AuthContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { AppRoutes } from "@/routes/AppRoutes";
import { TemplateModuleProvider } from "@/contexts/TemplateModuleContext";
import { ShopeeLinkModuleProvider } from "@/contexts/ShopeeLinkModuleContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SystemRuntime } from "@/components/SystemRuntime";
import { ViewportAdaptationProvider } from "@/components/ViewportAdaptationProvider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,          // sem retentativas — evita delay de 7-15s quando API está offline
      staleTime: 30_000,
    },
  },
});

const App = () => (
  <ErrorBoundary>
    <ViewportAdaptationProvider>
      <ThemeProvider defaultTheme="dark">
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <TemplateModuleProvider>
              <ShopeeLinkModuleProvider>
                <TooltipProvider>
                  <Sonner />
                  <BrowserRouter>
                    <SystemRuntime />
                    <AppRoutes />
                  </BrowserRouter>
                </TooltipProvider>
              </ShopeeLinkModuleProvider>
            </TemplateModuleProvider>
          </QueryClientProvider>
        </AuthProvider>
      </ThemeProvider>
    </ViewportAdaptationProvider>
  </ErrorBoundary>
);

export default App;
