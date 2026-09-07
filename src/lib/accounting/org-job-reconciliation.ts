import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import type { AccountRow } from "./reports";
import {
  isEconomicDirectCostLine,
  isEconomicRevenueActivity,
  plAmountForAccountType,
  type GlReconciliationSlice,
} from "./job-profitability";
import { roundMoney } from "./payment-fees";

type JournalLineRow = {
  account_id: string;
  debit: number;
  credit: number;
  job_id: string | null;
  cost_classification?: string | null;
  entry_id: string;
};

async function loadActiveEconomicLines(
  supabase: SupabaseClient,
  organizationId: string,
  throughDate?: string | null,
): Promise<JournalLineRow[]> {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, reverses_entry_id")
    .eq("organization_id", organizationId);

  const entryIds = (entries ?? []).map((row) => row.id as string);
  if (!entryIds.length) return [];

  const entryDates = new Map((entries ?? []).map((row) => [row.id as string, row.entry_date as string]));
  const reversalEntries = new Set(
    (entries ?? []).filter((row) => row.reverses_entry_id).map((row) => row.id as string),
  );

  const { data: reversals } = await supabase
    .from("teller_journal_entries")
    .select("reverses_entry_id")
    .eq("organization_id", organizationId)
    .in("reverses_entry_id", entryIds);

  const reversedOriginals = new Set(
    (reversals ?? []).map((row) => row.reverses_entry_id as string),
  );

  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("account_id, debit, credit, job_id, cost_classification, entry_id")
    .in("entry_id", entryIds);

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

function orgWideSlice(
  lines: JournalLineRow[],
  accounts: AccountRow[],
  types: string[],
  economic: (type: string, d: number, c: number, cc?: string | null) => boolean,
): GlReconciliationSlice {
  const accountMap = new Map(accounts.map((row) => [row.id, row]));
  let glActivity = 0;
  let jobAttributed = 0;

  for (const line of lines) {
    const account = accountMap.get(line.account_id);
    if (!account || !types.includes(account.type)) continue;
    const debit = asNumber(line.debit);
    const credit = asNumber(line.credit);
    if (!economic(account.type, debit, credit, line.cost_classification)) continue;
    const amount = plAmountForAccountType(account.type, debit, credit);
    glActivity = roundMoney(glActivity + amount);
    if (line.job_id) jobAttributed = roundMoney(jobAttributed + amount);
  }

  const unassigned = roundMoney(glActivity - jobAttributed);
  return { glActivity, jobAttributed, unassigned, difference: unassigned };
}

export type OrgJobGlReconciliation = {
  revenue: GlReconciliationSlice;
  directCost: GlReconciliationSlice;
  consistent: boolean;
};

export async function buildOrgJobGlReconciliation(
  supabase: SupabaseClient,
  organizationId: string,
  asOfDate?: string | null,
): Promise<OrgJobGlReconciliation> {
  const { data: accountsRaw } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype")
    .eq("organization_id", organizationId);
  const accounts = (accountsRaw ?? []) as AccountRow[];
  const lines = await loadActiveEconomicLines(supabase, organizationId, asOfDate);

  const revenue = orgWideSlice(lines, accounts, ["revenue"], isEconomicRevenueActivity);
  const directCost = orgWideSlice(lines, accounts, ["cogs", "expense"], isEconomicDirectCostLine);

  return {
    revenue,
    directCost,
    consistent:
      Math.abs(revenue.difference) <= 0.01 && Math.abs(directCost.difference) <= 0.01,
  };
}
