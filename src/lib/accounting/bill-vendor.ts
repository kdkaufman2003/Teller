import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "./audit";
import { isActiveDocumentAllocationRow } from "./document-allocations";

const VENDOR_KINDS = new Set(["vendor", "both"]);

export type PayableDocumentKind = "bill" | "expense";

const DOCUMENT_LABEL: Record<PayableDocumentKind, string> = {
  bill: "bill",
  expense: "expense",
};

export function assertPayableVendorChangeAllowed(input: {
  kind?: PayableDocumentKind;
  status: string;
  currentPartyId: string | null;
  nextPartyId: string;
  hasActiveVendorCredits: boolean;
  vendorExists: boolean;
  vendorKind: string | null;
}): void {
  const label = DOCUMENT_LABEL[input.kind ?? "bill"];
  if (input.status === "void") {
    throw new Error(`Cannot change the vendor on a void ${label}.`);
  }
  const nextPartyId = input.nextPartyId.trim();
  if (!nextPartyId) {
    throw new Error("Vendor is required.");
  }
  if (input.currentPartyId === nextPartyId) {
    throw new Error(`${label === "bill" ? "Bill" : "Expense"} is already assigned to this vendor.`);
  }
  if (!input.vendorExists) {
    throw new Error("Vendor not found.");
  }
  if (!input.vendorKind || !VENDOR_KINDS.has(input.vendorKind)) {
    throw new Error("Selected party is not a vendor.");
  }
  if (input.hasActiveVendorCredits) {
    throw new Error(
      "Cannot change the vendor while vendor credits are applied. Reverse the credits first.",
    );
  }
}

export function assertBillVendorChangeAllowed(
  input: Parameters<typeof assertPayableVendorChangeAllowed>[0],
): void {
  assertPayableVendorChangeAllowed({ ...input, kind: input.kind ?? "bill" });
}

async function documentHasActiveVendorCredits(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("teller_document_allocations")
    .select("amount, reversed_by_allocation_id, reversal_of_allocation_id, allocation_kind")
    .eq("organization_id", organizationId)
    .eq("target_document_id", documentId);

  if (error) throw new Error(error.message);
  return (data ?? []).some((row) => isActiveDocumentAllocationRow(row));
}

async function exclusivePaymentIdsForDocument(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<string[]> {
  const { data: payments, error } = await supabase
    .from("teller_payments")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("document_id", documentId);

  if (error) throw new Error(error.message);
  const paymentIds = (payments ?? []).map((row) => row.id as string);
  if (!paymentIds.length) return [];

  const { data: allocations, error: allocError } = await supabase
    .from("teller_payment_allocations")
    .select("payment_id, document_id")
    .eq("organization_id", organizationId)
    .in("payment_id", paymentIds);

  if (allocError) throw new Error(allocError.message);

  const shared = new Set(
    (allocations ?? [])
      .filter((row) => (row.document_id as string) !== documentId)
      .map((row) => row.payment_id as string),
  );

  return paymentIds.filter((id) => !shared.has(id));
}

export async function reassignPayableVendor(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string;
    kind: PayableDocumentKind;
    actorId?: string | null;
  },
): Promise<{ fromPartyId: string | null; toPartyId: string }> {
  const nextPartyId = input.partyId.trim();
  const label = DOCUMENT_LABEL[input.kind];

  const { data: document, error } = await supabase
    .from("teller_documents")
    .select("id, number, status, party_id, kind")
    .eq("organization_id", input.organizationId)
    .eq("kind", input.kind)
    .eq("id", input.documentId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!document) throw new Error(`${label === "bill" ? "Bill" : "Expense"} not found.`);

  const { data: vendor, error: vendorError } = await supabase
    .from("teller_parties")
    .select("id, kind")
    .eq("organization_id", input.organizationId)
    .eq("id", nextPartyId)
    .maybeSingle();

  if (vendorError) throw new Error(vendorError.message);

  const hasActiveVendorCredits = await documentHasActiveVendorCredits(
    supabase,
    input.organizationId,
    input.documentId,
  );

  assertPayableVendorChangeAllowed({
    kind: input.kind,
    status: document.status as string,
    currentPartyId: (document.party_id as string | null) ?? null,
    nextPartyId,
    hasActiveVendorCredits,
    vendorExists: Boolean(vendor?.id),
    vendorKind: (vendor?.kind as string | null) ?? null,
  });

  const fromPartyId = (document.party_id as string | null) ?? null;

  const { error: updateError } = await supabase
    .from("teller_documents")
    .update({ party_id: nextPartyId, updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("id", input.documentId);

  if (updateError) throw new Error(updateError.message);

  const exclusivePaymentIds = await exclusivePaymentIdsForDocument(
    supabase,
    input.organizationId,
    input.documentId,
  );
  if (exclusivePaymentIds.length) {
    const { error: paymentError } = await supabase
      .from("teller_payments")
      .update({ party_id: nextPartyId })
      .eq("organization_id", input.organizationId)
      .in("id", exclusivePaymentIds);
    if (paymentError) throw new Error(paymentError.message);
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: input.kind === "expense" ? "expense.vendor_changed" : "bill.vendor_changed",
    resourceKind: input.kind,
    resourceId: input.documentId,
    metadata: {
      number: document.number,
      fromPartyId,
      toPartyId: nextPartyId,
    },
  });

  return { fromPartyId, toPartyId: nextPartyId };
}

export async function reassignBillVendor(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string;
    actorId?: string | null;
  },
) {
  return reassignPayableVendor(supabase, { ...input, kind: "bill" });
}

export async function reassignExpenseVendor(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string;
    actorId?: string | null;
  },
) {
  return reassignPayableVendor(supabase, { ...input, kind: "expense" });
}
