import { roundMoney } from "../payment-fees";
import type { InventoryBalanceState } from "./types";

export type InventoryReconciliationResult = {
  subledgerValue: number;
  glInventoryAssetBalance: number;
  difference: number;
  quantityBridgeDifference: number;
  cogsDifference: number;
};

export function reconcileInventorySubledgerToGl(input: {
  balances: InventoryBalanceState[];
  glInventoryAssetBalance: number;
}): Pick<InventoryReconciliationResult, "subledgerValue" | "glInventoryAssetBalance" | "difference"> {
  const subledgerValue = roundMoney(
    input.balances.reduce((sum, row) => sum + row.inventoryValue, 0),
  );
  const glInventoryAssetBalance = roundMoney(input.glInventoryAssetBalance);
  return {
    subledgerValue,
    glInventoryAssetBalance,
    difference: roundMoney(subledgerValue - glInventoryAssetBalance),
  };
}

export function reconcileInventoryCogs(input: {
  issueCosts: number[];
  cogsGlActivity: number;
}): number {
  const issueTotal = roundMoney(input.issueCosts.reduce((sum, row) => sum + row, 0));
  return roundMoney(issueTotal - input.cogsGlActivity);
}

export function reconcileTransferZeroGl(input: {
  transferOutValue: number;
  transferInValue: number;
  glNetChange: number;
}): number {
  const netTransfer = roundMoney(input.transferOutValue - input.transferInValue);
  return roundMoney(netTransfer + input.glNetChange);
}

export type MovementSummary = {
  receipts: number;
  transfersIn: number;
  returnsIn: number;
  adjustmentsIn: number;
  issues: number;
  transfersOut: number;
  vendorReturns: number;
  adjustmentsOut: number;
};

export function summarizeMovementQuantities(
  movements: Array<{ movementType: string; quantityDelta: number }>,
): MovementSummary {
  const summary: MovementSummary = {
    receipts: 0,
    transfersIn: 0,
    returnsIn: 0,
    adjustmentsIn: 0,
    issues: 0,
    transfersOut: 0,
    vendorReturns: 0,
    adjustmentsOut: 0,
  };

  for (const row of movements) {
    const qty = Math.abs(row.quantityDelta);
    switch (row.movementType) {
      case "purchase_receipt":
      case "opening_balance":
        summary.receipts += qty;
        break;
      case "transfer_in":
        summary.transfersIn += qty;
        break;
      case "job_return":
        summary.returnsIn += qty;
        break;
      case "adjustment_in":
        summary.adjustmentsIn += qty;
        break;
      case "job_issue":
        summary.issues += qty;
        break;
      case "transfer_out":
        summary.transfersOut += qty;
        break;
      case "vendor_return":
        summary.vendorReturns += qty;
        break;
      case "adjustment_out":
        summary.adjustmentsOut += qty;
        break;
      default:
        break;
    }
  }

  for (const key of Object.keys(summary) as (keyof MovementSummary)[]) {
    summary[key] = roundMoney(summary[key]);
  }
  return summary;
}
