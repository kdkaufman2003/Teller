import type { SupabaseClient } from "@supabase/supabase-js";
import type { PresentationMode } from "@/lib/accounting/presentation-mode";
import { roundMoney } from "../../payment-fees";
import { listTaxFilingPeriods } from "../filing/service";
import type { TaxFilingPeriodRecord } from "../filing/types";
import { loadTaxPeriodPaymentSummary } from "../payments/period-balance";
import { loadTaxSettings } from "../load-tax-settings";
import { buildNeedsReviewTaxReport, buildTaxPaymentReport } from "../reports";
import { buildTaxSummaryReport } from "../reports/summary";
import type { TaxReportFilters } from "../reports/types";
import { buildTaxAttentionItems } from "./attention";
import { selectNextFilingPeriod } from "./next-period";
import {
  filingPeriodStatusLabel,
  jurisdictionStateCode,
  ownerSetupStatusLabelExtended,
  ownerStatePackLabel,
  statePackStatusLabel,
} from "./status-labels";
import type { GetTaxOwnerSummaryInput, TaxOwnerPeriodSummary, TaxOwnerSummary } from "./types";

export const OWNER_SUMMARY_MAX_PERIODS = 48;
export const OWNER_SUMMARY_PAYMENT_DETAIL_LIMIT = 500;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearStart(asOf: string): string {
  return `${asOf.slice(0, 4)}-01-01`;
}

type ReconciliationSnapshot = {
  endingSubledgerLiability?: number;
  endingOutstandingLiability?: number;
  authorityPaymentsApplied?: number;
  subledgerToGlDifference?: number;
  exceptions?: Array<{ severity?: string }>;
};

function reconciliationFromMetadata(metadata?: Record<string, unknown>): ReconciliationSnapshot | null {
  const last = metadata?.lastReconciliation;
  if (!last || typeof last !== "object") return null;
  return last as ReconciliationSnapshot;
}

function periodSummaryFromReconciliation(
  period: TaxFilingPeriodRecord,
  authorityName: string | null,
  reconciliation: ReconciliationSnapshot | null,
  paidFromAllocations: number,
): Pick<TaxOwnerPeriodSummary, "taxOwed" | "taxPaid" | "remaining" | "exceptionCount" | "glDifference"> {
  if (!reconciliation) {
    return {
      taxOwed: 0,
      taxPaid: paidFromAllocations,
      remaining: 0,
      exceptionCount: 0,
      glDifference: null,
    };
  }

  const taxOwed = roundMoney(
    reconciliation.endingSubledgerLiability ??
      reconciliation.endingOutstandingLiability ??
      0,
  );
  const taxPaid = roundMoney(reconciliation.authorityPaymentsApplied ?? paidFromAllocations);
  const remaining = roundMoney(Math.max(taxOwed - taxPaid, 0));

  return {
    taxOwed,
    taxPaid,
    remaining,
    exceptionCount: reconciliation.exceptions?.length ?? 0,
    glDifference: reconciliation.subledgerToGlDifference ?? null,
  };
}

export async function loadPeriodSummaries(
  supabase: SupabaseClient,
  organizationId: string,
  options?: { maxDetailedLoads?: number },
): Promise<TaxOwnerPeriodSummary[]> {
  const periods = (await listTaxFilingPeriods(supabase, organizationId)).slice(0, OWNER_SUMMARY_MAX_PERIODS);

  const authorityIds = [...new Set(periods.map((period) => period.authorityId).filter(Boolean))] as string[];
  const authorityById = new Map<string, string>();
  if (authorityIds.length) {
    const { data: authorities } = await supabase
      .from("teller_tax_authorities")
      .select("id, name")
      .in("id", authorityIds);
    for (const row of authorities ?? []) authorityById.set(row.id as string, row.name as string);
  }

  const periodIds = periods.map((period) => period.id);
  const paidByPeriod = new Map<string, number>();
  if (periodIds.length) {
    const { data: allocations } = await supabase
      .from("teller_tax_authority_payment_allocations")
      .select("filing_period_id, allocated_amount, teller_tax_authority_payments!inner(status)")
      .eq("organization_id", organizationId)
      .in("filing_period_id", periodIds);

    for (const row of allocations ?? []) {
      const payment = row.teller_tax_authority_payments as { status?: string };
      if (payment?.status === "reversed" || payment?.status === "voided") continue;
      const periodId = row.filing_period_id as string;
      paidByPeriod.set(
        periodId,
        roundMoney((paidByPeriod.get(periodId) ?? 0) + Number(row.allocated_amount)),
      );
    }
  }

  let detailedLoads = 0;
  const maxDetailedLoads = options?.maxDetailedLoads ?? 8;
  const summaries: TaxOwnerPeriodSummary[] = [];

  for (const period of periods) {
    const metadata = period.metadata ?? {};
    const reconciliation = reconciliationFromMetadata(metadata);
    const paidFromAllocations = paidByPeriod.get(period.id) ?? 0;
    let amounts = periodSummaryFromReconciliation(
      period,
      period.authorityId ? authorityById.get(period.authorityId) ?? null : null,
      reconciliation,
      paidFromAllocations,
    );

    const needsDetailedLoad =
      !reconciliation &&
      period.status !== "closed" &&
      detailedLoads < maxDetailedLoads &&
      period.periodEnd <= todayISO();

    if (needsDetailedLoad) {
      detailedLoads += 1;
      const paymentSummary = await loadTaxPeriodPaymentSummary(supabase, {
        organizationId,
        filingPeriodId: period.id,
      });
      amounts = {
        taxOwed: paymentSummary.filedLiability,
        taxPaid: paymentSummary.previouslyPaid,
        remaining: paymentSummary.remainingBalance,
        exceptionCount: 0,
        glDifference: null,
      };
    }

    const dueDateRaw = metadata.dueDate;
    const dueDate = typeof dueDateRaw === "string" && dueDateRaw ? dueDateRaw : null;

    summaries.push({
      id: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      status: period.status,
      statusLabel: filingPeriodStatusLabel(period.status),
      jurisdictionKey: period.jurisdictionKey ?? null,
      state: jurisdictionStateCode(period.jurisdictionKey),
      authorityName: period.authorityId ? authorityById.get(period.authorityId) ?? null : null,
      registrationId: period.registrationId,
      taxOwed: amounts.taxOwed,
      taxPaid: amounts.taxPaid,
      remaining: amounts.remaining,
      dueDate,
      dueDateConfigured: Boolean(dueDate),
      exceptionCount: amounts.exceptionCount,
      glDifference: amounts.glDifference,
    });
  }

  return summaries;
}

export function aggregateTaxOwedFromPeriods(periods: TaxOwnerPeriodSummary[]): number {
  return roundMoney(
    periods.reduce((sum, period) => {
      if (period.remaining <= 0) return sum;
      return sum + period.remaining;
    }, 0),
  );
}

export function aggregateUnappliedFromSummaries(
  summaries: Array<{ unappliedPayments: number }>,
): number {
  return roundMoney(summaries.reduce((sum, row) => sum + row.unappliedPayments, 0));
}

export async function getTaxOwnerSummary(
  supabase: SupabaseClient,
  input: GetTaxOwnerSummaryInput,
): Promise<TaxOwnerSummary> {
  const asOfDate = input.asOfDate ?? todayISO();
  const presentationMode: PresentationMode = input.presentationMode ?? "owner";
  const { organizationId } = input;

  const { schemaReady, readiness } = await loadTaxSettings(supabase, organizationId);
  const configured =
    schemaReady &&
    readiness.status !== "not_configured" &&
    readiness.checks.some((check) => check.passed);

  if (!schemaReady) {
    return {
      version: "15J.1",
      generatedAt: new Date().toISOString(),
      asOfDate,
      presentationMode,
      schemaReady: false,
      configured: false,
      hasActivity: false,
      setupStatus: readiness.status,
      setupStatusLabel: ownerSetupStatusLabelExtended(readiness.status),
      taxOwed: { amount: 0, label: "Recorded tax liability", scope: "filing_periods" },
      taxPaid: { amount: 0, label: "Tax authority payments", scopeStart: yearStart(asOfDate), scopeEnd: asOfDate },
      unappliedOverpayment: { amount: 0, label: "Tax overpayment / unapplied" },
      nextPeriod: null,
      attentionItems: buildTaxAttentionItems({
        readinessChecks: readiness.checks,
        setupConfigured: false,
        needsReviewTransactionCount: 0,
        periods: [],
        expiredExemptionCount: 0,
        rejectedExemptionCount: 0,
      }),
      attentionCount: 0,
      statePacks: [],
      registrations: [],
      periodSummaries: [],
    };
  }

  const reportFilters: TaxReportFilters = {
    organizationId,
    startDate: yearStart(asOfDate),
    endDate: asOfDate,
    registrationId: null,
    authorityId: null,
    filingPeriodId: null,
    state: null,
    taxType: "all",
    determinationStatus: null,
    jurisdictionKey: null,
  };

  const [{ data: registrations }, periodSummaries, paymentReport, needsReviewReport, activitySummary] =
    await Promise.all([
      supabase
        .from("teller_tax_registrations")
        .select("id, jurisdiction_key, authority_id, status, filing_frequency, metadata")
        .eq("organization_id", organizationId)
        .order("effective_from", { ascending: false }),
      loadPeriodSummaries(supabase, organizationId),
      buildTaxPaymentReport(supabase, reportFilters, {
        limit: OWNER_SUMMARY_PAYMENT_DETAIL_LIMIT,
        offset: 0,
      }),
      buildNeedsReviewTaxReport(supabase, reportFilters, { limit: 100, offset: 0 }),
      buildTaxSummaryReport(supabase, {
        ...reportFilters,
        startDate: yearStart(asOfDate),
        endDate: asOfDate,
      }),
    ]);

  const taxPaidAmount = roundMoney(
    paymentReport.rows
      .filter((row) => row.status !== "reversed" && row.status !== "voided")
      .reduce((sum, row) => sum + row.baseTaxAmount, 0),
  );

  const taxOwedAmount = aggregateTaxOwedFromPeriods(periodSummaries);

  const registrationIds = (registrations ?? []).map((row) => row.id as string);
  let unappliedTotal = 0;
  if (registrationIds.length) {
    const { data: unappliedRows } = await supabase
      .from("teller_tax_authority_payments")
      .select("unapplied_amount, status")
      .eq("organization_id", organizationId)
      .in("registration_id", registrationIds);
    for (const row of unappliedRows ?? []) {
      if (row.status === "reversed" || row.status === "voided") continue;
      unappliedTotal = roundMoney(unappliedTotal + Number(row.unapplied_amount));
    }
  }

  const { data: exemptionRows } = await supabase
    .from("teller_tax_exemptions")
    .select("status, effective_to, metadata")
    .eq("organization_id", organizationId);

  let expiredExemptionCount = 0;
  let rejectedExemptionCount = 0;
  for (const row of exemptionRows ?? []) {
    const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
    const reviewStatus = metadata.reviewStatus;
    if (reviewStatus === "rejected" || row.status === "rejected") rejectedExemptionCount += 1;
    if (row.status === "expired" || (row.effective_to && row.effective_to < asOfDate)) {
      expiredExemptionCount += 1;
    }
  }

  const attentionItems = buildTaxAttentionItems({
    readinessChecks: readiness.checks,
    setupConfigured: configured,
    needsReviewTransactionCount: needsReviewReport.total,
    periods: periodSummaries,
    expiredExemptionCount,
    rejectedExemptionCount,
  });

  const statePacks = (registrations ?? [])
    .map((registration) => {
      const state = jurisdictionStateCode(registration.jurisdiction_key as string | null) ?? "—";
      const metadata = (registration.metadata as Record<string, unknown> | null) ?? {};
      const version =
        (metadata.statePackVersion as string | undefined) ??
        (metadata.statePackId as string | undefined) ??
        null;
      const packActive = Boolean(metadata.statePackActivatedAt || metadata.statePackVersion);
      const status =
        registration.status !== "active"
          ? ("inactive" as const)
          : packActive
            ? ("active" as const)
            : ("needs_setup" as const);
      return {
        state,
        packLabel: ownerStatePackLabel(state, version),
        status,
        statusLabel: statePackStatusLabel(status),
      };
    })
    .filter((row) => row.state === "KS" || row.state === "MO" || row.state !== "—");

  const nextPeriod = selectNextFilingPeriod(periodSummaries, asOfDate);
  const hasActivity = activitySummary.transactionCount > 0 || paymentReport.total > 0;

  const summary: TaxOwnerSummary = {
    version: "15J.1",
    generatedAt: new Date().toISOString(),
    asOfDate,
    presentationMode,
    schemaReady,
    configured,
    hasActivity,
    setupStatus: readiness.status,
    setupStatusLabel: ownerSetupStatusLabelExtended(readiness.status),
    taxOwed: {
      amount: taxOwedAmount,
      label: "Recorded tax liability",
      scope: "filing_periods",
    },
    taxPaid: {
      amount: taxPaidAmount,
      label: "Tax authority payments",
      scopeStart: yearStart(asOfDate),
      scopeEnd: asOfDate,
    },
    unappliedOverpayment: {
      amount: unappliedTotal,
      label: "Tax overpayment / unapplied",
    },
    nextPeriod,
    attentionItems,
    attentionCount: attentionItems.length,
    statePacks,
    registrations: (registrations ?? []).map((registration) => ({
      id: registration.id as string,
      jurisdictionKey: (registration.jurisdiction_key as string | null) ?? null,
      state: jurisdictionStateCode(registration.jurisdiction_key as string | null),
      status: registration.status as string,
      filingFrequency: registration.filing_frequency as string,
    })),
    periodSummaries,
  };

  if (presentationMode === "accountant") {
    summary.accountantDetail = {
      needsReviewTransactionCount: needsReviewReport.total,
      periodCount: periodSummaries.length,
      queryBounds: {
        maxPeriodsLoaded: OWNER_SUMMARY_MAX_PERIODS,
        paymentReportRows: paymentReport.total,
      },
    };
  }

  return summary;
}
