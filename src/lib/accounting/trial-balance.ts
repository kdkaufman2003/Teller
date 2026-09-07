import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import type { AccountRow } from "./reports";
import { roundMoney } from "./payment-fees";

const ADJUSTMENT_SOURCE_KINDS = new Set(["adjustment"]);

export function computeTrialBalanceRowTotals(input: {
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  adjustmentDebit: number;
  adjustmentCredit: number;
}) {
  const unadjustedDebit = roundMoney(
    input.openingDebit + input.periodDebit - input.adjustmentDebit,
  );
  const unadjustedCredit = roundMoney(
    input.openingCredit + input.periodCredit - input.adjustmentCredit,
  );
  const adjustedDebit = roundMoney(unadjustedDebit + input.adjustmentDebit);
  const adjustedCredit = roundMoney(unadjustedCredit + input.adjustmentCredit);
  return { unadjustedDebit, unadjustedCredit, adjustedDebit, adjustedCredit };
}

export function isTrialBalanceBalanced(
  adjustedDebit: number,
  adjustedCredit: number,
  tolerance = 0.01,
): boolean {
  return Math.abs(adjustedDebit - adjustedCredit) <= tolerance;
}

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  unadjustedDebit: number;
  unadjustedCredit: number;
  adjustmentDebit: number;
  adjustmentCredit: number;
  adjustedDebit: number;
  adjustedCredit: number;
};

export type TrialBalanceReport = {
  periodStart: string | null;
  periodEnd: string;
  rows: TrialBalanceRow[];
  totals: {
    unadjustedDebit: number;
    unadjustedCredit: number;
    adjustmentDebit: number;
    adjustmentCredit: number;
    adjustedDebit: number;
    adjustedCredit: number;
  };
  balanced: boolean;
};

type LineRow = {
  account_id: string;
  debit: number;
  credit: number;
  entry_id: string;
};

async function loadScopedLines(
  supabase: SupabaseClient,
  organizationId: string,
  periodEnd: string,
  periodStart: string | null,
) {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, source_kind, reverses_entry_id")
    .eq("organization_id", organizationId)
    .lte("entry_date", periodEnd);

  const entryMap = new Map(
    (entries ?? []).map((row) => [
      row.id as string,
      {
        entry_date: row.entry_date as string,
        source_kind: (row.source_kind as string | null) ?? null,
        reverses_entry_id: row.reverses_entry_id as string | null,
      },
    ]),
  );

  const entryIds = [...entryMap.keys()];
  if (!entryIds.length) return [] as Array<LineRow & { entry_date: string; source_kind: string | null; isAdjustment: boolean }>;

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
    .select("account_id, debit, credit, entry_id")
    .in("entry_id", entryIds);

  const result: Array<LineRow & { entry_date: string; source_kind: string | null; isAdjustment: boolean }> = [];
  for (const line of lines ?? []) {
    const entryId = line.entry_id as string;
    if (reversalEntries.has(entryId) || reversedOriginals.has(entryId)) continue;
    const entry = entryMap.get(entryId);
    if (!entry) continue;
    result.push({
      account_id: line.account_id as string,
      debit: asNumber(line.debit),
      credit: asNumber(line.credit),
      entry_id: entryId,
      entry_date: entry.entry_date,
      source_kind: entry.source_kind,
      isAdjustment: ADJUSTMENT_SOURCE_KINDS.has(entry.source_kind ?? ""),
    });
  }
  return result;
}

export async function buildTrialBalance(
  supabase: SupabaseClient,
  organizationId: string,
  input: { periodStart?: string | null; periodEnd: string },
): Promise<TrialBalanceReport> {
  const periodEnd = input.periodEnd.slice(0, 10);
  const periodStart = input.periodStart?.slice(0, 10) ?? null;

  const { data: accountsRaw } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype")
    .eq("organization_id", organizationId);
  const accounts = (accountsRaw ?? []) as AccountRow[];

  const lines = await loadScopedLines(supabase, organizationId, periodEnd, periodStart);
  const totalsByAccount = new Map<
    string,
    {
      openingDebit: number;
      openingCredit: number;
      periodDebit: number;
      periodCredit: number;
      adjustmentDebit: number;
      adjustmentCredit: number;
    }
  >();

  for (const account of accounts) {
    totalsByAccount.set(account.id, {
      openingDebit: 0,
      openingCredit: 0,
      periodDebit: 0,
      periodCredit: 0,
      adjustmentDebit: 0,
      adjustmentCredit: 0,
    });
  }

  for (const line of lines) {
    const bucket = totalsByAccount.get(line.account_id);
    if (!bucket) continue;
    const inOpening = periodStart ? line.entry_date < periodStart : false;
    const inPeriod =
      (!periodStart || line.entry_date >= periodStart) && line.entry_date <= periodEnd;

    if (inOpening) {
      bucket.openingDebit = roundMoney(bucket.openingDebit + line.debit);
      bucket.openingCredit = roundMoney(bucket.openingCredit + line.credit);
    }
    if (inPeriod) {
      bucket.periodDebit = roundMoney(bucket.periodDebit + line.debit);
      bucket.periodCredit = roundMoney(bucket.periodCredit + line.credit);
      if (line.isAdjustment) {
        bucket.adjustmentDebit = roundMoney(bucket.adjustmentDebit + line.debit);
        bucket.adjustmentCredit = roundMoney(bucket.adjustmentCredit + line.credit);
      }
    }
  }

  const rows: TrialBalanceRow[] = accounts.map((account) => {
    const bucket = totalsByAccount.get(account.id)!;
    const { unadjustedDebit, unadjustedCredit, adjustedDebit, adjustedCredit } =
      computeTrialBalanceRowTotals(bucket);
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      openingDebit: bucket.openingDebit,
      openingCredit: bucket.openingCredit,
      periodDebit: bucket.periodDebit,
      periodCredit: bucket.periodCredit,
      unadjustedDebit,
      unadjustedCredit,
      adjustmentDebit: bucket.adjustmentDebit,
      adjustmentCredit: bucket.adjustmentCredit,
      adjustedDebit,
      adjustedCredit,
    };
  }).filter(
    (row) =>
      row.unadjustedDebit !== 0 ||
      row.unadjustedCredit !== 0 ||
      row.adjustmentDebit !== 0 ||
      row.adjustmentCredit !== 0,
  );

  const totals = rows.reduce(
    (sum, row) => ({
      unadjustedDebit: roundMoney(sum.unadjustedDebit + row.unadjustedDebit),
      unadjustedCredit: roundMoney(sum.unadjustedCredit + row.unadjustedCredit),
      adjustmentDebit: roundMoney(sum.adjustmentDebit + row.adjustmentDebit),
      adjustmentCredit: roundMoney(sum.adjustmentCredit + row.adjustmentCredit),
      adjustedDebit: roundMoney(sum.adjustedDebit + row.adjustedDebit),
      adjustedCredit: roundMoney(sum.adjustedCredit + row.adjustedCredit),
    }),
    {
      unadjustedDebit: 0,
      unadjustedCredit: 0,
      adjustmentDebit: 0,
      adjustmentCredit: 0,
      adjustedDebit: 0,
      adjustedCredit: 0,
    },
  );

  return {
    periodStart,
    periodEnd,
    rows,
    totals,
    balanced: isTrialBalanceBalanced(totals.adjustedDebit, totals.adjustedCredit),
  };
}
