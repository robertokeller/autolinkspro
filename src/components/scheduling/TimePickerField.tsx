import { useEffect, useRef, useState } from "react";
import { Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TimePickerFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const QUICK_TIMES = ["08:00", "09:00", "12:00", "15:00", "18:00", "21:00"];

export function TimePickerField({
  value,
  onChange,
  placeholder = "Selecionar hora",
  className,
}: TimePickerFieldProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, []);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <Button
        type="button"
        variant="outline"
        className="h-11 w-full justify-start bg-background/90 font-medium"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Clock3 className="mr-2 h-4 w-4 text-muted-foreground" />
        {value || placeholder}
      </Button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+0.5rem)] z-50 w-full min-w-[220px] rounded-xl border border-border/70 bg-popover p-3 shadow-xl">
          <input
            type="time"
            value={value}
            step={60}
            onChange={(event) => onChange(event.target.value.slice(0, 5))}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
          <div className="mt-3 grid grid-cols-3 gap-1.5">
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
      )}
    </div>
  );
}