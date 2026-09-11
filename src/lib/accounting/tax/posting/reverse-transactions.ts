import type { SupabaseClient } from "@supabase/supabase-js";

/** Append-only tax subledger reversal rows linked to a journal reversal entry. */
export async function recordTaxSubledgerReversalForDocument(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    documentId: string;
    reversalJournalEntryId: string;
    voidDate: string;
    originalTransactionType: "sales_tax_collected" | "sales_tax_reversed";
  },
): Promise<number> {
  const { data: originals, error } = await supabase
    .from("teller_tax_transactions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("document_id", input.documentId)
    .eq("is_posted", true)
    .eq("transaction_type", input.originalTransactionType);

  if (error) throw new Error(error.message);
  if (!originals?.length) return 0;

  const now = new Date().toISOString();
  let created = 0;

  for (const original of originals) {
    if (
      typeof original.metadata === "object" &&
      original.metadata &&
      (original.metadata as { appendOnlyReversal?: boolean }).appendOnlyReversal
    ) {
      continue;
    }

    const reversalType =
      input.originalTransactionType === "sales_tax_collected"
        ? "sales_tax_reversed"
        : "sales_tax_collected";

    const { data: inserted, error: insertError } = await supabase
      .from("teller_tax_transactions")
      .insert({
        organization_id: organizationId,
        transaction_type: reversalType,
        source_type: original.source_type,
        source_id: input.documentId,
        document_id: input.documentId,
        line_id: original.line_id,
        determination_status: original.determination_status,
        transaction_date: input.voidDate,
        taxable_basis: original.taxable_basis,
        tax_amount: original.tax_amount,
        primary_jurisdiction_key: original.primary_jurisdiction_key,
        rule_key: original.rule_key,
        is_posted: true,
        posted_at: now,
        posted_journal_entry_id: input.reversalJournalEntryId,
        metadata: {
          ...(typeof original.metadata === "object" && original.metadata ? original.metadata : {}),
          reversesTaxTransactionId: original.id,
          appendOnlyReversal: true,
        },
      })
      .select("id")
      .single();

    if (insertError || !inserted) throw new Error(insertError?.message || "Could not record tax reversal");

    const { data: components } = await supabase
      .from("teller_tax_transaction_components")
      .select("*")
      .eq("tax_transaction_id", original.id);

    for (const component of components ?? []) {
      const { error: componentError } = await supabase.from("teller_tax_transaction_components").insert({
        organization_id: organizationId,
        tax_transaction_id: inserted.id,
        component_type: component.component_type,
        jurisdiction_key: component.jurisdiction_key,
        authority_id: component.authority_id,
        rate_percent: component.rate_percent,
        taxable_basis: component.taxable_basis,
        tax_amount: component.tax_amount,
      });
      if (componentError) throw new Error(componentError.message);
    }

    created += 1;
  }

  return created;
}

/** Append-only reversal rows for posted purchase use-tax accruals. */
export async function recordPurchaseTaxReversalForDocument(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    documentId: string;
    reversalJournalEntryId: string;
    voidDate: string;
  },
): Promise<number> {
  const { data: originals, error } = await supabase
    .from("teller_tax_transactions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("document_id", input.documentId)
    .eq("is_posted", true)
    .eq("transaction_type", "use_tax_accrued");

  if (error) throw new Error(error.message);
  if (!originals?.length) return 0;

  const now = new Date().toISOString();
  let created = 0;

  for (const original of originals) {
    if (
      typeof original.metadata === "object" &&
      original.metadata &&
      (original.metadata as { appendOnlyReversal?: boolean }).appendOnlyReversal
    ) {
      continue;
    }

    const { data: inserted, error: insertError } = await supabase
      .from("teller_tax_transactions")
      .insert({
        organization_id: organizationId,
        transaction_type: "tax_adjustment",
        source_type: original.source_type,
        source_id: input.documentId,
        document_id: input.documentId,
        line_id: original.line_id,
        determination_status: original.determination_status,
        transaction_date: input.voidDate,
        taxable_basis: original.taxable_basis,
        tax_amount: original.tax_amount,
        primary_jurisdiction_key: original.primary_jurisdiction_key,
        rule_key: original.rule_key,
        is_posted: true,
        posted_at: now,
        posted_journal_entry_id: input.reversalJournalEntryId,
        metadata: {
          ...(typeof original.metadata === "object" && original.metadata ? original.metadata : {}),
          reversesTaxTransactionId: original.id,
          appendOnlyReversal: true,
          purchaseTaxReversal: true,
        },
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      throw new Error(insertError?.message || "Could not record purchase tax reversal");
    }

    const { data: components } = await supabase
      .from("teller_tax_transaction_components")
      .select("*")
      .eq("tax_transaction_id", original.id);

    for (const component of components ?? []) {
      const { error: componentError } = await supabase.from("teller_tax_transaction_components").insert({
        organization_id: organizationId,
        tax_transaction_id: inserted.id,
        component_type: component.component_type,
        jurisdiction_key: component.jurisdiction_key,
        authority_id: component.authority_id,
        rate_percent: component.rate_percent,
        taxable_basis: component.taxable_basis,
        tax_amount: component.tax_amount,
      });
      if (componentError) throw new Error(componentError.message);
    }

    created += 1;
  }

  return created;
}
