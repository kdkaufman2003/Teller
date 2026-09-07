import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { accountBySubtype } from "./accounts";
import { FIXED_ASSET_SUBTYPES } from "./fixed-asset-accounts";
import { allocateAssetNumber } from "./fixed-asset-numbering";
import type {
  FixedAssetAcquisitionMode,
  FixedAssetRecord,
  AccountLookup,
} from "./fixed-asset-types";

export async function createDraftFixedAsset(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    name: string;
    categoryId?: string | null;
    acquisitionMode?: FixedAssetAcquisitionMode;
    description?: string;
    originalCost?: number;
    salvageValue?: number;
    usefulLifeMonths?: number;
    placedInServiceDate?: string | null;
    acquisitionDate?: string | null;
    actorId?: string | null;
  },
) {
  const assetNumber = await allocateAssetNumber(supabase, input.organizationId);
  const { data, error } = await supabase
    .from("teller_fixed_assets")
    .insert({
      organization_id: input.organizationId,
      asset_number: assetNumber,
      name: input.name.trim(),
      description: input.description?.trim() || "",
      category_id: input.categoryId ?? null,
      acquisition_mode: input.acquisitionMode ?? "linked",
      original_cost: asNumber(input.originalCost),
      salvage_value: asNumber(input.salvageValue),
      useful_life_months: input.usefulLifeMonths ?? 0,
      placed_in_service_date: input.placedInServiceDate ?? null,
      acquisition_date: input.acquisitionDate ?? null,
      created_by: input.actorId ?? null,
      updated_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create asset");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.created",
    resourceKind: "fixed_asset",
    resourceId: data.id as string,
    metadata: { assetNumber, name: input.name },
  });

  return data as FixedAssetRecord;
}

export async function updateFixedAssetMetadata(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    assetId: string;
    patch: Record<string, unknown>;
    actorId?: string | null;
  },
) {
  const { data: current } = await supabase
    .from("teller_fixed_assets")
    .select("status")
    .eq("organization_id", input.organizationId)
    .eq("id", input.assetId)
    .maybeSingle();
  if (!current) throw new Error("Asset not found");

  const allowed = [
    "name",
    "description",
    "serial_number",
    "vin",
    "location_id",
    "location_text",
    "assigned_user_id",
    "job_id",
    "notes",
    "attachment_path",
    "metadata",
    "category_id",
    "salvage_value",
    "useful_life_months",
    "placed_in_service_date",
    "acquisition_date",
  ];
  const safePatch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in input.patch) safePatch[key] = input.patch[key];
  }

  const { data, error } = await supabase
    .from("teller_fixed_assets")
    .update({
      ...safePatch,
      updated_at: new Date().toISOString(),
      updated_by: input.actorId ?? null,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.assetId)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not update asset");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.updated",
    resourceKind: "fixed_asset",
    resourceId: input.assetId,
    metadata: { fields: Object.keys(safePatch) },
  });

  return data as FixedAssetRecord;
}

export async function deleteDraftFixedAsset(
  supabase: SupabaseClient,
  organizationId: string,
  assetId: string,
) {
  const { data } = await supabase
    .from("teller_fixed_assets")
    .select("status, acquisition_journal_entry_id")
    .eq("organization_id", organizationId)
    .eq("id", assetId)
    .maybeSingle();
  if (!data) throw new Error("Asset not found");
  if (data.status !== "draft") throw new Error("Only draft assets can be deleted");
  if (data.acquisition_journal_entry_id) {
    throw new Error("Cannot delete asset with linked acquisition journal");
  }

  const { error } = await supabase
    .from("teller_fixed_assets")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", assetId);
  if (error) throw new Error(error.message);
}

export async function resolveAssetAccounts(
  supabase: SupabaseClient,
  asset: FixedAssetRecord,
  accounts: AccountLookup[],
) {
  let category = null;
  if (asset.category_id) {
    const { data } = await supabase
      .from("teller_fixed_asset_categories")
      .select("*")
      .eq("id", asset.category_id)
      .maybeSingle();
    category = data;
  }

  const assetAccountId =
    asset.asset_account_id ||
    category?.asset_account_id ||
    accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.fixedAsset)?.id;
  const accumAccountId =
    asset.accumulated_depreciation_account_id ||
    category?.accumulated_depreciation_account_id ||
    accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.accumulatedDepreciation)?.id;
  const expenseAccountId =
    asset.depreciation_expense_account_id ||
    category?.depreciation_expense_account_id ||
    accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.depreciationExpense)?.id;
  const gainAccountId =
    asset.gain_account_id ||
    category?.gain_account_id ||
    accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.gainOnDisposal)?.id;
  const lossAccountId =
    asset.loss_account_id ||
    category?.loss_account_id ||
    accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.lossOnDisposal)?.id;

  if (!assetAccountId || !accumAccountId || !expenseAccountId || !gainAccountId || !lossAccountId) {
    throw new Error("Fixed asset account mappings are incomplete");
  }

  return {
    assetAccountId,
    accumAccountId,
    expenseAccountId,
    gainAccountId,
    lossAccountId,
  };
}

export async function loadFixedAsset(
  supabase: SupabaseClient,
  organizationId: string,
  assetId: string,
): Promise<FixedAssetRecord> {
  const { data, error } = await supabase
    .from("teller_fixed_assets")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", assetId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Asset not found");
  return data as FixedAssetRecord;
}

export async function listFixedAssets(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("teller_fixed_assets")
    .select("*")
    .eq("organization_id", organizationId)
    .order("asset_number");
  if (error) throw new Error(error.message);
  return (data ?? []) as FixedAssetRecord[];
}

export async function recordFixedAssetJournalLink(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    fixedAssetId: string;
    journalEntryId: string;
    linkKind: string;
    depreciationEntryId?: string | null;
  },
) {
  const { error } = await supabase.from("teller_fixed_asset_journal_links").insert({
    organization_id: input.organizationId,
    fixed_asset_id: input.fixedAssetId,
    journal_entry_id: input.journalEntryId,
    link_kind: input.linkKind,
    depreciation_entry_id: input.depreciationEntryId ?? null,
  });
  if (error && !error.message.includes("duplicate")) throw new Error(error.message);
}

export async function sumPostedDepreciationForAsset(
  supabase: SupabaseClient,
  assetId: string,
): Promise<number> {
  const { data } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .select("amount, status")
    .eq("asset_id", assetId)
    .eq("status", "posted");
  return (data ?? []).reduce((sum, row) => sum + asNumber(row.amount), 0);
}
