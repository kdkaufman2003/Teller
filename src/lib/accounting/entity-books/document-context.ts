import type { SupabaseClient } from "@supabase/supabase-js";
import { nextNumber } from "../accounts";

async function resolveDefaultLegalEntityId(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("teller_default_legal_entity_id", {
    p_org_id: organizationId,
  });
  if (error || !data) {
    throw new Error(error?.message || "Default legal entity missing for organization");
  }
  return data as string;
}

export async function loadDocumentLegalEntityId(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
  },
): Promise<string> {
  const { data, error } = await supabase
    .from("teller_documents")
    .select("id, legal_entity_id")
    .eq("id", input.documentId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error("Document not found");
  if (!data.legal_entity_id) {
    throw new Error("Document is missing legal entity ownership");
  }
  return data.legal_entity_id as string;
}

export async function resolvePostingLegalEntityId(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId?: string | null;
    legalEntityId?: string | null;
  },
): Promise<string> {
  if (input.documentId?.trim()) {
    return loadDocumentLegalEntityId(supabase, {
      organizationId: input.organizationId,
      documentId: input.documentId.trim(),
    });
  }
  if (input.legalEntityId?.trim()) return input.legalEntityId.trim();
  return resolveDefaultLegalEntityId(supabase, input.organizationId);
}

export async function nextEntityDocumentNumber(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    kind: string;
    prefix: string;
  },
): Promise<string> {
  const { data, error } = await supabase
    .from("teller_documents")
    .select("number")
    .eq("organization_id", input.organizationId)
    .eq("legal_entity_id", input.legalEntityId)
    .eq("kind", input.kind);
  if (error) throw new Error(error.message);
  return nextNumber(
    input.prefix,
    (data ?? []).map((row) => row.number as string),
  );
}
