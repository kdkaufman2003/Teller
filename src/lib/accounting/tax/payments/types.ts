export type TaxAuthorityPaymentStatus =
  | "draft"
  | "posted"
  | "partially_allocated"
  | "fully_allocated"
  | "reversed"
  | "voided"
  | "needs_review";

export type TaxManualAdjustmentDirection = "increase_liability" | "decrease_liability";

export type TaxManualAdjustmentReasonCode =
  | "authority_assessment"
  | "rounding_adjustment"
  | "prior_period_adjustment"
  | "manual_tax_adjustment"
  | "amendment_adjustment";

export type TaxAuthorityPaymentAllocationInput = {
  filingPeriodId: string;
  amount: number;
};

export type PostAuthorityTaxPaymentInput = {
  organizationId: string;
  registrationId: string;
  paymentDate: string;
  cashAccountId: string;
  baseTaxAmount: number;
  penaltyAmount?: number;
  interestAmount?: number;
  allocations?: TaxAuthorityPaymentAllocationInput[];
  referenceNumber?: string;
  memo?: string;
  idempotencyKey?: string;
  actorId?: string | null;
};

export type PostAuthorityTaxPaymentResult = {
  paymentId: string;
  journalEntryId: string;
  taxTransactionId: string;
  totalAmount: number;
  baseTaxAmount: number;
  unappliedAmount: number;
  allocationIds: string[];
  status: TaxAuthorityPaymentStatus;
};

export type PostTaxManualAdjustmentInput = {
  organizationId: string;
  registrationId: string;
  filingPeriodId?: string | null;
  adjustmentDate: string;
  amount: number;
  direction: TaxManualAdjustmentDirection;
  reasonCode: TaxManualAdjustmentReasonCode;
  reasonNotes?: string;
  offsetAccountId: string;
  idempotencyKey?: string;
  actorId?: string | null;
};

export type PostTaxManualAdjustmentResult = {
  adjustmentId: string;
  journalEntryId: string;
  taxTransactionId: string;
};

export type TaxPeriodPaymentSummary = {
  filedLiability: number;
  previouslyPaid: number;
  remainingBalance: number;
  unappliedPayments: number;
};
