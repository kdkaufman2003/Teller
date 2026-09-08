import { roundMoney } from "../../payment-fees";
import type { InventoryCloseFinding } from "../close-integration";
import type { GrniAgingRow } from "./reporting";

export type GrniCloseFinding = InventoryCloseFinding;

export function classifyGrniGlMismatchFinding(input: {
  difference: number;
}): GrniCloseFinding | null {
  if (Math.abs(input.difference) <= 0.009) return null;
  return {
    key: "grni_gl_mismatch",
    severity: "blocker",
    title: "GRNI subledger does not tie to GL",
    description: `Open receipt subledger differs from GRNI GL by ${input.difference.toFixed(2)}.`,
    route: "/app/accounting/inventory/reconciliation",
    difference: input.difference,
  };
}

export function classifyReceiptMatchOverCapacityFinding(input: {
  overCapacityCount: number;
}): GrniCloseFinding | null {
  if (input.overCapacityCount <= 0) return null;
  return {
    key: "grni_match_over_capacity",
    severity: "blocker",
    title: "Receipt/bill match over capacity",
    description: `${input.overCapacityCount} allocation(s) exceed valid match capacity.`,
    route: "/app/accounting/inventory/movements",
  };
}

export function classifyBrokenReceiptBillAllocationFinding(input: {
  brokenCount: number;
}): GrniCloseFinding | null {
  if (input.brokenCount <= 0) return null;
  return {
    key: "grni_broken_allocation",
    severity: "blocker",
    title: "Broken receipt/bill allocation",
    description: `${input.brokenCount} settlement allocation(s) have invalid lineage.`,
    route: "/app/accounting/inventory/reconciliation",
  };
}

export function classifyGrniAgingWarning(input: {
  agingRows: GrniAgingRow[];
}): GrniCloseFinding | null {
  const maxAge = input.agingRows.reduce((max, row) => Math.max(max, row.ageDays), 0);
  if (maxAge <= 30) return null;
  const severity = maxAge > 90 ? "warning" : maxAge > 60 ? "warning" : "warning";
  const title =
    maxAge > 90
      ? "GRNI outstanding over 90 days"
      : maxAge > 60
        ? "GRNI outstanding over 60 days"
        : "GRNI outstanding over 30 days";
  return {
    key: "grni_aging",
    severity,
    title,
    description: `Oldest open GRNI is ${maxAge} days.`,
    route: "/app/reports/grni-aging",
  };
}

export function classifyLargePpvWarning(input: {
  ppvTotal: number;
  threshold?: number;
}): GrniCloseFinding | null {
  const threshold = input.threshold ?? 500;
  if (Math.abs(input.ppvTotal) <= threshold) return null;
  return {
    key: "grni_large_ppv",
    severity: "warning",
    title: "Unusually large purchase price variance",
    description: `PPV total ${roundMoney(input.ppvTotal).toFixed(2)} exceeds threshold.`,
    route: "/app/reports/purchase-price-variance",
    difference: input.ppvTotal,
  };
}

export function evaluateGrniCloseFindings(input: {
  grniDifference: number;
  overCapacityCount: number;
  brokenAllocationCount: number;
  agingRows: GrniAgingRow[];
  ppvTotal: number;
}): GrniCloseFinding[] {
  const findings: GrniCloseFinding[] = [];
  const push = (row: GrniCloseFinding | null) => {
    if (row) findings.push(row);
  };
  push(classifyGrniGlMismatchFinding({ difference: input.grniDifference }));
  push(classifyReceiptMatchOverCapacityFinding({ overCapacityCount: input.overCapacityCount }));
  push(classifyBrokenReceiptBillAllocationFinding({ brokenCount: input.brokenAllocationCount }));
  push(classifyGrniAgingWarning({ agingRows: input.agingRows }));
  push(classifyLargePpvWarning({ ppvTotal: input.ppvTotal }));
  return findings;
}
