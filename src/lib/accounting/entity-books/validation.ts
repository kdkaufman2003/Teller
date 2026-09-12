import type { SupabaseClient } from "@supabase/supabase-js";
import { EntityControlError, ENTITY_CONTROL_MESSAGES } from "./errors";

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
    throw new EntityControlError(ENTITY_CONTROL_MESSAGES.accountWrongEntity);
  }
}

export async function assertPaymentBelongsToEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    paymentId: string;
  },
): Promise<void> {
  const { data, error } = await supabase
    .from("teller_payments")
    .select("id, legal_entity_id")
    .eq("id", input.paymentId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Payment not found");
  if (data.legal_entity_id !== input.legalEntityId) {
    throw new EntityControlError(ENTITY_CONTROL_MESSAGES.paymentWrongEntity);
  }
}

export async function assertBankAccountBelongsToEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    bankAccountId: string;
  },
): Promise<void> {
  const { data, error } = await supabase
    .from("teller_bank_accounts")
    .select("id, legal_entity_id")
    .eq("id", input.bankAccountId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Bank account not found");
  if (data.legal_entity_id !== input.legalEntityId) {
    throw new EntityControlError(ENTITY_CONTROL_MESSAGES.bankAccountWrongEntity);
  }
}

export async function assertAllocationSameEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    paymentId: string;
    documentId: string;
  },
): Promise<void> {
  const [{ data: payment }, { data: document }] = await Promise.all([
    supabase
      .from("teller_payments")
      .select("id, legal_entity_id")
      .eq("id", input.paymentId)
      .eq("organization_id", input.organizationId)
      .maybeSingle(),
    supabase
      .from("teller_documents")
      .select("id, legal_entity_id")
      .eq("id", input.documentId)
      .eq("organization_id", input.organizationId)
      .maybeSingle(),
  ]);
  if (!payment?.id) throw new Error("Payment not found");
  if (!document?.id) throw new Error("Document not found");
  if (payment.legal_entity_id !== document.legal_entity_id) {
    throw new EntityControlError(ENTITY_CONTROL_MESSAGES.crossEntityAllocation);
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
    throw new EntityControlError(ENTITY_CONTROL_MESSAGES.documentWrongEntity);
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
