import type { PlanningSettings } from "@/lib/planning/settings/planning-settings";

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

function addMonthsClamped(isoDate: string, months: number, dayOfMonth?: number | null): string {
  const date = parseDate(isoDate);
  const targetDay = dayOfMonth ?? date.getDate();
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(targetDay, lastDay));
  return formatDate(date);
}

export function nextPayrollDate(
  cadence: PlanningSettings["payrollCadence"],
  afterDate: string,
  anchorPayDate?: string,
): string {
  const anchor = anchorPayDate?.slice(0, 10) ?? afterDate.slice(0, 10);

  if (cadence === "weekly") {
    let next = addDays(afterDate, 1);
    while (next <= afterDate) next = addDays(next, 7);
    if (anchor && next <= afterDate) {
      let cursor = anchor;
      while (cursor <= afterDate) cursor = addDays(cursor, 7);
      return cursor;
    }
    return addDays(afterDate, 7);
  }

  if (cadence === "biweekly") {
    let cursor = anchor;
    while (cursor <= afterDate) cursor = addDays(cursor, 14);
    return cursor;
  }

  if (cadence === "semimonthly") {
    const date = parseDate(afterDate);
    const y = date.getFullYear();
    const m = date.getMonth();
    const day = date.getDate();
    if (day < 15) return formatDate(new Date(y, m, 15));
    return formatDate(new Date(y, m + 1, 0));
  }

  return addMonthsClamped(afterDate, 1);
}

export function projectPayrollDates(input: {
  cadence: PlanningSettings["payrollCadence"];
  anchorPayDate: string;
  fromDate: string;
  throughDate: string;
  maxDates?: number;
}): string[] {
  const dates: string[] = [];
  let cursor = input.fromDate.slice(0, 10);
  const limit = input.maxDates ?? 20;

  while (dates.length < limit) {
    const next = nextPayrollDate(input.cadence, cursor, input.anchorPayDate);
    if (next > input.throughDate) break;
    if (next >= input.fromDate.slice(0, 10)) dates.push(next);
    cursor = next;
  }

  return dates;
}
