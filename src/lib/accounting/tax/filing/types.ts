import type { TaxFilingFrequency } from "../types";

export type TaxFilingPeriodStatus =
  | "open"
  | "ready_for_review"
  | "reviewed"
  | "filed"
  | "closed"
  | "needs_review";

export type TaxFilingPeriodSnapshotKind = "reconciliation" | "reviewed" | "filed";

export type TaxReconciliationExceptionCode =
  | "GL_WITHOUT_TAX_SUBLEDGER"
  | "TAX_SUBLEDGER_WITHOUT_GL"
  | "WRONG_TAX_PAYABLE_ACCOUNT"
  | "UNASSIGNED_REGISTRATION"
  | "UNASSIGNED_AUTHORITY"
  | "TRANSACTION_OUTSIDE_REGISTRATION_DATES"
  | "NEEDS_REVIEW_TAX_TRANSACTION"
  | "COMPONENT_MISMATCH"
  | "PERIOD_OVERLAP"
  | "PERIOD_GAP"
  | "LATE_PERIOD_TRANSACTION"
  | "SUBLEDGER_GL_DIFFERENCE";

export type TaxRegistrationRecord = {
  id: string;
  organizationId: string;
  authorityId?: string | null;
  jurisdictionKey?: string | null;
  registrationNumber?: string | null;
  filingFrequency: TaxFilingFrequency;
  status: "active" | "inactive" | "pending";
  effectiveFrom: string;
  effectiveTo?: string | null;
};

export type TaxFilingPeriodRecord = {
  id: string;
  organizationId: string;
  registrationId: string;
  authorityId?: string | null;
  jurisdictionKey?: string | null;
  periodStart: string;
  periodEnd: string;
  filingFrequency: TaxFilingFrequency;
  status: TaxFilingPeriodStatus;
  metadata?: Record<string, unknown>;
};

export type TaxLiabilityRollforwardLine = {
  category:
    | "beginning_liability"
    | "sales_tax_accrued"
    | "use_tax_accrued"
    | "sales_tax_reversed"
    | "sales_tax_refunded"
    | "use_tax_reversed"
    | "tax_adjustment"
    | "authority_payment"
    | "ending_subledger_liability";
  amount: number;
  transactionCount: number;
};

export type TaxReconciliationException = {
  code: TaxReconciliationExceptionCode;
  message: string;
  severity: "blocking" | "warning";
  taxTransactionId?: string | null;
  journalEntryId?: string | null;
  documentId?: string | null;
  amount?: number | null;
};

export type TaxPeriodReconciliationResult = {
  period: TaxFilingPeriodRecord;
  registration: TaxRegistrationRecord;
  salesTaxAccrued: number;
  useTaxAccrued: number;
  salesTaxCredits: number;
  useTaxReversals: number;
  taxAdjustments: number;
  netSubledgerLiability: number;
  authorityPaymentsApplied: number;
  beginningSubledgerLiability: number;
  endingSubledgerLiability: number;
  endingOutstandingLiability: number;
  beginningGlBalance: number;
  periodGlMovement: number;
  endingGlBalance: number;
  subledgerToGlDifference: number;
  glRollforwardDifference: number;
  rollforward: TaxLiabilityRollforwardLine[];
  exceptions: TaxReconciliationException[];
  readiness: TaxPeriodReadiness;
  transactionIds: string[];
  calculationVersion: string;
};

export type TaxPeriodReadiness = {
  ready: boolean;
  blockingReasons: string[];
};
