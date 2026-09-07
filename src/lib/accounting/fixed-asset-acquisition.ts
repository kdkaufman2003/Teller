import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { accountBySubtype } from "./accounts";
import { FIXED_ASSET_SUBTYPES } from "./fixed-asset-accounts";
import {
  loadFixedAsset,
  recordFixedAssetJournalLink,
  resolveAssetAccounts,
} from "./fixed-assets";
import { persistDepreciationSchedule } from "./fixed-asset-depreciation";
import {
  assertOrgPeriodOpen,
  loadOrgAccounts,
  postJournal,
} from "./post";

async function assertFixedAssetDebitLine(
  supabase: SupabaseClient,
  organizationId: string,
  journalEntryId: string,
  expectedAmount: number,
) {
  const accounts = await loadOrgAccounts(supabase, organizationId);
  const fixedAssetIds = new Set(
    accounts
      .filter((account) => account.subtype === FIXED_ASSET_SUBTYPES.fixedAsset)
      .map((account) => account.id),
  );

  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit")
    .eq("entry_id", journalEntryId);

  const debitTotal = (lines ?? [])
    .filter((line) => fixedAssetIds.has(line.account_id as string))
    .reduce((sum, line) => sum + asNumber(line.debit), 0);

  if (Math.abs(debitTotal - expectedAmount) > 0.009) {
    throw new Error("Acquisition journal fixed asset debit does not match asset cost");
  }
}

export async function linkFixedAssetAcquisition(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    assetId: string;
    purchaseDocumentLineId?: string | null;
    acquisitionJournalEntryId: string;
    actorId?: string | null;
  },
) {
  const asset = await loadFixedAsset(supabase, input.organizationId, input.assetId);
  if (asset.status !== "draft") throw new Error("Only draft assets can be linked");

  const { data: entry } = await supabase
    .from("teller_journal_entries")
    .select("id, organization_id, entry_date")
    .eq("id", input.acquisitionJournalEntryId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!entry) throw new Error("Acquisition journal not found");

  let documentLine = null;
  if (input.purchaseDocumentLineId) {
    const { data } = await supabase
      .from("teller_document_lines")
      .select("id, document_id, amount, account_id")
      .eq("id", input.purchaseDocumentLineId)
      .maybeSingle();
    documentLine = data;
    if (!documentLine) throw new Error("Purchase document line not found");
  }

  const cost = documentLine ? asNumber(documentLine.amount) : asset.original_cost;
  await assertFixedAssetDebitLine(supabase, input.organizationId, input.acquisitionJournalEntryId, cost);

  const { data: updated, error } = await supabase
    .from("teller_fixed_assets")
    .update({
      status: "active",
      acquisition_mode: "linked",
      original_cost: cost,
      acquisition_journal_entry_id: input.acquisitionJournalEntryId,
      purchase_document_line_id: input.purchaseDocumentLineId ?? null,
      purchase_document_id: documentLine?.document_id ?? asset.purchase_document_id,
      acquisition_date: asset.acquisition_date || (entry.entry_date as string),
      placed_in_service_date:
        asset.placed_in_service_date || asset.acquisition_date || (entry.entry_date as string),
      activated_at: new Date().toISOString(),
      updated_by: input.actorId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.assetId)
    .select("*")
    .single();
  if (error || !updated) throw new Error(error?.message || "Could not link asset");

  await recordFixedAssetJournalLink(supabase, {
    organizationId: input.organizationId,
    fixedAssetId: input.assetId,
    journalEntryId: input.acquisitionJournalEntryId,
    linkKind: "acquisition",
  });

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const fixedAssetAccountIds = accounts
    .filter((account) => account.subtype === FIXED_ASSET_SUBTYPES.fixedAsset)
    .map((account) => account.id);
  if (fixedAssetAccountIds.length) {
    const { error: tagError } = await supabase
      .from("teller_journal_lines")
      .update({ fixed_asset_id: input.assetId })
      .eq("entry_id", input.acquisitionJournalEntryId)
      .in("account_id", fixedAssetAccountIds)
      .is("fixed_asset_id", null);
    if (tagError) throw new Error(tagError.message);
  }

  await persistDepreciationSchedule(supabase, input.organizationId, input.assetId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.linked",
    resourceKind: "fixed_asset",
    resourceId: input.assetId,
    metadata: { acquisitionJournalEntryId: input.acquisitionJournalEntryId },
  });

  return updated;
}

export async function activateNewAcquisition(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    assetId: string;
    paymentKind: "cash" | "ap";
    entryDate: string;
    vendorPartyId?: string | null;
    actorId?: string | null;
  },
) {
  const asset = await loadFixedAsset(supabase, input.organizationId, input.assetId);
  if (asset.status !== "draft") throw new Error("Only draft assets can be activated");
  if (asset.acquisition_mode !== "new_acquisition") {
    throw new Error("Asset acquisition mode must be new_acquisition");
  }
  if (!asset.placed_in_service_date) throw new Error("placed_in_service_date is required");
  if (asset.useful_life_months <= 0) throw new Error("useful_life_months must be greater than zero");
  if (asset.original_cost <= 0) throw new Error("original_cost must be greater than zero");
  if (asset.salvage_value > asset.original_cost) {
    throw new Error("salvage_value cannot exceed original_cost");
  }

  await assertOrgPeriodOpen(supabase, input.organizationId, input.entryDate);
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const mapped = await resolveAssetAccounts(supabase, asset, accounts);
  const ap = accountBySubtype(accounts, "payable");
  const cash = accountBySubtype(accounts, "bank") || accounts.find((a) => a.code === "1000");
  if (input.paymentKind === "ap" && !ap) throw new Error("Accounts Payable is missing");
  if (input.paymentKind === "cash" && !cash) throw new Error("Cash account is missing");

  const amount = asNumber(asset.original_cost);
  const creditAccountId = input.paymentKind === "ap" ? ap!.id : cash!.id;

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.entryDate,
    memo: `Fixed asset acquisition ${asset.asset_number}`,
    sourceKind: "fixed-asset-acquisition",
    sourceId: input.assetId,
    actorId: input.actorId,
    lines: [
      {
        account_id: mapped.assetAccountId,
        debit: amount,
        fixed_asset_id: input.assetId,
        memo: asset.name,
      },
      {
        account_id: creditAccountId,
        credit: amount,
        party_id: input.paymentKind === "ap" ? input.vendorPartyId ?? asset.vendor_party_id : null,
        memo: `Acquisition ${asset.asset_number}`,
      },
    ],
  });

  const { data: updated, error } = await supabase
    .from("teller_fixed_assets")
    .update({
      status: "active",
      acquisition_journal_entry_id: entryId,
      acquisition_date: input.entryDate,
      vendor_party_id: input.vendorPartyId ?? asset.vendor_party_id,
      asset_account_id: mapped.assetAccountId,
      accumulated_depreciation_account_id: mapped.accumAccountId,
      depreciation_expense_account_id: mapped.expenseAccountId,
      gain_account_id: mapped.gainAccountId,
      loss_account_id: mapped.lossAccountId,
      activated_at: new Date().toISOString(),
      updated_by: input.actorId ?? null,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.assetId)
    .select("*")
    .single();
  if (error || !updated) throw new Error(error?.message || "Could not activate asset");

  await recordFixedAssetJournalLink(supabase, {
    organizationId: input.organizationId,
    fixedAssetId: input.assetId,
    journalEntryId: entryId,
    linkKind: "acquisition",
  });
  await persistDepreciationSchedule(supabase, input.organizationId, input.assetId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.activated",
    resourceKind: "fixed_asset",
    resourceId: input.assetId,
    metadata: { mode: "new_acquisition", journalEntryId: entryId },
  });

  return updated;
}

export async function activateOpeningBalanceAsset(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    assetId: string;
    entryDate: string;
    openingAccumulatedDepreciation?: number;
    actorId?: string | null;
  },
) {
  const asset = await loadFixedAsset(supabase, input.organizationId, input.assetId);
  if (asset.status !== "draft") throw new Error("Only draft assets can be activated");
  if (asset.acquisition_mode !== "opening_balance") {
    throw new Error("Asset acquisition mode must be opening_balance");
  }
  if (!asset.placed_in_service_date) throw new Error("placed_in_service_date is required");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.entryDate);
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const mapped = await resolveAssetAccounts(supabase, asset, accounts);
  const obe =
    accountBySubtype(accounts, FIXED_ASSET_SUBTYPES.openingBalanceEquity) ||
    accountBySubtype(accounts, "equity");

  if (!obe) throw new Error("Opening Balance Equity account is missing");

  const cost = asNumber(asset.original_cost);
  const openingAccum = asNumber(input.openingAccumulatedDepreciation);
  if (openingAccum < 0) throw new Error("opening accumulated depreciation cannot be negative");
  if (openingAccum > cost) throw new Error("opening accumulated depreciation cannot exceed cost");

  const acquisitionEntryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.entryDate,
    memo: `Opening fixed asset ${asset.asset_number}`,
    sourceKind: "fixed-asset-opening",
    sourceId: input.assetId,
    actorId: input.actorId,
    lines: [
      {
        account_id: mapped.assetAccountId,
        debit: cost,
        fixed_asset_id: input.assetId,
        memo: asset.name,
      },
      {
        account_id: obe.id,
        credit: cost,
        memo: `Opening asset ${asset.asset_number}`,
      },
    ],
  });

  let openingAccumEntryId: string | null = null;
  if (openingAccum > 0) {
    openingAccumEntryId = await postJournal(supabase, {
      organizationId: input.organizationId,
      entryDate: input.entryDate,
      memo: `Opening accumulated depreciation ${asset.asset_number}`,
      sourceKind: "fixed-asset-opening-accum",
      sourceId: input.assetId,
      actorId: input.actorId,
      lines: [
        {
          account_id: obe.id,
          debit: openingAccum,
          memo: `Opening accum depr ${asset.asset_number}`,
        },
        {
          account_id: mapped.accumAccountId,
          credit: openingAccum,
          fixed_asset_id: input.assetId,
          memo: `Opening accum depr ${asset.asset_number}`,
        },
      ],
    });
  }

  const { data: updated, error } = await supabase
    .from("teller_fixed_assets")
    .update({
      status: "active",
      acquisition_journal_entry_id: acquisitionEntryId,
      opening_accum_depr_journal_entry_id: openingAccumEntryId,
      acquisition_date: input.entryDate,
      activated_at: new Date().toISOString(),
      updated_by: input.actorId ?? null,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.assetId)
    .select("*")
    .single();
  if (error || !updated) throw new Error(error?.message || "Could not activate opening asset");

  await recordFixedAssetJournalLink(supabase, {
    organizationId: input.organizationId,
    fixedAssetId: input.assetId,
    journalEntryId: acquisitionEntryId,
    linkKind: "opening_balance",
  });
  if (openingAccumEntryId) {
    await recordFixedAssetJournalLink(supabase, {
      organizationId: input.organizationId,
      fixedAssetId: input.assetId,
      journalEntryId: openingAccumEntryId,
      linkKind: "opening_accum_depr",
    });
  }

  await persistDepreciationSchedule(supabase, input.organizationId, input.assetId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.opening_recorded",
    resourceKind: "fixed_asset",
    resourceId: input.assetId,
    metadata: { acquisitionEntryId, openingAccumEntryId },
  });

  return updated;
}

export async function capitalizeExpensedPurchase(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    assetId: string;
    expenseAccountId: string;
    amount: number;
    entryDate: string;
    sourceDocumentLineId?: string | null;
    actorId?: string | null;
  },
) {
  const asset = await loadFixedAsset(supabase, input.organizationId, input.assetId);
  if (asset.status !== "draft") throw new Error("Only draft assets can be capitalized");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.entryDate);
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const mapped = await resolveAssetAccounts(supabase, asset, accounts);
  const amount = asNumber(input.amount);

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.entryDate,
    memo: `Capitalize to fixed asset ${asset.asset_number}`,
    sourceKind: "fixed-asset-capitalization",
    sourceId: input.assetId,
    actorId: input.actorId,
    lines: [
      {
        account_id: mapped.assetAccountId,
        debit: amount,
        fixed_asset_id: input.assetId,
        memo: asset.name,
      },
      {
        account_id: input.expenseAccountId,
        credit: amount,
        memo: `Reclassify to ${asset.asset_number}`,
      },
    ],
  });

  const { data: updated, error } = await supabase
    .from("teller_fixed_assets")
    .update({
      status: "active",
      acquisition_mode: "linked",
      original_cost: amount,
      capitalization_journal_entry_id: entryId,
      acquisition_journal_entry_id: entryId,
      purchase_document_line_id: input.sourceDocumentLineId ?? null,
      placed_in_service_date: asset.placed_in_service_date || input.entryDate,
      acquisition_date: input.entryDate,
      activated_at: new Date().toISOString(),
      updated_by: input.actorId ?? null,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.assetId)
    .select("*")
    .single();
  if (error || !updated) throw new Error(error?.message || "Could not capitalize asset");

  await recordFixedAssetJournalLink(supabase, {
    organizationId: input.organizationId,
    fixedAssetId: input.assetId,
    journalEntryId: entryId,
    linkKind: "capitalization",
  });
  await persistDepreciationSchedule(supabase, input.organizationId, input.assetId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "fixed_asset.capitalized",
    resourceKind: "fixed_asset",
    resourceId: input.assetId,
    metadata: { journalEntryId: entryId, amount },
  });

  return updated;
}
