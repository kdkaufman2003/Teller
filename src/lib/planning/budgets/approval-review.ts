import type { BudgetLineInput } from "./types";
import { budgetAnnualTotal } from "./totals";
import { monthLabel, fiscalYearCalendarMonths } from "./periods";

export type ApprovalReviewSummary = {
  budgetName: string;
  fiscalYear: number;
  versionNumber: number;
  versionLabel: string;
  status: string;
  accountCount: number;
  monthsWithValues: number;
  annualTotal: number;
  monthlyTotals: Array<{ periodMonth: string; label: string; total: number }>;
  warnings: string[];
  canApprove: boolean;
};

export function buildApprovalReview(input: {
  budgetName: string;
  fiscalYear: number;
  versionNumber: number;
  versionLabel: string;
  status: string;
  lines: BudgetLineInput[];
}): ApprovalReviewSummary {
  const months = fiscalYearCalendarMonths(input.fiscalYear);
  const accountIds = new Set(input.lines.map((line) => line.accountId));
  const monthsWithValues = new Set(input.lines.filter((line) => Math.abs(line.amount) >= 0.005).map((line) => line.periodMonth));
  const warnings: string[] = [];

  if (input.lines.length === 0) {
    warnings.push("No budget amounts entered yet.");
  }
  if (accountIds.size === 0) {
    warnings.push("No accounts have budget values.");
  }
  if (monthsWithValues.size < 3) {
    warnings.push("Budget appears incomplete — fewer than three months have values.");
  }

  const monthlyTotals = months.map((periodMonth) => ({
    periodMonth,
    label: monthLabel(periodMonth),
    total: input.lines
      .filter((line) => line.periodMonth === periodMonth)
      .reduce((sum, line) => sum + line.amount, 0),
  }));

  return {
    budgetName: input.budgetName,
    fiscalYear: input.fiscalYear,
    versionNumber: input.versionNumber,
    versionLabel: input.versionLabel,
    status: input.status,
    accountCount: accountIds.size,
    monthsWithValues: monthsWithValues.size,
    annualTotal: budgetAnnualTotal(input.lines),
    monthlyTotals: monthlyTotals.map((row) => ({ ...row, total: Math.round(row.total * 100) / 100 })),
    warnings,
    canApprove:
      (input.status === "draft" || input.status === "submitted") && input.lines.length > 0,
  };
}
