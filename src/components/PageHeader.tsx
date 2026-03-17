interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {description && (
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{children}</div>}
    </header>
  );
}
