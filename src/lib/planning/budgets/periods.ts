import { parseFiscalYearStart } from "@/lib/org/config";

/** Twelve calendar months for a labeled fiscal year (Jan–Dec of fiscal_year). */
export function fiscalYearCalendarMonths(fiscalYear: number): string[] {
  if (fiscalYear < 1900 || fiscalYear > 2200) {
    throw new Error("Fiscal year must be between 1900 and 2200");
  }
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    return `${fiscalYear}-${String(month).padStart(2, "0")}-01`;
  });
}

export function isValidPeriodMonth(value: string): boolean {
  if (!/^\d{4}-\d{2}-01$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

export function periodMonthInFiscalYear(periodMonth: string, fiscalYear: number): boolean {
  if (!isValidPeriodMonth(periodMonth)) return false;
  const year = Number(periodMonth.slice(0, 4));
  return year === fiscalYear;
}

export function assertPeriodMonthInFiscalYear(periodMonth: string, fiscalYear: number): void {
  if (!isValidPeriodMonth(periodMonth)) {
    throw new Error("Period must be the first day of a month (YYYY-MM-01)");
  }
  if (!periodMonthInFiscalYear(periodMonth, fiscalYear)) {
    throw new Error(`Period ${periodMonth} is outside fiscal year ${fiscalYear}`);
  }
}

export function monthLabel(periodMonth: string): string {
  const month = Number(periodMonth.slice(5, 7));
  const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return labels[month - 1] ?? periodMonth;
}

export function resolvePlanningFiscalYearStartMonth(
  answers: Record<string, unknown> | null | undefined,
): number {
  return parseFiscalYearStart(answers?.fiscalYearStart);
}
