import { cn } from "@/lib/utils";

import type { SessionStatus } from "@/lib/types";

type Status = SessionStatus;

const statusConfig: Record<string, { color: string; label: string; animate?: boolean }> = {
  online: { color: "bg-success", label: "Conectado", animate: true },
  offline: { color: "bg-destructive", label: "Desconectado" },
  warning: { color: "bg-warning", label: "Atenção", animate: true },
  connecting: { color: "bg-info", label: "Conectando...", animate: true },
  awaiting_code: { color: "bg-warning", label: "Aguardando código", animate: true },
  awaiting_password: { color: "bg-warning", label: "Aguardando senha 2FA", animate: true },
  qr_code: { color: "bg-info", label: "Aguardando QR Code", animate: true },
  pairing_code: { color: "bg-warning", label: "Aguardando autenticacao", animate: true },
};

interface StatusIndicatorProps {
  status: Status | string;
  showLabel?: boolean;
  size?: "sm" | "md";
}

export function StatusIndicator({ status, showLabel = true, size = "sm" }: StatusIndicatorProps) {
  const config = statusConfig[status as string] ?? statusConfig.offline;

  return (
    <div className="flex items-center gap-2">
      <span className="relative flex items-center justify-center">
        {config.animate && (
          <span
            className={cn(
              "absolute inline-flex h-[180%] w-[180%] rounded-full opacity-20",
              config.color,
              "animate-pulse"
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex rounded-full border border-white/20 shadow-sm",
            config.color,
            size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5"
          )}
        />
      </span>
      {showLabel && (
        <span className={cn(
          "text-xs font-semibold tracking-tight",
          status === "online" ? "text-success/90" : "text-muted-foreground"
        )}>{config.label}</span>
      )}
    </div>
  );
}
