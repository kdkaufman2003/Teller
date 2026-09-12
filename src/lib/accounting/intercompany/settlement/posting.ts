import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../../audit";
import { assertIntercompanyAccess, assertIntercompanyEntityPair } from "../validation";
import { assertAllocationSumMatchesAmount } from "./allocation";
import type { PostIntercompanySettlementInput } from "./types";

function rpcAllocations(allocations: PostIntercompanySettlementInput["allocations"]) {
  return allocations.map((row) => ({
    intercompany_transaction_id: row.intercompanyTransactionId,
    amount_applied: row.amountApplied,
  }));
}

export async function postIntercompanySettlement(
  supabase: SupabaseClient,
  input: PostIntercompanySettlementInput & {
    auth?: { userId: string; role: import("@/types").ProfileRole };
  },
) {
  await assertIntercompanyEntityPair(supabase, {
    organizationId: input.organizationId,
    sourceLegalEntityId: input.payerLegalEntityId,
    counterpartyLegalEntityId: input.payeeLegalEntityId,
  });

  if (input.auth) {
    await assertIntercompanyAccess(supabase, {
      organizationId: input.organizationId,
      sourceLegalEntityId: input.payerLegalEntityId,
      counterpartyLegalEntityId: input.payeeLegalEntityId,
      auth: input.auth,
    });
  }

  assertAllocationSumMatchesAmount(input.allocations, input.amount);

  const { data, error } = await supabase.rpc("teller_atomic_post_intercompany_settlement", {
    p_organization_id: input.organizationId,
    p_payer_legal_entity_id: input.payerLegalEntityId,
    p_payee_legal_entity_id: input.payeeLegalEntityId,
    p_settlement_date: input.settlementDate,
    p_amount: input.amount,
    p_reference: input.reference ?? null,
    p_memo: input.memo ?? "Intercompany settlement",
    p_allocations: rpcAllocations(input.allocations),
    p_payer_bank_account_id: input.payerBankAccountId ?? null,
    p_payee_bank_account_id: input.payeeBankAccountId ?? null,
    p_settlement_mode: input.settlementMode ?? "itemized",
    p_idempotency_key: input.idempotencyKey ?? null,
    p_metadata: {},
    p_actor_id: input.actorId ?? null,
    p_simulate_failure_after: null,
  });

  if (error) throw new Error(error.message);

  const result = data as {
    duplicate: boolean;
    settlement_id: string;
    payer_journal_id: string;
    payee_journal_id: string;
  };

  if (!result.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "intercompany.settlement.posted",
      resourceKind: "intercompany_settlement",
      resourceId: result.settlement_id,
      metadata: {
        payerLegalEntityId: input.payerLegalEntityId,
        payeeLegalEntityId: input.payeeLegalEntityId,
        amount: input.amount,
        allocationCount: input.allocations.length,
        payerJournalId: result.payer_journal_id,
        payeeJournalId: result.payee_journal_id,
      },
    });
  }

  return {
    duplicate: result.duplicate,
    settlementId: result.settlement_id,
    payerJournalId: result.payer_journal_id,
    payeeJournalId: result.payee_journal_id,
  };
}
