import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { accountsBySubtype, FIXED_ASSET_SUBTYPES } from "./fixed-asset-accounts";
import type { AccountLookup, GlReconciliationSlice } from "./fixed-asset-types";
import { roundMoney } from "./payment-fees";

const TOLERANCE = 0.01;

type JournalLineRow = {
  account_id: string;
  debit: number;
  credit: number;
  fixed_asset_id: string | null;
  entry_id: string;
};

async function loadActiveJournalLines(
  supabase: SupabaseClient,
  organizationId: string,
  accountIds: string[],
  throughDate?: string | null,
): Promise<JournalLineRow[]> {
  if (!accountIds.length) return [];

  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit, fixed_asset_id, entry_id")
    .in("account_id", accountIds);

  const entryIds = [...new Set((lines ?? []).map((line) => line.entry_id as string))];
  if (!entryIds.length) return [];

  let entryQuery = supabase
    .from("teller_journal_entries")
    .select("id, entry_date, reverses_entry_id")
    .eq("organization_id", organizationId)
    .in("id", entryIds);

  if (throughDate) {
    entryQuery = entryQuery.lte("entry_date", throughDate);
  }

  const { data: entries } = await entryQuery;
  const entryDates = new Map((entries ?? []).map((entry) => [entry.id as string, entry.entry_date as string]));
  const reversalEntries = new Set(
    (entries ?? []).filter((entry) => entry.reverses_entry_id).map((entry) => entry.id as string),
  );

  const { data: reversals } = await supabase
    .from("teller_journal_entries")
    .select("reverses_entry_id")
    .eq("organization_id", organizationId)
    .in("reverses_entry_id", entryIds);

  const reversedOriginals = new Set(
    (reversals ?? []).map((row) => row.reverses_entry_id as string),
  );

  return (lines ?? []).filter((line) => {
    const entryId = line.entry_id as string;
    if (reversalEntries.has(entryId) || reversedOriginals.has(entryId)) return false;
    if (throughDate) {
      const entryDate = entryDates.get(entryId);
      if (!entryDate || entryDate > throughDate) return false;
    }
    return true;
  }) as JournalLineRow[];
}

function sliceFromLines(
  lines: JournalLineRow[],
  balanceFn: (debit: number, credit: number) => number,
): { glActivity: number; attributed: number; unassigned: number } {
  let glActivity = 0;
  let attributed = 0;
  for (const line of lines) {
    const amount = balanceFn(asNumber(line.debit), asNumber(line.credit));
    glActivity = roundMoney(glActivity + amount);
    if (line.fixed_asset_id) attributed = roundMoney(attributed + amount);
  }
  return {
    glActivity,
    attributed,
    unassigned: roundMoney(glActivity - attributed),
  };
}

export async function buildFixedAssetCostReconciliation(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: AccountLookup[],
  asOfDate?: string | null,
): Promise<GlReconciliationSlice & { subledgerCost: number }> {
  const fixedAssetAccounts = accountsBySubtype(accounts, FIXED_ASSET_SUBTYPES.fixedAsset);
  const accountIds = fixedAssetAccounts.map((account) => account.id);
  const lines = await loadActiveJournalLines(supabase, organizationId, accountIds, asOfDate);
  const { glActivity, attributed, unassigned } = sliceFromLines(lines, (debit, credit) => debit - credit);

  const { data: assets } = await supabase
    .from("teller_fixed_assets")
    .select("original_cost, status, disposal_date")
    .eq("organization_id", organizationId)
    .in("status", ["active", "disposed"]);

  const subledgerCost = roundMoney(
    (assets ?? []).reduce((sum, asset) => {
      if (asset.status === "disposed" && asOfDate && asset.disposal_date && asset.disposal_date <= asOfDate) {
        return sum;
      }
      return sum + asNumber(asset.original_cost);
    }, 0),
  );

  const difference = roundMoney(attributed - subledgerCost);
  return {
    glActivity,
    subledgerAttributed: attributed,
    subledgerCost,
    unassigned,
    difference,
  };
}

export async function buildAccumulatedDepreciationReconciliation(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: AccountLookup[],
  asOfDate?: string | null,
): Promise<GlReconciliationSlice & { subledgerAccumDepr: number }> {
  const accumAccounts = accountsBySubtype(accounts, FIXED_ASSET_SUBTYPES.accumulatedDepreciation);
  const accountIds = accumAccounts.map((account) => account.id);
  const lines = await loadActiveJournalLines(supabase, organizationId, accountIds, asOfDate);
  const { glActivity, attributed, unassigned } = sliceFromLines(lines, (debit, credit) => credit - debit);

  const { data: entries } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .select("amount, asset_id, status, journal_entry_id")
    .eq("organization_id", organizationId)
    .eq("status", "posted");

  const { data: assets } = await supabase
    .from("teller_fixed_assets")
    .select("id, status, disposal_date, opening_accum_depr_journal_entry_id")
    .eq("organization_id", organizationId);

  const onBooksAssetIds = new Set(
    (assets ?? [])
      .filter((asset) => {
        if (asset.status === "active") return true;
        if (
          asset.status === "disposed" &&
          asOfDate &&
          asset.disposal_date &&
          asset.disposal_date > asOfDate
        ) {
          return true;
        }
        return false;
      })
      .map((asset) => asset.id as string),
  );

  const journalEntryIds = [
    ...new Set(
      (entries ?? [])
        .map((row) => row.journal_entry_id as string | null)
        .filter(Boolean) as string[],
    ),
    ...new Set(
      (assets ?? [])
        .map((asset) => asset.opening_accum_depr_journal_entry_id as string | null)
        .filter(Boolean) as string[],
    ),
  ];

  const entryDateById = new Map<string, string>();
  if (journalEntryIds.length) {
    const { data: journalEntries } = await supabase
      .from("teller_journal_entries")
      .select("id, entry_date")
      .eq("organization_id", organizationId)
      .in("id", journalEntryIds);
    for (const entry of journalEntries ?? []) {
      entryDateById.set(entry.id as string, entry.entry_date as string);
    }
  }

  const postedDepreciation = roundMoney(
    (entries ?? [])
      .filter((row) => {
        if (!onBooksAssetIds.has(row.asset_id as string)) return false;
        if (!asOfDate) return true;
        const entryDate = entryDateById.get(row.journal_entry_id as string);
        return Boolean(entryDate && entryDate <= asOfDate);
      })
      .reduce((sum, row) => sum + asNumber(row.amount), 0),
  );

  let openingAccumDepr = 0;
  for (const asset of assets ?? []) {
    if (!onBooksAssetIds.has(asset.id as string)) continue;
    const openingEntryId = asset.opening_accum_depr_journal_entry_id as string | null;
    if (!openingEntryId) continue;
    if (asOfDate) {
      const entryDate = entryDateById.get(openingEntryId);
      if (!entryDate || entryDate > asOfDate) continue;
    }
    const { data: openingLines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", openingEntryId)
      .eq("fixed_asset_id", asset.id as string)
      .in("account_id", accountIds);
    openingAccumDepr = roundMoney(
      openingAccumDepr +
        (openingLines ?? []).reduce(
          (sum, line) => sum + asNumber(line.credit) - asNumber(line.debit),
          0,
        ),
    );
  }

  const subledgerAccumDepr = roundMoney(postedDepreciation + openingAccumDepr);

  const difference = roundMoney(attributed - subledgerAccumDepr);
  return {
    glActivity,
    subledgerAttributed: attributed,
    subledgerAccumDepr,
    unassigned,
    difference,
  };
}

export async function buildDepreciationExpenseReconciliation(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: AccountLookup[],
  periodYear: number,
  periodMonth: number,
): Promise<GlReconciliationSlice & { subledgerDeprExpense: number }> {
  const expenseAccounts = accountsBySubtype(accounts, FIXED_ASSET_SUBTYPES.depreciationExpense);
  const accountIds = expenseAccounts.map((account) => account.id);

  const periodStart = `${periodYear}-${String(periodMonth).padStart(2, "0")}-01`;
  const periodEnd =
    periodMonth === 12
      ? `${periodYear + 1}-01-01`
      : `${periodYear}-${String(periodMonth + 1).padStart(2, "0")}-01`;

  const lines = await loadActiveJournalLines(supabase, organizationId, accountIds);
  const periodLines = [];
  for (const line of lines) {
    const { data: entry } = await supabase
      .from("teller_journal_entries")
      .select("entry_date")
      .eq("id", line.entry_id)
      .maybeSingle();
    const entryDate = entry?.entry_date as string | undefined;
    if (!entryDate || entryDate < periodStart || entryDate >= periodEnd) continue;
    periodLines.push(line);
  }

  const { glActivity, attributed, unassigned } = sliceFromLines(
    periodLines,
    (debit, credit) => debit - credit,
  );

  const { data: entries } = await supabase
    .from("teller_fixed_asset_depreciation_entries")
    .select("amount")
    .eq("organization_id", organizationId)
    .eq("period_year", periodYear)
    .eq("period_month", periodMonth)
    .eq("status", "posted");

  const subledgerDeprExpense = roundMoney(
    (entries ?? []).reduce((sum, row) => sum + asNumber(row.amount), 0),
  );

  const difference = roundMoney(glActivity - subledgerDeprExpense);
  return {
    glActivity,
    subledgerAttributed: attributed,
    subledgerDeprExpense,
    unassigned,
    difference,
  };
}

export async function buildFixedAssetReconciliationReport(
  supabase: SupabaseClient,
  organizationId: string,
  input?: {
    asOfDate?: string | null;
    periodYear?: number;
    periodMonth?: number;
  },
) {
  const { data: accountsRaw } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype")
    .eq("organization_id", organizationId);
  const accounts = (accountsRaw ?? []) as AccountLookup[];

  const asOfDate = input?.asOfDate ?? null;
  const periodYear = input?.periodYear ?? new Date().getFullYear();
  const periodMonth = input?.periodMonth ?? new Date().getMonth() + 1;

  const cost = await buildFixedAssetCostReconciliation(supabase, organizationId, accounts, asOfDate);
  const accum = await buildAccumulatedDepreciationReconciliation(
    supabase,
    organizationId,
    accounts,
    asOfDate,
  );
  const expense = await buildDepreciationExpenseReconciliation(
    supabase,
    organizationId,
    accounts,
    periodYear,
    periodMonth,
  );

  return {
    asOfDate,
    periodYear,
    periodMonth,
    fixedAssetCost: cost,
    accumulatedDepreciation: accum,
    depreciationExpense: expense,
    consistent:
      Math.abs(cost.difference) <= TOLERANCE &&
      Math.abs(accum.difference) <= TOLERANCE &&
      Math.abs(expense.difference) <= TOLERANCE,
  };
}
