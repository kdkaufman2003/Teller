import { buildAccrualRollforward } from "../schedules/rollforward";
import { roundMoney } from "../payment-fees";
import type { AccrualVarianceRow } from "./types";
import { variancePercent } from "./status";

export function buildAccrualSettlementRollforward(input: {
  controlAccountId: string;
  beginningAccrual: number;
  newAccruals: number;
  settlements: number;
  reversals: number;
  glBalance: number;
}) {
  const settlementsNet = roundMoney(input.settlements + input.reversals);
  return buildAccrualRollforward({
    controlAccountId: input.controlAccountId,
    beginningAccrual: input.beginningAccrual,
    newAccruals: input.newAccruals,
    settlements: settlementsNet,
    glBalance: input.glBalance,
  });
}

export function buildAccrualVarianceReportRows(
  rows: Array<{
    occurrenceId: string;
    scheduleId: string;
    scheduleName: string;
    vendorName: string | null;
    occurrenceDate: string;
    estimatedAmount: number;
    appliedAmount: number;
    actualAmountAllocated: number;
    varianceAmount: number;
    settlementDate: string | null;
    billId: string | null;
    billNumber: string | null;
    settlementId: string | null;
  }>,
): AccrualVarianceRow[] {
  return rows.map((row) => ({
    occurrenceId: row.occurrenceId,
    scheduleId: row.scheduleId,
    scheduleName: row.scheduleName,
    vendorName: row.vendorName,
    occurrenceDate: row.occurrenceDate,
    estimatedAmount: row.estimatedAmount,
    actualAmount: row.actualAmountAllocated,
    varianceAmount: row.varianceAmount,
    variancePercent: variancePercent(row.estimatedAmount, row.actualAmountAllocated),
    settlementDate: row.settlementDate,
    billId: row.billId,
    billNumber: row.billNumber,
    settlementId: row.settlementId,
  }));
}

export function distributeSettlementVariance(
  allocations: Array<{ occurrenceId: string; appliedAmount: number }>,
  totalVariance: number,
): Map<string, number> {
  const map = new Map<string, number>();
  const appliedTotal = roundMoney(allocations.reduce((sum, row) => sum + row.appliedAmount, 0));
  if (Math.abs(totalVariance) < 0.009 || appliedTotal <= 0) {
    for (const row of allocations) map.set(row.occurrenceId, 0);
    return map;
  }

  let assigned = 0;
  for (let i = 0; i < allocations.length; i += 1) {
    const row = allocations[i];
    if (i === allocations.length - 1) {
      map.set(row.occurrenceId, roundMoney(totalVariance - assigned));
    } else {
      const share = roundMoney((row.appliedAmount / appliedTotal) * totalVariance);
      map.set(row.occurrenceId, share);
      assigned = roundMoney(assigned + share);
    }
  }
  return map;
}

export function reconcileAccrualLiabilityToGl(input: {
  subledgerEnding: number;
  glBalance: number;
}): { difference: number; tied: boolean } {
  const difference = roundMoney(input.subledgerEnding - input.glBalance);
  return { difference, tied: Math.abs(difference) < 0.01 };
}
