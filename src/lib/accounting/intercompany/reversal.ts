import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../audit";
import { assertIntercompanyAccess } from "./validation";

export async function reverseIntercompanyTransaction(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    intercompanyTransactionId: string;
    reversalDate: string;
    memo?: string;
    actorId?: string | null;
    auth?: { userId: string; role: import("@/types").ProfileRole };
  },
) {
  const { data: tx, error: loadError } = await supabase
    .from("teller_intercompany_transactions")
    .select(
      "id, status, source_legal_entity_id, counterparty_legal_entity_id, source_journal_id, counterparty_journal_id",
    )
    .eq("organization_id", input.organizationId)
    .eq("id", input.intercompanyTransactionId)
    .maybeSingle();

  if (loadError) throw new Error(loadError.message);
  if (!tx?.id) throw new Error("Intercompany transaction not found");
  if (tx.status === "reversed") {
    const { data: reversalRow, error: reversalError } = await supabase
      .from("teller_intercompany_transactions")
      .select("id, source_journal_id, counterparty_journal_id")
      .eq("organization_id", input.organizationId)
      .eq("reverses_transaction_id", input.intercompanyTransactionId)
      .eq("status", "posted")
      .maybeSingle();
    if (reversalError) throw new Error(reversalError.message);
    if (!reversalRow?.id) {
      throw new Error("Intercompany transaction is already reversed");
    }
    return {
      duplicate: true,
      reversalTransactionId: reversalRow.id,
      sourceReversalJournalId: reversalRow.source_journal_id as string,
      counterpartyReversalJournalId: reversalRow.counterparty_journal_id as string,
      originalTransactionId: input.intercompanyTransactionId,
    };
  }

  if (input.auth) {
    await assertIntercompanyAccess(supabase, {
      organizationId: input.organizationId,
      sourceLegalEntityId: tx.source_legal_entity_id,
      counterpartyLegalEntityId: tx.counterparty_legal_entity_id,
      auth: input.auth,
    });
  }

  const { data, error } = await supabase.rpc("teller_atomic_reverse_intercompany", {
    p_organization_id: input.organizationId,
    p_intercompany_transaction_id: input.intercompanyTransactionId,
    p_reversal_date: input.reversalDate,
    p_memo: input.memo ?? "Intercompany reversal",
    p_actor_id: input.actorId ?? null,
    p_simulate_failure_after: null,
  });

  if (error) throw new Error(error.message);

  const result = data as {
    duplicate: boolean;
    reversal_transaction_id: string;
    source_reversal_journal_id: string;
    counterparty_reversal_journal_id: string;
    original_transaction_id: string;
  };

  if (!result.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "intercompany.reversed",
      resourceKind: "intercompany_transaction",
      resourceId: input.intercompanyTransactionId,
      metadata: {
        reversalTransactionId: result.reversal_transaction_id,
        sourceReversalJournalId: result.source_reversal_journal_id,
        counterpartyReversalJournalId: result.counterparty_reversal_journal_id,
      },
    });
  }

  return {
    duplicate: result.duplicate,
    reversalTransactionId: result.reversal_transaction_id,
    sourceReversalJournalId: result.source_reversal_journal_id,
    counterpartyReversalJournalId: result.counterparty_reversal_journal_id,
    originalTransactionId: result.original_transaction_id,
  };
}
