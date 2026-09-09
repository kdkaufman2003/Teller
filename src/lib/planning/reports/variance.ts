import { roundMoney } from "@/lib/accounting/payment-fees";

/** Variance $ = Actual - Budget (Phase 14 canonical formula). */
export function varianceAmount(actual: number, budget: number): number {
  return roundMoney(actual - budget);
}

export type VariancePercentResult = number | null;

/**
 * Percentage variance = variance / |budget|.
 * Budget = 0 and Actual = 0 → 0
 * Budget = 0 and Actual ≠ 0 → null (display N/M)
 */
export function variancePercent(actual: number, budget: number): VariancePercentResult {
  const variance = varianceAmount(actual, budget);
  if (Math.abs(budget) < 0.005) {
    if (Math.abs(actual) < 0.005) return 0;
    return null;
  }
  return roundMoney((variance / Math.abs(budget)) * 100);
}

export type VarianceStatus = "favorable" | "unfavorable" | "on_plan" | "unbudgeted" | "no_activity";

export function varianceStatus(
  actual: number,
  budget: number,
  accountType: string,
): VarianceStatus {
  const hasActual = Math.abs(actual) >= 0.005;
  const hasBudget = Math.abs(budget) >= 0.005;
  if (!hasActual && !hasBudget) return "no_activity";
  if (hasActual && !hasBudget) return "unbudgeted";

  const variance = varianceAmount(actual, budget);
  if (Math.abs(variance) < 0.005) return "on_plan";

  if (accountType === "revenue") {
    return variance > 0 ? "favorable" : "unfavorable";
  }
  if (accountType === "cogs" || accountType === "expense") {
    return variance < 0 ? "favorable" : "unfavorable";
  }
  return variance > 0 ? "favorable" : "unfavorable";
}

/** Normalize GL activity and budget into positive owner-facing magnitudes for P&L types. */
export function normalizeOwnerFacingAmount(amount: number, accountType: string): number {
  if (accountType === "revenue" || accountType === "cogs" || accountType === "expense") {
    return roundMoney(Math.abs(amount));
  }
  return roundMoney(amount);
}

export function formatVariancePercent(value: VariancePercentResult): string {
  if (value === null) return "N/M";
  return `${value.toFixed(1)}%`;
}

export function varianceStatusLabel(status: VarianceStatus): string {
  switch (status) {
    case "favorable":
      return "Favorable";
    case "unfavorable":
      return "Unfavorable";
    case "on_plan":
      return "On Plan";
    case "unbudgeted":
      return "Unbudgeted";
    default:
      return "No Activity";
  }
}

export type VarianceAmounts = {
  budget: number;
  actual: number;
  varianceAmount: number;
  variancePercent: VariancePercentResult;
  status: VarianceStatus;
};

export function computeVarianceAmounts(
  actual: number,
  budget: number,
  accountType: string,
): VarianceAmounts {
  const normalizedActual = normalizeOwnerFacingAmount(actual, accountType);
  const normalizedBudget = normalizeOwnerFacingAmount(budget, accountType);
  return {
    budget: normalizedBudget,
    actual: normalizedActual,
    varianceAmount: varianceAmount(normalizedActual, normalizedBudget),
    variancePercent: variancePercent(normalizedActual, normalizedBudget),
    status: varianceStatus(normalizedActual, normalizedBudget, accountType),
  };
}

export function sumAmounts(values: number[]): number {
  return roundMoney(values.reduce((sum, value) => sum + value, 0));
}
