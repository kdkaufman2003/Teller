import type { TaxDeterminationStatus, TaxTransactionType } from "../types";
import type { TaxFilingPeriodStatus, TaxPeriodReconciliationResult, TaxReconciliationException } from "../filing/types";

export const TAX_REPORT_VERSION = "teller_tax_report_v1";

/** Primary report filter date basis — tax transaction date, not GL posting date. */
export const TAX_REPORT_DATE_BASIS = "transaction_date" as const;

export type TaxReportKind =
  | "summary"
  | "rollforward"
  | "gl_reconciliation"
  | "sales_detail"
  | "use_detail"
  | "exempt"
  | "needs_review"
  | "payments"
  | "adjustments"
  | "jurisdictions"
  | "authorities"
  | "filing_period";

export type TaxReportFilters = {
  organizationId: string;
  startDate?: string | null;
  endDate?: string | null;
  filingPeriodId?: string | null;
  registrationId?: string | null;
  authorityId?: string | null;
  state?: string | null;
  taxType?: "sales" | "use" | "payment" | "adjustment" | "all" | null;
  determinationStatus?: TaxDeterminationStatus | null;
  jurisdictionKey?: string | null;
};

export type TaxReportPagination = {
  limit: number;
  offset: number;
};

export type LoadedTaxTransaction = {
  id: string;
  organizationId: string;
  transactionType: TaxTransactionType;
  sourceType: string;
  sourceId?: string | null;
  documentId?: string | null;
  lineId?: string | null;
  determinationStatus: string;
  transactionDate: string;
  taxableBasis: number;
  taxAmount: number;
  primaryJurisdictionKey?: string | null;
  registrationId?: string | null;
  authorityId?: string | null;
  filingPeriodId?: string | null;
  postedJournalEntryId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type LoadedTaxComponent = {
  taxTransactionId: string;
  componentType: string;
  jurisdictionKey: string;
  authorityId?: string | null;
  ratePercent: number;
  taxableBasis: number;
  taxAmount: number;
};

export type LoadedDeterminationSnapshot = {
  id: string;
  taxTransactionId?: string | null;
  documentId?: string | null;
  lineId?: string | null;
  transactionDate: string;
  taxCategoryKey?: string | null;
  jurisdictionKey?: string | null;
  determinationStatus: string;
  taxableBasis: number;
  taxAmount: number;
  ratePercent?: number | null;
  exemptionId?: string | null;
  metadata?: Record<string, unknown> | null;
  precedenceTrace?: Record<string, unknown> | null;
  components?: unknown[];
};

export type TaxSummaryReport = {
  version: typeof TAX_REPORT_VERSION;
  dateBasis: typeof TAX_REPORT_DATE_BASIS;
  filters: TaxReportFilters;
  generatedAt: string;
  taxableSales: number;
  exemptSales: number;
  nonTaxableSales: number;
  salesTaxAccrued: number;
  useTaxAccrued: number;
  salesTaxCredits: number;
  useTaxReversals: number;
  taxAdjustments: number;
  authorityPayments: number;
  netLiabilityChange: number;
  outstandingLiability: number;
  transactionCount: number;
  needsReviewCount: number;
};

export type TaxRollforwardReport = {
  version: typeof TAX_REPORT_VERSION;
  dateBasis: typeof TAX_REPORT_DATE_BASIS;
  filters: TaxReportFilters;
  generatedAt: string;
  beginningLiability: number;
  salesTaxAccrued: number;
  useTaxAccrued: number;
  salesTaxCredits: number;
  useTaxReversals: number;
  taxAdjustments: number;
  authorityPayments: number;
  endingOutstandingLiability: number;
  rollforwardDifference: number;
};

export type TaxGlReconciliationReport = {
  version: typeof TAX_REPORT_VERSION;
  dateBasis: typeof TAX_REPORT_DATE_BASIS;
  filters: TaxReportFilters;
  generatedAt: string;
  subledgerLiability: number;
  glLiability: number;
  difference: number;
  exceptionCount: number;
  status: "reconciled" | "unreconciled" | "needs_review";
  exceptions: TaxReconciliationException[];
};

export type TaxSalesDetailRow = {
  transactionDate: string;
  documentId?: string | null;
  documentNumber?: string | null;
  customerName?: string | null;
  lineCategory?: string | null;
  taxableBasis: number;
  taxAmount: number;
  jurisdictionKey?: string | null;
  authorityName?: string | null;
  componentSummary?: string | null;
  ratePercent?: number | null;
  exemptionStatus?: string | null;
  determinationStatus: string;
  statePackVersion?: string | null;
  journalEntryId?: string | null;
  taxTransactionId: string;
};

export type TaxUseDetailRow = {
  transactionDate: string;
  documentId?: string | null;
  documentNumber?: string | null;
  vendorName?: string | null;
  lineCategory?: string | null;
  purchaseBasis: number;
  vendorTaxCharged: number;
  requiredTax: number;
  useTaxAccrued: number;
  jurisdictionKey?: string | null;
  classification?: string | null;
  determinationStatus: string;
  journalEntryId?: string | null;
  taxTransactionId: string;
};

export type TaxExemptDetailRow = {
  transactionDate: string;
  customerName?: string | null;
  documentId?: string | null;
  exemptedBasis: number;
  certificateNumber?: string | null;
  certificateStatusAtDetermination?: string | null;
  jurisdictionKey?: string | null;
  category?: string | null;
  reason?: string | null;
  snapshotId: string;
  taxTransactionId?: string | null;
};

export type TaxNeedsReviewRow = {
  source: "transaction" | "reconciliation" | "filing_period";
  transactionDate?: string | null;
  taxTransactionId?: string | null;
  documentId?: string | null;
  reasonCode: string;
  message: string;
  severity: "blocking" | "warning";
  amount?: number | null;
};

export type TaxPaymentReportRow = {
  paymentDate: string;
  authorityName?: string | null;
  registrationJurisdiction?: string | null;
  paymentAmount: number;
  baseTaxAmount: number;
  penaltyAmount: number;
  interestAmount: number;
  referenceNumber?: string | null;
  bankAccountName?: string | null;
  journalEntryId?: string | null;
  status: string;
  paymentId: string;
};

export type TaxAdjustmentReportRow = {
  adjustmentDate: string;
  authorityName?: string | null;
  registrationJurisdiction?: string | null;
  periodLabel?: string | null;
  adjustmentType: string;
  reason?: string | null;
  amount: number;
  offsetAccountCode?: string | null;
  journalEntryId?: string | null;
  createdBy?: string | null;
  adjustmentId: string;
};

export type TaxJurisdictionSummaryRow = {
  jurisdictionKey: string;
  jurisdictionName?: string | null;
  jurisdictionLevel: string;
  taxableBasis: number;
  taxAccrued: number;
  credits: number;
  netLiability: number;
  componentCount: number;
};

export type TaxAuthoritySummaryRow = {
  authorityId?: string | null;
  authorityKey?: string | null;
  authorityName?: string | null;
  registrationId?: string | null;
  registrationJurisdiction?: string | null;
  taxAccrued: number;
  credits: number;
  adjustments: number;
  payments: number;
  netOutstanding: number;
};

export type TaxFilingPeriodReport = {
  version: typeof TAX_REPORT_VERSION;
  dateBasis: typeof TAX_REPORT_DATE_BASIS;
  generatedAt: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  registrationId: string;
  jurisdictionKey?: string | null;
  authorityName?: string | null;
  status: TaxFilingPeriodStatus;
  salesTaxAccrued: number;
  useTaxAccrued: number;
  salesTaxCredits: number;
  taxAdjustments: number;
  netLiability: number;
  paid: number;
  remaining: number;
  reconciliationDifference: number;
  exceptionCount: number;
  readiness: TaxPeriodReconciliationResult["readiness"];
};

export type TaxReportReadiness = {
  status: "ready" | "needs_review" | "unreconciled" | "incomplete_configuration";
  blockingReasons: string[];
  exceptionCount: number;
};

export type PaginatedReport<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
};

export type AccountantTaxPackageManifest = {
  organizationId: string;
  organizationName?: string | null;
  generatedAt: string;
  reportPeriodStart?: string | null;
  reportPeriodEnd?: string | null;
  filingPeriodId?: string | null;
  registrations: Array<{ id: string; jurisdictionKey?: string | null; registrationNumber?: string | null }>;
  authorities: Array<{ id?: string | null; name?: string | null }>;
  dateBasis: typeof TAX_REPORT_DATE_BASIS;
  includedFiles: string[];
  statePackVersions: string[];
  reconciliationStatus: string;
  exceptionCount: number;
  reportVersion: typeof TAX_REPORT_VERSION;
};

export type AccountantTaxPackageFile = {
  filename: string;
  content: string;
};
