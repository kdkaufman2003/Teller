import type { PresentationMode } from "@/lib/accounting/presentation-mode";
import type { TaxFilingPeriodStatus } from "../filing/types";
import type { TaxSetupStatus } from "../types";

export type TaxAttentionSeverity = "critical" | "needs_review" | "informational";

export type TaxAttentionItem = {
  id: string;
  severity: TaxAttentionSeverity;
  title: string;
  description: string;
  actionLabel: string;
  actionHref: string;
  source: "setup" | "transaction" | "period" | "exemption" | "payment";
};

export type TaxOwnerPeriodSummary = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: TaxFilingPeriodStatus;
  statusLabel: string;
  jurisdictionKey?: string | null;
  state?: string | null;
  authorityName?: string | null;
  registrationId: string;
  taxOwed: number;
  taxPaid: number;
  remaining: number;
  dueDate?: string | null;
  dueDateConfigured: boolean;
  exceptionCount?: number;
  glDifference?: number | null;
};

export type TaxStatePackStatus = {
  state: string;
  packLabel: string;
  status: "active" | "needs_setup" | "inactive";
  statusLabel: string;
};

export type TaxOwnerSummary = {
  version: "15J.1";
  generatedAt: string;
  asOfDate: string;
  presentationMode: PresentationMode;
  schemaReady: boolean;
  configured: boolean;
  hasActivity: boolean;
  setupStatus: TaxSetupStatus;
  setupStatusLabel: string;
  taxOwed: {
    amount: number;
    label: string;
    scope: "filing_periods";
  };
  taxPaid: {
    amount: number;
    label: string;
    scopeStart: string;
    scopeEnd: string;
  };
  unappliedOverpayment: {
    amount: number;
    label: string;
  };
  nextPeriod: TaxOwnerPeriodSummary | null;
  attentionItems: TaxAttentionItem[];
  attentionCount: number;
  statePacks: TaxStatePackStatus[];
  registrations: Array<{
    id: string;
    jurisdictionKey?: string | null;
    state?: string | null;
    status: string;
    filingFrequency: string;
  }>;
  periodSummaries: TaxOwnerPeriodSummary[];
  accountantDetail?: {
    needsReviewTransactionCount: number;
    periodCount: number;
    queryBounds: {
      maxPeriodsLoaded: number;
      paymentReportRows: number;
    };
  };
};

export type GetTaxOwnerSummaryInput = {
  organizationId: string;
  asOfDate?: string;
  presentationMode?: PresentationMode;
};
