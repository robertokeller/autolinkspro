import type { WeekDay } from "@/lib/types";

export const WEEK_DAYS: { value: WeekDay; label: string }[] = [
  { value: "mon", label: "Seg" },
  { value: "tue", label: "Ter" },
  { value: "wed", label: "Qua" },
  { value: "thu", label: "Qui" },
  { value: "fri", label: "Sex" },
  { value: "sat", label: "Sab" },
  { value: "sun", label: "Dom" },
];

export function normalizeScheduleTime(value: string): string {
  const v = value.trim();
  if (!/^\d{2}:\d{2}$/.test(v)) return "";

  const [hhRaw, mmRaw] = v.split(":");
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return "";

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function mergeDateWithScheduleTime(dateTime: string, time: string): string {
  const normalized = normalizeScheduleTime(time);
  if (!normalized) return dateTime;

  const base = new Date(dateTime);
  const source = Number.isNaN(base.getTime()) ? new Date() : base;
  const [hhRaw, mmRaw] = normalized.split(":");
  source.setSeconds(0, 0);
  source.setHours(Number(hhRaw), Number(mmRaw), 0, 0);
  return source.toISOString();
}
