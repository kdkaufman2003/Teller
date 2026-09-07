import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { accountBySubtype } from "./accounts";
import {
  DEFAULT_FIXED_ASSET_CATEGORIES,
  FIXED_ASSET_SUBTYPES,
} from "./fixed-asset-accounts";
import type { AccountLookup } from "./fixed-asset-types";

export async function ensureFixedAssetSettings(
  supabase: SupabaseClient,
  organizationId: string,
) {
  const { data } = await supabase
    .from("teller_fixed_asset_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (data) return data;

  const { data: created, error } = await supabase
    .from("teller_fixed_asset_settings")
    .insert({ organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return created;
}

export async function loadFixedAssetSettings(supabase: SupabaseClient, organizationId: string) {
  return ensureFixedAssetSettings(supabase, organizationId);
}

export async function updateFixedAssetSettings(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    patch: {
      capitalization_threshold?: number | null;
      depreciation_convention?: string;
      rounding_policy?: string;
    };
    actorId?: string | null;
  },
) {
  await ensureFixedAssetSettings(supabase, input.organizationId);
  const { error } = await supabase
    .from("teller_fixed_asset_settings")
    .update({ ...input.patch, updated_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId);
  if (error) throw new Error(error.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "settings.updated",
    resourceKind: "fixed_asset_settings",
    resourceId: input.organizationId,
    metadata: input.patch,
  });
}

export async function seedDefaultFixedAssetCategories(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: AccountLookup[],
) {
  const asset = accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.fixedAsset);
  const accum = accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.accumulatedDepreciation);
  const expense = accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.depreciationExpense);
  const gain = accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.gainOnDisposal);
  const loss = accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.lossOnDisposal);

  for (const [index, row] of DEFAULT_FIXED_ASSET_CATEGORIES.entries()) {
    const { data: existing } = await supabase
      .from("teller_fixed_asset_categories")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("code", row.code)
      .maybeSingle();
    if (existing?.id) continue;

    const { error } = await supabase.from("teller_fixed_asset_categories").insert({
      organization_id: organizationId,
      code: row.code,
      name: row.name,
      default_useful_life_months: row.default_useful_life_months,
      asset_account_id: asset?.id ?? null,
      accumulated_depreciation_account_id: accum?.id ?? null,
      depreciation_expense_account_id: expense?.id ?? null,
      gain_account_id: gain?.id ?? null,
      loss_account_id: loss?.id ?? null,
      sort_order: (index + 1) * 10,
    });
    if (error) throw new Error(error.message);
  }
}

export async function createFixedAssetCategory(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    code: string;
    name: string;
    description?: string;
    defaultUsefulLifeMonths?: number;
    assetAccountId?: string | null;
    accumulatedDepreciationAccountId?: string | null;
    depreciationExpenseAccountId?: string | null;
    gainAccountId?: string | null;
    lossAccountId?: string | null;
    actorId?: string | null;
  },
) {
  const { data, error } = await supabase
    .from("teller_fixed_asset_categories")
    .insert({
      organization_id: input.organizationId,
      code: input.code.trim(),
      name: input.name.trim(),
      description: input.description?.trim() || "",
      default_useful_life_months: input.defaultUsefulLifeMonths ?? 60,
      asset_account_id: input.assetAccountId ?? null,
      accumulated_depreciation_account_id: input.accumulatedDepreciationAccountId ?? null,
      depreciation_expense_account_id: input.depreciationExpenseAccountId ?? null,
      gain_account_id: input.gainAccountId ?? null,
      loss_account_id: input.lossAccountId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create category");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.category_created",
    resourceKind: "fixed_asset_category",
    resourceId: data.id as string,
    metadata: { code: input.code, name: input.name },
  });

  return data;
}

export async function listFixedAssetCategories(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("teller_fixed_asset_categories")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("sort_order");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export function exceedsCapitalizationThreshold(
  amount: number,
  threshold: number | null | undefined,
): boolean {
  if (threshold == null || threshold <= 0) return false;
  return asNumber(amount) >= threshold;
}
