import { useViewportProfile } from "@/hooks/useViewportProfile";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  const viewport = useViewportProfile();
  const compactHeader = viewport.isMobile || (viewport.isTablet && viewport.orientation === "portrait");

  return (
    <header className={cn("mb-6 flex flex-col gap-4 sm:mb-8 sm:gap-6 animate-fade-in", compactHeader && "gap-3")}>
      <div className="min-w-0">
        <h1 className={cn("text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl text-foreground", compactHeader && "text-xl")}>{title}</h1>
        {description && (
          <p className={cn("mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground/80 font-medium sm:text-base", compactHeader && "text-xs line-clamp-2")}>{description}</p>
        )}
      </div>
      {children && (
        <div className={cn("flex w-full flex-wrap items-stretch gap-2.5 py-1 sm:items-center sm:justify-end", compactHeader && "rounded-2xl border border-border/50 bg-card/60 backdrop-blur-sm p-3 shadow-premium")}>
          {children}
        </div>
      )}
    </header>
  );
}
