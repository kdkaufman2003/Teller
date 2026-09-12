import type { SupabaseClient } from "@supabase/supabase-js";

export type AccountingStateVersions = {
  accountingVersion: number;
  closeStateVersion: number;
};

export class AccountingStateChangedError extends Error {
  constructor() {
    super("ACCOUNTING_STATE_CHANGED");
    this.name = "AccountingStateChangedError";
  }
}

export async function loadAccountingStateVersions(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId?: string | null,
): Promise<AccountingStateVersions> {
  const { data, error } = await supabase.rpc("teller_get_accounting_state", {
    p_org: organizationId,
    p_legal_entity_id: legalEntityId ?? null,
  });
  if (error) {
    let entityId = legalEntityId?.trim() ?? "";
    if (!entityId) {
      const { data: defaultEntity, error: defaultError } = await supabase.rpc(
        "teller_default_legal_entity_id",
        { p_org_id: organizationId },
      );
      if (defaultError || !defaultEntity) {
        throw new Error(defaultError?.message || "Default legal entity missing");
      }
      entityId = defaultEntity as string;
    }
    const { data: row, error: rowError } = await supabase
      .from("teller_accounting_state_versions")
      .select("accounting_version, close_state_version")
      .eq("organization_id", organizationId)
      .eq("legal_entity_id", entityId)
      .maybeSingle();
    if (rowError) throw new Error(rowError.message);
    return {
      accountingVersion: Number(row?.accounting_version ?? 0),
      closeStateVersion: Number(row?.close_state_version ?? 0),
    };
  }

  const result = Array.isArray(data) ? data[0] : data;
  return {
    accountingVersion: Number(result?.accounting_version ?? 0),
    closeStateVersion: Number(result?.close_state_version ?? 0),
  };
}

export async function bumpCloseStateVersion(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("teller_increment_close_state_version", {
    p_org: organizationId,
    p_legal_entity_id: legalEntityId ?? null,
  });
  if (error) throw new Error(error.message);
}

export function isAccountingStateChangedError(error: unknown): boolean {
  if (error instanceof AccountingStateChangedError) return true;
  if (error instanceof Error) {
    return error.message.includes("ACCOUNTING_STATE_CHANGED");
  }
  return false;
}
