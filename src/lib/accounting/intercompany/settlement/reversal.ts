import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../../audit";
import { assertIntercompanyAccess } from "../validation";

export async function reverseIntercompanySettlement(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    settlementId: string;
    reversalDate: string;
    memo?: string;
    actorId?: string | null;
    auth?: { userId: string; role: import("@/types").ProfileRole };
  },
) {
  const { data: settlement, error: loadError } = await supabase
    .from("teller_intercompany_settlements")
    .select(
      "id, status, payer_legal_entity_id, payee_legal_entity_id, reversal_settlement_id",
    )
    .eq("organization_id", input.organizationId)
    .eq("id", input.settlementId)
    .maybeSingle();

  if (loadError) throw new Error(loadError.message);
  if (!settlement?.id) throw new Error("Intercompany settlement not found");

  if (settlement.status === "reversed" && settlement.reversal_settlement_id) {
    return {
      duplicate: true,
      reversalSettlementId: settlement.reversal_settlement_id as string,
    };
  }

  if (input.auth) {
    await assertIntercompanyAccess(supabase, {
      organizationId: input.organizationId,
      sourceLegalEntityId: settlement.payer_legal_entity_id as string,
      counterpartyLegalEntityId: settlement.payee_legal_entity_id as string,
      auth: input.auth,
    });
  }

  const { data, error } = await supabase.rpc("teller_atomic_reverse_intercompany_settlement", {
    p_organization_id: input.organizationId,
    p_settlement_id: input.settlementId,
    p_reversal_date: input.reversalDate,
    p_memo: input.memo ?? "Intercompany settlement reversal",
    p_actor_id: input.actorId ?? null,
    p_simulate_failure_after: null,
  });

  if (error) throw new Error(error.message);

  const result = data as {
    duplicate: boolean;
    reversal_settlement_id: string;
    payer_reversal_journal_id?: string;
    payee_reversal_journal_id?: string;
  };

  if (!result.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "intercompany.settlement.reversed",
      resourceKind: "intercompany_settlement",
      resourceId: input.settlementId,
      metadata: {
        reversalSettlementId: result.reversal_settlement_id,
      },
    });
  }

  return {
    duplicate: result.duplicate,
    reversalSettlementId: result.reversal_settlement_id,
    payerReversalJournalId: result.payer_reversal_journal_id,
    payeeReversalJournalId: result.payee_reversal_journal_id,
  };
}
