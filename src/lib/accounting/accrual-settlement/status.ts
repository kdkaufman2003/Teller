import { roundMoney } from "../payment-fees";
import type { AccrualSettlementStatus, OccurrenceSettlementStatus } from "./types";

export function computeOccurrenceSettlementStatus(input: {
  occurrenceAmount: number;
  settledAmount: number;
  occurrenceStatus: string;
}): OccurrenceSettlementStatus {
  if (input.occurrenceStatus === "reversed") return "reversed";
  if (input.occurrenceStatus === "failed") return "needs_review";

  const remaining = roundMoney(input.occurrenceAmount - input.settledAmount);
  if (remaining <= 0.009) return "settled";
  if (input.settledAmount > 0.009) return "partially_settled";
  return "unsettled";
}

export function computeSettlementHeaderStatus(input: {
  estimatedApplied: number;
  occurrenceRemainingAfter: number;
}): AccrualSettlementStatus {
  if (input.occurrenceRemainingAfter > 0.009 && input.estimatedApplied > 0.009) {
    return "partially_settled";
  }
  return "settled";
}

export function variancePercent(estimated: number, actual: number): number | null {
  if (estimated <= 0) return null;
  return roundMoney(((actual - estimated) / estimated) * 100);
}
