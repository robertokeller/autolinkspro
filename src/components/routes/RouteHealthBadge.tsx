import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import {
  computeRouteHealth,
  type RouteHealthInput,
  type RouteHealthLevel,
} from "@/lib/route-health";

type RouteHealthBadgeProps = RouteHealthInput;

const levelConfig: Record<
  RouteHealthLevel,
  { label: string; shortLabel: string; dotClass: string; textClass: string; borderClass: string; pingClass: string }
> = {
  healthy: {
    label: "Funcionando",
    shortLabel: "Funcionando",
    dotClass: "bg-success",
    textClass: "text-success",
    borderClass: "border-success/30 bg-success/10",
    pingClass: "animate-ping",
  },
  partial: {
    label: "Funcionando com alertas",
    shortLabel: "Com alertas",
    dotClass: "bg-warning",
    textClass: "text-warning",
    borderClass: "border-warning/30 bg-warning/10",
    pingClass: "animate-pulse",
  },
  error: {
    label: "Não funcionando",
    shortLabel: "Não funcionando",
    dotClass: "bg-destructive",
    textClass: "text-destructive",
    borderClass: "border-destructive/30 bg-destructive/10",
    pingClass: "",
  },
};

const stepStatusIcon = {
  ok: <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />,
  warn: <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />,
  error: <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />,
};

export function RouteHealthBadge(props: RouteHealthBadgeProps) {
  const { level, steps, issues, primaryIssue } = computeRouteHealth(props);
  const config = levelConfig[level];
  const hasMultipleIssues = issues.length > 1;
  const triggerLabel = primaryIssue
    ? `${config.shortLabel} · Problema na etapa ${primaryIssue.stepNumber}`
    : config.shortLabel;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex max-w-[280px] cursor-default select-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
              config.borderClass,
              config.textClass,
            )}
            title={triggerLabel}
          >
            <span className="relative flex h-1.5 w-1.5">
              {level !== "error" && (
                <span
                  className={cn(
                    "absolute inline-flex h-full w-full rounded-full opacity-60",
                    config.dotClass,
                    config.pingClass,
                  )}
                />
              )}
              <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", config.dotClass)} />
            </span>
            <span className="truncate">{triggerLabel}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="w-[min(92vw,560px)] max-w-[min(92vw,560px)] max-h-[70vh] overflow-y-auto p-3 whitespace-normal break-words">
          <p className="mb-1 text-xs font-semibold text-foreground">Monitor de Saúde da Rota</p>
          <p className={cn("mb-2 text-xs font-medium", config.textClass)}>
            Status atual: {config.label}
          </p>
            {primaryIssue && (
              <div className="mb-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs">
                <p className="font-medium text-foreground">
                  Parte exata com problema: Etapa {primaryIssue.stepNumber} - {primaryIssue.label}
                </p>
                <p className={cn(primaryIssue.status === "error" ? "text-destructive" : "text-warning")}>
                  {primaryIssue.detail}
                </p>
                {hasMultipleIssues && (
                  <p className="mt-1 text-muted-foreground">
                    +{issues.length - 1} ponto(s) adicional(is) no fluxo
                  </p>
                )}
              </div>
            )}
          <ul className="space-y-1.5">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                {stepStatusIcon[step.status]}
                <div className="min-w-0">
                    <span className="font-medium text-foreground">Etapa {i + 1} - {step.label}:</span>{" "}
                  <span
                    className={cn(
                      step.status === "ok"
                        ? "text-muted-foreground"
                        : step.status === "warn"
                          ? "text-warning"
                          : "text-destructive",
                    )}
                  >
                    {step.detail}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
