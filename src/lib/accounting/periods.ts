import { fiscalYearStartLabel } from "@/lib/org/config";

export type PeriodCloseRow = {
  id: string;
  period_end: string;
  notes: string;
  closed_at: string;
  closed_by: string | null;
  event_type?: "close" | "reopen";
  effective_closed_through?: string | null;
  reopen_reason?: string;
  readiness_snapshot?: Record<string, unknown>;
  warnings_acknowledged?: unknown[];
  metadata?: Record<string, unknown>;
};

export type MonthPeriod = {
  key: string;
  start: string;
  end: string;
  label: string;
  status: "open" | "closed";
};

export class PeriodClosedError extends Error {
  closedThrough: string;

  constructor(closedThrough: string) {
    super(`Accounting period is closed through ${closedThrough}`);
    this.name = "PeriodClosedError";
    this.closedThrough = closedThrough;
  }
}

export function booksClosedThrough(
  closes: Pick<
    PeriodCloseRow,
    "period_end" | "effective_closed_through" | "closed_at" | "event_type"
  >[],
): string | null {
  if (!closes.length) return null;
  const latest = [...closes].sort((a, b) => {
    const at = a.closed_at ?? "";
    const bt = b.closed_at ?? "";
    return bt.localeCompare(at);
  })[0];
  if (!latest) return null;
  if (latest.event_type === "reopen") {
    return latest.effective_closed_through?.slice(0, 10) ?? null;
  }
  return (latest.effective_closed_through ?? latest.period_end)?.slice(0, 10) ?? null;
}

export function assertEntryDateOpen(closedThrough: string | null, entryDate: string) {
  if (!closedThrough) return;
  if (entryDate.slice(0, 10) <= closedThrough.slice(0, 10)) {
    throw new PeriodClosedError(closedThrough.slice(0, 10));
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function endOfMonth(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month, 0));
  return date.toISOString().slice(0, 10);
}

export function startOfMonth(year: number, month: number): string {
  return `${year}-${pad(month)}-01`;
}

export function monthPeriod(year: number, month: number): Omit<MonthPeriod, "status"> {
  const start = startOfMonth(year, month);
  const end = endOfMonth(year, month);
  return {
    key: `${year}-${pad(month)}`,
    start,
    end,
    label: `${fiscalYearStartLabel(month)} ${year}`,
  };
}

export function recentMonthPeriods(
  count: number,
  reference = new Date(),
  closedThrough: string | null = null,
): MonthPeriod[] {
  const periods: MonthPeriod[] = [];
  let year = reference.getFullYear();
  let month = reference.getMonth() + 1;

  for (let index = 0; index < count; index += 1) {
    const period = monthPeriod(year, month);
    periods.push({
      ...period,
      status:
        closedThrough && period.end <= closedThrough.slice(0, 10) ? "closed" : "open",
    });
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }

  return periods;
}

export function nextCloseablePeriodEnd(
  closedThrough: string | null,
  today = new Date().toISOString().slice(0, 10),
): string | null {
  const todayDate = today.slice(0, 10);

  if (!closedThrough) {
    const date = new Date(todayDate + "T12:00:00");
    date.setDate(0);
    return date.toISOString().slice(0, 10);
  }

  const closed = new Date(closedThrough.slice(0, 10) + "T12:00:00");
  closed.setMonth(closed.getMonth() + 2, 0);
  const candidate = closed.toISOString().slice(0, 10);
  return candidate <= todayDate ? candidate : null;
}

export function validatePeriodClose(input: {
  periodEnd: string;
  closedThrough: string | null;
  today?: string;
}): { ok: true } | { ok: false; reason: string } {
  const periodEnd = input.periodEnd.slice(0, 10);
  const today = (input.today ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

  if (periodEnd > today) {
    return { ok: false, reason: "Cannot close a future period." };
  }

  if (input.closedThrough && periodEnd <= input.closedThrough.slice(0, 10)) {
    return { ok: false, reason: "That period is already closed." };
  }

  const expected = nextCloseablePeriodEnd(input.closedThrough, today);
  if (expected && periodEnd !== expected) {
    return {
      ok: false,
      reason: `Close periods in order. Next period to close ends ${expected}.`,
    };
  }

  return { ok: true };
}
