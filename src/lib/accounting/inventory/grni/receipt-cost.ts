import { roundMoney } from "../../payment-fees";

export type ReceiptCostSource = "po_line_unit_cost" | "explicit_receipt_cost";

export type ResolveReceiptUnitCostInput = {
  poLineUnitCost?: number | null;
  explicitReceiptUnitCost?: number | null;
};

export type ResolveReceiptUnitCostResult = {
  unitCost: number;
  source: ReceiptCostSource;
};

function roundUnitCost(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Receipt valuation from explicit trusted sources only.
 * Preferred: PO line agreed unit cost, then explicit receipt estimated cost.
 */
export function resolveReceiptUnitCost(input: ResolveReceiptUnitCostInput): ResolveReceiptUnitCostResult {
  const poCost = input.poLineUnitCost;
  if (poCost != null && Number.isFinite(poCost) && poCost >= 0) {
    return { unitCost: roundUnitCost(poCost), source: "po_line_unit_cost" };
  }
  const explicit = input.explicitReceiptUnitCost;
  if (explicit != null && Number.isFinite(explicit) && explicit >= 0) {
    return { unitCost: roundUnitCost(explicit), source: "explicit_receipt_cost" };
  }
  throw new Error("Receipt cannot be posted without valid unit cost from PO line or explicit receipt cost");
}

export function computeReceiptExtendedCost(quantity: number, unitCost: number): number {
  if (quantity <= 0) throw new Error("Receipt quantity must be positive");
  return roundMoney(quantity * unitCost);
}

/** V1: block accounting receipt until valid cost is available. */
export const GRNI_RECEIPT_COST_POLICY = "block_until_valid_cost_v1" as const;
