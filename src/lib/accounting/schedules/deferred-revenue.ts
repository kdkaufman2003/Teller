import { roundMoney } from "../payment-fees";
import { DEFERRED_REVENUE_V1_NOTE } from "./types";
import { buildPrepaidRecognitionPeriods } from "./prepaid";

export { DEFERRED_REVENUE_V1_NOTE };

/**
 * V1 deferred revenue uses customer deposit liability (Phase 3 subtype `deposit`).
 * Recognition: Dr Deposit Liability / Cr Revenue — does not re-post cash receipt.
 */
export function deferredRevenueJournalLines(input: {
  amount: number;
  liabilityAccountId: string;
  revenueAccountId: string;
  jobId?: string | null;
}) {
  const amount = roundMoney(input.amount);
  return [
    { account_id: input.liabilityAccountId, debit: amount, job_id: input.jobId ?? null },
    { account_id: input.revenueAccountId, credit: amount, job_id: input.jobId ?? null },
  ];
}

export function buildDeferredRevenuePeriods(input: {
  startDate: string;
  endDate: string;
  originalAmount: number;
}) {
  return buildPrepaidRecognitionPeriods({
    ...input,
    method: "straight_line_monthly",
  });
}

/** Guard: schedule recognition must not duplicate invoice revenue already posted. */
export function assertNoDoubleCountWithAppliedDeposit(input: {
  depositFullyApplied: boolean;
  scheduleLinkedToDeposit: boolean;
}): void {
  if (input.depositFullyApplied && input.scheduleLinkedToDeposit) {
    throw new Error("Cannot recognize deferred revenue on a fully applied customer deposit");
  }
}

export function whenToUseCustomerDepositVsDeferredSchedule(): Record<string, string> {
  return {
    customer_deposit:
      "Upfront cash/check receipt before service delivery — Dr Cash / Cr Customer Deposit (Phase 3 RPC).",
    deferred_revenue_schedule:
      "Systematic earn-out of an existing deposit liability — Dr Deposit / Cr Revenue via schedule occurrence.",
    invoice_revenue: "Earned at invoice open/post — standard AR/revenue posting.",
    schedule_based: "Only for liability balances not yet recognized; never duplicates applied deposit revenue.",
  };
}
