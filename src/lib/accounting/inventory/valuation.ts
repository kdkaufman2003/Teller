import { roundMoney } from "../payment-fees";
import type { InventoryBalanceState } from "./types";

export type WeightedAverageReceiptResult = {
  quantityOnHand: number;
  inventoryValue: number;
  weightedAverageUnitCost: number;
};

export type WeightedAverageIssueResult = WeightedAverageReceiptResult & {
  cogsAmount: number;
  unitCostApplied: number;
};

/** Receipt into weighted-average inventory. Cent-safe deterministic math. */
export function applyWeightedAverageReceipt(
  state: InventoryBalanceState,
  receiptQuantity: number,
  receiptUnitCost: number,
): WeightedAverageReceiptResult {
  if (receiptQuantity <= 0) throw new Error("Receipt quantity must be positive");
  if (receiptUnitCost < 0) throw new Error("Receipt unit cost cannot be negative");

  const receiptValue = roundMoney(receiptQuantity * receiptUnitCost);
  const quantityOnHand = roundMoney(state.quantityOnHand + receiptQuantity);
  const inventoryValue = roundMoney(state.inventoryValue + receiptValue);
  const weightedAverageUnitCost =
    quantityOnHand <= 0.0001 ? 0 : roundMoney(inventoryValue / quantityOnHand);

  return { quantityOnHand, inventoryValue, weightedAverageUnitCost };
}

/** Issue from weighted-average inventory. */
export function applyWeightedAverageIssue(
  state: InventoryBalanceState,
  issueQuantity: number,
  allowNegative = false,
): WeightedAverageIssueResult {
  if (issueQuantity <= 0) throw new Error("Issue quantity must be positive");
  if (!allowNegative && issueQuantity - state.quantityOnHand > 0.0001) {
    throw new Error(
      `Insufficient inventory: on hand ${state.quantityOnHand}, issue ${issueQuantity}`,
    );
  }

  const unitCostApplied =
    state.quantityOnHand <= 0.0001 ? state.weightedAverageUnitCost : state.weightedAverageUnitCost;
  const cogsAmount = roundMoney(issueQuantity * unitCostApplied);
  const quantityOnHand = roundMoney(state.quantityOnHand - issueQuantity);
  const inventoryValue = roundMoney(Math.max(0, state.inventoryValue - cogsAmount));
  const weightedAverageUnitCost =
    quantityOnHand <= 0.0001 ? unitCostApplied : roundMoney(inventoryValue / quantityOnHand);

  return {
    quantityOnHand,
    inventoryValue,
    weightedAverageUnitCost,
    cogsAmount,
    unitCostApplied,
  };
}

/** Job return at original issue unit cost (preserves job economics). */
export function applyJobReturnAtCost(
  state: InventoryBalanceState,
  returnQuantity: number,
  originalIssueUnitCost: number,
): WeightedAverageReceiptResult {
  return applyWeightedAverageReceipt(state, returnQuantity, originalIssueUnitCost);
}

/** Transfer preserves valuation — no org-wide GL effect. */
export function applyTransferOut(
  state: InventoryBalanceState,
  quantity: number,
  allowNegative = false,
): { quantityOnHand: number; inventoryValue: number; weightedAverageUnitCost: number; extendedCost: number } {
  const issue = applyWeightedAverageIssue(state, quantity, allowNegative);
  return {
    quantityOnHand: issue.quantityOnHand,
    inventoryValue: issue.inventoryValue,
    weightedAverageUnitCost: issue.weightedAverageUnitCost,
    extendedCost: issue.cogsAmount,
  };
}

export function applyTransferIn(
  state: InventoryBalanceState,
  quantity: number,
  unitCost: number,
): WeightedAverageReceiptResult {
  return applyWeightedAverageReceipt(state, quantity, unitCost);
}

export function reconcileQuantityBridge(input: {
  openingQuantity: number;
  receipts: number;
  transfersIn: number;
  returnsIn: number;
  adjustmentsIn: number;
  issues: number;
  transfersOut: number;
  vendorReturns: number;
  adjustmentsOut: number;
  endingQuantity: number;
}): number {
  const computed = roundMoney(
    input.openingQuantity +
      input.receipts +
      input.transfersIn +
      input.returnsIn +
      input.adjustmentsIn -
      input.issues -
      input.transfersOut -
      input.vendorReturns -
      input.adjustmentsOut,
  );
  return roundMoney(computed - input.endingQuantity);
}
