import { useEffect, useMemo, useRef, useState } from "react";
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
  const [isoDate = "", timePart = ""] = value.split("T");
  const [year = "", month = "", day = ""] = isoDate.split("-");
  if (!year || !month || !day) return { isoDate: "", isoTime: "" };
  return {
    isoDate,
    isoTime: timePart.slice(0, 5),
  };
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
  const rootRef = useRef<HTMLDivElement | null>(null);

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
      setDisplayMonth(startOfMonth(parseISO(parsed.isoDate)));
    }
  }, [value]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpenDatePicker(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, []);

  const dateLabel = selectedDate
    ? format(parseISO(selectedDate), "dd/MM/yyyy", { locale: ptBR })
    : "Selecionar data";
  const weekDayLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];

  return (
    <div ref={rootRef} className={cn("space-y-2", className)}>
      <Label className="flex items-center gap-1.5">
        <CalendarClock className="h-3.5 w-3.5 text-primary" />
        {label}
        {required ? " *" : ""}
      </Label>

      <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_136px]">
          <div className="relative">
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full justify-start bg-background/90 font-medium"
              onClick={() => setOpenDatePicker((prev) => !prev)}
            >
              {dateLabel}
            </Button>

            {openDatePicker && (
              <div className="absolute left-0 top-[calc(100%+0.5rem)] z-50 w-[290px] rounded-xl border border-border/70 bg-popover p-3 shadow-xl">
                <div className="mb-3 flex items-center justify-between">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
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
                    className="h-8 w-8"
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
                        className={cn("h-8 px-0 text-xs", muted && "text-muted-foreground")}
                        onClick={() => {
                          setSelectedDate(dayIso);
                          emitIfReady(dayIso, selectedTime);
                          setOpenDatePicker(false);
                        }}
                      >
                        {format(day, "d")}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <TimePickerField
            value={selectedTime}
            onChange={(nextTime) => {
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
