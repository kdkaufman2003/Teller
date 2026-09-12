import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntercompanyAccountPair } from "./types";

export async function provisionIntercompanyAccounts(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    ownerLegalEntityId: string;
    counterpartyLegalEntityId: string;
  },
): Promise<IntercompanyAccountPair> {
  if (input.ownerLegalEntityId === input.counterpartyLegalEntityId) {
    throw new Error("Intercompany accounts require distinct legal entities");
  }

  const { data, error } = await supabase.rpc("teller_provision_intercompany_accounts", {
    p_organization_id: input.organizationId,
    p_owner_entity_id: input.ownerLegalEntityId,
    p_counterparty_entity_id: input.counterpartyLegalEntityId,
  });

  if (error || !data) {
    throw new Error(error?.message || "Could not provision intercompany accounts");
  }

  const row = data as {
    due_from_account_id: string | null;
    due_to_account_id: string | null;
    provisioned?: boolean;
  };

  let dueFromAccountId = row.due_from_account_id;
  let dueToAccountId = row.due_to_account_id;

  if (!dueFromAccountId || !dueToAccountId) {
    const { data: pair, error: pairError } = await supabase
      .from("teller_intercompany_account_pairs")
      .select("due_from_account_id, due_to_account_id")
      .eq("owner_legal_entity_id", input.ownerLegalEntityId)
      .eq("counterparty_legal_entity_id", input.counterpartyLegalEntityId)
      .maybeSingle();
    if (pairError) throw new Error(pairError.message);
    dueFromAccountId = pair?.due_from_account_id ?? null;
    dueToAccountId = pair?.due_to_account_id ?? null;
  }

  if (!dueFromAccountId || !dueToAccountId) {
    throw new Error("Could not resolve intercompany due-to/due-from accounts");
  }

  return {
    dueFromAccountId,
    dueToAccountId,
    provisioned: Boolean(row.provisioned),
  };
}
