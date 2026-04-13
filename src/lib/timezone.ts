import { type Locale, format as fnsFormat } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toZonedTime } from "date-fns-tz";

/** IANA timezone for Sao Paulo */
const TIMEZONE = "America/Sao_Paulo";

/**
 * Convert a Date or ISO string to a Date object adjusted for Sao Paulo timezone.
 * Use this before formatting so that the displayed time is always BRT/BRST.
 */
function toBRT(date: Date | string | number): Date {
  return toZonedTime(typeof date === "string" || typeof date === "number" ? new Date(date) : date, TIMEZONE);
}

/**
 * Format a date in Sao Paulo timezone using date-fns patterns.
 * Always uses ptBR locale by default.
 */
export function formatBRT(
  date: Date | string | number,
  pattern: string,
  options?: { locale?: Locale }
): string {
  return fnsFormat(toBRT(date), pattern, { locale: options?.locale ?? ptBR });
}

/**
 * Format a date in the system timezone (browser/OS timezone).
 * Uses ptBR locale by default and supports 24h tokens like HH:mm.
 */
export function formatSystem(
  date: Date | string | number,
  pattern: string,
  options?: { locale?: Locale }
): string {
  const parsed = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return fnsFormat(parsed, pattern, { locale: options?.locale ?? ptBR });
}

/**
 * Get the current time formatted in Sao Paulo timezone.
 */
export function nowBRT(pattern: string): string {
  return formatBRT(new Date(), pattern);
}
