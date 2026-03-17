import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, ChevronDown, Circle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/routes";

interface OnboardingStep {
  label: string;
  description: string;
  href: string;
  done: boolean;
}

interface Props {
  hasSession: boolean;
  hasGroups: boolean;
  hasShopee: boolean;
  hasAutomation: boolean;
}

export function OnboardingChecklist({ hasSession, hasGroups, hasShopee, hasAutomation }: Props) {
  const [isExpanded, setIsExpanded] = useState(true);

  const steps: OnboardingStep[] = [
    {
      label: "Conecte uma sessão",
      description: "WhatsApp ou Telegram",
      href: ROUTES.app.connectionsWhatsApp,
      done: hasSession,
    },
    {
      label: "Sincronize grupos",
      description: "Importe seus grupos",
      href: ROUTES.app.connectionsWhatsApp,
      done: hasGroups,
    },
    {
      label: "Configure a Shopee",
      description: "Credenciais de afiliado",
      href: ROUTES.app.shopeeConfiguracoes,
      done: hasShopee,
    },
    {
      label: "Crie uma automação",
      description: "Envio automático de ofertas",
      href: ROUTES.app.shopeeAutomacoes,
      done: hasAutomation,
    },
  ];

  const completedCount = steps.filter((step) => step.done).length;
  const allDone = completedCount === steps.length;

  if (allDone) return null;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <Card className="glass ring-1 ring-primary/20">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm font-semibold">
            <span>Primeiros Passos</span>
            <div className="flex items-center gap-1">
              <Badge variant="secondary" className="text-2xs">
                {completedCount}/{steps.length}
              </Badge>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={isExpanded ? "Colapsar primeiros passos" : "Expandir primeiros passos"}
                >
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !isExpanded && "-rotate-90")} />
                </Button>
              </CollapsibleTrigger>
            </div>
          </CardTitle>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-2">
            {steps.map((step) => (
              <Link
                key={step.label}
                to={step.href}
                className={cn(
                  "group flex items-center gap-3 rounded-xl p-3 transition-all",
                  step.done ? "bg-success/5" : "bg-secondary/50 hover:bg-secondary hover:ring-1 hover:ring-border",
                )}
              >
                {step.done ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                ) : (
                  <Circle className="h-5 w-5 shrink-0 text-muted-foreground/40" />
                )}
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-medium", step.done && "text-muted-foreground line-through")}>{step.label}</p>
                  <p className="text-2xs text-muted-foreground">{step.description}</p>
                </div>
                {!step.done && (
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" />
                )}
              </Link>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
