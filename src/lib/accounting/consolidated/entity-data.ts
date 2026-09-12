import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEntityJournalLines } from "../trial-balance";
import type { AccountRow } from "../reports";

export async function loadEntityAccounts(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId: string,
): Promise<Array<AccountRow & { subtype?: string | null }>> {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", legalEntityId)
    .order("code");
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<AccountRow & { subtype?: string | null }>;
}

export async function loadEntityDatedLines(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    endDate: string;
  },
) {
  return loadEntityJournalLines(
    supabase,
    input.organizationId,
    input.legalEntityId,
    input.endDate.slice(0, 10),
    null,
  );
}
