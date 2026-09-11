import { roundMoney } from "../../payment-fees";
import { aggregateRollforward, type TaxTransactionForRollforward } from "../filing/rollforward";
import type { LoadedTaxTransaction, TaxReportFilters, TaxRollforwardReport } from "./types";
import { TAX_REPORT_DATE_BASIS, TAX_REPORT_VERSION } from "./types";
import { filterTransactions } from "./filters";
import { loadPostedTaxTransactions } from "./load";

function toRollforwardTx(tx: LoadedTaxTransaction): TaxTransactionForRollforward {
  return {
    id: tx.id,
    transactionType: tx.transactionType,
    transactionDate: tx.transactionDate,
    taxAmount: tx.taxAmount,
    determinationStatus: tx.determinationStatus,
    postedJournalEntryId: tx.postedJournalEntryId,
    primaryJurisdictionKey: tx.primaryJurisdictionKey,
    metadata: tx.metadata,
  };
}

export function buildTaxRollforwardFromTransactions(
  filters: TaxReportFilters,
  beginningTransactions: LoadedTaxTransaction[],
  periodTransactions: LoadedTaxTransaction[],
): TaxRollforwardReport {
  const beginning = aggregateRollforward(beginningTransactions.map(toRollforwardTx)).totals.netAmount;
  const period = aggregateRollforward(periodTransactions.map(toRollforwardTx)).totals;
  const ending = roundMoney(beginning + period.netAmount);
  const expectedEnding = roundMoney(
    beginning +
      period.salesTaxAccrued +
      period.useTaxAccrued -
      period.salesTaxCredits -
      period.useTaxReversals +
      period.taxAdjustments -
      period.authorityPayments,
  );

  return {
    version: TAX_REPORT_VERSION,
    dateBasis: TAX_REPORT_DATE_BASIS,
    filters,
    generatedAt: new Date().toISOString(),
    beginningLiability: beginning,
    salesTaxAccrued: period.salesTaxAccrued,
    useTaxAccrued: period.useTaxAccrued,
    salesTaxCredits: period.salesTaxCredits,
    useTaxReversals: period.useTaxReversals,
    taxAdjustments: period.taxAdjustments,
    authorityPayments: period.authorityPayments,
    endingOutstandingLiability: ending,
    rollforwardDifference: roundMoney(ending - expectedEnding),
  };
}

export async function buildTaxRollforwardReport(
  supabase: Parameters<typeof loadPostedTaxTransactions>[0],
  filters: TaxReportFilters,
): Promise<TaxRollforwardReport> {
  if (!filters.startDate || !filters.endDate) {
    throw new Error("Rollforward report requires startDate and endDate");
  }

  const allThroughEnd = await loadPostedTaxTransactions(supabase, filters.organizationId, {
    endDate: filters.endDate,
  });
  const scoped = filterTransactions(allThroughEnd, filters);
  const beginningTransactions = scoped.filter((tx) => tx.transactionDate < filters.startDate!);
  const periodTransactions = scoped.filter(
    (tx) => tx.transactionDate >= filters.startDate! && tx.transactionDate <= filters.endDate!,
  );

  return buildTaxRollforwardFromTransactions(filters, beginningTransactions, periodTransactions);
}
