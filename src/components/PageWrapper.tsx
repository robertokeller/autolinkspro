import { Suspense, ReactNode } from "react";
import { PageLoadingFallback } from "@/components/PageLoadingFallback";

interface PageWrapperProps {
  children: ReactNode;
  fallbackLabel?: string;
}

/**
 * Wrapper para páginas com lazy loading automático.
 * Automatically wraps the page content with Suspense and provides
 * a consistent loading fallback.
 *
 * @example
 * ```tsx
 * export default function MyPage() {
 *   return (
 *     <PageWrapper>
 *       <div>My page content</div>
 *     </PageWrapper>
 *   );
 * }
 * ```
 */
export function PageWrapper({ children, fallbackLabel = "Carregando página..." }: PageWrapperProps) {
  return (
    <Suspense fallback={<PageLoadingFallback label={fallbackLabel} />}>
      {children}
    </Suspense>
  );
}
