import { roundMoney } from "../../payment-fees";
import { aggregateRollforward, type TaxTransactionForRollforward } from "../filing/rollforward";
import type { LoadedTaxTransaction, TaxReportFilters, TaxSummaryReport } from "./types";
import { TAX_REPORT_DATE_BASIS, TAX_REPORT_VERSION } from "./types";
import { transactionMatchesFilters } from "./filters";
import { loadFilteredPostedTaxTransactions, loadPostedTaxTransactions } from "./load";

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

function aggregateSalesBasis(transactions: LoadedTaxTransaction[]): {
  taxableSales: number;
  exemptSales: number;
  nonTaxableSales: number;
} {
  let taxableSales = 0;
  let exemptSales = 0;
  let nonTaxableSales = 0;

  for (const tx of transactions) {
    if (!["sales_tax_collected", "sales_tax_reversed", "sales_tax_refunded"].includes(tx.transactionType)) {
      continue;
    }
    const basis = roundMoney(Math.abs(tx.taxableBasis));
    if (tx.determinationStatus === "exempt") exemptSales = roundMoney(exemptSales + basis);
    else if (tx.determinationStatus === "non_taxable") nonTaxableSales = roundMoney(nonTaxableSales + basis);
    else taxableSales = roundMoney(taxableSales + basis);
  }

  return { taxableSales, exemptSales, nonTaxableSales };
}

export function buildTaxSummaryFromTransactions(
  filters: TaxReportFilters,
  transactions: LoadedTaxTransaction[],
): TaxSummaryReport {
  const rollforward = aggregateRollforward(transactions.map(toRollforwardTx));
  const salesBasis = aggregateSalesBasis(transactions);

  return {
    version: TAX_REPORT_VERSION,
    dateBasis: TAX_REPORT_DATE_BASIS,
    filters,
    generatedAt: new Date().toISOString(),
    taxableSales: salesBasis.taxableSales,
    exemptSales: salesBasis.exemptSales,
    nonTaxableSales: salesBasis.nonTaxableSales,
    salesTaxAccrued: rollforward.totals.salesTaxAccrued,
    useTaxAccrued: rollforward.totals.useTaxAccrued,
    salesTaxCredits: rollforward.totals.salesTaxCredits,
    useTaxReversals: rollforward.totals.useTaxReversals,
    taxAdjustments: rollforward.totals.taxAdjustments,
    authorityPayments: rollforward.totals.authorityPayments,
    netLiabilityChange: rollforward.totals.netAmount,
    outstandingLiability: rollforward.totals.netAmount,
    transactionCount: transactions.length,
    needsReviewCount: transactions.filter((tx) => tx.determinationStatus === "needs_review").length,
  };
}

export async function buildTaxSummaryReport(
  supabase: Parameters<typeof loadFilteredPostedTaxTransactions>[0],
  filters: TaxReportFilters,
): Promise<TaxSummaryReport> {
  const transactions = await loadFilteredPostedTaxTransactions(supabase, filters);
  return buildTaxSummaryFromTransactions(filters, transactions);
}

export async function buildOutstandingLiability(
  supabase: Parameters<typeof loadPostedTaxTransactions>[0],
  organizationId: string,
  asOf: string,
  filters: Omit<TaxReportFilters, "startDate" | "endDate">,
): Promise<number> {
  const transactions = await loadPostedTaxTransactions(supabase, organizationId, { endDate: asOf });
  const scoped = transactions.filter((tx) => {
    const merged = { ...filters, organizationId, startDate: null, endDate: asOf };
    return transactionMatchesFilters(tx, merged);
  });
  return aggregateRollforward(scoped.map(toRollforwardTx)).totals.netAmount;
}
