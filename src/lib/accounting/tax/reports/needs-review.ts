import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaginatedReport, TaxNeedsReviewRow, TaxReportFilters, TaxReportPagination } from "./types";
import { buildTaxGlReconciliationReport } from "./gl-reconciliation";
import { loadFilteredPostedTaxTransactions, paginateRows, resolveFilingPeriodDateRange } from "./load";
import { reconcileTaxPeriod } from "../filing/reconcile";

export async function buildNeedsReviewTaxReport(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  pagination: TaxReportPagination,
): Promise<PaginatedReport<TaxNeedsReviewRow>> {
  const rows: TaxNeedsReviewRow[] = [];

  const transactions = await loadFilteredPostedTaxTransactions(supabase, filters);
  for (const tx of transactions) {
    if (tx.determinationStatus !== "needs_review") continue;
    const metadata = (tx.metadata ?? {}) as Record<string, unknown>;
    const reasonCodes = Array.isArray(metadata.reasonCodes) ? metadata.reasonCodes : ["NEEDS_REVIEW"];
    rows.push({
      source: "transaction",
      transactionDate: tx.transactionDate,
      taxTransactionId: tx.id,
      documentId: tx.documentId,
      reasonCode: String(reasonCodes[0] ?? "NEEDS_REVIEW"),
      message: "Tax transaction requires review before filing",
      severity: "blocking",
      amount: tx.taxAmount,
    });
  }

  if (filters.filingPeriodId) {
    const periodRange = await resolveFilingPeriodDateRange(
      supabase,
      filters.organizationId,
      filters.filingPeriodId,
    );
    const reconciliation = await reconcileTaxPeriod(supabase, {
      organizationId: filters.organizationId,
      registrationId: periodRange.registrationId,
      periodStart: periodRange.startDate,
      periodEnd: periodRange.endDate,
    });
    for (const exception of reconciliation.exceptions) {
      rows.push({
        source: "reconciliation",
        transactionDate: periodRange.endDate,
        taxTransactionId: exception.taxTransactionId,
        documentId: exception.documentId,
        reasonCode: exception.code,
        message: exception.message,
        severity: exception.severity,
        amount: exception.amount ?? null,
      });
    }
  } else if (filters.startDate && filters.endDate) {
    const glReport = await buildTaxGlReconciliationReport(supabase, filters);
    for (const exception of glReport.exceptions) {
      rows.push({
        source: "reconciliation",
        reasonCode: exception.code,
        message: exception.message,
        severity: exception.severity,
        amount: exception.amount ?? null,
      });
    }
  }

  return paginateRows(rows, pagination);
}
