import { useState } from "react";
import { Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface TimePickerFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

function normalizeTime(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) return "";
  const [hourRaw, minuteRaw] = trimmed.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return "";
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function currentTimeLabel(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function TimePickerField({
  value,
  onChange,
  placeholder = "Selecionar hora",
  className,
}: TimePickerFieldProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("h-11 w-full min-w-0 justify-start bg-background/90 font-medium tabular-nums", className)}
        >
          <Clock3 className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="truncate">{value || placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(17rem,calc(100vw-1rem))] p-3 sm:w-[220px]">
        <div className="space-y-3">
          <Input
            type="time"
            value={value}
            step={60}
            onChange={(event) => {
              const raw = String(event.target.value || "").slice(0, 5);
              if (!raw) {
                onChange("");
                return;
              }
              const next = normalizeTime(raw);
              onChange(next);
            }}
            className="h-11 sm:h-10"
          />
          <div className="flex items-center gap-1.5 justify-between">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                onChange(currentTimeLabel());
                setOpen(false);
              }}
              className="h-9 text-xs sm:h-8"
            >
              Agora
            </Button>
            {value && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className="h-9 text-xs sm:h-8"
              >
                Limpar
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
