import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";

export type AllocationKind =
  | "invoice_payment"
  | "bill_payment"
  | "deposit_apply"
  | "credit_apply"
  | "vendor_credit_apply"
  | "refund_offset";

export type PaymentType =
  | "customer_payment"
  | "customer_deposit"
  | "customer_refund"
  | "bill_payment"
  | "vendor_refund";

export function allocationKindForDocumentKind(
  documentKind: string,
): AllocationKind {
  if (documentKind === "expense" || documentKind === "bill") {
    return "bill_payment";
  }
  return "invoice_payment";
}

export function paymentTypeForDocumentKind(documentKind: string): PaymentType {
  if (documentKind === "expense" || documentKind === "bill") {
    return "bill_payment";
  }
  return "customer_payment";
}

export type PaymentAllocationRow = {
  id: string;
  payment_id: string;
  document_id: string;
  amount: number;
  allocation_kind: string;
  application_journal_entry_id?: string | null;
  application_event_id?: string | null;
};

export async function recordPaymentAllocation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    paymentId: string;
    documentId: string;
    amount: number;
    allocationKind: AllocationKind;
    applicationJournalEntryId?: string | null;
    applicationEventId?: string | null;
  },
): Promise<{ id: string; inserted: boolean }> {
  const amount = roundMoney(asNumber(input.amount));
  if (amount <= 0.009) {
    throw new Error("Allocation amount must be greater than zero.");
  }

  const row: Record<string, unknown> = {
    organization_id: input.organizationId,
    payment_id: input.paymentId,
    document_id: input.documentId,
    amount,
    allocation_kind: input.allocationKind,
  };
  if (input.applicationJournalEntryId) {
    row.application_journal_entry_id = input.applicationJournalEntryId;
  }
  if (input.applicationEventId) {
    row.application_event_id = input.applicationEventId;
  }

  const { data, error } = await supabase
    .from("teller_payment_allocations")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    if (error.message.includes("duplicate")) {
      if (input.applicationEventId) {
        const { data: existing } = await supabase
          .from("teller_payment_allocations")
          .select("id")
          .eq("organization_id", input.organizationId)
          .eq("application_event_id", input.applicationEventId)
          .maybeSingle();
        if (existing?.id) return { id: existing.id as string, inserted: false };
      }
      if (input.allocationKind !== "deposit_apply") {
        const { data: existing } = await supabase
          .from("teller_payment_allocations")
          .select("id")
          .eq("payment_id", input.paymentId)
          .eq("document_id", input.documentId)
          .eq("allocation_kind", input.allocationKind)
          .maybeSingle();
        if (existing?.id) return { id: existing.id as string, inserted: false };
      }
    }
    throw new Error(error.message);
  }

  return { id: data!.id as string, inserted: true };
}

export async function sumAllocationsForDocument(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<number> {
  const { data: allocations, error } = await supabase
    .from("teller_payment_allocations")
    .select("amount, payment_id, allocation_kind, reversed_by_allocation_id, reversal_of_allocation_id")
    .eq("organization_id", organizationId)
    .eq("document_id", documentId);

  if (error) throw new Error(error.message);
  if (!allocations?.length) return 0;

  const paymentIds = [...new Set(allocations.map((row) => row.payment_id as string))];
  const { data: payments, error: paymentsError } = await supabase
    .from("teller_payments")
    .select("id, status")
    .eq("organization_id", organizationId)
    .in("id", paymentIds);

  if (paymentsError) throw new Error(paymentsError.message);

  const postedIds = new Set(
    (payments ?? [])
      .filter((row) => (row.status ?? "posted") === "posted")
      .map((row) => row.id as string),
  );

  return roundMoney(
    allocations
      .filter(
        (row) =>
          postedIds.has(row.payment_id as string) &&
          !row.reversed_by_allocation_id &&
          !row.reversal_of_allocation_id,
      )
      .reduce((sum, row) => {
        const amount = asNumber(row.amount);
        if (row.allocation_kind === "refund_offset") return sum - amount;
        if (
          row.allocation_kind === "invoice_payment" ||
          row.allocation_kind === "bill_payment" ||
          row.allocation_kind === "deposit_apply"
        ) {
          return sum + amount;
        }
        return sum;
      }, 0),
  );
}

export async function sumAllocationsForPayment(
  supabase: SupabaseClient,
  organizationId: string,
  paymentId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_payment_allocations")
    .select("amount, allocation_kind, reversed_by_allocation_id")
    .eq("organization_id", organizationId)
    .eq("payment_id", paymentId);

  if (error) throw new Error(error.message);
  return roundMoney(
    (data ?? [])
      .filter((row) => !row.reversed_by_allocation_id)
      .reduce((sum, row) => {
        const amount = asNumber(row.amount);
        if (row.allocation_kind === "refund_offset") return sum - amount;
        if (row.allocation_kind.endsWith("_reversal")) return sum;
        return sum + amount;
      }, 0),
  );
}

/** Batch authoritative paid amounts keyed by document id. */
export async function authoritativeAmountPaidByDocuments(
  supabase: SupabaseClient,
  organizationId: string,
  documentIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!documentIds.length) return result;

  for (const id of documentIds) result.set(id, 0);

  const { data: allocations, error } = await supabase
    .from("teller_payment_allocations")
    .select(
      "document_id, amount, payment_id, allocation_kind, reversed_by_allocation_id, reversal_of_allocation_id",
    )
    .eq("organization_id", organizationId)
    .in("document_id", documentIds);

  if (error) throw new Error(error.message);
  if (!allocations?.length) {
    return fallbackPaidByDocuments(supabase, organizationId, documentIds, result);
  }

  const paymentIds = [...new Set(allocations.map((row) => row.payment_id as string))];
  const { data: payments } = await supabase
    .from("teller_payments")
    .select("id, status")
    .eq("organization_id", organizationId)
    .in("id", paymentIds);

  const postedIds = new Set(
    (payments ?? [])
      .filter((row) => (row.status ?? "posted") === "posted")
      .map((row) => row.id as string),
  );

  for (const row of allocations) {
    if (!postedIds.has(row.payment_id as string)) continue;
    if (row.reversed_by_allocation_id) continue;
    if (row.reversal_of_allocation_id) continue;

    const amount = asNumber(row.amount);
    const kind = row.allocation_kind as string;
    let delta = 0;
    if (kind === "refund_offset") delta = -amount;
    else if (
      kind === "invoice_payment" ||
      kind === "bill_payment" ||
      kind === "deposit_apply"
    ) {
      delta = amount;
    } else {
      continue;
    }

    const docId = row.document_id as string;
    result.set(docId, roundMoney((result.get(docId) ?? 0) + delta));
  }

  return result;
}

async function fallbackPaidByDocuments(
  supabase: SupabaseClient,
  organizationId: string,
  documentIds: string[],
  result: Map<string, number>,
): Promise<Map<string, number>> {
  const { data: payments, error } = await supabase
    .from("teller_payments")
    .select("document_id, amount, status")
    .eq("organization_id", organizationId)
    .in("document_id", documentIds);

  if (error) throw new Error(error.message);

  for (const row of payments ?? []) {
    if ((row.status ?? "posted") !== "posted") continue;
    const docId = row.document_id as string;
    if (!docId) continue;
    result.set(docId, roundMoney((result.get(docId) ?? 0) + asNumber(row.amount)));
  }

  return result;
}

export async function documentHasActivePayments(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<boolean> {
  const paid = await sumAllocationsForDocument(supabase, organizationId, documentId);
  if (paid > 0.009) return true;

  const { count, error } = await supabase
    .from("teller_payments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("document_id", documentId)
    .eq("status", "posted");

  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export type AllocationBackfillRow = {
  paymentId: string;
  documentId: string;
  amount: number;
  allocationKind: AllocationKind;
  action: "insert" | "skip" | "flag";
  reason?: string;
};

export async function backfillPaymentAllocations(
  supabase: SupabaseClient,
  organizationId: string,
  options: { apply?: boolean } = {},
): Promise<{ rows: AllocationBackfillRow[]; inserted: number; skipped: number; flagged: number }> {
  const { data: payments, error } = await supabase
    .from("teller_payments")
    .select("id, document_id, amount, status, payment_type")
    .eq("organization_id", organizationId)
    .eq("status", "posted")
    .not("document_id", "is", null);

  if (error) throw new Error(error.message);

  const rows: AllocationBackfillRow[] = [];
  let inserted = 0;
  let skipped = 0;
  let flagged = 0;

  for (const payment of payments ?? []) {
    const documentId = payment.document_id as string;
    const paymentId = payment.id as string;
    const amount = roundMoney(asNumber(payment.amount));

    const { data: doc } = await supabase
      .from("teller_documents")
      .select("kind")
      .eq("organization_id", organizationId)
      .eq("id", documentId)
      .maybeSingle();

    if (!doc) {
      rows.push({
        paymentId,
        documentId,
        amount,
        allocationKind: "invoice_payment",
        action: "flag",
        reason: "missing_document",
      });
      flagged += 1;
      continue;
    }

    const allocationKind = allocationKindForDocumentKind(doc.kind as string);

    const { data: existing } = await supabase
      .from("teller_payment_allocations")
      .select("id")
      .eq("payment_id", paymentId)
      .eq("document_id", documentId)
      .eq("allocation_kind", allocationKind)
      .maybeSingle();

    if (existing?.id) {
      rows.push({ paymentId, documentId, amount, allocationKind, action: "skip", reason: "exists" });
      skipped += 1;
      continue;
    }

    const allocatedOnPayment = await sumAllocationsForPayment(
      supabase,
      organizationId,
      paymentId,
    );
    if (allocatedOnPayment + amount > roundMoney(asNumber(payment.amount)) + 0.009) {
      rows.push({
        paymentId,
        documentId,
        amount,
        allocationKind,
        action: "flag",
        reason: "allocation_exceeds_payment",
      });
      flagged += 1;
      continue;
    }

    if (options.apply) {
      await recordPaymentAllocation(supabase, {
        organizationId,
        paymentId,
        documentId,
        amount,
        allocationKind,
      });
      inserted += 1;
      rows.push({ paymentId, documentId, amount, allocationKind, action: "insert" });
    } else {
      rows.push({ paymentId, documentId, amount, allocationKind, action: "insert" });
      inserted += 1;
    }
  }

  return { rows, inserted, skipped, flagged };
}
