export type CalendarMode = "month" | "week";

// Calendar dates represent civil days at UTC noon, independent of browser DST.
export function calendarKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function dueDayKey(value: string, timeZone: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function calendarToday(timeZone: string, now = new Date()): Date {
  return new Date(`${dueDayKey(now.toISOString(), timeZone)}T12:00:00Z`);
}

export function calendarDays(anchor: Date, mode: CalendarMode): Date[] {
  const first = mode === "month" ? new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1, 12)) : new Date(anchor);
  first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
  return Array.from({ length: mode === "month" ? 42 : 7 }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return date;
  });
}

export function shiftCalendar(anchor: Date, mode: CalendarMode, direction: number): Date {
  if (mode === "month") return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + direction, 1, 12));
  const date = new Date(anchor);
  date.setUTCDate(date.getUTCDate() + direction * 7);
  return date;
}
