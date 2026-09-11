import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../../payment-fees";
import { signedTaxAmountForTransaction, type TaxTransactionForRollforward } from "../filing/rollforward";
import type {
  PaginatedReport,
  TaxAuthoritySummaryRow,
  TaxJurisdictionSummaryRow,
  TaxReportFilters,
  TaxReportPagination,
} from "./types";
import { loadFilteredPostedTaxTransactions, loadTaxTransactionComponents, paginateRows } from "./load";

function jurisdictionLevel(jurisdictionKey: string): string {
  const parts = jurisdictionKey.split("-");
  if (parts.length <= 2) return "state";
  if (parts.length === 3) return "county";
  if (parts.length === 4) return "city";
  return "district";
}

export async function buildJurisdictionSummaryReport(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  pagination: TaxReportPagination,
): Promise<PaginatedReport<TaxJurisdictionSummaryRow>> {
  const transactions = await loadFilteredPostedTaxTransactions(supabase, filters);
  const components = await loadTaxTransactionComponents(
    supabase,
    filters.organizationId,
    transactions.map((tx) => tx.id),
  );

  const byJurisdiction = new Map<string, TaxJurisdictionSummaryRow>();

  for (const component of components) {
    const key = component.jurisdictionKey;
    const existing = byJurisdiction.get(key) ?? {
      jurisdictionKey: key,
      jurisdictionLevel: jurisdictionLevel(key),
      taxableBasis: 0,
      taxAccrued: 0,
      credits: 0,
      netLiability: 0,
      componentCount: 0,
    };
    existing.taxableBasis = roundMoney(existing.taxableBasis + Math.abs(component.taxableBasis));
    existing.taxAccrued = roundMoney(existing.taxAccrued + Math.abs(component.taxAmount));
    existing.netLiability = roundMoney(existing.netLiability + Math.abs(component.taxAmount));
    existing.componentCount += 1;
    byJurisdiction.set(key, existing);
  }

  for (const tx of transactions) {
    if (tx.transactionType === "sales_tax_reversed" || tx.transactionType === "sales_tax_refunded") {
      const key = tx.primaryJurisdictionKey ?? "unknown";
      const existing = byJurisdiction.get(key) ?? {
        jurisdictionKey: key,
        jurisdictionLevel: jurisdictionLevel(key),
        taxableBasis: 0,
        taxAccrued: 0,
        credits: 0,
        netLiability: 0,
        componentCount: 0,
      };
      existing.credits = roundMoney(existing.credits + Math.abs(tx.taxAmount));
      existing.netLiability = roundMoney(existing.netLiability - Math.abs(tx.taxAmount));
      byJurisdiction.set(key, existing);
    }
  }

  const rows = [...byJurisdiction.values()].sort((a, b) => a.jurisdictionKey.localeCompare(b.jurisdictionKey));
  return paginateRows(rows, pagination);
}

export async function buildAuthoritySummaryReport(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  pagination: TaxReportPagination,
): Promise<PaginatedReport<TaxAuthoritySummaryRow>> {
  const transactions = await loadFilteredPostedTaxTransactions(supabase, filters);
  const byAuthority = new Map<string, TaxAuthoritySummaryRow>();

  for (const tx of transactions) {
    const authorityId = tx.authorityId ?? "unassigned";
    const existing = byAuthority.get(authorityId) ?? {
      authorityId: tx.authorityId,
      registrationId: tx.registrationId,
      taxAccrued: 0,
      credits: 0,
      adjustments: 0,
      payments: 0,
      netOutstanding: 0,
    };

    const signed = signedTaxAmountForTransaction({
      id: tx.id,
      transactionType: tx.transactionType,
      transactionDate: tx.transactionDate,
      taxAmount: tx.taxAmount,
      determinationStatus: tx.determinationStatus,
      metadata: tx.metadata,
    } as TaxTransactionForRollforward);

    existing.taxAccrued = roundMoney(existing.taxAccrued + signed.salesTaxAccrued + signed.useTaxAccrued);
    existing.credits = roundMoney(existing.credits + signed.salesTaxCredits + signed.useTaxReversals);
    existing.adjustments = roundMoney(existing.adjustments + signed.taxAdjustments);
    existing.payments = roundMoney(existing.payments + signed.authorityPayments);
    existing.netOutstanding = roundMoney(existing.netOutstanding + signed.netAmount);
    byAuthority.set(authorityId, existing);
  }

  const authorityIds = [...byAuthority.keys()].filter((id) => id !== "unassigned");
  const authorityById = new Map<string, { name: string; authorityKey: string }>();
  if (authorityIds.length) {
    const { data } = await supabase.from("teller_tax_authorities").select("id, name, authority_key").in("id", authorityIds);
    for (const row of data ?? []) {
      authorityById.set(row.id as string, {
        name: row.name as string,
        authorityKey: row.authority_key as string,
      });
    }
  }

  const registrationIds = [...new Set(transactions.map((tx) => tx.registrationId).filter(Boolean))] as string[];
  const registrationById = new Map<string, string>();
  if (registrationIds.length) {
    const { data } = await supabase
      .from("teller_tax_registrations")
      .select("id, jurisdiction_key")
      .eq("organization_id", filters.organizationId)
      .in("id", registrationIds);
    for (const row of data ?? []) registrationById.set(row.id as string, row.jurisdiction_key as string);
  }

  const rows = [...byAuthority.entries()].map(([key, row]) => {
    const authority = key !== "unassigned" ? authorityById.get(key) : undefined;
    return {
      ...row,
      authorityKey: authority?.authorityKey ?? (key === "unassigned" ? "unassigned" : null),
      authorityName: authority?.name ?? (key === "unassigned" ? "Unassigned" : null),
      registrationJurisdiction: row.registrationId ? registrationById.get(row.registrationId) : null,
    };
  });

  return paginateRows(rows.sort((a, b) => (a.authorityName ?? "").localeCompare(b.authorityName ?? "")), pagination);
}
