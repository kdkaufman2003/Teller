import { roundMoney } from "@/lib/accounting/payment-fees";
import type {
  CashFlowLine,
  CashHorizonWeek,
  CashOutlookSummary,
  CashOutlookWarning,
  CashWeeklySummary,
} from "./types";
import { bucketDateIntoHorizon } from "./weeks";

export function manualOverridesToFlowLines(input: {
  overrides: Array<{
    id: string;
    effectiveDate: string;
    flowKind: "inflow" | "outflow";
    amount: number;
    label: string;
    notes: string;
  }>;
  horizonWeeks: CashHorizonWeek[];
  horizonStart: string;
  horizonEnd: string;
}): CashFlowLine[] {
  return input.overrides.map((override) => {
    const bucket = bucketDateIntoHorizon(
      override.effectiveDate,
      input.horizonStart,
      input.horizonEnd,
      input.horizonWeeks,
    );
    const weekIndex =
      bucket.kind === "week"
        ? bucket.weekIndex
        : bucket.kind === "overdue"
          ? 1
          : null;
    const week =
      weekIndex != null ? input.horizonWeeks.find((w) => w.weekIndex === weekIndex) : null;

    return {
      id: override.id,
      weekIndex,
      periodStart: week?.periodStart ?? null,
      periodEnd: week?.periodEnd ?? null,
      flowKind: override.flowKind,
      category: "manual",
      amount: roundMoney(override.amount),
      sourceKind: "manual_override",
      sourceId: override.id,
      label: override.label,
      explanation: `Manual — ${override.label}`,
      overdue: bucket.kind === "overdue",
      beyondHorizon: bucket.kind === "beyond",
      metadata: { notes: override.notes },
    };
  });
}

export function aggregateWeeklyCash(input: {
  startingCash: number;
  horizonWeeks: CashHorizonWeek[];
  flowLines: CashFlowLine[];
}): {
  weeks: CashWeeklySummary[];
  beyondHorizon: CashFlowLine[];
  summary: CashOutlookSummary;
} {
  const inHorizon = input.flowLines.filter((line) => !line.beyondHorizon);
  const beyondHorizon = input.flowLines.filter((line) => line.beyondHorizon);

  let opening = roundMoney(input.startingCash);
  const weeks: CashWeeklySummary[] = [];
  let lowestCash = opening;
  let lowestCashWeekIndex: number | null = 1;
  let lowestCashDate: string | null = input.horizonWeeks[0]?.periodEnd ?? null;
  let firstNegativeWeekIndex: number | null = null;
  let firstNegativeWeekLabel: string | null = null;

  let totalIn = 0;
  let totalOut = 0;

  for (const week of input.horizonWeeks) {
    const weekLines = inHorizon.filter((line) => line.weekIndex === week.weekIndex);
    const cashIn = roundMoney(
      weekLines.filter((l) => l.flowKind === "inflow").reduce((s, l) => s + l.amount, 0),
    );
    const cashOut = roundMoney(
      weekLines.filter((l) => l.flowKind === "outflow").reduce((s, l) => s + l.amount, 0),
    );
    const netChange = roundMoney(cashIn - cashOut);
    const closing = roundMoney(opening + netChange);

    totalIn = roundMoney(totalIn + cashIn);
    totalOut = roundMoney(totalOut + cashOut);

    if (closing < lowestCash) {
      lowestCash = closing;
      lowestCashWeekIndex = week.weekIndex;
      lowestCashDate = week.periodEnd;
    }

    if (firstNegativeWeekIndex == null && closing < -0.009) {
      firstNegativeWeekIndex = week.weekIndex;
      firstNegativeWeekLabel = week.label;
    }

    weeks.push({
      weekIndex: week.weekIndex,
      periodStart: week.periodStart,
      periodEnd: week.periodEnd,
      label: week.label,
      openingCash: opening,
      cashIn,
      cashOut,
      netChange,
      closingCash: closing,
      lines: weekLines,
    });

    opening = closing;
  }

  const endingCash = weeks[weeks.length - 1]?.closingCash ?? input.startingCash;

  const summary: CashOutlookSummary = {
    startingCash: roundMoney(input.startingCash),
    expectedMoneyIn: totalIn,
    expectedMoneyOut: totalOut,
    endingCash,
    lowestCash,
    lowestCashWeekIndex,
    lowestCashDate,
    firstNegativeWeekIndex,
    firstNegativeWeekLabel,
    runwayWeeks: firstNegativeWeekIndex ?? "13+",
  };

  return { weeks, beyondHorizon, summary };
}

export function buildCashWarnings(input: {
  startingCashAccounts: number;
  arOverdueCount: number;
  apOverdueCount: number;
  arDefaultTimingCount: number;
  apDefaultTimingCount: number;
  firstNegativeWeekIndex: number | null;
  payrollMissingAmount?: boolean;
  unscheduledPurchasingCount?: number;
  dedupeDroppedCount?: number;
}): CashOutlookWarning[] {
  const warnings: CashOutlookWarning[] = [];

  if (input.startingCashAccounts === 0) {
    warnings.push({
      code: "no_cash_accounts",
      message: "No eligible cash or bank GL accounts were found. Starting cash is $0.",
      severity: "warn",
    });
  }

  if (input.arOverdueCount > 0) {
    warnings.push({
      code: "overdue_ar",
      message: `${input.arOverdueCount} overdue receivable(s) included in Week 1.`,
      severity: "warn",
    });
  }

  if (input.apOverdueCount > 0) {
    warnings.push({
      code: "overdue_ap",
      message: `${input.apOverdueCount} overdue bill(s) included in Week 1.`,
      severity: "warn",
    });
  }

  if (input.arDefaultTimingCount > 0 || input.apDefaultTimingCount > 0) {
    warnings.push({
      code: "default_timing",
      message: "Some items used default collection or payment timing (no due date on document).",
      severity: "info",
    });
  }

  if (input.payrollMissingAmount) {
    warnings.push({
      code: "payroll_amount_unavailable",
      message: "Payroll cadence is configured but no posted payroll run is available for amount projection.",
      severity: "warn",
    });
  }

  if ((input.unscheduledPurchasingCount ?? 0) > 0) {
    warnings.push({
      code: "unscheduled_purchasing",
      message: `${input.unscheduledPurchasingCount} purchase commitment(s) have no expected date and are listed separately.`,
      severity: "warn",
    });
  }

  if ((input.dedupeDroppedCount ?? 0) > 0) {
    warnings.push({
      code: "source_dedupe",
      message: `${input.dedupeDroppedCount} duplicate cash source(s) were excluded by precedence rules.`,
      severity: "info",
    });
  }

  if (input.firstNegativeWeekIndex != null) {
    warnings.push({
      code: "negative_cash",
      message: `Projected cash shortfall in Week ${input.firstNegativeWeekIndex}.`,
      severity: "warn",
    });
  } else {
    warnings.push({
      code: "no_shortfall",
      message: "No projected cash shortfall in the next 13 weeks.",
      severity: "info",
    });
  }

  return warnings;
}
