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

export type BillRecurrence = "weekly" | "monthly" | "quarterly" | "yearly";

export function advanceRecurrenceDate(
  recurrence: BillRecurrence,
  currentDate: string,
  issueDayOfMonth?: number | null,
): string {
  switch (recurrence) {
    case "weekly":
      return addDays(currentDate, 7);
    case "monthly":
      return addMonthsClamped(currentDate, 1, issueDayOfMonth);
    case "quarterly":
      return addMonthsClamped(currentDate, 3, issueDayOfMonth);
    case "yearly":
      return addMonthsClamped(currentDate, 12, issueDayOfMonth);
    default:
      return addMonthsClamped(currentDate, 1, issueDayOfMonth);
  }
}

export function generateRecurrenceOccurrences(input: {
  recurrence: BillRecurrence;
  startDate: string;
  endDate: string | null;
  fromDate: string;
  throughDate: string;
  issueDayOfMonth?: number | null;
  maxOccurrences?: number;
}): string[] {
  const occurrences: string[] = [];
  let cursor = input.startDate.slice(0, 10);
  const limit = input.maxOccurrences ?? 52;

  while (occurrences.length < limit) {
    if (input.endDate && cursor > input.endDate.slice(0, 10)) break;
    if (cursor > input.throughDate) break;
    if (cursor >= input.fromDate.slice(0, 10)) occurrences.push(cursor);
    cursor = advanceRecurrenceDate(input.recurrence, cursor, input.issueDayOfMonth);
    if (cursor <= input.startDate) break;
  }

  return occurrences;
}

export function paymentDateFromOccurrence(occurrenceDate: string, defaultDueDays: number): string {
  return addDays(occurrenceDate, defaultDueDays);
}
