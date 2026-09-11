import { roundMoney } from "../../payment-fees";
import { reconcileTaxPeriod } from "../filing/reconcile";
import { loadTaxSettings } from "../load-tax-settings";
import type { TaxGlReconciliationReport, TaxReportFilters } from "./types";
import { TAX_REPORT_DATE_BASIS, TAX_REPORT_VERSION } from "./types";
import { aggregateRollforward, type TaxTransactionForRollforward } from "../filing/rollforward";
import { filterTransactions } from "./filters";
import { loadPostedTaxTransactions, resolveFilingPeriodDateRange } from "./load";

const JOURNAL_ENTRY_ID_BATCH_SIZE = 80;

async function sumGlTaxPayableForJournalEntries(
  supabase: Parameters<typeof reconcileTaxPeriod>[0],
  taxPayableAccountId: string,
  journalEntryIds: string[],
): Promise<number> {
  if (journalEntryIds.length === 0) return 0;

  let total = 0;
  for (let index = 0; index < journalEntryIds.length; index += JOURNAL_ENTRY_ID_BATCH_SIZE) {
    const batch = journalEntryIds.slice(index, index + JOURNAL_ENTRY_ID_BATCH_SIZE);
    const { data, error } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("account_id", taxPayableAccountId)
      .in("entry_id", batch);
    if (error) throw new Error(error.message);
    total += (data ?? []).reduce(
      (sum, line) => sum + Number(line.credit ?? 0) - Number(line.debit ?? 0),
      0,
    );
  }
  return roundMoney(total);
}

export async function buildTaxGlReconciliationReport(
  supabase: Parameters<typeof reconcileTaxPeriod>[0],
  filters: TaxReportFilters,
): Promise<TaxGlReconciliationReport> {
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
    const difference = reconciliation.subledgerToGlDifference;
    const status =
      reconciliation.readiness.ready && Math.abs(difference) <= 0.009
        ? "reconciled"
        : reconciliation.exceptions.some((e) => e.severity === "blocking")
          ? "needs_review"
          : "unreconciled";

    return {
      version: TAX_REPORT_VERSION,
      dateBasis: TAX_REPORT_DATE_BASIS,
      filters,
      generatedAt: new Date().toISOString(),
      subledgerLiability: reconciliation.netSubledgerLiability,
      glLiability: reconciliation.periodGlMovement,
      difference,
      exceptionCount: reconciliation.exceptions.length,
      status,
      exceptions: reconciliation.exceptions,
    };
  }

  if (!filters.startDate || !filters.endDate) {
    throw new Error("GL reconciliation requires startDate/endDate or filingPeriodId");
  }

  const { settings } = await loadTaxSettings(supabase, filters.organizationId);
  const taxPayableAccountId = settings.salesTaxPayableAccountId?.trim() ?? "";
  const transactions = filterTransactions(
    await loadPostedTaxTransactions(supabase, filters.organizationId, {
      startDate: filters.startDate,
      endDate: filters.endDate,
    }),
    filters,
  );

  const subledgerLiability = aggregateRollforward(
    transactions.map(
      (tx): TaxTransactionForRollforward => ({
        id: tx.id,
        transactionType: tx.transactionType,
        transactionDate: tx.transactionDate,
        taxAmount: tx.taxAmount,
        determinationStatus: tx.determinationStatus,
        postedJournalEntryId: tx.postedJournalEntryId,
        primaryJurisdictionKey: tx.primaryJurisdictionKey,
        metadata: tx.metadata,
      }),
    ),
  ).totals.netAmount;

  const journalEntryIds = [
    ...new Set(
      transactions.map((tx) => tx.postedJournalEntryId).filter((id): id is string => Boolean(id?.trim())),
    ),
  ];

  const glLiability = taxPayableAccountId
    ? await sumGlTaxPayableForJournalEntries(supabase, taxPayableAccountId, journalEntryIds)
    : 0;

  const difference = roundMoney(subledgerLiability - glLiability);
  const exceptions =
    !taxPayableAccountId
      ? [
          {
            code: "WRONG_TAX_PAYABLE_ACCOUNT" as const,
            message: "Sales tax payable account is not configured",
            severity: "blocking" as const,
          },
        ]
      : Math.abs(difference) > 0.009
        ? [
            {
              code: "SUBLEDGER_GL_DIFFERENCE" as const,
              message: `Subledger ${subledgerLiability} differs from GL ${glLiability}`,
              severity: "blocking" as const,
              amount: difference,
            },
          ]
        : [];

  return {
    version: TAX_REPORT_VERSION,
    dateBasis: TAX_REPORT_DATE_BASIS,
    filters,
    generatedAt: new Date().toISOString(),
    subledgerLiability,
    glLiability,
    difference,
    exceptionCount: exceptions.length,
    status: exceptions.length === 0 ? "reconciled" : "unreconciled",
    exceptions,
  };
}
