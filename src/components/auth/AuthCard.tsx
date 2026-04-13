import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import type { ReactNode } from "react";

interface AuthCardProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  showLogo?: boolean;
}

export function AuthCard({ title, description, children, showLogo = true }: AuthCardProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-lg bg-card [&_input]:!bg-card [&_input]:!text-card-foreground">
        <CardHeader className="text-center space-y-2">
          {showLogo && (
            <div className="mx-auto flex h-12 w-12 items-center justify-center">
              <img
                src="/brand/logo-chama-128.png"
                alt="AutoLinks!"
                className="h-12 w-12 object-contain"
                loading="lazy"
              />
            </div>
          )}
          <CardTitle className="text-2xl font-bold">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        {children}
      </Card>
    </div>
  );
}
