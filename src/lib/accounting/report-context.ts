import {
  fiscalYearStartDate,
  parseAccountingBasis,
  parseFiscalYearStart,
} from "@/lib/org/config";
import type { AccountingBasis } from "./reports";
import { reportPeriodRange, type DateRange, type ReportPeriod } from "./reports";

export type ReportComparison =
  | "none"
  | "prior_period"
  | "prior_year"
  | "prior_ytd";

export type PresentationMode = "accountant" | "owner";

export type ReportContext = {
  organizationId: string;
  startDate: string | null;
  endDate: string | null;
  asOfDate: string;
  basis: AccountingBasis;
  comparison: ReportComparison;
  fiscalYearStart: number;
  presentationMode: PresentationMode;
  rangeLabel: string;
};

export type ComparativeAmounts = {
  currentAmount: number;
  comparisonAmount: number;
  varianceAmount: number;
  variancePercent: number | null;
};

export function buildReportContext(input: {
  organizationId: string;
  period?: ReportPeriod;
  startDate?: string | null;
  endDate?: string | null;
  asOfDate?: string | null;
  basis?: string | null;
  comparison?: ReportComparison;
  fiscalYearStart?: number | string | null;
  presentationMode?: PresentationMode;
  today?: Date;
}): ReportContext {
  const fiscalYearStart = parseFiscalYearStart(input.fiscalYearStart);
  const today = input.today ?? new Date();

  let range: DateRange;
  if (input.startDate !== undefined || input.endDate !== undefined) {
    const start = input.startDate?.slice(0, 10) ?? null;
    const end = input.endDate?.slice(0, 10) ?? today.toISOString().slice(0, 10);
    range = {
      start,
      end,
      label: start && end ? `${start} – ${end}` : end ? `Through ${end}` : "All time",
    };
  } else {
    range = reportPeriodRange(input.period ?? "ytd", today, fiscalYearStart);
  }

  const asOfDate = (input.asOfDate ?? range.end ?? today.toISOString().slice(0, 10)).slice(
    0,
    10,
  );

  return {
    organizationId: input.organizationId,
    startDate: range.start,
    endDate: range.end,
    asOfDate,
    basis: parseAccountingBasis(input.basis),
    comparison: input.comparison ?? "none",
    fiscalYearStart,
    presentationMode: input.presentationMode ?? "accountant",
    rangeLabel: range.label,
  };
}

export function comparisonRangeForContext(
  ctx: ReportContext,
): { start: string | null; end: string | null; asOf: string } | null {
  if (ctx.comparison === "none") return null;

  const end = ctx.endDate ?? ctx.asOfDate;
  const start = ctx.startDate;

  if (ctx.comparison === "prior_period") {
    if (!start || !end) return null;
    const startMs = new Date(start + "T12:00:00").getTime();
    const endMs = new Date(end + "T12:00:00").getTime();
    const days = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
    const priorEnd = new Date(startMs - 24 * 60 * 60 * 1000);
    const priorStart = new Date(priorEnd.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    return {
      start: priorStart.toISOString().slice(0, 10),
      end: priorEnd.toISOString().slice(0, 10),
      asOf: priorEnd.toISOString().slice(0, 10),
    };
  }

  if (ctx.comparison === "prior_year") {
    const shiftYear = (iso: string) => {
      const d = new Date(iso.slice(0, 10) + "T12:00:00");
      d.setFullYear(d.getFullYear() - 1);
      return d.toISOString().slice(0, 10);
    };
    return {
      start: start ? shiftYear(start) : null,
      end: shiftYear(end),
      asOf: shiftYear(ctx.asOfDate),
    };
  }

  if (ctx.comparison === "prior_ytd") {
    const fyStart = fiscalYearStartDate(new Date(end + "T12:00:00"), ctx.fiscalYearStart);
    const priorFyStart = new Date(fyStart);
    priorFyStart.setFullYear(priorFyStart.getFullYear() - 1);
    const priorEnd = new Date(end + "T12:00:00");
    priorEnd.setFullYear(priorEnd.getFullYear() - 1);
    return {
      start: priorFyStart.toISOString().slice(0, 10),
      end: priorEnd.toISOString().slice(0, 10),
      asOf: priorEnd.toISOString().slice(0, 10),
    };
  }

  return null;
}

export function computeComparativeAmounts(
  currentAmount: number,
  comparisonAmount: number,
): ComparativeAmounts {
  const varianceAmount = Math.round((currentAmount - comparisonAmount) * 100) / 100;
  let variancePercent: number | null = null;
  if (Math.abs(comparisonAmount) >= 0.005) {
    variancePercent = Math.round((varianceAmount / comparisonAmount) * 10000) / 100;
  } else if (Math.abs(currentAmount) >= 0.005) {
    variancePercent = null;
  } else {
    variancePercent = 0;
  }
  return {
    currentAmount: Math.round(currentAmount * 100) / 100,
    comparisonAmount: Math.round(comparisonAmount * 100) / 100,
    varianceAmount,
    variancePercent,
  };
}

export function inReportDateRange(
  date: string,
  start: string | null,
  end: string | null,
): boolean {
  const d = date.slice(0, 10);
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

export function dayBefore(isoDate: string): string {
  const date = new Date(isoDate.slice(0, 10) + "T12:00:00");
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}
