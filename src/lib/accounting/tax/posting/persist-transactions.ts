import type { SupabaseClient } from "@supabase/supabase-js";
import { buildLineDeterminationSnapshot } from "../calculation/snapshot";
import type { TaxCalculationInput, TaxCalculationResult, TaxCalculationLineResult } from "../calculation/types";
import type { TaxSourceType, TaxTransactionType } from "../types";

export type PersistedTaxBundle = {
  transactionIds: string[];
  snapshotIds: string[];
  taxTotal: number;
};

function mapLineDeterminationStatus(line: TaxCalculationLineResult): string {
  if (line.determinationStatus === "needs_review") return "needs_review";
  if (line.treatment === "exempt") return "exempt";
  if (line.treatment === "non_taxable") return "non_taxable";
  if (line.determinationStatus === "override") return "override";
  return "resolved";
}

function collectionTransactionType(sourceType: TaxSourceType): TaxTransactionType {
  return sourceType === "credit_memo" ? "sales_tax_reversed" : "sales_tax_collected";
}

/** Positive tax_amount + transaction_type semantics (see phase15d docs). */
export async function persistPostedTaxBundle(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    calculationInput: TaxCalculationInput;
    calculation: TaxCalculationResult;
    documentId: string;
    sourceType: TaxSourceType;
    journalEntryId: string;
    originalDocumentId?: string | null;
  },
): Promise<PersistedTaxBundle> {
  const transactionIds: string[] = [];
  const snapshotIds: string[] = [];
  const txType = collectionTransactionType(input.sourceType);
  const now = new Date().toISOString();

  for (const line of input.calculation.lineResults) {
    const { data: tx, error: txError } = await supabase
      .from("teller_tax_transactions")
      .insert({
        organization_id: organizationId,
        transaction_type: txType,
        source_type: input.sourceType,
        source_id: input.documentId,
        document_id: input.documentId,
        line_id: line.lineId ?? null,
        determination_status: mapLineDeterminationStatus(line),
        transaction_date: input.calculationInput.transactionDate,
        taxable_basis: line.taxableBasis,
        tax_amount: Math.abs(line.taxAmount),
        primary_jurisdiction_key: line.jurisdictionKey,
        rule_key: typeof line.trace.ruleId === "string" ? line.trace.ruleId : null,
        is_posted: true,
        posted_at: now,
        posted_journal_entry_id: input.journalEntryId,
        metadata: {
          engineVersion: input.calculation.determinationMetadata.engineVersion,
          lineKey: line.lineKey,
          lineId: line.lineId ?? null,
          treatment: line.treatment,
          originalDocumentId: input.originalDocumentId ?? null,
          sourceLineage: input.originalDocumentId
            ? { originalDocumentId: input.originalDocumentId }
            : {},
        },
      })
      .select("id")
      .single();

    if (txError || !tx) throw new Error(txError?.message || "Could not persist tax transaction");

    transactionIds.push(tx.id);

    for (const component of line.components) {
      const { error: componentError } = await supabase.from("teller_tax_transaction_components").insert({
        organization_id: organizationId,
        tax_transaction_id: tx.id,
        component_type: component.componentType,
        jurisdiction_key: component.jurisdictionKey,
        rate_percent: component.ratePercent,
        taxable_basis: component.taxableBasis,
        tax_amount: Math.abs(component.taxAmount),
      });
      if (componentError) throw new Error(componentError.message);
    }

    const snapshotPayload = buildLineDeterminationSnapshot(
      organizationId,
      input.calculationInput.transactionDate,
      line,
      input.calculation,
      { documentId: input.documentId, lineId: line.lineId ?? null },
    );

    const { data: snapshot, error: snapshotError } = await supabase
      .from("teller_tax_determination_snapshots")
      .insert({
        organization_id: organizationId,
        document_id: input.documentId,
        line_id: line.lineId ?? null,
        tax_transaction_id: tx.id,
        transaction_date: snapshotPayload.transactionDate,
        tax_category_key: snapshotPayload.taxCategoryKey,
        jurisdiction_key: snapshotPayload.jurisdictionKey,
        determination_status: snapshotPayload.determinationStatus,
        taxable_basis: snapshotPayload.taxableBasis,
        tax_amount: snapshotPayload.taxAmount,
        rate_percent: snapshotPayload.ratePercent,
        rule_key: snapshotPayload.ruleKey,
        exemption_id: snapshotPayload.exemptionId ?? null,
        components: snapshotPayload.components,
        precedence_trace: snapshotPayload.precedenceTrace,
        metadata: { ...snapshotPayload.metadata, posted: true, journalEntryId: input.journalEntryId },
      })
      .select("id")
      .single();

    if (snapshotError || !snapshot) throw new Error(snapshotError?.message || "Could not persist tax snapshot");
    snapshotIds.push(snapshot.id);
  }

  return {
    transactionIds,
    snapshotIds,
    taxTotal: input.calculation.taxTotal,
  };
}

export async function findPostedTaxForDocument(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<{ journalEntryId: string | null; transactionCount: number } | null> {
  const { data, error } = await supabase
    .from("teller_tax_transactions")
    .select("posted_journal_entry_id")
    .eq("organization_id", organizationId)
    .eq("document_id", documentId)
    .eq("is_posted", true)
    .limit(1);

  if (error) throw new Error(error.message);
  if (!data?.length) return null;

  const { count } = await supabase
    .from("teller_tax_transactions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("document_id", documentId)
    .eq("is_posted", true);

  return {
    journalEntryId: (data[0]?.posted_journal_entry_id as string | null) ?? null,
    transactionCount: count ?? 0,
  };
}
