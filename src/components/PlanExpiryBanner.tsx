import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { AlertTriangle, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccessControl } from "@/hooks/useAccessControl";
import { useAuth } from "@/contexts/AuthContext";
import { ROUTES } from "@/lib/routes";

export function PlanExpiryBanner() {
  const { user, isAdmin } = useAuth();
  const { isPlanExpired, planExpiresAt } = useAccessControl();
  const navigate = useNavigate();
  const location = useLocation();
  const [dismissedExpiringSoon, setDismissedExpiringSoon] = useState(false);

  if (!user || isAdmin) return null;

  const planExpiresAtMs = planExpiresAt ? Date.parse(planExpiresAt) : NaN;
  const msToExpiry = Number.isFinite(planExpiresAtMs) ? planExpiresAtMs - Date.now() : NaN;
  const daysToExpiry = Number.isFinite(msToExpiry) ? Math.ceil(msToExpiry / (1000 * 60 * 60 * 24)) : NaN;
  const expiryLabel = Number.isFinite(planExpiresAtMs)
    ? new Date(planExpiresAtMs).toLocaleDateString("pt-BR")
    : null;
  const isExpiringSoon = !isPlanExpired && Number.isFinite(daysToExpiry) && daysToExpiry <= 3;
  const isOnAccountPage = location.pathname === ROUTES.app.account;

  if (isPlanExpired && !isOnAccountPage) {
    return (
      <div className="flex items-center justify-between gap-3 bg-destructive px-4 py-2.5 text-destructive-foreground">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <XCircle className="h-4 w-4 shrink-0" />
          <span className="truncate">
            <strong>Plano expirado{expiryLabel ? ` em ${expiryLabel}` : ""}.</strong>{" "}
            Renove pra voltar a usar tudo.
          </span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => navigate(ROUTES.app.account)}
        >
          Renovar agora
        </Button>
      </div>
    );
  }

  if (isExpiringSoon && !dismissedExpiringSoon) {
    const daysLabel =
      daysToExpiry <= 0 ? "hoje" : daysToExpiry === 1 ? "amanhã" : `em ${daysToExpiry} dias`;
    return (
      <div className="flex items-center justify-between gap-3 bg-warning px-4 py-2.5 text-warning-foreground">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="truncate">
            <strong>
              Plano vence {daysLabel}
              {expiryLabel ? ` (${expiryLabel})` : ""}.
            </strong>{" "}
            Renove pra não perder o acesso.
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => navigate(ROUTES.app.account)}>
            Renovar
          </Button>
          <button
            className="opacity-80 hover:opacity-100"
            onClick={() => setDismissedExpiringSoon(true)}
            aria-label="Fechar aviso"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return null;
}
