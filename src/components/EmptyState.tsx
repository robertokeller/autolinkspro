import * as React from "react";
import { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ icon: Icon, title, description, actionLabel, onAction }, ref) => {
    return (
      <div ref={ref} className="flex flex-col items-center justify-center py-16 text-center animate-fade-in">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted mb-4">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold mb-1">{title}</h3>
        <p className="text-sm text-muted-foreground max-w-sm mb-4">{description}</p>
        {actionLabel && onAction && (
          <Button onClick={onAction} size="sm">
            {actionLabel}
          </Button>
        )}
      </div>
    );
  }
);
EmptyState.displayName = "EmptyState";
