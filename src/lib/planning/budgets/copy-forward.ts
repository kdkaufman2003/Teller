import type { BudgetLineInput } from "./types";
import { shiftPeriodMonth } from "./prior-year-baseline";

export function copyForwardLines(
  sourceLines: BudgetLineInput[],
  sourceFiscalYear: number,
  targetFiscalYear: number,
): BudgetLineInput[] {
  const yearDelta = targetFiscalYear - sourceFiscalYear;
  if (yearDelta === 0) {
    return sourceLines.map((line) => ({ ...line, notes: line.notes ?? "" }));
  }
  return sourceLines.map((line) => ({
    accountId: line.accountId,
    periodMonth: shiftPeriodMonth(line.periodMonth, yearDelta),
    amount: line.amount,
    notes: line.notes ?? "",
  }));
}

export function cloneLinesForVersion(
  sourceLines: BudgetLineInput[],
  sourceKind: "prior_version" | "clone" = "clone",
): BudgetLineInput[] {
  return sourceLines.map((line) => ({
    accountId: line.accountId,
    periodMonth: line.periodMonth,
    amount: line.amount,
    notes: line.notes ?? "",
  }));
}
