import { roundMoney } from "../payment-fees";

export type SettlementJournalAccrualAllocation = {
  appliedAmount: number;
  actualAmountAllocated: number;
  varianceAmount: number;
  liabilityAccountId: string;
  expenseAccountId: string;
  jobId?: string | null;
  partyId?: string | null;
  memo?: string;
};

export type SettlementJournalLine = {
  account_id: string;
  debit?: number;
  credit?: number;
  party_id?: string | null;
  job_id?: string | null;
  memo?: string;
};

/**
 * Build settlement journal with per-allocation variance and separate new expense economics.
 * Never assigns bill-level variance to a single "first" expense account.
 */
export function buildAccrualSettlementJournalLines(input: {
  accrualAllocations: SettlementJournalAccrualAllocation[];
  newExpenseDebits?: Array<{
    accountId: string;
    amount: number;
    partyId?: string | null;
    jobId?: string | null;
    memo?: string;
  }>;
  recoverableTaxDebits?: Array<{
    accountId: string;
    amount: number;
    partyId?: string | null;
    memo?: string;
  }>;
  billTotal: number;
  apAccountId: string;
  partyId?: string | null;
}): SettlementJournalLine[] {
  const billTotal = roundMoney(input.billTotal);
  const lines: SettlementJournalLine[] = [];

  for (const allocation of input.accrualAllocations) {
    const applied = roundMoney(allocation.appliedAmount);
    if (applied > 0) {
      lines.push({
        account_id: allocation.liabilityAccountId,
        debit: applied,
        party_id: allocation.partyId ?? input.partyId ?? null,
        job_id: allocation.jobId ?? null,
        memo: allocation.memo ?? "Clear accrued liability",
      });
    }

    const variance = roundMoney(allocation.varianceAmount);
    if (variance > 0) {
      lines.push({
        account_id: allocation.expenseAccountId,
        debit: variance,
        party_id: allocation.partyId ?? input.partyId ?? null,
        job_id: allocation.jobId ?? null,
        memo: "Accrual settlement variance (actual > estimate)",
      });
    } else if (variance < 0) {
      lines.push({
        account_id: allocation.expenseAccountId,
        credit: roundMoney(-variance),
        party_id: allocation.partyId ?? input.partyId ?? null,
        job_id: allocation.jobId ?? null,
        memo: "Accrual settlement variance (actual < estimate)",
      });
    }
  }

  for (const expense of input.newExpenseDebits ?? []) {
    const amount = roundMoney(expense.amount);
    if (amount <= 0) continue;
    lines.push({
      account_id: expense.accountId,
      debit: amount,
      party_id: expense.partyId ?? input.partyId ?? null,
      job_id: expense.jobId ?? null,
      memo: expense.memo ?? "Bill expense",
    });
  }

  for (const taxDebit of input.recoverableTaxDebits ?? []) {
    const amount = roundMoney(taxDebit.amount);
    if (amount <= 0) continue;
    lines.push({
      account_id: taxDebit.accountId,
      debit: amount,
      party_id: taxDebit.partyId ?? input.partyId ?? null,
      memo: taxDebit.memo ?? "Recoverable input tax",
    });
  }

  lines.push({
    account_id: input.apAccountId,
    credit: billTotal,
    party_id: input.partyId ?? null,
    memo: "Vendor bill AP",
  });

  return lines;
}

/** Reversal lines mirror posted settlement. */
export function buildAccrualSettlementReversalLines(
  postedLines: SettlementJournalLine[],
): SettlementJournalLine[] {
  return postedLines.map((line) => ({
    account_id: line.account_id,
    debit: line.credit,
    credit: line.debit,
    party_id: line.party_id ?? null,
    job_id: line.job_id ?? null,
    memo: line.memo ? `Reversal: ${line.memo}` : "Reversal: accrual settlement",
  }));
}

export function sumJournalDebits(lines: SettlementJournalLine[]): number {
  return roundMoney(lines.reduce((sum, line) => sum + (line.debit ?? 0), 0));
}

export function sumJournalCredits(lines: SettlementJournalLine[]): number {
  return roundMoney(lines.reduce((sum, line) => sum + (line.credit ?? 0), 0));
}

export function assertSettlementJournalBalanced(lines: SettlementJournalLine[]): void {
  const debits = sumJournalDebits(lines);
  const credits = sumJournalCredits(lines);
  if (Math.abs(debits - credits) > 0.009) {
    throw new Error(`Settlement journal unbalanced: debits=${debits} credits=${credits}`);
  }
}

export function totalExpenseEffectFromSettlement(input: {
  accrualAllocations: Array<{ appliedAmount: number; varianceAmount: number }>;
  newExpenseAmount: number;
}): number {
  const accrualEffect = input.accrualAllocations.reduce(
    (sum, row) => sum + row.appliedAmount + Math.max(0, row.varianceAmount),
    0,
  );
  return roundMoney(accrualEffect + input.newExpenseAmount);
}
