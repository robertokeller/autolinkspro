import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronDown, Circle, Rocket, Wand2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/routes";

interface OnboardingStep {
  id: string;
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

const ONBOARDING_STORAGE_KEY = "dashboard-onboarding-expanded";

export function OnboardingChecklist({ hasSession, hasGroups, hasShopee, hasAutomation }: Props) {
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const saved = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (saved === "0") return false;
    if (saved === "1") return true;
    return true;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, isExpanded ? "1" : "0");
  }, [isExpanded]);

  const steps: OnboardingStep[] = [
    {
      id: "connect-channel",
      label: "Conecte um canal",
      description: "WhatsApp ou Telegram para começar a operação",
      href: ROUTES.app.connectionsWhatsApp,
      done: hasSession,
    },
    {
      id: "sync-groups",
      label: "Organize os destinos",
      description: "Sincronize e prepare seus grupos mestres",
      href: ROUTES.app.connectionsMasterGroups,
      done: hasGroups,
    },
    {
      id: "setup-shopee",
      label: "Configure a Shopee",
      description: "Conecte suas credenciais para liberar automações",
      href: ROUTES.app.shopeeConfiguracoes,
      done: hasShopee,
    },
    {
      id: "activate-campaign",
      label: "Ative sua primeira automação",
      description: "Ligue sua campanha inicial para iniciar os envios",
      href: hasShopee ? ROUTES.app.shopeeAutomacoes : ROUTES.app.shopeeConfiguracoes,
      done: hasAutomation,
    },
  ];

  const completedCount = steps.filter((step) => step.done).length;
  const nextStep = steps.find((step) => !step.done);
  const progressPct = Math.round((completedCount / steps.length) * 100);
  const allDone = completedCount === steps.length;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <Card className="glass ring-1 ring-primary/20">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
            <span className="inline-flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-primary" />
              Assistente de ativação
            </span>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-2xs">{completedCount}/{steps.length}</Badge>
              <Badge variant="outline" className="text-2xs">{progressPct}%</Badge>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={isExpanded ? "Colapsar assistente" : "Expandir assistente"}
                >
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !isExpanded && "-rotate-90")} />
                </Button>
              </CollapsibleTrigger>
            </div>
          </CardTitle>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-2">
            {steps.map((step, index) => {
              const isNextStep = nextStep?.id === step.id;
              return (
                <Link
                  key={step.id}
                  to={step.href}
                  className={cn(
                    "group flex items-center gap-3 rounded-xl p-3 transition-all",
                    step.done ? "bg-success/5" : "bg-secondary/50 hover:bg-secondary hover:ring-1 hover:ring-border",
                    isNextStep && "ring-1 ring-primary/30",
                  )}
                >
                  {step.done ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                  ) : (
                    <Circle className="h-5 w-5 shrink-0 text-muted-foreground/40" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm font-medium", step.done && "text-muted-foreground line-through")}>Etapa {index + 1}: {step.label}</p>
                    <p className="text-2xs text-muted-foreground">{step.description}</p>
                  </div>
                  {isNextStep && !step.done && (
                    <Badge variant="outline" className="shrink-0 border-primary/40 text-primary">Próxima</Badge>
                  )}
                </Link>
              );
            })}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
