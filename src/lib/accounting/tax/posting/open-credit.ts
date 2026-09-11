import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { postCreditMemoOpen } from "../../credits";
import type { TaxLocationInput } from "../types";
import { buildTaxCalculationInputFromDocument, type DocumentLineForTax } from "./document-input";
import { findPostedTaxForDocument, persistPostedTaxBundle } from "./persist-transactions";
import { prepareDocumentTaxPosting } from "./prepare";
import { TaxPostingBlockedError } from "./open-invoice";

export async function postCreditMemoOpenWithPhase15Tax(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    reason?: string;
    location: TaxLocationInput;
    lines: DocumentLineForTax[];
    originalDocumentId?: string | null;
    actorId?: string | null;
  },
): Promise<{ entryId: string; taxTotal: number; subtotal: number; total: number }> {
  const existing = await findPostedTaxForDocument(supabase, input.organizationId, input.documentId);
  if (existing?.journalEntryId) {
    const { data: doc } = await supabase
      .from("teller_documents")
      .select("posted_entry_id, tax, subtotal, total")
      .eq("id", input.documentId)
      .maybeSingle();
    if (doc?.posted_entry_id === existing.journalEntryId) {
      return {
        entryId: existing.journalEntryId,
        taxTotal: asNumber(doc.tax),
        subtotal: asNumber(doc.subtotal),
        total: asNumber(doc.total),
      };
    }
  }

  const calculationInput = buildTaxCalculationInputFromDocument({
    transactionDate: input.issueDate,
    transactionType: "credit_memo",
    partyId: input.partyId,
    location: input.location,
    lines: input.lines,
  });

  const prepared = await prepareDocumentTaxPosting(supabase, input.organizationId, {
    calculationInput,
    sourceType: "credit_memo",
    sourceId: input.documentId,
    transactionType: "sales_tax_reversed",
  });

  if (!prepared.canPost) {
    throw new TaxPostingBlockedError(prepared.reason ?? "Tax posting is blocked");
  }

  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = prepared.taxTotal;
  const total = subtotal + tax;

  const entryId = await postCreditMemoOpen(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    partyId: input.partyId,
    jobId: input.jobId,
    issueDate: input.issueDate,
    number: input.number,
    tax,
    reason: input.reason,
    taxPayableAccountId: prepared.salesTaxPayableAccountId,
    lines: input.lines.map((line) => ({
      amount: asNumber(line.amount),
      account_id: line.account_id ?? null,
      description: line.description ?? "",
    })),
    actorId: input.actorId,
  });

  await persistPostedTaxBundle(supabase, input.organizationId, {
    calculationInput,
    calculation: prepared.calculation,
    documentId: input.documentId,
    sourceType: "credit_memo",
    journalEntryId: entryId,
    originalDocumentId: input.originalDocumentId ?? null,
  });

  return { entryId, taxTotal: tax, subtotal, total };
}
