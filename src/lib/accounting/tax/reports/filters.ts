import type { TaxReportFilters, TaxReportPagination } from "./types";
import type { LoadedTaxTransaction } from "./types";

export const DEFAULT_REPORT_PAGE_SIZE = 100;
export const MAX_REPORT_PAGE_SIZE = 500;
export const TRANSACTION_ID_BATCH_SIZE = 80;

export function parseTaxReportFilters(input: {
  organizationId: string;
  startDate?: string | null;
  endDate?: string | null;
  filingPeriodId?: string | null;
  registrationId?: string | null;
  authorityId?: string | null;
  state?: string | null;
  taxType?: string | null;
  determinationStatus?: string | null;
  jurisdictionKey?: string | null;
}): TaxReportFilters {
  return {
    organizationId: input.organizationId,
    startDate: input.startDate?.trim() || null,
    endDate: input.endDate?.trim() || null,
    filingPeriodId: input.filingPeriodId?.trim() || null,
    registrationId: input.registrationId?.trim() || null,
    authorityId: input.authorityId?.trim() || null,
    state: input.state?.trim().toUpperCase() || null,
    taxType: parseTaxType(input.taxType),
    determinationStatus: (input.determinationStatus?.trim() as TaxReportFilters["determinationStatus"]) || null,
    jurisdictionKey: input.jurisdictionKey?.trim() || null,
  };
}

function parseTaxType(value?: string | null): TaxReportFilters["taxType"] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "all") return "all";
  if (normalized === "sales") return "sales";
  if (normalized === "use") return "use";
  if (normalized === "payment") return "payment";
  if (normalized === "adjustment") return "adjustment";
  return "all";
}

export function parseTaxReportPagination(input?: {
  limit?: string | number | null;
  offset?: string | number | null;
}): TaxReportPagination {
  const limitRaw = Number(input?.limit ?? DEFAULT_REPORT_PAGE_SIZE);
  const offsetRaw = Number(input?.offset ?? 0);
  return {
    limit: Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_REPORT_PAGE_SIZE, 1), MAX_REPORT_PAGE_SIZE),
    offset: Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0),
  };
}

function inferStateFromJurisdiction(jurisdictionKey?: string | null): string | null {
  if (!jurisdictionKey) return null;
  const parts = jurisdictionKey.split("-");
  if (parts.length >= 2 && parts[0] === "US") return parts[1]!.toUpperCase();
  return null;
}

export function transactionMatchesTaxType(tx: LoadedTaxTransaction, taxType: TaxReportFilters["taxType"]): boolean {
  if (!taxType || taxType === "all") return true;
  if (taxType === "sales") {
    return ["sales_tax_collected", "sales_tax_reversed", "sales_tax_refunded"].includes(tx.transactionType);
  }
  if (taxType === "use") return tx.transactionType === "use_tax_accrued";
  if (taxType === "payment") return tx.transactionType === "authority_payment";
  if (taxType === "adjustment") return tx.transactionType === "tax_adjustment";
  return true;
}

export function transactionMatchesFilters(tx: LoadedTaxTransaction, filters: TaxReportFilters): boolean {
  if (filters.registrationId && tx.registrationId !== filters.registrationId) return false;
  if (filters.authorityId && tx.authorityId !== filters.authorityId) return false;
  if (filters.filingPeriodId && tx.filingPeriodId !== filters.filingPeriodId) return false;
  if (filters.jurisdictionKey) {
    const key = tx.primaryJurisdictionKey ?? "";
    if (key !== filters.jurisdictionKey && !key.startsWith(`${filters.jurisdictionKey}-`)) return false;
  }
  if (filters.state) {
    const state = inferStateFromJurisdiction(tx.primaryJurisdictionKey);
    if (state !== filters.state) return false;
  }
  if (filters.determinationStatus && tx.determinationStatus !== filters.determinationStatus) return false;
  if (!transactionMatchesTaxType(tx, filters.taxType)) return false;
  return true;
}

export function filterTransactions(
  transactions: LoadedTaxTransaction[],
  filters: TaxReportFilters,
): LoadedTaxTransaction[] {
  return transactions.filter((tx) => transactionMatchesFilters(tx, filters));
}
