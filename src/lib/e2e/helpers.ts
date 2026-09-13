import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

export function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

export function srcExists(rel: string): boolean {
  return existsSync(join(ROOT, rel));
}

/** Sum debits and credits; returns imbalance magnitude (0 = balanced). */
export function journalImbalance(lines: { debit: number; credit: number }[]): number {
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  return Math.abs(debit - credit);
}

/** Assets = Liabilities + Equity within tolerance. */
export function balanceSheetEquation(
  assets: number,
  liabilities: number,
  equity: number,
  tolerance = 0.01,
): boolean {
  return Math.abs(assets - (liabilities + equity)) <= tolerance;
}

export const LIFECYCLE_MATRIX_DOC = "docs/PHASE-17G-E2E-CERTIFICATION.md";

export const E2E_MODULE_PATHS = {
  ar: "src/lib/accounting/payments.ts",
  ap: "src/lib/accounting/bill-pay.ts",
  deposits: "src/lib/accounting/deposits.ts",
  credits: "src/lib/accounting/credits.ts",
  refunds: "src/lib/accounting/settlements.ts",
  writeoffs: "src/lib/accounting/settlement-reconciliation.ts",
  banking: "src/lib/banking/categorize.ts",
  transfer: "src/lib/banking/transfer.ts",
  inventory: "src/lib/accounting/inventory",
  grni: "src/lib/accounting/inventory/grni",
  jobs: "src/lib/accounting/job-profitability.ts",
  fixedAssets: "src/lib/accounting/fixed-assets.ts",
  payroll: "src/lib/accounting/payroll",
  tax: "src/lib/accounting/tax",
  recurring: "src/lib/accounting/schedules",
  accrual: "src/lib/accounting/schedules/accrual.ts",
  post: "src/lib/accounting/post.ts",
  periods: "src/lib/accounting/periods.ts",
  intercompany: "src/lib/accounting/intercompany",
  consolidation: "src/lib/accounting/consolidated",
  audit: "src/lib/accounting/audit.ts",
  idempotency: "src/lib/reliability/idempotency.ts",
  presentation: "src/lib/ux/presentation-mode.ts",
} as const;
