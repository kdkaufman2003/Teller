import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntercompanyOpenItem, SettlementAllocationInput } from "./types";

/**
 * Deterministic oldest-first auto-apply. Never over-applies.
 * User must review allocations before posting — not applied silently after post.
 */
export async function autoApplySettlementAllocations(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    payerLegalEntityId: string;
    payeeLegalEntityId: string;
    amount: number;
    asOf?: string;
  },
): Promise<SettlementAllocationInput[]> {
  const { data, error } = await supabase.rpc("teller_intercompany_open_items", {
    p_organization_id: input.organizationId,
    p_entity_a_id: input.payerLegalEntityId,
    p_entity_b_id: input.payeeLegalEntityId,
    p_as_of: input.asOf ?? new Date().toISOString().slice(0, 10),
  });

  if (error) throw new Error(error.message);

  const items = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
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
  })) as IntercompanyOpenItem[];
  let remaining = input.amount;
  const allocations: SettlementAllocationInput[] = [];

  for (const item of items) {
    if (remaining <= 0.009) break;
    const apply = Math.min(remaining, item.remainingAmount);
    if (apply <= 0.009) continue;
    allocations.push({
      intercompanyTransactionId: item.intercompanyTransactionId,
      amountApplied: apply,
    });
    remaining -= apply;
  }

  if (remaining > 0.009) {
    throw new Error("Settlement amount exceeds total open intercompany balance for this pair");
  }

  return allocations;
}

export function assertAllocationSumMatchesAmount(
  allocations: SettlementAllocationInput[],
  amount: number,
): void {
  const sum = allocations.reduce((total, row) => total + row.amountApplied, 0);
  if (Math.abs(sum - amount) > 0.009) {
    throw new Error("Settlement amount must equal the sum of allocations");
  }
  if (allocations.some((row) => row.amountApplied <= 0)) {
    throw new Error("Each allocation must be positive");
  }
}
