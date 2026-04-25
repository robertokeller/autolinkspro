import { useEffect, useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isBefore,
  isSameDay,
  isSameMonth,
  isValid,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ptBR } from "date-fns/locale";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  minDate?: string;
  maxDate?: string;
}

function parseYmd(value: string): Date | null {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = parseISO(raw);
  return isValid(parsed) ? parsed : null;
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Selecionar data",
  className,
  disabled = false,
  minDate,
  maxDate,
}: DatePickerProps) {
  const selectedDate = useMemo(() => parseYmd(value), [value]);
  const minDateValue = useMemo(() => parseYmd(minDate || ""), [minDate]);
  const maxDateValue = useMemo(() => parseYmd(maxDate || ""), [maxDate]);

  const [open, setOpen] = useState(false);
  const [displayMonth, setDisplayMonth] = useState<Date>(() =>
    startOfMonth(selectedDate || new Date())
  );

  useEffect(() => {
    if (selectedDate) {
      setDisplayMonth(startOfMonth(selectedDate));
    }
  }, [selectedDate]);

  const monthDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(displayMonth), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(displayMonth), { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [displayMonth]);

  const dateLabel = selectedDate
    ? format(selectedDate, "dd/MM/yyyy", { locale: ptBR })
    : placeholder;

  const weekDayLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "h-10 w-full justify-start bg-background/90 text-left font-medium",
            !selectedDate && "text-muted-foreground",
            className,
          )}
        >
          <CalendarDays className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="truncate">{dateLabel}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-1rem))] p-2.5 sm:w-[298px] sm:p-3">
        <div className="mb-3 flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 sm:h-8 sm:w-8"
            onClick={() => setDisplayMonth((prev) => addMonths(prev, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium">
            {format(displayMonth, "MMMM yyyy", { locale: ptBR })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 sm:h-8 sm:w-8"
            onClick={() => setDisplayMonth((prev) => addMonths(prev, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
          {weekDayLabels.map((labelValue) => (
            <span key={labelValue} className="py-1">
              {labelValue}
            </span>
          ))}
        </div>

        <div className="mt-1 grid grid-cols-7 gap-1">
          {monthDays.map((day) => {
            const dayIso = format(day, "yyyy-MM-dd");
            const isSelected = selectedDate ? isSameDay(day, selectedDate) : false;
            const muted = !isSameMonth(day, displayMonth);
            const beforeMin = minDateValue ? isBefore(startOfDay(day), startOfDay(minDateValue)) : false;
            const afterMax = maxDateValue ? isBefore(startOfDay(maxDateValue), startOfDay(day)) : false;
            const isDisabled = muted || beforeMin || afterMax;

            return (
              <Button
                key={dayIso}
                type="button"
                variant={isSelected ? "default" : "ghost"}
                className={cn(
                  "h-9 w-9 min-w-0 p-0 text-xs sm:h-8 sm:w-8",
                  muted && "text-muted-foreground",
                  isDisabled && "cursor-not-allowed opacity-40",
                )}
                disabled={isDisabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(dayIso);
                  setOpen(false);
                }}
              >
                {format(day, "d")}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
