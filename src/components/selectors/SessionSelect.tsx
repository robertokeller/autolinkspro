import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Wifi, AlertTriangle } from "lucide-react";
import { ChannelPlatformIcon } from "@/components/icons/ChannelPlatformIcon";

interface SessionOption {
  id: string;
  label: string;
  status: string;
  platform: "whatsapp" | "telegram";
}

interface SessionSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  sessions: SessionOption[];
  placeholder?: string;
  emptyLabel?: string;
  showStatusIcon?: boolean;
  showPlatformIcon?: boolean;
}

export function SessionSelect({
  value,
  onValueChange,
  sessions,
  placeholder = "Selecione uma sessão...",
  emptyLabel = "Nenhuma sessão disponível",
  showStatusIcon = true,
  showPlatformIcon = true,
}: SessionSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {sessions.length === 0 && (
          <SelectItem value="_none" disabled>
            {emptyLabel}
          </SelectItem>
        )}
        {sessions.map((session) => (
          <SelectItem key={session.id} value={session.id}>
            <span className="flex items-center gap-2">
              {showPlatformIcon && <ChannelPlatformIcon platform={session.platform} className="h-3 w-3" />}
              {session.label}
              {showStatusIcon && (
                session.status === "online"
                  ? <Wifi className="h-3 w-3 text-success" />
                  : <AlertTriangle className="h-3 w-3 text-warning" />
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
