import type { CashHorizonWeek, CashWeekBucketResult } from "./types";
import { CASH_HORIZON_WEEKS } from "./types";

/** Parse YYYY-MM-DD as local calendar date (noon UTC-safe). */
function parseDate(isoDate: string): Date {
  return new Date(isoDate.slice(0, 10) + "T12:00:00");
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(isoDate: string, days: number): string {
  const date = parseDate(isoDate);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

/** Monday on or before the given date (ISO week convention for Teller cash planning). */
export function weekStartMonday(isoDate: string): string {
  const date = parseDate(isoDate);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return formatDate(date);
}

/** Sunday ending the week that contains isoDate (week starts Monday). */
export function weekEndSunday(weekStart: string): string {
  return addDays(weekStart, 6);
}

export function buildCashHorizonWeeks(
  asOfDate: string,
  horizonWeeks: number = CASH_HORIZON_WEEKS,
): { weeks: CashHorizonWeek[]; horizonStart: string; horizonEnd: string } {
  const horizonStart = weekStartMonday(asOfDate);
  const weeks: CashHorizonWeek[] = [];

  for (let index = 0; index < horizonWeeks; index++) {
    const periodStart = addDays(horizonStart, index * 7);
    const periodEnd = weekEndSunday(periodStart);
    weeks.push({
      weekIndex: index + 1,
      periodStart,
      periodEnd,
      label: `Week ${index + 1} (${periodStart.slice(5)} – ${periodEnd.slice(5)})`,
    });
  }

  const horizonEnd = weeks[weeks.length - 1]?.periodEnd ?? horizonStart;
  return { weeks, horizonStart, horizonEnd };
}

export function bucketDateIntoHorizon(
  targetDate: string,
  horizonStart: string,
  horizonEnd: string,
  horizonWeeks: CashHorizonWeek[],
): CashWeekBucketResult {
  const date = targetDate.slice(0, 10);
  if (date < horizonStart) {
    return { kind: "overdue" };
  }
  if (date > horizonEnd) {
    return { kind: "beyond" };
  }

  for (const week of horizonWeeks) {
    if (date >= week.periodStart && date <= week.periodEnd) {
      return { kind: "week", weekIndex: week.weekIndex };
    }
  }

  return { kind: "beyond" };
}

export function addCalendarDays(isoDate: string, days: number): string {
  return addDays(isoDate, days);
}
