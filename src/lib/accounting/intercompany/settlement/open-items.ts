import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntercompanyOpenItem } from "./types";

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

export async function listIntercompanyOpenItems(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entityAId: string;
    entityBId: string;
    asOf?: string;
  },
): Promise<IntercompanyOpenItem[]> {
  const { data, error } = await supabase.rpc("teller_intercompany_open_items", {
    p_organization_id: input.organizationId,
    p_entity_a_id: input.entityAId,
    p_entity_b_id: input.entityBId,
    p_as_of: input.asOf ?? new Date().toISOString().slice(0, 10),
  });

  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(mapOpenItem);
}

export async function getIntercompanyTransactionOpenBalance(
  supabase: SupabaseClient,
  intercompanyTransactionId: string,
  asOf?: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("teller_intercompany_tx_open_balance", {
    p_intercompany_transaction_id: intercompanyTransactionId,
    p_as_of: asOf ?? null,
  });

  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}
