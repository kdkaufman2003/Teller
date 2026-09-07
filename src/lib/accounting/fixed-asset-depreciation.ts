import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { buildStraightLineSchedule } from "./fixed-asset-depreciation-calc";
import { loadFixedAssetSettings } from "./fixed-asset-settings";
import {
  loadFixedAsset,
  recordFixedAssetJournalLink,
  resolveAssetAccounts,
  sumPostedDepreciationForAsset,
} from "./fixed-assets";
import type { DepreciationConvention, DepreciationScheduleLine } from "./fixed-asset-types";
import {
  assertOrgPeriodOpen,
  loadOrgAccounts,
  postJournal,
  reverseJournalEntry,
} from "./post";
import { roundMoney } from "./payment-fees";

export async function buildAssetDepreciationSchedule(
  supabase: SupabaseClient,
  organizationId: string,
  assetId: string,
  stopThrough?: { year: number; month: number } | null,
): Promise<DepreciationScheduleLine[]> {
  const asset = await loadFixedAsset(supabase, organizationId, assetId);
  if (!asset.placed_in_service_date || asset.useful_life_months <= 0) return [];

  const settings = await loadFixedAssetSettings(supabase, organizationId);
  const convention = (settings.depreciation_convention || "full_month") as DepreciationConvention;

  return buildStraightLineSchedule({
    originalCost: asNumber(asset.original_cost),
    salvageValue: asNumber(asset.salvage_value),
    usefulLifeMonths: asset.useful_life_months,
    placedInServiceDate: asset.placed_in_service_date,
    convention,
    stopThrough,
  });
}

export async function persistDepreciationSchedule(
  supabase: SupabaseClient,
  organizationId: string,
  assetId: string,
) {
  const schedule = await buildAssetDepreciationSchedule(supabase, organizationId, assetId);
  await supabase
    .from("teller_fixed_asset_depreciation_schedule_lines")
    .delete()
    .eq("asset_id", assetId);

  if (!schedule.length) return schedule;

  const { error } = await supabase.from("teller_fixed_asset_depreciation_schedule_lines").insert(
    schedule.map((line) => ({
      organization_id: organizationId,
      asset_id: assetId,
      period_year: line.periodYear,
      period_month: line.periodMonth,
      period_start_date: line.periodStartDate,
      beginning_book_value: line.beginningBookValue,
      depreciation_amount: line.depreciationAmount,
      accumulated_depreciation: line.accumulatedDepreciation,
      ending_book_value: line.endingBookValue,
      is_final_period: line.isFinalPeriod,
    })),
  );
  if (error) throw new Error(error.message);
  return schedule;
}

export async function previewDepreciationForPeriod(
  supabase: SupabaseClient,
  organizationId: string,
  periodYear: number,
  periodMonth: number,
) {
  const { data: assets } = await supabase
    .from("teller_fixed_assets")
    .select("id, asset_number, name, status")
    .eq("organization_id", organizationId)
    .eq("status", "active");

  const rows = [];
  for (const asset of assets ?? []) {
    const { data: scheduleLine } = await supabase
      .from("teller_fixed_asset_depreciation_schedule_lines")
      .select("*")
      .eq("asset_id", asset.id as string)
      .eq("period_year", periodYear)
      .eq("period_month", periodMonth)
      .maybeSingle();

    const { data: posted } = await supabase
      .from("teller_fixed_asset_depreciation_entries")
      .select("id, status, amount, journal_entry_id")
      .eq("asset_id", asset.id as string)
      .eq("period_year", periodYear)
      .eq("period_month", periodMonth)
      .eq("status", "posted")
      .maybeSingle();

    if (!scheduleLine || asNumber(scheduleLine.depreciation_amount) <= 0) continue;

    rows.push({
      assetId: asset.id as string,
      assetNumber: asset.asset_number as string,
      name: asset.name as string,
      calculatedAmount: asNumber(scheduleLine.depreciation_amount),
      posted: Boolean(posted),
      postedEntryId: posted?.id ?? null,
      postedJournalEntryId: posted?.journal_entry_id ?? null,
    });
  }

  return {
    periodYear,
    periodMonth,
    rows,
    totalCalculated: roundMoney(rows.reduce((sum, row) => sum + row.calculatedAmount, 0)),
    totalReadyToPost: roundMoney(
      rows.filter((row) => !row.posted).reduce((sum, row) => sum + row.calculatedAmount, 0),
    ),
  };
}

async function postSingleAssetDepreciation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    assetId: string;
    periodYear: number;
    periodMonth: number;
    entryDate: string;
    batchId?: string | null;
    replacesEntryId?: string | null;
    actorId?: string | null;
  },
) {
  const asset = await loadFixedAsset(supabase, input.organizationId, input.assetId);
  if (asset.status !== "active") throw new Error("Only active assets can depreciate");

  const { data: existingPosted } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .select("id")
    .eq("asset_id", input.assetId)
    .eq("period_year", input.periodYear)
    .eq("period_month", input.periodMonth)
    .eq("status", "posted")
    .maybeSingle();
  if (existingPosted?.id) throw new Error("Depreciation already posted for this asset and period");

  const { data: scheduleLine } = await supabase
    .from("teller_fixed_asset_depreciation_schedule_lines")
    .select("*")
    .eq("asset_id", input.assetId)
    .eq("period_year", input.periodYear)
    .eq("period_month", input.periodMonth)
    .maybeSingle();
  if (!scheduleLine) throw new Error("No depreciation schedule line for period");

  const amount = asNumber(scheduleLine.depreciation_amount);
  if (amount <= 0) throw new Error("Depreciation amount must be positive");

  const postedAccum = await sumPostedDepreciationForAsset(supabase, input.assetId);
  const basis = Math.max(0, asNumber(asset.original_cost) - asNumber(asset.salvage_value));
  if (postedAccum >= basis - 0.009) throw new Error("Asset is fully depreciated");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.entryDate);
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const mapped = await resolveAssetAccounts(supabase, asset, accounts);

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.entryDate,
    memo: `Depreciation ${asset.asset_number} ${input.periodYear}-${String(input.periodMonth).padStart(2, "0")}`,
    sourceKind: "fixed-asset-depreciation",
    sourceId: input.assetId,
    actorId: input.actorId,
    lines: [
      {
        account_id: mapped.expenseAccountId,
        debit: amount,
        fixed_asset_id: input.assetId,
        memo: asset.name,
      },
      {
        account_id: mapped.accumAccountId,
        credit: amount,
        fixed_asset_id: input.assetId,
        memo: asset.name,
      },
    ],
  });

  const { data: deprEntry, error } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .insert({
      organization_id: input.organizationId,
      asset_id: input.assetId,
      batch_id: input.batchId ?? null,
      period_year: input.periodYear,
      period_month: input.periodMonth,
      amount,
      status: "posted",
      journal_entry_id: entryId,
      replaces_entry_id: input.replacesEntryId ?? null,
      posted_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  if (error || !deprEntry) throw new Error(error?.message || "Could not record depreciation entry");

  await recordFixedAssetJournalLink(supabase, {
    organizationId: input.organizationId,
    fixedAssetId: input.assetId,
    journalEntryId: entryId,
    linkKind: "depreciation",
    depreciationEntryId: deprEntry.id as string,
  });

  return { entryId, depreciationEntry: deprEntry, amount };
}

export async function postDepreciationBatch(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    periodYear: number;
    periodMonth: number;
    entryDate: string;
    actorId?: string | null;
  },
) {
  const preview = await previewDepreciationForPeriod(
    supabase,
    input.organizationId,
    input.periodYear,
    input.periodMonth,
  );
  const ready = preview.rows.filter((row) => !row.posted);
  if (!ready.length) throw new Error("No depreciation ready to post for period");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.entryDate);

  const { data: existingBatch } = await supabase
    .from("teller_fixed_asset_depreciation_batches")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("period_year", input.periodYear)
    .eq("period_month", input.periodMonth)
    .eq("status", "posted")
    .maybeSingle();
  if (existingBatch?.id) throw new Error("Depreciation batch already posted for period");

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const journalLines: {
    account_id: string;
    debit?: number;
    credit?: number;
    fixed_asset_id?: string;
    memo?: string;
  }[] = [];

  const assetAmounts: { assetId: string; amount: number; expenseAccountId: string; accumAccountId: string }[] =
    [];

  for (const row of ready) {
    const asset = await loadFixedAsset(supabase, input.organizationId, row.assetId);
    const mapped = await resolveAssetAccounts(supabase, asset, accounts);
    assetAmounts.push({
      assetId: row.assetId,
      amount: row.calculatedAmount,
      expenseAccountId: mapped.expenseAccountId,
      accumAccountId: mapped.accumAccountId,
    });
    journalLines.push({
      account_id: mapped.expenseAccountId,
      debit: row.calculatedAmount,
      fixed_asset_id: row.assetId,
      memo: `${asset.asset_number} depreciation`,
    });
    journalLines.push({
      account_id: mapped.accumAccountId,
      credit: row.calculatedAmount,
      fixed_asset_id: row.assetId,
      memo: `${asset.asset_number} depreciation`,
    });
  }

  const totalAmount = roundMoney(assetAmounts.reduce((sum, row) => sum + row.amount, 0));
  const { data: batch, error: batchError } = await supabase
    .from("teller_fixed_asset_depreciation_batches")
    .insert({
      organization_id: input.organizationId,
      period_year: input.periodYear,
      period_month: input.periodMonth,
      total_amount: totalAmount,
      asset_count: assetAmounts.length,
      status: "posted",
      memo: `Depreciation ${input.periodYear}-${String(input.periodMonth).padStart(2, "0")}`,
      posted_by: input.actorId ?? null,
      posted_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (batchError || !batch) throw new Error(batchError?.message || "Could not create batch");

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.entryDate,
    memo: batch.memo as string,
    sourceKind: "fixed-asset-depreciation-batch",
    sourceId: batch.id as string,
    actorId: input.actorId,
    lines: journalLines,
  });

  await supabase
    .from("teller_fixed_asset_depreciation_batches")
    .update({ journal_entry_id: entryId })
    .eq("id", batch.id as string);

  for (const row of assetAmounts) {
    const { data: deprEntry, error } = await supabase
      .from("teller_fixed_asset_depreciation_entries")
      .insert({
        organization_id: input.organizationId,
        asset_id: row.assetId,
        batch_id: batch.id as string,
        period_year: input.periodYear,
        period_month: input.periodMonth,
        amount: row.amount,
        status: "posted",
        journal_entry_id: entryId,
        posted_by: input.actorId ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    await recordFixedAssetJournalLink(supabase, {
      organizationId: input.organizationId,
      fixedAssetId: row.assetId,
      journalEntryId: entryId,
      linkKind: "depreciation",
      depreciationEntryId: deprEntry.id as string,
    });
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.depreciation_posted",
    resourceKind: "fixed_asset_depreciation_batch",
    resourceId: batch.id as string,
    metadata: {
      periodYear: input.periodYear,
      periodMonth: input.periodMonth,
      totalAmount,
      assetCount: assetAmounts.length,
      journalEntryId: entryId,
    },
  });

  return { batchId: batch.id as string, journalEntryId: entryId, totalAmount, assetCount: assetAmounts.length };
}

export async function postAssetDepreciationThroughPeriod(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    assetId: string;
    throughYear: number;
    throughMonth: number;
    actorId?: string | null;
  },
) {
  const schedule = await buildAssetDepreciationSchedule(supabase, input.organizationId, input.assetId, {
    year: input.throughYear,
    month: input.throughMonth,
  });

  const postedEntries = [];
  for (const line of schedule) {
    const entryDate = `${line.periodYear}-${String(line.periodMonth).padStart(2, "0")}-01`;
    try {
      const result = await postSingleAssetDepreciation(supabase, {
        organizationId: input.organizationId,
        assetId: input.assetId,
        periodYear: line.periodYear,
        periodMonth: line.periodMonth,
        entryDate,
        actorId: input.actorId,
      });
      postedEntries.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already posted")) throw error;
    }
  }

  return postedEntries;
}

export async function reverseDepreciationEntry(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    depreciationEntryId: string;
    reversalDate: string;
    actorId?: string | null;
  },
) {
  const { data: entry } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.depreciationEntryId)
    .maybeSingle();
  if (!entry) throw new Error("Depreciation entry not found");
  if (entry.status !== "posted") throw new Error("Only posted depreciation can be reversed");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.reversalDate);

  const reversalEntryId = await reverseJournalEntry(supabase, {
    organizationId: input.organizationId,
    entryId: entry.journal_entry_id as string,
    entryDate: input.reversalDate,
    memo: `Reverse depreciation entry ${entry.id}`,
    sourceId: entry.asset_id as string,
    actorId: input.actorId,
  });

  await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .update({
      status: "reversed",
      reversal_journal_entry_id: reversalEntryId,
    })
    .eq("id", entry.id as string);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.depreciation_reversed",
    resourceKind: "fixed_asset_depreciation_entry",
    resourceId: entry.id as string,
    metadata: { reversalJournalEntryId: reversalEntryId },
  });

  return { reversalEntryId, originalEntryId: entry.id as string };
}

export async function repostDepreciationAfterReversal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    reversedEntryId: string;
    entryDate: string;
    actorId?: string | null;
  },
) {
  const { data: reversed } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.reversedEntryId)
    .maybeSingle();
  if (!reversed || reversed.status !== "reversed") {
    throw new Error("Reversed depreciation entry not found");
  }

  return postSingleAssetDepreciation(supabase, {
    organizationId: input.organizationId,
    assetId: reversed.asset_id as string,
    periodYear: reversed.period_year as number,
    periodMonth: reversed.period_month as number,
    entryDate: input.entryDate,
    replacesEntryId: reversed.id as string,
    actorId: input.actorId,
  });
}

export { postSingleAssetDepreciation };
