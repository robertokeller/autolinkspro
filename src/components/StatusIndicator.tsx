import { cn } from "@/lib/utils";

import type { SessionStatus } from "@/lib/types";

type Status = SessionStatus;

const statusConfig: Record<Status, { color: string; label: string }> = {
  online: { color: "bg-success", label: "Conectado" },
  offline: { color: "bg-destructive", label: "Desconectado" },
  warning: { color: "bg-warning", label: "Atenção" },
  connecting: { color: "bg-info", label: "Conectando..." },
  awaiting_code: { color: "bg-warning", label: "Aguardando código" },
  awaiting_password: { color: "bg-warning", label: "Aguardando senha 2FA" },
  qr_code: { color: "bg-info", label: "Aguardando QR Code" },
  pairing_code: { color: "bg-warning", label: "Aguardando Pairing Code" },
};

interface StatusIndicatorProps {
  status: Status;
  showLabel?: boolean;
  size?: "sm" | "md";
}

export function StatusIndicator({ status, showLabel = true, size = "sm" }: StatusIndicatorProps) {
  const config = statusConfig[status] ?? statusConfig.offline;

  return (
    <div className="flex items-center gap-1.5">
      <span className="relative flex">
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-75",
           config.color,
            status === "online" && "animate-ping",
            (status === "connecting" || status === "qr_code" || status === "pairing_code") && "animate-pulse"
          )}
        />
        <span
          className={cn(
            "relative inline-flex rounded-full",
            config.color,
            size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5"
          )}
        />
      </span>
      {showLabel && (
        <span className="text-xs text-muted-foreground">{config.label}</span>
      )}
    </div>
  );
}
