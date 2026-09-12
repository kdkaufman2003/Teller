import type { SupabaseClient } from "@supabase/supabase-js";

export async function assertAccountBelongsToEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    accountId: string;
  },
): Promise<void> {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, legal_entity_id")
    .eq("id", input.accountId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Account not found");
  if (data.legal_entity_id !== input.legalEntityId) {
    throw new Error("Default account must belong to the active legal entity");
  }
}

export async function assertAccountsBelongToEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    accountIds: Array<string | null | undefined>;
  },
): Promise<void> {
  for (const accountId of input.accountIds) {
    if (!accountId?.trim()) continue;
    await assertAccountBelongsToEntity(supabase, {
      organizationId: input.organizationId,
      legalEntityId: input.legalEntityId,
      accountId: accountId.trim(),
    });
  }
}

export async function assertDocumentBelongsToEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    documentId: string;
  },
): Promise<void> {
  const { data, error } = await supabase
    .from("teller_documents")
    .select("id, legal_entity_id")
    .eq("id", input.documentId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Document not found");
  if (data.legal_entity_id !== input.legalEntityId) {
    throw new Error("Cross-entity document access is not allowed");
  }
}

export async function assertPaymentDocumentSameEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    paymentLegalEntityId: string;
    documentId: string;
  },
): Promise<void> {
  await assertDocumentBelongsToEntity(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.paymentLegalEntityId,
    documentId: input.documentId,
  });
}
