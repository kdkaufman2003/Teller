import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAccountsBelongToEntity } from "./validation";

export const ENTITY_METADATA_KEYS = {
  inventoryMappings: "inventoryAccountMappings",
  salesTaxPayableAccountId: "salesTaxPayableAccountId",
  useTaxExpenseAccountId: "useTaxExpenseAccountId",
} as const;

export type EntityAccountingSettings = {
  organizationId: string;
  legalEntityId: string;
  fiscalYearStartMonth: number;
  accountingMethod: "accrual" | "cash";
  defaultCashAccountId: string | null;
  defaultArAccountId: string | null;
  defaultApAccountId: string | null;
  retainedEarningsAccountId: string | null;
  customerDepositsAccountId: string | null;
  metadata: Record<string, unknown>;
};

export async function loadEntityAccountingSettings(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId: string,
): Promise<EntityAccountingSettings | null> {
  const { data, error } = await supabase
    .from("teller_entity_accounting_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", legalEntityId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    organizationId,
    legalEntityId,
    fiscalYearStartMonth: Number(data.fiscal_year_start_month ?? 1),
    accountingMethod: (data.accounting_method as "accrual" | "cash") ?? "accrual",
    defaultCashAccountId: (data.default_cash_account_id as string | null) ?? null,
    defaultArAccountId: (data.default_ar_account_id as string | null) ?? null,
    defaultApAccountId: (data.default_ap_account_id as string | null) ?? null,
    retainedEarningsAccountId: (data.retained_earnings_account_id as string | null) ?? null,
    customerDepositsAccountId: (data.customer_deposits_account_id as string | null) ?? null,
    metadata: (data.metadata as Record<string, unknown>) ?? {},
  };
}

export async function upsertEntityAccountingSettings(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    patch: Partial<
      Pick<
        EntityAccountingSettings,
        | "fiscalYearStartMonth"
        | "accountingMethod"
        | "defaultCashAccountId"
        | "defaultArAccountId"
        | "defaultApAccountId"
        | "retainedEarningsAccountId"
        | "customerDepositsAccountId"
        | "metadata"
      >
    >;
  },
): Promise<EntityAccountingSettings> {
  await assertAccountsBelongToEntity(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.legalEntityId,
    accountIds: [
      input.patch.defaultCashAccountId,
      input.patch.defaultArAccountId,
      input.patch.defaultApAccountId,
      input.patch.retainedEarningsAccountId,
      input.patch.customerDepositsAccountId,
    ],
  });

  const existing = await loadEntityAccountingSettings(
    supabase,
    input.organizationId,
    input.legalEntityId,
  );
  const metadata = { ...(existing?.metadata ?? {}), ...(input.patch.metadata ?? {}) };

  const row = {
    organization_id: input.organizationId,
    legal_entity_id: input.legalEntityId,
    fiscal_year_start_month: input.patch.fiscalYearStartMonth ?? existing?.fiscalYearStartMonth ?? 1,
    accounting_method: input.patch.accountingMethod ?? existing?.accountingMethod ?? "accrual",
    default_cash_account_id:
      input.patch.defaultCashAccountId !== undefined
        ? input.patch.defaultCashAccountId
        : (existing?.defaultCashAccountId ?? null),
    default_ar_account_id:
      input.patch.defaultArAccountId !== undefined
        ? input.patch.defaultArAccountId
        : (existing?.defaultArAccountId ?? null),
    default_ap_account_id:
      input.patch.defaultApAccountId !== undefined
        ? input.patch.defaultApAccountId
        : (existing?.defaultApAccountId ?? null),
    retained_earnings_account_id:
      input.patch.retainedEarningsAccountId !== undefined
        ? input.patch.retainedEarningsAccountId
        : (existing?.retainedEarningsAccountId ?? null),
    customer_deposits_account_id:
      input.patch.customerDepositsAccountId !== undefined
        ? input.patch.customerDepositsAccountId
        : (existing?.customerDepositsAccountId ?? null),
    metadata,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("teller_entity_accounting_settings").upsert(row, {
    onConflict: "organization_id,legal_entity_id",
  });
  if (error) throw new Error(error.message);

  return (await loadEntityAccountingSettings(
    supabase,
    input.organizationId,
    input.legalEntityId,
  ))!;
}

export async function upsertEntityMetadataAccountRefs(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    metadataPatch: Record<string, unknown>;
    accountIdsToValidate: Array<string | null | undefined>;
  },
): Promise<EntityAccountingSettings> {
  await assertAccountsBelongToEntity(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.legalEntityId,
    accountIds: input.accountIdsToValidate,
  });
  return upsertEntityAccountingSettings(supabase, {
    organizationId: input.organizationId,
    legalEntityId: input.legalEntityId,
    patch: { metadata: input.metadataPatch },
  });
}
