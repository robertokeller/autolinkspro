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
    <header className={cn("mb-4 flex flex-col gap-2.5 sm:mb-6 sm:gap-3", compactHeader && "gap-2")}>
      <div className="min-w-0">
        <h1 className={cn("text-xl font-bold leading-tight tracking-tight min-[420px]:text-2xl sm:text-3xl", compactHeader && "text-lg min-[420px]:text-xl")}>{title}</h1>
        {description && (
          <p className={cn("mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground sm:text-sm", compactHeader && "line-clamp-2")}>{description}</p>
        )}
      </div>
      {children && (
        <div className={cn("flex w-full flex-wrap items-stretch gap-2 sm:items-center sm:justify-end", compactHeader && "rounded-xl border border-border/60 bg-card/70 p-2.5")}>
          {children}
        </div>
      )}
    </header>
  );
}
