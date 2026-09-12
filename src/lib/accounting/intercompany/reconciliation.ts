import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntercompanyPairBalance } from "./types";

export async function getIntercompanyPairBalance(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entityAId: string;
    entityBId: string;
    asOf?: string;
  },
): Promise<IntercompanyPairBalance> {
  const { data, error } = await supabase.rpc("teller_intercompany_pair_balances", {
    p_organization_id: input.organizationId,
    p_entity_a_id: input.entityAId,
    p_entity_b_id: input.entityBId,
    p_as_of: input.asOf ?? new Date().toISOString().slice(0, 10),
  });

  if (error || !data) {
    throw new Error(error?.message || "Could not compute intercompany pair balance");
  }

  const row = data as {
    entity_a_id: string;
    entity_b_id: string;
    a_due_from_b: number;
    a_due_to_b: number;
    b_due_from_a: number;
    b_due_to_a: number;
    receivable_payable_difference: number;
    payable_receivable_difference: number;
    balanced: boolean;
  };

  return {
    entityAId: row.entity_a_id,
    entityBId: row.entity_b_id,
    aDueFromB: Number(row.a_due_from_b),
    aDueToB: Number(row.a_due_to_b),
    bDueFromA: Number(row.b_due_from_a),
    bDueToA: Number(row.b_due_to_a),
    receivablePayableDifference: Number(row.receivable_payable_difference),
    payableReceivableDifference: Number(row.payable_receivable_difference),
    balanced: Boolean(row.balanced),
  };
}

export async function listIntercompanyTransactions(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId?: string | null;
    limit?: number;
  },
) {
  let query = supabase
    .from("teller_intercompany_transactions")
    .select(
      "id, organization_id, source_legal_entity_id, counterparty_legal_entity_id, transaction_type, transaction_date, description, reference, amount, currency, status, source_journal_id, counterparty_journal_id, reversal_transaction_id, reverses_transaction_id, created_at, reversed_at",
    )
    .eq("organization_id", input.organizationId)
    .in("status", ["posted", "reversed"])
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 50);

  if (input.legalEntityId) {
    query = query.or(
      `source_legal_entity_id.eq.${input.legalEntityId},counterparty_legal_entity_id.eq.${input.legalEntityId}`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}
