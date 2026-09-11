import type { TaxCalculationResult } from "./calculation-contract";
import type { TaxSourceType, TaxTransactionType } from "./types";

/** Phase 15D will map calculation output to journal lines via post.ts — not in 15A. */
export type TaxPostingIntent = {
  organizationId: string;
  sourceType: TaxSourceType;
  sourceId: string;
  transactionType: TaxTransactionType;
  transactionDate: string;
  calculation: TaxCalculationResult;
  salesTaxPayableAccountId: string;
};

export type TaxPostingPlan = {
  canPost: boolean;
  reason?: string;
  journalLines: Array<{
    accountRole: "accounts_receivable" | "revenue" | "sales_tax_payable";
    debit?: number;
    credit?: number;
    memo?: string;
  }>;
};

/** Validates posting prerequisites without creating journals (15A). */
export function planTaxPosting(intent: TaxPostingIntent): TaxPostingPlan {
  if (!intent.salesTaxPayableAccountId) {
    return { canPost: false, reason: "Sales tax payable account is not configured", journalLines: [] };
  }
  if (intent.calculation.status === "needs_review") {
    return { canPost: false, reason: "Tax determination needs review before posting", journalLines: [] };
  }
  if (intent.calculation.taxTotal < 0) {
    return { canPost: false, reason: "Tax total cannot be negative", journalLines: [] };
  }
  return {
    canPost: true,
    journalLines: [],
  };
}
