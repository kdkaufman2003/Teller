import { roundMoney } from "../payment-fees";

export function accrualJournalLines(input: {
  amount: number;
  expenseAccountId: string;
  liabilityAccountId: string;
  jobId?: string | null;
}) {
  const amount = roundMoney(input.amount);
  return [
    { account_id: input.expenseAccountId, debit: amount, job_id: input.jobId ?? null },
    { account_id: input.liabilityAccountId, credit: amount, job_id: input.jobId ?? null },
  ];
}

export function accrualReversalLines(input: {
  amount: number;
  expenseAccountId: string;
  liabilityAccountId: string;
  jobId?: string | null;
}) {
  const amount = roundMoney(input.amount);
  return [
    { account_id: input.liabilityAccountId, debit: amount, job_id: input.jobId ?? null },
    { account_id: input.expenseAccountId, credit: amount, job_id: input.jobId ?? null },
  ];
}

export function monthlyAccrualAmount(fixedAmount: number): number {
  return roundMoney(fixedAmount);
}

/**
 * Accrual recognition journals do not create AP. Actual vendor bills use accrual settlement
 * (Phase 11.1) to clear accrued liability without duplicating expense.
 */
export function accrualMustNotCreateApBill(): true {
  return true;
}

/** Settlement via bill posting is the supported path to recognize AP against accrued liability. */
export function accrualSettlementViaBillAllowed(): true {
  return true;
}
