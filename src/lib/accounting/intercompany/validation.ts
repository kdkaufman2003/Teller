import type { SupabaseClient } from "@supabase/supabase-js";
import { assertEntityAccess, type EntityAuthContext } from "../legal-entity/access";
import { assertAccountsBelongToEntity } from "../entity-books/validation";

export async function assertIntercompanyEntityPair(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    sourceLegalEntityId: string;
    counterpartyLegalEntityId: string;
  },
): Promise<void> {
  if (input.sourceLegalEntityId === input.counterpartyLegalEntityId) {
    throw new Error("Intercompany transactions require two different companies");
  }

  const { data: entities, error } = await supabase
    .from("teller_legal_entities")
    .select("id, organization_id, is_active")
    .eq("organization_id", input.organizationId)
    .in("id", [input.sourceLegalEntityId, input.counterpartyLegalEntityId]);

  if (error) throw new Error(error.message);
  if ((entities?.length ?? 0) !== 2) {
    throw new Error("Both companies must belong to your organization");
  }
  if (entities?.some((e) => !e.is_active)) {
    throw new Error("Inactive companies cannot participate in intercompany transactions");
  }
}

export async function assertIntercompanyAccess(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    sourceLegalEntityId: string;
    counterpartyLegalEntityId: string;
    auth: EntityAuthContext;
  },
): Promise<void> {
  await assertEntityAccess(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.sourceLegalEntityId,
    auth: input.auth,
  });
  await assertEntityAccess(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.counterpartyLegalEntityId,
    auth: input.auth,
  });
}

export async function assertIntercompanyLineAccounts(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    accountIds: Array<string | null | undefined>;
  },
): Promise<void> {
  await assertAccountsBelongToEntity(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.legalEntityId,
    accountIds: input.accountIds,
  });
}
