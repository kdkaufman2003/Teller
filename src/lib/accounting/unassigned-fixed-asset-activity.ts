import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { accountsBySubtype, FIXED_ASSET_SUBTYPES } from "./fixed-asset-accounts";
import type { AccountLookup } from "./fixed-asset-types";

export type UnassignedFixedAssetActivityRow = {
  accountCode: string;
  accountName: string;
  entryId: string;
  entryDate: string;
  sourceKind: string | null;
  debit: number;
  credit: number;
  memo: string;
};

export async function listUnassignedFixedAssetActivity(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<UnassignedFixedAssetActivityRow[]> {
  const { data: accountsRaw } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype")
    .eq("organization_id", organizationId);
  const accounts = (accountsRaw ?? []) as AccountLookup[];

  const controlSubtypes = new Set<string>([
    FIXED_ASSET_SUBTYPES.fixedAsset,
    FIXED_ASSET_SUBTYPES.accumulatedDepreciation,
    FIXED_ASSET_SUBTYPES.depreciationExpense,
  ]);

  const controlAccounts = accounts.filter((account) => controlSubtypes.has(account.subtype ?? ""));
  if (!controlAccounts.length) return [];

  const accountMap = new Map(controlAccounts.map((account) => [account.id, account]));
  const accountIds = controlAccounts.map((account) => account.id);

  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit, memo, fixed_asset_id, entry_id")
    .in("account_id", accountIds)
    .is("fixed_asset_id", null);

  const entryIds = [...new Set((lines ?? []).map((line) => line.entry_id as string))];
  if (!entryIds.length) return [];

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, source_kind, reverses_entry_id")
    .eq("organization_id", organizationId)
    .in("id", entryIds);

  const entryMap = new Map((entries ?? []).map((entry) => [entry.id as string, entry]));
  const reversalEntries = new Set(
    (entries ?? []).filter((entry) => entry.reverses_entry_id).map((entry) => entry.id as string),
  );

  const rows: UnassignedFixedAssetActivityRow[] = [];
  for (const line of lines ?? []) {
    const entryId = line.entry_id as string;
    if (reversalEntries.has(entryId)) continue;
    const entry = entryMap.get(entryId);
    if (!entry) continue;
    const account = accountMap.get(line.account_id as string);
    if (!account) continue;
    const debit = asNumber(line.debit);
    const credit = asNumber(line.credit);
    if (debit <= 0 && credit <= 0) continue;

    rows.push({
      accountCode: account.code,
      accountName: account.name,
      entryId,
      entryDate: entry.entry_date as string,
      sourceKind: (entry.source_kind as string | null) ?? null,
      debit,
      credit,
      memo: (line.memo as string) || "",
    });
  }

  return rows.sort((a, b) => b.entryDate.localeCompare(a.entryDate));
}
