export type HealthGrade = "excellent" | "good" | "fair" | "needs_work";

export type HealthFactorStatus = "good" | "attention" | "critical";

export type AttentionSeverity = "info" | "warning" | "critical";

export type HealthFactor = {
  id: string;
  label: string;
  score: number;
  weight: number;
  status: HealthFactorStatus;
  detail: string;
};

export type AttentionItem = {
  id: string;
  severity: AttentionSeverity;
  title: string;
  description: string;
  href?: string;
  count?: number;
};

export type HealthReport = {
  score: number;
  grade: HealthGrade;
  headline: string;
  subheadline?: string;
  factors: HealthFactor[];
  attention: AttentionItem[];
  booksCurrentThrough: string | null;
};

/** Raw counts the engine evaluates — gathered server-side per org. */
export type HealthSignals = {
  draftInvoiceCount: number;
  overdueInvoiceCount: number;
  openInvoiceCount: number;
  draftExpenseCount: number;
  receiptExpenseWithoutAttachment: number;
  unmatchedBankCount: number;
  suggestedBankCount: number;
  bankConnectionCount: number;
  bankConnectionErrorCount: number;
  hfacEnabled: boolean;
  hfacStaleSync: boolean;
  hfacLastSyncedAt: string | null;
  taxPendingReviewCount: number;
  lastPostedDate: string | null;
};
