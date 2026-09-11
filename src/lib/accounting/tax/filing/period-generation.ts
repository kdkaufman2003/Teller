import type { TaxFilingFrequency } from "../types";
import type { TaxRegistrationRecord } from "./types";

export type GeneratedFilingPeriod = {
  periodStart: string;
  periodEnd: string;
  filingFrequency: TaxFilingFrequency;
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function clipStart(date: string, minDate: string): string {
  return date < minDate ? minDate : date;
}

function clipEnd(date: string, maxDate: string | null): string {
  if (!maxDate) return date;
  return date > maxDate ? maxDate : date;
}

function monthEnd(year: number, monthIndex: number): string {
  return isoDate(new Date(Date.UTC(year, monthIndex + 1, 0)));
}

function monthStart(year: number, monthIndex: number): string {
  return isoDate(new Date(Date.UTC(year, monthIndex, 1)));
}

function quarterBounds(year: number, quarter: number): { start: string; end: string } {
  const startMonth = (quarter - 1) * 3;
  return {
    start: monthStart(year, startMonth),
    end: monthEnd(year, startMonth + 2),
  };
}

/** Deterministic filing periods for one registration within a date range. */
export function generateFilingPeriodsForRegistration(
  registration: TaxRegistrationRecord,
  rangeStart: string,
  rangeEnd: string,
): GeneratedFilingPeriod[] {
  if (registration.status !== "active") return [];

  const effectiveStart = registration.effectiveFrom;
  const effectiveEnd = registration.effectiveTo ?? null;
  const cursorStart = clipStart(rangeStart, effectiveStart);
  const cappedRangeEnd = clipEnd(rangeEnd, effectiveEnd);
  if (cursorStart > cappedRangeEnd) return [];

  const periods: GeneratedFilingPeriod[] = [];
  const frequency = registration.filingFrequency;

  if (frequency === "monthly" || frequency === "other") {
    let cursor = new Date(`${cursorStart}T00:00:00Z`);
    const end = new Date(`${cappedRangeEnd}T00:00:00Z`);
    while (cursor <= end) {
      const start = monthStart(cursor.getUTCFullYear(), cursor.getUTCMonth());
      const endDate = monthEnd(cursor.getUTCFullYear(), cursor.getUTCMonth());
      const periodStart = clipStart(start, effectiveStart);
      const periodEnd = clipEnd(endDate, effectiveEnd);
      if (periodStart <= periodEnd && periodStart <= cappedRangeEnd && periodEnd >= cursorStart) {
        periods.push({
          periodStart,
          periodEnd,
          filingFrequency: frequency === "other" ? "monthly" : "monthly",
        });
      }
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
    return dedupePeriods(periods);
  }

  if (frequency === "quarterly") {
    let year = Number(cursorStart.slice(0, 4));
    const endYear = Number(cappedRangeEnd.slice(0, 4));
    while (year <= endYear) {
      for (let quarter = 1; quarter <= 4; quarter += 1) {
        const bounds = quarterBounds(year, quarter);
        const periodStart = clipStart(bounds.start, effectiveStart);
        const periodEnd = clipEnd(bounds.end, effectiveEnd);
        if (periodStart > periodEnd) continue;
        if (periodEnd < cursorStart || periodStart > cappedRangeEnd) continue;
        periods.push({ periodStart, periodEnd, filingFrequency: "quarterly" });
      }
      year += 1;
    }
    return dedupePeriods(periods);
  }

  let year = Number(cursorStart.slice(0, 4));
  const endYear = Number(cappedRangeEnd.slice(0, 4));
  while (year <= endYear) {
    const periodStart = clipStart(`${year}-01-01`, effectiveStart);
    const periodEnd = clipEnd(`${year}-12-31`, effectiveEnd);
    if (periodStart <= periodEnd && periodEnd >= cursorStart && periodStart <= cappedRangeEnd) {
      periods.push({ periodStart, periodEnd, filingFrequency: "annual" });
    }
    year += 1;
  }
  return dedupePeriods(periods);
}

function dedupePeriods(periods: GeneratedFilingPeriod[]): GeneratedFilingPeriod[] {
  const seen = new Set<string>();
  return periods.filter((period) => {
    const key = `${period.periodStart}:${period.periodEnd}:${period.filingFrequency}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function detectRegistrationOverlap(registrations: TaxRegistrationRecord[]): boolean {
  const active = registrations.filter((row) => row.status === "active");
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.authorityId && b.authorityId && a.authorityId !== b.authorityId) continue;
      if (a.jurisdictionKey && b.jurisdictionKey && a.jurisdictionKey !== b.jurisdictionKey) continue;
      const aEnd = a.effectiveTo ?? "9999-12-31";
      const bEnd = b.effectiveTo ?? "9999-12-31";
      if (a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd) return true;
    }
  }
  return false;
}
