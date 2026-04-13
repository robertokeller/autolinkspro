import { useEffect, useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ptBR } from "date-fns/locale";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CalendarClock, ChevronLeft, ChevronRight } from "lucide-react";
import { TimePickerField } from "@/components/scheduling/TimePickerField";

interface DateTimeFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
  className?: string;
}

function toDateValue(value: string): { isoDate: string; isoTime: string } {
  if (!value) return { isoDate: "", isoTime: "" };

  // Local datetime without timezone suffix (e.g. 2026-03-18T15:30 or with seconds)
  // should be used as-is. Full ISO strings with timezone are parsed to local time.
  const localDateTimeMatch = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/
  );
  if (localDateTimeMatch) {
    return {
      isoDate: localDateTimeMatch[1],
      isoTime: localDateTimeMatch[2],
    };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { isoDate: "", isoTime: "" };

  return {
    isoDate: format(parsed, "yyyy-MM-dd"),
    isoTime: format(parsed, "HH:mm"),
  };
}

function nowTimeLabel(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function DateTimeField({
  value,
  onChange,
  label = "Data e hora",
  required = false,
  className,
}: DateTimeFieldProps) {
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedTime, setSelectedTime] = useState("");
  const [openDatePicker, setOpenDatePicker] = useState(false);
  const [displayMonth, setDisplayMonth] = useState(() => startOfMonth(new Date()));

  const monthDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(displayMonth), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(displayMonth), { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [displayMonth]);

  const emitIfReady = (dateValue: string, timeValue: string) => {
    if (!dateValue || !timeValue) return;
    onChange(`${dateValue}T${timeValue}`);
  };

  useEffect(() => {
    const parsed = toDateValue(value);
    setSelectedDate(parsed.isoDate);
    setSelectedTime(parsed.isoTime);

    if (parsed.isoDate) {
      const parsedDate = parseISO(parsed.isoDate);
      if (!Number.isNaN(parsedDate.getTime())) {
        setDisplayMonth(startOfMonth(parsedDate));
      }
    }
  }, [value]);

  const dateLabel = useMemo(() => {
    if (!selectedDate) return "Selecionar data";
    const parsedDate = parseISO(selectedDate);
    if (Number.isNaN(parsedDate.getTime())) return "Selecionar data";
    return format(parsedDate, "dd/MM/yyyy", { locale: ptBR });
  }, [selectedDate]);

  const weekDayLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];

  return (
    <div className={cn("space-y-2", className)}>
      <Label className="flex items-center gap-1.5">
        <CalendarClock className="h-3.5 w-3.5 text-primary" />
        {label}
        {required ? " *" : ""}
      </Label>

      <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,164px)]">
          <Popover modal open={openDatePicker} onOpenChange={setOpenDatePicker}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="h-11 w-full min-w-0 justify-start bg-background/90 font-medium"
              >
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
                  const isSelected = selectedDate ? isSameDay(day, parseISO(selectedDate)) : false;
                  const muted = !isSameMonth(day, displayMonth);
                  return (
                    <Button
                      key={dayIso}
                      type="button"
                      variant={isSelected ? "default" : "ghost"}
                      className={cn("h-9 w-9 min-w-0 p-0 text-xs sm:h-8 sm:w-8", muted && "text-muted-foreground")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        const resolvedTime = selectedTime || nowTimeLabel();
                        setSelectedDate(dayIso);
                        if (!selectedTime) setSelectedTime(resolvedTime);
                        emitIfReady(dayIso, resolvedTime);
                        setOpenDatePicker(false);
                      }}
                    >
                      {format(day, "d")}
                    </Button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          <TimePickerField
            value={selectedTime}
            onChange={(nextTime) => {
              if (!nextTime) {
                setSelectedTime("");
                onChange("");
                return;
              }
              setSelectedTime(nextTime);
              emitIfReady(selectedDate, nextTime);
            }}
            placeholder="Selecionar hora"
          />
        </div>
      </div>
    </div>
  );
}
