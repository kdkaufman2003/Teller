export type AccrualSettlementStatus =
  | "draft"
  | "posted"
  | "partially_settled"
  | "settled"
  | "reversed"
  | "failed"
  | "needs_review";

export type OccurrenceSettlementStatus =
  | "unsettled"
  | "partially_settled"
  | "settled"
  | "reversed"
  | "needs_review";

export type AccrualAllocationInput = {
  occurrenceId: string;
  appliedAmount: number;
  /** Explicit actual economics for this accrual; otherwise computed proportionally. */
  actualAmountAllocated?: number;
};

export type SettlementBillLineInput = {
  amount: number;
  account_id: string | null;
  description?: string;
  occurrenceId?: string | null;
  settlesAccrual?: boolean;
  taxAmount?: number;
  taxable?: boolean;
  recoverableInputTax?: boolean;
};

export type EligibleAccrualOccurrence = {
  occurrenceId: string;
  scheduleId: string;
  scheduleName: string;
  occurrenceDate: string;
  accruedAmount: number;
  settledAmount: number;
  remainingAmount: number;
  settlementStatus: OccurrenceSettlementStatus;
  vendorPartyId: string | null;
  vendorName: string | null;
  liabilityAccountId: string;
  expenseAccountId: string;
  journalEntryId: string | null;
};

export type SettlementPreview = {
  billTotal: number;
  billSubtotal: number;
  estimatedApplied: number;
  varianceAmount: number;
  accrualSettlementPortion: number;
  newExpensePortion: number;
  purchaseTaxPortion: number;
  apAmount: number;
  allocations: Array<{
    occurrenceId: string;
    appliedAmount: number;
    actualAmountAllocated: number;
    actualPreTaxAllocated: number;
    nonrecoverableTaxAllocated: number;
    recoverableTaxAllocated: number;
    varianceAmount: number;
    estimatedAmount: number;
    liabilityAccountId: string;
    expenseAccountId: string;
  }>;
  journalLines: Array<{
    account_id: string;
    debit?: number;
    credit?: number;
    memo?: string;
    party_id?: string | null;
    job_id?: string | null;
  }>;
  totalExpenseEffect: number;
};

export type AccrualVarianceRow = {
  occurrenceId: string;
  scheduleId: string;
  scheduleName: string;
  vendorName: string | null;
  occurrenceDate: string;
  estimatedAmount: number;
  actualAmount: number;
  varianceAmount: number;
  variancePercent: number | null;
  settlementDate: string | null;
  billId: string | null;
  billNumber: string | null;
  settlementId: string | null;
};

export function accrualSettlementIdempotencyKey(billId: string, clientKey?: string | null): string {
  if (clientKey?.trim()) return `accrual-settle:${clientKey.trim()}`;
  return `accrual-settle:bill:${billId}`;
}
