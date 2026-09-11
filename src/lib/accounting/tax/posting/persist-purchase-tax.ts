import type { SupabaseClient } from "@supabase/supabase-js";
import { buildLineDeterminationSnapshot } from "../calculation/snapshot";
import type { TaxCalculationInput, TaxCalculationResult, TaxCalculationLineResult } from "../calculation/types";
import type { PurchaseTaxComparisonResult } from "../purchase/types";

export type PersistedPurchaseTaxBundle = {
  transactionIds: string[];
  snapshotIds: string[];
  useTaxDueTotal: number;
};

function mapPurchaseLineStatus(
  line: TaxCalculationLineResult,
  comparisonLine: PurchaseTaxComparisonResult["lineResults"][number],
): string {
  if (comparisonLine.status === "needs_review" || line.determinationStatus === "needs_review") {
    return "needs_review";
  }
  if (line.treatment === "exempt") return "exempt";
  if (line.treatment === "non_taxable") return "non_taxable";
  if (comparisonLine.useTaxDue > 0.009) return "resolved";
  if (comparisonLine.vendorTaxOverage > 0.009) return "needs_review";
  return "resolved";
}

/** Persist purchase-side use tax accrual rows and immutable determination snapshots. */
export async function persistPostedPurchaseTaxBundle(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    calculationInput: TaxCalculationInput;
    calculation: TaxCalculationResult;
    comparison: PurchaseTaxComparisonResult;
    documentId: string;
    journalEntryId: string;
    vendorTaxCharged: number;
  },
): Promise<PersistedPurchaseTaxBundle> {
  const transactionIds: string[] = [];
  const snapshotIds: string[] = [];
  const now = new Date().toISOString();

  for (const line of input.calculation.lineResults) {
    const comparisonLine =
      input.comparison.lineResults.find((row) => row.lineKey === line.lineKey) ??
      input.comparison.lineResults.find((row) => row.lineId === line.lineId);

    const useTaxDue = comparisonLine?.useTaxDue ?? 0;
    const vendorTax = comparisonLine?.vendorTax ?? 0;
    const requiredTax = comparisonLine?.requiredTax ?? line.taxAmount;

    if (requiredTax <= 0.009 && vendorTax <= 0.009 && useTaxDue <= 0.009) continue;

    const { data: tx, error: txError } = await supabase
      .from("teller_tax_transactions")
      .insert({
        organization_id: organizationId,
        transaction_type: "use_tax_accrued",
        source_type: "bill",
        source_id: input.documentId,
        document_id: input.documentId,
        line_id: line.lineId ?? null,
        determination_status: mapPurchaseLineStatus(line, comparisonLine ?? {
          lineKey: line.lineKey,
          taxableBasis: line.taxableBasis,
          requiredTax,
          vendorTax,
          useTaxDue,
          vendorTaxOverage: 0,
          status: "fully_taxed",
          classification: "other",
          components: [],
        }),
        transaction_date: input.calculationInput.transactionDate,
        taxable_basis: line.taxableBasis,
        tax_amount: Math.abs(useTaxDue),
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
          requiredTax,
          vendorTax,
          useTaxDue,
          vendorTaxChargedDocument: input.vendorTaxCharged,
          purchaseTaxStatus: comparisonLine?.status ?? null,
          vendorTaxOverage: comparisonLine?.vendorTaxOverage ?? 0,
        },
      })
      .select("id")
      .single();

    if (txError || !tx) throw new Error(txError?.message || "Could not persist purchase tax transaction");

    transactionIds.push(tx.id);

    for (const component of line.components) {
      const comparisonComponent = comparisonLine?.components.find(
        (row) => row.jurisdictionKey === component.jurisdictionKey,
      );
      const { error: componentError } = await supabase.from("teller_tax_transaction_components").insert({
        organization_id: organizationId,
        tax_transaction_id: tx.id,
        component_type: component.componentType,
        jurisdiction_key: component.jurisdictionKey,
        rate_percent: component.ratePercent,
        taxable_basis: component.taxableBasis,
        tax_amount: Math.abs(comparisonComponent?.useTaxDue ?? component.taxAmount),
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
        tax_amount: useTaxDue,
        rate_percent: snapshotPayload.ratePercent,
        rule_key: snapshotPayload.ruleKey,
        exemption_id: snapshotPayload.exemptionId ?? null,
        components: snapshotPayload.components,
        precedence_trace: snapshotPayload.precedenceTrace,
        metadata: {
          ...snapshotPayload.metadata,
          posted: true,
          journalEntryId: input.journalEntryId,
          requiredTax,
          vendorTax,
          useTaxDue,
          vendorTaxChargedDocument: input.vendorTaxCharged,
        },
      })
      .select("id")
      .single();

    if (snapshotError || !snapshot) {
      throw new Error(snapshotError?.message || "Could not persist purchase tax snapshot");
    }
    snapshotIds.push(snapshot.id);
  }

  return {
    transactionIds,
    snapshotIds,
    useTaxDueTotal: input.comparison.useTaxDueTotal,
  };
}

export async function findPostedPurchaseTaxForDocument(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<{ journalEntryId: string | null; transactionCount: number } | null> {
  const { data, error } = await supabase
    .from("teller_tax_transactions")
    .select("posted_journal_entry_id")
    .eq("organization_id", organizationId)
    .eq("document_id", documentId)
    .eq("source_type", "bill")
    .eq("transaction_type", "use_tax_accrued")
    .eq("is_posted", true)
    .limit(1);

  if (error) throw new Error(error.message);
  if (!data?.length) return null;

  const { count } = await supabase
    .from("teller_tax_transactions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("document_id", documentId)
    .eq("source_type", "bill")
    .eq("transaction_type", "use_tax_accrued")
    .eq("is_posted", true);

  return {
    journalEntryId: (data[0]?.posted_journal_entry_id as string | null) ?? null,
    transactionCount: count ?? 0,
  };
}
