import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { isFullyDepreciated, netBookValue } from "./fixed-asset-depreciation-calc";
import { batchSumPostedDepreciationForAssets } from "./fixed-assets";
import type { FixedAssetRecord } from "./fixed-asset-types";

export type FixedAssetRegisterRow = FixedAssetRecord & {
  accumulatedDepreciation: number;
  netBookValue: number;
  isFullyDepreciated: boolean;
};

export async function buildFixedAssetRegister(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<FixedAssetRegisterRow[]> {
  const { data: assets, error } = await supabase
    .from("teller_fixed_assets")
    .select("*")
    .eq("organization_id", organizationId)
    .order("asset_number");
  if (error) throw new Error(error.message);

  const assetList = assets ?? [];
  const accumByAsset = await batchSumPostedDepreciationForAssets(
    supabase,
    assetList.map((asset) => asset.id as string),
  );

  return assetList.map((asset) => {
    const accum = accumByAsset.get(asset.id as string) ?? 0;
    const cost = asNumber(asset.original_cost);
    const salvage = asNumber(asset.salvage_value);
    return {
      ...(asset as FixedAssetRecord),
      accumulatedDepreciation: accum,
      netBookValue: netBookValue(cost, accum),
      isFullyDepreciated: isFullyDepreciated(cost, salvage, accum),
    };
  });
}

export type AssetRollforward = {
  beginningCost: number;
  additions: number;
  disposals: number;
  endingCost: number;
  beginningAccumDepr: number;
  depreciation: number;
  accumDeprRemovedOnDisposal: number;
  endingAccumDepr: number;
};

export async function buildAssetRollforward(
  supabase: SupabaseClient,
  organizationId: string,
  startDate: string,
  endDate: string,
): Promise<AssetRollforward> {
  const { data: assets } = await supabase
    .from("teller_fixed_assets")
    .select("*")
    .eq("organization_id", organizationId);

  let beginningCost = 0;
  let endingCost = 0;
  let additions = 0;
  let disposals = 0;

  for (const asset of assets ?? []) {
    const cost = asNumber(asset.original_cost);
    const activatedAt = (asset.activated_at as string | null)?.slice(0, 10) || asset.acquisition_date;
    const disposed = asset.status === "disposed";
    const disposalDate = asset.disposal_date as string | null;

    if (activatedAt && activatedAt <= startDate && (!disposed || (disposalDate && disposalDate > startDate))) {
      beginningCost += cost;
    }
    if (activatedAt && activatedAt > startDate && activatedAt <= endDate) additions += cost;
    if (disposed && disposalDate && disposalDate > startDate && disposalDate <= endDate) disposals += cost;
    if (asset.status === "active" || (disposed && disposalDate && disposalDate > endDate)) {
      if (activatedAt && activatedAt <= endDate) endingCost += cost;
    }
    if (disposed && disposalDate && disposalDate <= endDate && activatedAt && activatedAt <= endDate) {
      // ending excludes disposed within period — handled above
    }
  }

  // Simpler ending = beginning + additions - disposals
  endingCost = beginningCost + additions - disposals;

  const { data: deprEntries } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .select("amount, posted_at, asset_id, status")
    .eq("organization_id", organizationId)
    .eq("status", "posted");

  let depreciation = 0;
  for (const entry of deprEntries ?? []) {
    const postedAt = (entry.posted_at as string).slice(0, 10);
    if (postedAt >= startDate && postedAt <= endDate) {
      depreciation += asNumber(entry.amount);
    }
  }

  const disposedInPeriod = (assets ?? []).filter((asset) => {
    if (asset.status !== "disposed") return false;
    const disposalDate = asset.disposal_date as string | null;
    return Boolean(disposalDate && disposalDate >= startDate && disposalDate <= endDate);
  });
  const disposedAccum = await batchSumPostedDepreciationForAssets(
    supabase,
    disposedInPeriod.map((asset) => asset.id as string),
  );
  let accumDeprRemovedOnDisposal = 0;
  for (const asset of disposedInPeriod) {
    accumDeprRemovedOnDisposal += disposedAccum.get(asset.id as string) ?? 0;
  }

  const beginningAccumDepr = 0; // demo-level; full implementation would opening-balance by date
  const endingAccumDepr = beginningAccumDepr + depreciation - accumDeprRemovedOnDisposal;

  return {
    beginningCost,
    additions,
    disposals,
    endingCost,
    beginningAccumDepr,
    depreciation,
    accumDeprRemovedOnDisposal,
    endingAccumDepr,
  };
}
