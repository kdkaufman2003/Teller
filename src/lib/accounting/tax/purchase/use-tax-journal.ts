import { roundMoney } from "../../payment-fees";
import { classifyPurchaseLine } from "./classify-line";
import type { PurchaseTaxComparisonResult } from "./types";

export type UseTaxJournalLine = {
  account_id: string;
  debit?: number;
  credit?: number;
  party_id?: string | null;
  job_id?: string | null;
  cost_classification?: string | null;
  memo?: string;
};

export type UseTaxLineTarget = {
  lineKey: string;
  accountId: string;
  accountType?: string | null;
  costType?: string | null;
  jobId?: string | null;
  costClassification?: string | null;
};

/**
 * Use tax owed to a tax authority: Dr cost/asset destination, Cr Sales & Use Tax Payable.
 * Vendor-charged tax is handled separately via allocateVendorPurchaseTax.
 */
export function buildUseTaxJournalLines(input: {
  comparison: PurchaseTaxComparisonResult;
  lineTargets: UseTaxLineTarget[];
  useTaxExpenseAccountId: string | null;
  salesTaxPayableAccountId: string;
  partyId?: string | null;
  memo?: string;
}): UseTaxJournalLine[] {
  const useTaxTotal = input.comparison.useTaxDueTotal;
  if (useTaxTotal <= 0.009) return [];

  const debitByAccount = new Map<
    string,
    { amount: number; jobId?: string | null; costClassification?: string | null }
  >();

  for (const line of input.comparison.lineResults) {
    if (line.useTaxDue <= 0.009) continue;
    const target = input.lineTargets.find((row) => row.lineKey === line.lineKey);
    if (!target) continue;

    const classification = classifyPurchaseLine({
      accountType: target.accountType,
      costType: target.costType,
    });

    let debitAccountId: string;
    if (classification === "inventory" || classification === "fixed_asset") {
      debitAccountId = target.accountId;
    } else {
      debitAccountId = input.useTaxExpenseAccountId ?? target.accountId;
    }

    const existing = debitByAccount.get(debitAccountId) ?? {
      amount: 0,
      jobId: target.jobId,
      costClassification: target.costClassification,
    };
    existing.amount = roundMoney(existing.amount + line.useTaxDue);
    debitByAccount.set(debitAccountId, existing);
  }

  const lines: UseTaxJournalLine[] = [];
  for (const [accountId, row] of debitByAccount) {
    lines.push({
      account_id: accountId,
      debit: row.amount,
      party_id: input.partyId,
      job_id: row.jobId ?? null,
      cost_classification: row.costClassification ?? null,
      memo: input.memo ?? "Use tax accrual",
    });
  }

  lines.push({
    account_id: input.salesTaxPayableAccountId,
    credit: useTaxTotal,
    party_id: input.partyId,
    memo: input.memo ?? "Use tax payable",
  });

  return lines;
}
