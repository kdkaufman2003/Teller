import { roundMoney } from "../../payment-fees";

export type ReceiptOpenState = {
  receiptLineId: string;
  quantityReceived: number;
  quantityMatched: number;
  receiptValue: number;
  valueMatched: number;
};

export type BillSettlementInput = {
  billLineId: string;
  receiptLineId: string;
  quantityToMatch: number;
  receiptUnitCost: number;
  billUnitCost: number;
};

export type BillSettlementPreview = {
  receiptLineId: string;
  billLineId: string;
  quantityMatched: number;
  receiptValueMatched: number;
  billValueMatched: number;
  varianceAmount: number;
};

export function computeOpenReceiptQuantity(state: ReceiptOpenState): number {
  return roundMoney(Math.max(0, state.quantityReceived - state.quantityMatched));
}

export function computeOpenReceiptValue(state: ReceiptOpenState): number {
  return roundMoney(Math.max(0, state.receiptValue - state.valueMatched));
}

export function assertMatchCapacity(
  state: ReceiptOpenState,
  quantityToMatch: number,
): void {
  const openQty = computeOpenReceiptQuantity(state);
  if (quantityToMatch - openQty > 0.0001) {
    throw new Error(
      `Match quantity ${quantityToMatch} exceeds open receipt quantity ${openQty}`,
    );
  }
  if (quantityToMatch <= 0) {
    throw new Error("Match quantity must be positive");
  }
}

export function previewBillSettlement(input: BillSettlementInput): BillSettlementPreview {
  const receiptValueMatched = roundMoney(input.quantityToMatch * input.receiptUnitCost);
  const billValueMatched = roundMoney(input.quantityToMatch * input.billUnitCost);
  const varianceAmount = roundMoney(billValueMatched - receiptValueMatched);
  return {
    receiptLineId: input.receiptLineId,
    billLineId: input.billLineId,
    quantityMatched: roundMoney(input.quantityToMatch),
    receiptValueMatched,
    billValueMatched,
    varianceAmount,
  };
}

export function applySettlementToReceiptState(
  state: ReceiptOpenState,
  settlement: BillSettlementPreview,
): ReceiptOpenState {
  assertMatchCapacity(state, settlement.quantityMatched);
  return {
    ...state,
    quantityMatched: roundMoney(state.quantityMatched + settlement.quantityMatched),
    valueMatched: roundMoney(state.valueMatched + settlement.receiptValueMatched),
  };
}

export function assertBillMatchCapacity(
  billQuantity: number,
  alreadyMatched: number,
  quantityToMatch: number,
): void {
  const open = roundMoney(Math.max(0, billQuantity - alreadyMatched));
  if (quantityToMatch - open > 0.0001) {
    throw new Error(`Bill match quantity ${quantityToMatch} exceeds open bill quantity ${open}`);
  }
}

export function canReverseReceipt(state: ReceiptOpenState): boolean {
  return state.quantityMatched <= 0.0001 && state.valueMatched <= 0.009;
}

export function grniSettlementIdempotencyKey(receiptLineId: string, billLineId: string, operationId: string): string {
  return `grni:settle:${receiptLineId}:${billLineId}:${operationId}`;
}

export function grniSettlementReversalIdempotencyKey(allocationId: string): string {
  return `grni:settle:reverse:${allocationId}`;
}

export type AllocationRow = {
  id: string;
  receiptLineId: string;
  billLineId: string;
  quantityMatched: number;
  receiptValueMatched: number;
  billValueMatched: number;
  varianceAmount: number;
  reversedByAllocationId?: string | null;
};

export function sumOpenGrniSubledger(receipts: ReceiptOpenState[]): number {
  return roundMoney(receipts.reduce((sum, row) => sum + computeOpenReceiptValue(row), 0));
}

export function sumSettlementVariance(allocations: AllocationRow[]): number {
  return roundMoney(
    allocations
      .filter((row) => !row.reversedByAllocationId)
      .reduce((sum, row) => sum + row.varianceAmount, 0),
  );
}

/** Unmatched inventory bill line must not debit on-hand inventory (V1). */
export const UNMATCHED_INVENTORY_BILL_POLICY =
  "require_receipt_match_before_grni_settlement_no_inventory_on_hand_debit_v1" as const;
