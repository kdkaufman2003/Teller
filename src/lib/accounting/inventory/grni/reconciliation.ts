import { roundMoney } from "../../payment-fees";
import { sumOpenGrniSubledger, type ReceiptOpenState } from "./settlement";

export type GrniReconciliationResult = {
  openReceiptSubledger: number;
  grniGlBalance: number;
  difference: number;
};

export function reconcileGrniSubledgerToGl(input: {
  receipts: ReceiptOpenState[];
  grniGlBalance: number;
}): GrniReconciliationResult {
  const openReceiptSubledger = sumOpenGrniSubledger(input.receipts);
  const grniGlBalance = roundMoney(input.grniGlBalance);
  return {
    openReceiptSubledger,
    grniGlBalance,
    difference: roundMoney(openReceiptSubledger - grniGlBalance),
  };
}

export function assertGrniReconciliationZero(result: GrniReconciliationResult): void {
  if (Math.abs(result.difference) > 0.009) {
    throw new Error(
      `GRNI subledger ${result.openReceiptSubledger} does not tie to GL ${result.grniGlBalance}`,
    );
  }
}

export function scanOrphanSettlementRisk(input: {
  allocations: Array<{ id: string; receiptLineId: string; billLineId: string; reversedByAllocationId?: string | null }>;
  receiptLineIds: Set<string>;
  billLineIds: Set<string>;
}): number {
  let orphans = 0;
  for (const row of input.allocations) {
    if (row.reversedByAllocationId) continue;
    if (!input.receiptLineIds.has(row.receiptLineId) || !input.billLineIds.has(row.billLineId)) {
      orphans++;
    }
  }
  return orphans;
}
