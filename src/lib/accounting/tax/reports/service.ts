import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxReportFilters, TaxReportKind, TaxReportPagination } from "./types";
import { parseTaxReportFilters, parseTaxReportPagination } from "./filters";
import { buildTaxSummaryReport } from "./summary";
import { buildTaxRollforwardReport } from "./rollforward";
import { buildTaxGlReconciliationReport } from "./gl-reconciliation";
import { buildSalesTaxDetailReport, buildUseTaxDetailReport, buildExemptTaxDetailReport } from "./details";
import { buildTaxPaymentReport, buildTaxAdjustmentReport } from "./payments-adjustments";
import { buildNeedsReviewTaxReport } from "./needs-review";
import { buildJurisdictionSummaryReport, buildAuthoritySummaryReport } from "./jurisdiction-authority";
import { buildFilingPeriodTaxReport } from "./filing-period-report";
import { buildTaxReportReadiness } from "./readiness";
import { buildAccountantTaxPackage } from "./accountant-package";
import { resolveFilingPeriodDateRange } from "./load";

export type TaxReportQueryInput = {
  organizationId: string;
  report: TaxReportKind;
  startDate?: string | null;
  endDate?: string | null;
  filingPeriodId?: string | null;
  registrationId?: string | null;
  authorityId?: string | null;
  state?: string | null;
  taxType?: string | null;
  determinationStatus?: string | null;
  jurisdictionKey?: string | null;
  limit?: string | number | null;
  offset?: string | number | null;
};

export async function resolveReportFilters(
  supabase: SupabaseClient,
  input: TaxReportQueryInput,
): Promise<TaxReportFilters> {
  const filters = parseTaxReportFilters(input);
  if (filters.filingPeriodId && (!filters.startDate || !filters.endDate)) {
    const period = await resolveFilingPeriodDateRange(supabase, input.organizationId, filters.filingPeriodId);
    filters.startDate = period.startDate;
    filters.endDate = period.endDate;
    if (!filters.registrationId) filters.registrationId = period.registrationId;
  }
  return filters;
}

export async function runTaxReport(
  supabase: SupabaseClient,
  input: TaxReportQueryInput,
): Promise<unknown> {
  const filters = await resolveReportFilters(supabase, input);
  const pagination = parseTaxReportPagination({ limit: input.limit, offset: input.offset });

  switch (input.report) {
    case "summary":
      return buildTaxSummaryReport(supabase, filters);
    case "rollforward":
      return buildTaxRollforwardReport(supabase, filters);
    case "gl_reconciliation":
      return buildTaxGlReconciliationReport(supabase, filters);
    case "sales_detail":
      return buildSalesTaxDetailReport(supabase, filters, pagination);
    case "use_detail":
      return buildUseTaxDetailReport(supabase, filters, pagination);
    case "exempt":
      return buildExemptTaxDetailReport(supabase, filters, pagination);
    case "needs_review":
      return buildNeedsReviewTaxReport(supabase, filters, pagination);
    case "payments":
      return buildTaxPaymentReport(supabase, filters, pagination);
    case "adjustments":
      return buildTaxAdjustmentReport(supabase, filters, pagination);
    case "jurisdictions":
      return buildJurisdictionSummaryReport(supabase, filters, pagination);
    case "authorities":
      return buildAuthoritySummaryReport(supabase, filters, pagination);
    case "filing_period":
      if (!filters.filingPeriodId) throw new Error("filingPeriodId is required for filing_period report");
      return buildFilingPeriodTaxReport(supabase, filters.organizationId, filters.filingPeriodId);
    default:
      throw new Error(`Unknown tax report: ${input.report}`);
  }
}

export async function runTaxReportWithReadiness(
  supabase: SupabaseClient,
  input: TaxReportQueryInput,
): Promise<{ report: unknown; readiness: Awaited<ReturnType<typeof buildTaxReportReadiness>> }> {
  const filters = await resolveReportFilters(supabase, input);
  const [report, summary, gl] = await Promise.all([
    runTaxReport(supabase, { ...input, startDate: filters.startDate, endDate: filters.endDate }),
    buildTaxSummaryReport(supabase, filters),
    buildTaxGlReconciliationReport(supabase, filters),
  ]);
  const readiness = await buildTaxReportReadiness(supabase, input.organizationId, gl, summary.needsReviewCount);
  return { report, readiness };
}

export async function runAccountantTaxPackage(
  supabase: SupabaseClient,
  input: TaxReportQueryInput,
  options?: { organizationName?: string | null },
) {
  const filters = await resolveReportFilters(supabase, input);
  return buildAccountantTaxPackage(supabase, filters, options);
}

export { parseTaxReportFilters, parseTaxReportPagination };
export type { TaxReportPagination };
