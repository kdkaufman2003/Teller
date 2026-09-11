import { roundMoney } from "../../payment-fees";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  LoadedDeterminationSnapshot,
  LoadedTaxComponent,
  LoadedTaxTransaction,
  PaginatedReport,
  TaxExemptDetailRow,
  TaxReportFilters,
  TaxReportPagination,
  TaxSalesDetailRow,
  TaxUseDetailRow,
} from "./types";
import { transactionMatchesTaxType } from "./filters";
import {
  loadDeterminationSnapshots,
  loadFilteredPostedTaxTransactions,
  loadTaxTransactionComponents,
  paginateRows,
} from "./load";

type DocumentLookup = Map<string, { number?: string | null; partyName?: string | null }>;

async function loadDocumentLookup(
  supabase: SupabaseClient,
  organizationId: string,
  documentIds: string[],
): Promise<DocumentLookup> {
  const lookup: DocumentLookup = new Map();
  if (documentIds.length === 0) return lookup;

  const batchSize = 80;
  for (let index = 0; index < documentIds.length; index += batchSize) {
    const batch = documentIds.slice(index, index + batchSize);
    const { data } = await supabase
      .from("teller_documents")
      .select("id, number, party_id")
      .eq("organization_id", organizationId)
      .in("id", batch);
    const partyIds = [...new Set((data ?? []).map((row) => row.party_id).filter(Boolean))] as string[];
    const partyNames = new Map<string, string>();
    if (partyIds.length) {
      const { data: parties } = await supabase
        .from("teller_parties")
        .select("id, name")
        .eq("organization_id", organizationId)
        .in("id", partyIds);
      for (const party of parties ?? []) partyNames.set(party.id as string, party.name as string);
    }
    for (const row of data ?? []) {
      lookup.set(row.id as string, {
        number: (row.number as string | null) ?? null,
        partyName: row.party_id ? partyNames.get(row.party_id as string) ?? null : null,
      });
    }
  }
  return lookup;
}

function componentSummary(components: LoadedTaxComponent[]): string {
  return components
    .map((c) => `${c.componentType}:${c.jurisdictionKey}@${c.ratePercent}%`)
    .join("; ");
}

function statePackVersionFromMetadata(metadata?: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const trace = metadata as { statePackVersion?: string; engineVersion?: string };
  return trace.statePackVersion ?? null;
}

function statePackVersionFromSnapshot(snapshot?: LoadedDeterminationSnapshot | null): string | null {
  if (!snapshot?.metadata) return null;
  const meta = snapshot.metadata as Record<string, unknown>;
  const trace = snapshot.precedenceTrace ?? {};
  return (
    (meta.statePackVersion as string | undefined) ??
    (trace.statePackVersion as string | undefined) ??
    null
  );
}

export async function buildSalesTaxDetailReport(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  pagination: TaxReportPagination,
): Promise<PaginatedReport<TaxSalesDetailRow>> {
  const transactions = (await loadFilteredPostedTaxTransactions(supabase, filters)).filter(
    (tx) => tx.transactionType === "sales_tax_collected",
  );
  const { rows: page, total } = paginateRows(transactions, pagination);
  const documentIds = [...new Set(page.map((tx) => tx.documentId).filter(Boolean))] as string[];
  const lookup = await loadDocumentLookup(supabase, filters.organizationId, documentIds);
  const components = await loadTaxTransactionComponents(
    supabase,
    filters.organizationId,
    page.map((tx) => tx.id),
  );
  const componentsByTx = new Map<string, LoadedTaxComponent[]>();
  for (const component of components) {
    const list = componentsByTx.get(component.taxTransactionId) ?? [];
    list.push(component);
    componentsByTx.set(component.taxTransactionId, list);
  }
  const snapshots = await loadDeterminationSnapshots(
    supabase,
    filters.organizationId,
    {},
    page.map((tx) => tx.id),
  );
  const snapshotByTx = new Map(snapshots.map((s) => [s.taxTransactionId ?? s.id, s]));

  const rows: TaxSalesDetailRow[] = page.map((tx) => {
    const doc = tx.documentId ? lookup.get(tx.documentId) : undefined;
    const txComponents = componentsByTx.get(tx.id) ?? [];
    const snapshot = snapshotByTx.get(tx.id);
    return {
      transactionDate: tx.transactionDate,
      documentId: tx.documentId,
      documentNumber: doc?.number,
      customerName: doc?.partyName,
      lineCategory: snapshot?.taxCategoryKey ?? null,
      taxableBasis: tx.taxableBasis,
      taxAmount: tx.taxAmount,
      jurisdictionKey: tx.primaryJurisdictionKey,
      componentSummary: componentSummary(txComponents),
      ratePercent: snapshot?.ratePercent ?? null,
      exemptionStatus: tx.determinationStatus === "exempt" ? "exempt" : null,
      determinationStatus: tx.determinationStatus,
      statePackVersion: statePackVersionFromSnapshot(snapshot) ?? statePackVersionFromMetadata(tx.metadata),
      journalEntryId: tx.postedJournalEntryId,
      taxTransactionId: tx.id,
    };
  });

  return { rows, total, limit: pagination.limit, offset: pagination.offset };
}

export async function buildUseTaxDetailReport(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  pagination: TaxReportPagination,
): Promise<PaginatedReport<TaxUseDetailRow>> {
  const transactions = (await loadFilteredPostedTaxTransactions(supabase, filters)).filter((tx) =>
    transactionMatchesTaxType(tx, "use"),
  );
  const { rows: page, total } = paginateRows(transactions, pagination);
  const documentIds = [...new Set(page.map((tx) => tx.documentId).filter(Boolean))] as string[];
  const lookup = await loadDocumentLookup(supabase, filters.organizationId, documentIds);
  const snapshots = await loadDeterminationSnapshots(
    supabase,
    filters.organizationId,
    {},
    page.map((tx) => tx.id),
  );
  const snapshotByTx = new Map(snapshots.map((s) => [s.taxTransactionId ?? s.id, s]));

  const rows: TaxUseDetailRow[] = page.map((tx) => {
    const doc = tx.documentId ? lookup.get(tx.documentId) : undefined;
    const metadata = (tx.metadata ?? {}) as Record<string, unknown>;
    const vendorTax = roundMoney(Number(metadata.vendorTax ?? 0));
    const requiredTax = roundMoney(Number(metadata.requiredTax ?? metadata.expectedTax ?? tx.taxAmount));
    const useTaxDue = roundMoney(Number(metadata.useTaxDue ?? tx.taxAmount));
    return {
      transactionDate: tx.transactionDate,
      documentId: tx.documentId,
      documentNumber: doc?.number,
      vendorName: doc?.partyName,
      lineCategory: snapshotByTx.get(tx.id)?.taxCategoryKey ?? null,
      purchaseBasis: tx.taxableBasis,
      vendorTaxCharged: vendorTax,
      requiredTax,
      useTaxAccrued: useTaxDue,
      jurisdictionKey: tx.primaryJurisdictionKey,
      classification: (metadata.purchaseTaxClassification as string | undefined) ?? null,
      determinationStatus: tx.determinationStatus,
      journalEntryId: tx.postedJournalEntryId,
      taxTransactionId: tx.id,
    };
  });

  return { rows, total, limit: pagination.limit, offset: pagination.offset };
}

export async function buildExemptTaxDetailReport(
  supabase: SupabaseClient,
  filters: TaxReportFilters,
  pagination: TaxReportPagination,
): Promise<PaginatedReport<TaxExemptDetailRow>> {
  const snapshots = (await loadDeterminationSnapshots(supabase, filters.organizationId, {
    startDate: filters.startDate,
    endDate: filters.endDate,
  })).filter((snapshot) => snapshot.determinationStatus === "exempt");

  const documentIds = [...new Set(snapshots.map((s) => s.documentId).filter(Boolean))] as string[];
  const lookup = await loadDocumentLookup(supabase, filters.organizationId, documentIds);

  const exemptionIds = [...new Set(snapshots.map((s) => s.exemptionId).filter(Boolean))] as string[];
  const exemptionById = new Map<string, { certificateNumber?: string | null; status?: string | null }>();
  if (exemptionIds.length) {
    const { data } = await supabase
      .from("teller_tax_exemptions")
      .select("id, certificate_number, status")
      .eq("organization_id", filters.organizationId)
      .in("id", exemptionIds);
    for (const row of data ?? []) {
      exemptionById.set(row.id as string, {
        certificateNumber: (row.certificate_number as string | null) ?? null,
        status: (row.status as string | null) ?? null,
      });
    }
  }

  const rows: TaxExemptDetailRow[] = snapshots.map((snapshot) => {
    const doc = snapshot.documentId ? lookup.get(snapshot.documentId) : undefined;
    const exemption = snapshot.exemptionId ? exemptionById.get(snapshot.exemptionId) : undefined;
    const trace = snapshot.precedenceTrace ?? {};
    return {
      transactionDate: snapshot.transactionDate,
      customerName: doc?.partyName,
      documentId: snapshot.documentId,
      exemptedBasis: snapshot.taxableBasis,
      certificateNumber: exemption?.certificateNumber ?? null,
      certificateStatusAtDetermination:
        (trace.exemptionStatusAtDetermination as string | undefined) ??
        (snapshot.metadata as { exemptionStatusAtDetermination?: string } | null)?.exemptionStatusAtDetermination ??
        exemption?.status ??
        null,
      jurisdictionKey: snapshot.jurisdictionKey,
      category: snapshot.taxCategoryKey,
      reason: (trace.precedenceSource as string | undefined) ?? "customer_exemption",
      snapshotId: snapshot.id,
      taxTransactionId: snapshot.taxTransactionId,
    };
  });

  return paginateRows(rows, pagination);
}

export function sumDetailTaxAmount(transactions: LoadedTaxTransaction[]): number {
  return roundMoney(transactions.reduce((sum, tx) => sum + Math.abs(tx.taxAmount), 0));
}
