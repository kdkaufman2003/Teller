import type { SupabaseClient } from "@supabase/supabase-js";
import { TRANSACTION_ID_BATCH_SIZE } from "./filters";
import type {
  LoadedDeterminationSnapshot,
  LoadedTaxComponent,
  LoadedTaxTransaction,
  TaxReportFilters,
  TaxReportPagination,
} from "./types";
import { transactionMatchesFilters } from "./filters";

function parseTransaction(row: Record<string, unknown>): LoadedTaxTransaction {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    transactionType: row.transaction_type as LoadedTaxTransaction["transactionType"],
    sourceType: row.source_type as string,
    sourceId: (row.source_id as string | null) ?? null,
    documentId: (row.document_id as string | null) ?? null,
    lineId: (row.line_id as string | null) ?? null,
    determinationStatus: row.determination_status as string,
    transactionDate: row.transaction_date as string,
    taxableBasis: Number(row.taxable_basis ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    primaryJurisdictionKey: (row.primary_jurisdiction_key as string | null) ?? null,
    registrationId: (row.registration_id as string | null) ?? null,
    authorityId: (row.authority_id as string | null) ?? null,
    filingPeriodId: (row.filing_period_id as string | null) ?? null,
    postedJournalEntryId: (row.posted_journal_entry_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}

function parseSnapshot(row: Record<string, unknown>): LoadedDeterminationSnapshot {
  return {
    id: row.id as string,
    taxTransactionId: (row.tax_transaction_id as string | null) ?? null,
    documentId: (row.document_id as string | null) ?? null,
    lineId: (row.line_id as string | null) ?? null,
    transactionDate: row.transaction_date as string,
    taxCategoryKey: (row.tax_category_key as string | null) ?? null,
    jurisdictionKey: (row.jurisdiction_key as string | null) ?? null,
    determinationStatus: row.determination_status as string,
    taxableBasis: Number(row.taxable_basis ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    ratePercent: row.rate_percent != null ? Number(row.rate_percent) : null,
    exemptionId: (row.exemption_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    precedenceTrace: (row.precedence_trace as Record<string, unknown> | null) ?? null,
    components: (row.components as unknown[]) ?? [],
  };
}

function parseComponent(row: Record<string, unknown>): LoadedTaxComponent {
  return {
    taxTransactionId: row.tax_transaction_id as string,
    componentType: row.component_type as string,
    jurisdictionKey: row.jurisdiction_key as string,
    authorityId: (row.authority_id as string | null) ?? null,
    ratePercent: Number(row.rate_percent ?? 0),
    taxableBasis: Number(row.taxable_basis ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
  };
}

type DateRange = { startDate?: string | null; endDate?: string | null };

function applyDateRangeQuery<T extends { gte: (c: string, v: string) => T; lte: (c: string, v: string) => T }>(
  query: T,
  range: DateRange,
): T {
  let next = query;
  if (range.startDate) next = next.gte("transaction_date", range.startDate);
  if (range.endDate) next = next.lte("transaction_date", range.endDate);
  return next;
}

/** Loads posted tax transactions with optional date bounds — batched for large org histories. */
export async function loadPostedTaxTransactions(
  supabase: SupabaseClient,
  organizationId: string,
  range: DateRange,
  options?: { includeUnposted?: boolean },
): Promise<LoadedTaxTransaction[]> {
  const pageSize = 500;
  const rows: LoadedTaxTransaction[] = [];
  let offset = 0;

  while (true) {
    let query = supabase
      .from("teller_tax_transactions")
      .select("*")
      .eq("organization_id", organizationId)
      .order("transaction_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (!options?.includeUnposted) query = query.eq("is_posted", true);
    query = applyDateRangeQuery(query, range);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    rows.push(...data.map((row) => parseTransaction(row as Record<string, unknown>)));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

export async function loadFilteredPostedTaxTransactions(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
): Promise<LoadedTaxTransaction[]> {
  const rows = await loadPostedTaxTransactions(supabase, filters.organizationId, {
    startDate: filters.startDate,
    endDate: filters.endDate,
  });
  return rows.filter((tx) => transactionMatchesFilters(tx, filters));
}

export async function loadTaxTransactionComponents(
  supabase: SupabaseClient,
  organizationId: string,
  transactionIds: string[],
): Promise<LoadedTaxComponent[]> {
  if (transactionIds.length === 0) return [];

  const components: LoadedTaxComponent[] = [];
  for (let index = 0; index < transactionIds.length; index += TRANSACTION_ID_BATCH_SIZE) {
    const batch = transactionIds.slice(index, index + TRANSACTION_ID_BATCH_SIZE);
    const { data, error } = await supabase
      .from("teller_tax_transaction_components")
      .select("*")
      .eq("organization_id", organizationId)
      .in("tax_transaction_id", batch);
    if (error) throw new Error(error.message);
    components.push(...(data ?? []).map((row) => parseComponent(row as Record<string, unknown>)));
  }
  return components;
}

export async function loadDeterminationSnapshots(
  supabase: SupabaseClient,
  organizationId: string,
  range: DateRange,
  transactionIds?: string[],
): Promise<LoadedDeterminationSnapshot[]> {
  const snapshots: LoadedDeterminationSnapshot[] = [];

  if (transactionIds?.length) {
    for (let index = 0; index < transactionIds.length; index += TRANSACTION_ID_BATCH_SIZE) {
      const batch = transactionIds.slice(index, index + TRANSACTION_ID_BATCH_SIZE);
      const { data, error } = await supabase
        .from("teller_tax_determination_snapshots")
        .select("*")
        .eq("organization_id", organizationId)
        .in("tax_transaction_id", batch);
      if (error) throw new Error(error.message);
      snapshots.push(...(data ?? []).map((row) => parseSnapshot(row as Record<string, unknown>)));
    }
    return snapshots;
  }

  let query = supabase
    .from("teller_tax_determination_snapshots")
    .select("*")
    .eq("organization_id", organizationId)
    .order("transaction_date", { ascending: true });
  query = applyDateRangeQuery(query, range);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => parseSnapshot(row as Record<string, unknown>));
}

export function paginateRows<T>(rows: T[], pagination: TaxReportPagination): {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
} {
  const total = rows.length;
  return {
    total,
    limit: pagination.limit,
    offset: pagination.offset,
    rows: rows.slice(pagination.offset, pagination.offset + pagination.limit),
  };
}

export async function resolveFilingPeriodDateRange(
  supabase: SupabaseClient,
  organizationId: string,
  filingPeriodId: string,
): Promise<{ startDate: string; endDate: string; registrationId: string }> {
  const { data, error } = await supabase
    .from("teller_tax_filing_periods")
    .select("period_start, period_end, registration_id, organization_id")
    .eq("id", filingPeriodId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Filing period not found");
  return {
    startDate: data.period_start as string,
    endDate: data.period_end as string,
    registrationId: data.registration_id as string,
  };
}
