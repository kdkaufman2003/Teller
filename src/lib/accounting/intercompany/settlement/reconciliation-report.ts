import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntercompanyOpenItem, IntercompanyPairReconciliation } from "./types";

function mapOpenItem(row: Record<string, unknown>): IntercompanyOpenItem {
  return {
    intercompanyTransactionId: String(row.intercompany_transaction_id),
    transactionDate: String(row.transaction_date),
    transactionType: String(row.transaction_type),
    reference: (row.reference as string | null) ?? null,
    description: String(row.description ?? ""),
    originalAmount: Number(row.original_amount),
    settledAmount: Number(row.settled_amount),
    remainingAmount: Number(row.remaining_amount),
    sourceLegalEntityId: String(row.source_legal_entity_id),
    counterpartyLegalEntityId: String(row.counterparty_legal_entity_id),
    sourceJournalId: (row.source_journal_id as string | null) ?? null,
    counterpartyJournalId: (row.counterparty_journal_id as string | null) ?? null,
    status: String(row.status ?? "open"),
  };
}

export async function getIntercompanyPairReconciliation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entityAId: string;
    entityBId: string;
    asOf?: string;
  },
): Promise<IntercompanyPairReconciliation> {
  const { data, error } = await supabase.rpc("teller_intercompany_pair_reconciliation", {
    p_organization_id: input.organizationId,
    p_entity_a_id: input.entityAId,
    p_entity_b_id: input.entityBId,
    p_as_of: input.asOf ?? new Date().toISOString().slice(0, 10),
  });

  if (error || !data) {
    throw new Error(error?.message || "Could not compute intercompany reconciliation");
  }

  const row = data as Record<string, unknown>;
  return {
    entityAId: String(row.entity_a_id),
    entityBId: String(row.entity_b_id),
    asOf: String(row.as_of),
    aDueFromB: Number(row.a_due_from_b),
    aDueToB: Number(row.a_due_to_b),
    bDueFromA: Number(row.b_due_from_a),
    bDueToA: Number(row.b_due_to_a),
    receivablePayableDifference: Number(row.receivable_payable_difference),
    payableReceivableDifference: Number(row.payable_receivable_difference),
    netAOwesB: Number(row.net_a_owes_b),
    netBOwesA: Number(row.net_b_owes_a),
    balanced: Boolean(row.balanced),
    openBalance: Number(row.open_balance),
    settledDuringPeriod: Number(row.settled_during_period),
    openItemsCount: Number(row.open_items_count),
    openItems: ((row.open_items ?? []) as Record<string, unknown>[]).map(mapOpenItem),
    lastActivity: (row.last_activity as string | null) ?? null,
    status: row.status as IntercompanyPairReconciliation["status"],
  };
}

export async function listIntercompanySettlements(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId?: string | null;
    limit?: number;
  },
) {
  let query = supabase
    .from("teller_intercompany_settlements")
    .select(
      "id, organization_id, payer_legal_entity_id, payee_legal_entity_id, settlement_date, amount, currency, status, settlement_mode, payer_journal_id, payee_journal_id, reference, memo, idempotency_key, created_at, posted_at, reversal_settlement_id, reversed_at",
    )
    .eq("organization_id", input.organizationId)
    .in("status", ["posted", "partially_reconciled", "reconciled", "reversed"])
    .order("settlement_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 50);

  if (input.legalEntityId) {
    query = query.or(
      `payer_legal_entity_id.eq.${input.legalEntityId},payee_legal_entity_id.eq.${input.legalEntityId}`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}
