import { roundMoney } from "@/lib/accounting/payment-fees";
import { aggregateWeeklyCash } from "@/lib/planning/cash/engine";
import type { CashFlowLine, CashOutlookReport } from "@/lib/planning/cash/types";
import { addCalendarDays, bucketDateIntoHorizon } from "@/lib/planning/cash/weeks";
import type { ScenarioCashAdjustmentInput, ScenarioDriverInput } from "./types";

const REAL_AMOUNT_SOURCES = new Set([
  "ap_bill",
  "grni_receipt_line",
  "payroll_posted",
]);

const PROJECTED_AMOUNT_SOURCES = new Set([
  "payroll_projection",
  "po_line_commitment",
  "capex_plan",
]);

function driverValue(drivers: ScenarioDriverInput[], type: ScenarioDriverInput["driverType"]): number {
  const row = drivers.find((driver) => driver.driverType === type);
  return row?.valueNumeric != null ? Number(row.valueNumeric) : 0;
}

function lineCashDate(line: CashFlowLine): string {
  const meta = line.metadata as Record<string, unknown> | undefined;
  const candidates = [
    meta?.collectionDate,
    meta?.paymentDate,
    meta?.payDate,
    meta?.occurrenceDate,
    line.periodStart,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);
  }
  return line.periodStart ?? "";
}

function shiftCashLineTiming(
  line: CashFlowLine,
  dayShift: number,
  horizonWeeks: CashOutlookReport["weeks"],
  horizonStart: string,
  horizonEnd: string,
): CashFlowLine {
  if (!dayShift) return { ...line };
  const sourceDate = lineCashDate(line);
  if (!sourceDate) return { ...line };

  const shiftedDate = addCalendarDays(sourceDate, dayShift);
  const bucket = bucketDateIntoHorizon(shiftedDate, horizonStart, horizonEnd, horizonWeeks.map((week) => ({
    weekIndex: week.weekIndex,
    periodStart: week.periodStart,
    periodEnd: week.periodEnd,
    label: week.label,
  })));

  const weekIndex =
    bucket.kind === "week"
      ? bucket.weekIndex
      : bucket.kind === "overdue"
        ? 1
        : null;
  const week = weekIndex != null ? horizonWeeks.find((row) => row.weekIndex === weekIndex) : null;

  return {
    ...line,
    weekIndex,
    periodStart: week?.periodStart ?? null,
    periodEnd: week?.periodEnd ?? null,
    overdue: bucket.kind === "overdue",
    beyondHorizon: bucket.kind === "beyond",
    metadata: {
      ...line.metadata,
      scenarioShiftedDate: shiftedDate,
      scenarioDayShift: dayShift,
    },
  };
}

function applyAmountAdjustment(line: CashFlowLine, pct: number): CashFlowLine {
  if (!pct) return line;
  return {
    ...line,
    amount: roundMoney(line.amount * (1 + pct / 100)),
    metadata: {
      ...line.metadata,
      scenarioAmountPct: pct,
    },
  };
}

function scenarioManualLines(
  adjustments: ScenarioCashAdjustmentInput[],
  horizonWeeks: CashOutlookReport["weeks"],
  horizonStart: string,
  horizonEnd: string,
): CashFlowLine[] {
  return adjustments.map((row, index) => {
    const bucket = bucketDateIntoHorizon(
      row.effectiveDate,
      horizonStart,
      horizonEnd,
      horizonWeeks.map((week) => ({
        weekIndex: week.weekIndex,
        periodStart: week.periodStart,
        periodEnd: week.periodEnd,
        label: week.label,
      })),
    );
    const weekIndex =
      bucket.kind === "week"
        ? bucket.weekIndex
        : bucket.kind === "overdue"
          ? 1
          : null;
    const week = weekIndex != null ? horizonWeeks.find((entry) => entry.weekIndex === weekIndex) : null;

    return {
      id: `scenario-manual-${index}`,
      weekIndex,
      periodStart: week?.periodStart ?? null,
      periodEnd: week?.periodEnd ?? null,
      flowKind: row.flowKind,
      category: "manual",
      amount: roundMoney(row.amount),
      sourceKind: "scenario_manual",
      sourceId: `scenario-manual-${index}`,
      label: row.label,
      explanation: `Scenario — ${row.label}`,
      overdue: bucket.kind === "overdue",
      beyondHorizon: bucket.kind === "beyond",
      metadata: { scenarioOnly: true, notes: row.notes ?? "" },
    };
  });
}

export function applyCashScenarioOverlay(
  base: CashOutlookReport,
  drivers: ScenarioDriverInput[],
  cashAdjustments: ScenarioCashAdjustmentInput[] = [],
): CashOutlookReport {
  const arShift = driverValue(drivers, "ar_days_adjustment");
  const apShift = driverValue(drivers, "ap_days_adjustment");
  const payrollPct = driverValue(drivers, "payroll_percentage");
  const purchasingPct = driverValue(drivers, "purchasing_percentage");
  const capexPct = driverValue(drivers, "capex_percentage");

  const baseLines = base.weeks.flatMap((week) => week.lines);
  const adjustedLines: CashFlowLine[] = [];

  for (const line of baseLines) {
    let next = { ...line };

    if (line.category === "ar_collection") {
      next = shiftCashLineTiming(next, arShift, base.weeks, base.horizonStart, base.horizonEnd);
    }

    if (line.category === "ap_payment" || line.sourceKind === "recurring_bill") {
      next = shiftCashLineTiming(next, apShift, base.weeks, base.horizonStart, base.horizonEnd);
    }

    if (line.sourceKind === "payroll_projection" && payrollPct !== 0) {
      next = applyAmountAdjustment(next, payrollPct);
    } else if (line.sourceKind === "po_line_commitment" && purchasingPct !== 0) {
      next = applyAmountAdjustment(next, purchasingPct);
    } else if (
      (line.sourceKind === "capex_plan" || line.category === "capex") &&
      capexPct !== 0
    ) {
      next = applyAmountAdjustment(next, capexPct);
    } else if (REAL_AMOUNT_SOURCES.has(line.sourceKind) && payrollPct !== 0) {
      void payrollPct;
    }

    adjustedLines.push(next);
  }

  adjustedLines.push(
    ...scenarioManualLines(cashAdjustments, base.weeks, base.horizonStart, base.horizonEnd),
  );

  const scheduled = adjustedLines.filter(
    (line) => !(line.category === "purchasing" && line.metadata?.unscheduled === true),
  );
  const unscheduled = adjustedLines.filter(
    (line) => line.category === "purchasing" && line.metadata?.unscheduled === true,
  );

  const { weeks, beyondHorizon, summary } = aggregateWeeklyCash({
    startingCash: base.startingCash.total,
    horizonWeeks: base.weeks.map((week) => ({
      weekIndex: week.weekIndex,
      periodStart: week.periodStart,
      periodEnd: week.periodEnd,
      label: week.label,
    })),
    flowLines: scheduled,
  });

  const warnings = [...base.warnings];
  if (arShift !== 0 || apShift !== 0) {
    warnings.push({
      code: "scenario_timing",
      message: `Scenario timing overlay applied (AR ${arShift >= 0 ? "+" : ""}${arShift} days, AP ${apShift >= 0 ? "+" : ""}${apShift} days).`,
      severity: "info",
    });
  }
  if (beyondHorizon.length > base.beyondHorizon.length) {
    warnings.push({
      code: "scenario_beyond_horizon",
      message: "Scenario timing pushed additional items beyond the 13-week window.",
      severity: "warn",
    });
  }

  return {
    ...base,
    weeks,
    beyondHorizon,
    unscheduledPurchasing: unscheduled,
    summary,
    warnings,
    sourceCoverage: base.sourceCoverage,
  };
}

export function isRealCashObligation(sourceKind: string): boolean {
  return REAL_AMOUNT_SOURCES.has(sourceKind);
}

export function isProjectedCashSource(sourceKind: string): boolean {
  return PROJECTED_AMOUNT_SOURCES.has(sourceKind);
}
