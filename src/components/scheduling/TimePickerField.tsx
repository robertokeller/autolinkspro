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

const QUICK_TIMES = ["08:00", "09:00", "12:00", "15:00", "18:00", "21:00"];

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("h-11 w-full justify-start bg-background/90 font-medium", className)}
        >
          <Clock3 className="mr-2 h-4 w-4 text-muted-foreground" />
          {value || placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-3">
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
            className="h-10"
          />
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                onChange(currentTimeLabel());
                setOpen(false);
              }}
              className="h-8 text-xs"
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
                className="h-8 text-xs"
              >
                Limpar
              </Button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {QUICK_TIMES.map((quickTime) => (
              <Button
                key={quickTime}
                type="button"
                size="sm"
                variant={value === quickTime ? "default" : "outline"}
                onClick={() => {
                  onChange(quickTime);
                  setOpen(false);
                }}
                className="h-8 text-xs"
              >
                {quickTime}
              </Button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
