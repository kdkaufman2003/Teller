import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";

export type DocumentAllocationKind = "customer_credit_apply" | "vendor_credit_apply";

const SOURCE_KIND_MAP: Record<string, DocumentAllocationKind> = {
  credit_memo: "customer_credit_apply",
  vendor_credit: "vendor_credit_apply",
};

const TARGET_KIND_MAP: Record<string, DocumentAllocationKind> = {
  invoice: "customer_credit_apply",
  bill: "vendor_credit_apply",
};

const ACTIVE_DOCUMENT_ALLOCATION_KINDS = new Set<DocumentAllocationKind>([
  "customer_credit_apply",
  "vendor_credit_apply",
]);

type DocumentAllocationRow = {
  amount: unknown;
  reversed_by_allocation_id?: string | null;
  reversal_of_allocation_id?: string | null;
  allocation_kind?: string | null;
};

/** Original credit application is active iff no immutable reversal row references it. */
export function isActiveDocumentAllocationRow(row: DocumentAllocationRow): boolean {
  if (row.reversal_of_allocation_id) return false;
  if (row.reversed_by_allocation_id) return false;
  const kind = row.allocation_kind ?? "";
  if (kind.endsWith("_reversal")) return false;
  return ACTIVE_DOCUMENT_ALLOCATION_KINDS.has(kind as DocumentAllocationKind);
}

export function documentAllocationKind(
  sourceKind: string,
  targetKind: string,
): DocumentAllocationKind {
  const fromSource = SOURCE_KIND_MAP[sourceKind];
  const fromTarget = TARGET_KIND_MAP[targetKind];
  if (!fromSource || fromSource !== fromTarget) {
    throw new Error(`Cannot apply ${sourceKind} to ${targetKind}`);
  }
  return fromSource;
}

export async function recordDocumentAllocation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    sourceDocumentId: string;
    targetDocumentId: string;
    amount: number;
    allocationKind: DocumentAllocationKind;
  },
): Promise<string> {
  const amount = roundMoney(asNumber(input.amount));
  if (amount <= 0.009) {
    throw new Error("Credit application amount must be greater than zero.");
  }

  const { data, error } = await supabase
    .from("teller_document_allocations")
    .insert({
      organization_id: input.organizationId,
      source_document_id: input.sourceDocumentId,
      target_document_id: input.targetDocumentId,
      amount,
      allocation_kind: input.allocationKind,
    })
    .select("id")
    .single();

  if (error) {
    if (error.message.includes("duplicate")) {
      const { data: existing } = await supabase
        .from("teller_document_allocations")
        .select("id")
        .eq("source_document_id", input.sourceDocumentId)
        .eq("target_document_id", input.targetDocumentId)
        .eq("allocation_kind", input.allocationKind)
        .maybeSingle();
      if (existing?.id) return existing.id as string;
    }
    throw new Error(error.message);
  }

  return data!.id as string;
}

export async function sumCreditsAppliedToDocument(
  supabase: SupabaseClient,
  organizationId: string,
  targetDocumentId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_document_allocations")
    .select("amount, reversed_by_allocation_id, reversal_of_allocation_id, allocation_kind")
    .eq("organization_id", organizationId)
    .eq("target_document_id", targetDocumentId);

  if (error) throw new Error(error.message);
  return roundMoney(
    (data ?? [])
      .filter((row) => isActiveDocumentAllocationRow(row))
      .reduce((sum, row) => sum + asNumber(row.amount), 0),
  );
}

export async function sumCreditsAppliedFromDocument(
  supabase: SupabaseClient,
  organizationId: string,
  sourceDocumentId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_document_allocations")
    .select("amount, reversed_by_allocation_id, reversal_of_allocation_id, allocation_kind")
    .eq("organization_id", organizationId)
    .eq("source_document_id", sourceDocumentId);

  if (error) throw new Error(error.message);
  return roundMoney(
    (data ?? [])
      .filter((row) => isActiveDocumentAllocationRow(row))
      .reduce((sum, row) => sum + asNumber(row.amount), 0),
  );
}

export async function documentHasAppliedCredits(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
  asSource: boolean,
): Promise<boolean> {
  const column = asSource ? "source_document_id" : "target_document_id";
  const { count, error } = await supabase
    .from("teller_document_allocations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq(column, documentId);

  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export async function batchCreditsAppliedToDocuments(
  supabase: SupabaseClient,
  organizationId: string,
  documentIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!documentIds.length) return result;
  for (const id of documentIds) result.set(id, 0);

  const { data, error } = await supabase
    .from("teller_document_allocations")
    .select(
      "target_document_id, amount, reversed_by_allocation_id, reversal_of_allocation_id, allocation_kind",
    )
    .eq("organization_id", organizationId)
    .in("target_document_id", documentIds);

  if (error) throw new Error(error.message);

  for (const row of data ?? []) {
    if (!isActiveDocumentAllocationRow(row)) continue;
    const id = row.target_document_id as string;
    result.set(id, roundMoney((result.get(id) ?? 0) + asNumber(row.amount)));
  }

  return result;
}

/** Batch credit-applied amounts keyed by source (credit) document id. */
export async function batchCreditsAppliedFromDocuments(
  supabase: SupabaseClient,
  organizationId: string,
  documentIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!documentIds.length) return result;
  for (const id of documentIds) result.set(id, 0);

  const { data, error } = await supabase
    .from("teller_document_allocations")
    .select(
      "source_document_id, amount, reversed_by_allocation_id, reversal_of_allocation_id, allocation_kind",
    )
    .eq("organization_id", organizationId)
    .in("source_document_id", documentIds);

  if (error) throw new Error(error.message);

  for (const row of data ?? []) {
    if (!isActiveDocumentAllocationRow(row)) continue;
    const id = row.source_document_id as string;
    result.set(id, roundMoney((result.get(id) ?? 0) + asNumber(row.amount)));
  }

  return result;
}
