import { roundMoney } from "../payment-fees";

export type InventoryCloseFinding = {
  key: string;
  severity: "blocker" | "warning" | "informational";
  title: string;
  description: string;
  route?: string;
  difference?: number;
};

export function classifyInventoryGlMismatchFinding(input: {
  difference: number;
}): InventoryCloseFinding | null {
  if (Math.abs(input.difference) <= 0.009) return null;
  return {
    key: "inventory_gl_mismatch",
    severity: "blocker",
    title: "Inventory subledger does not tie to GL",
    description: `Inventory subledger differs from inventory asset GL by ${input.difference.toFixed(2)}.`,
    route: "/app/accounting/inventory/reconciliation",
    difference: input.difference,
  };
}

export function classifyNegativeInventoryFinding(input: {
  rows: Array<{ sku: string; quantityOnHand: number }>;
  allowNegative: boolean;
}): InventoryCloseFinding | null {
  if (input.allowNegative) return null;
  const negatives = input.rows.filter((row) => row.quantityOnHand < -0.0001);
  if (!negatives.length) return null;
  return {
    key: "inventory_negative_stock",
    severity: "blocker",
    title: "Negative inventory not permitted",
    description: `${negatives.length} item/location balance(s) are negative.`,
    route: "/app/accounting/inventory",
  };
}

export function classifyUnvaluedMovementFinding(input: {
  unvaluedCount: number;
}): InventoryCloseFinding | null {
  if (input.unvaluedCount <= 0) return null;
  return {
    key: "inventory_unvalued_movement",
    severity: "blocker",
    title: "Unvalued inventory movement",
    description: `${input.unvaluedCount} economic movement(s) lack valuation.`,
    route: "/app/accounting/inventory/movements",
  };
}

export function classifyBrokenTransferFinding(input: {
  brokenPairs: number;
}): InventoryCloseFinding | null {
  if (input.brokenPairs <= 0) return null;
  return {
    key: "inventory_broken_transfer",
    severity: "blocker",
    title: "Broken inventory transfer pairs",
    description: `${input.brokenPairs} transfer group(s) are incomplete.`,
    route: "/app/accounting/inventory/transfers",
  };
}

export function classifyLargeCountVarianceFinding(input: {
  varianceValue: number;
  threshold?: number;
}): InventoryCloseFinding | null {
  const threshold = input.threshold ?? 500;
  if (Math.abs(input.varianceValue) <= threshold) return null;
  return {
    key: "inventory_large_count_variance",
    severity: "warning",
    title: "Large physical count variance",
    description: `Count variance of ${roundMoney(input.varianceValue).toFixed(2)} exceeds threshold.`,
    route: "/app/accounting/inventory/counts",
    difference: input.varianceValue,
  };
}

export function classifyNormalInventoryBalanceFinding(input: {
  totalValue: number;
}): InventoryCloseFinding | null {
  if (input.totalValue <= 0.009) return null;
  return {
    key: "inventory_normal_balance",
    severity: "informational",
    title: "Inventory balances present",
    description: `Inventory subledger value ${roundMoney(input.totalValue).toFixed(2)}.`,
    route: "/app/accounting/inventory",
  };
}

export function evaluateInventoryCloseFindings(input: {
  glDifference: number;
  negativeRows: Array<{ sku: string; quantityOnHand: number }>;
  allowNegative: boolean;
  unvaluedCount: number;
  brokenTransfers: number;
  countVarianceValue?: number;
  totalSubledgerValue: number;
}): InventoryCloseFinding[] {
  const findings: InventoryCloseFinding[] = [];
  const push = (row: InventoryCloseFinding | null) => {
    if (row) findings.push(row);
  };

  push(classifyInventoryGlMismatchFinding({ difference: input.glDifference }));
  push(classifyNegativeInventoryFinding({ rows: input.negativeRows, allowNegative: input.allowNegative }));
  push(classifyUnvaluedMovementFinding({ unvaluedCount: input.unvaluedCount }));
  push(classifyBrokenTransferFinding({ brokenPairs: input.brokenTransfers }));
  if (input.countVarianceValue != null) {
    push(classifyLargeCountVarianceFinding({ varianceValue: input.countVarianceValue }));
  }
  push(classifyNormalInventoryBalanceFinding({ totalValue: input.totalSubledgerValue }));

  return findings;
}
