import type { SupabaseClient } from "@supabase/supabase-js";
import { generalPack } from "@/lib/industries/general";

export type CoaSetupMode = "standard" | "copy_structure";

export async function initializeEntityCoa(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    mode: CoaSetupMode;
    sourceLegalEntityId?: string | null;
  },
): Promise<{ accountsCreated: number }> {
  const { count: existingCount, error: countError } = await supabase
    .from("teller_accounts")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", input.organizationId)
    .eq("legal_entity_id", input.legalEntityId);
  if (countError) throw new Error(countError.message);
  if ((existingCount ?? 0) > 0) {
    throw new Error("Legal entity already has a chart of accounts");
  }

  if (input.mode === "standard") {
    const templateAccounts = generalPack.resolve({}).accounts;
    const rows = templateAccounts.map((account) => ({
      organization_id: input.organizationId,
      legal_entity_id: input.legalEntityId,
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype ?? "",
      industry_tag: account.industryTag ?? "",
      is_system: true,
    }));
    const { error } = await supabase.from("teller_accounts").insert(rows);
    if (error) throw new Error(error.message);
    return { accountsCreated: rows.length };
  }

  if (!input.sourceLegalEntityId?.trim()) {
    throw new Error("sourceLegalEntityId is required to copy COA structure");
  }
  if (input.sourceLegalEntityId === input.legalEntityId) {
    throw new Error("Cannot copy COA structure from the same legal entity");
  }

  const { data: sourceAccounts, error: sourceError } = await supabase
    .from("teller_accounts")
    .select("code, name, type, subtype, industry_tag, is_system, cash_flow_category")
    .eq("organization_id", input.organizationId)
    .eq("legal_entity_id", input.sourceLegalEntityId)
    .eq("archived", false);
  if (sourceError) throw new Error(sourceError.message);
  if (!sourceAccounts?.length) throw new Error("Source entity has no accounts to copy");

  const rows = sourceAccounts.map((account) => ({
    organization_id: input.organizationId,
    legal_entity_id: input.legalEntityId,
    code: account.code as string,
    name: account.name as string,
    type: account.type as string,
    subtype: (account.subtype as string) ?? "",
    industry_tag: (account.industry_tag as string) ?? "",
    is_system: Boolean(account.is_system),
    cash_flow_category: (account.cash_flow_category as string | null) ?? null,
  }));

  const { error: insertError } = await supabase.from("teller_accounts").insert(rows);
  if (insertError) throw new Error(insertError.message);

  return { accountsCreated: rows.length };
}
