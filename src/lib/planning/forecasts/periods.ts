import { fiscalYearCalendarMonths, isValidPeriodMonth } from "@/lib/planning/budgets/periods";

/** Add calendar months to a period month (YYYY-MM-01). */
export function addMonths(periodMonth: string, delta: number): string {
  if (!isValidPeriodMonth(periodMonth)) {
    throw new Error("Period must be the first day of a month (YYYY-MM-01)");
  }
  const year = Number(periodMonth.slice(0, 4));
  const month = Number(periodMonth.slice(5, 7));
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Rolling forward horizon: months after anchor through horizonMonths inclusive. */
export function rollingForwardMonths(anchorMonth: string, horizonMonths: number): string[] {
  if (horizonMonths < 1 || horizonMonths > 36) {
    throw new Error("Horizon must be between 1 and 36 months");
  }
  return Array.from({ length: horizonMonths }, (_, index) => addMonths(anchorMonth, index + 1));
}

/** YTD actual months from fiscal year start through cutoff (inclusive). */
export function ytdActualMonths(anchorMonth: string, cutoffMonth: string): string[] {
  if (!isValidPeriodMonth(anchorMonth) || !isValidPeriodMonth(cutoffMonth)) {
    throw new Error("Invalid period month");
  }
  const fiscalYear = Number(cutoffMonth.slice(0, 4));
  const yearMonths = fiscalYearCalendarMonths(fiscalYear);
  return yearMonths.filter((month) => month <= cutoffMonth);
}

export function isActualizedPeriod(periodMonth: string, cutoffMonth: string): boolean {
  return periodMonth <= cutoffMonth;
}

export function defaultAnchorMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export function resolveActualCutoffMonth(
  versionCutoff: string | null | undefined,
  anchorMonth: string,
): string {
  return versionCutoff ?? anchorMonth;
}
