import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";
import type { AccountRow } from "./reports";

export type GlAccountTotalRow = {
  account_id: string;
  opening_debit: number | string;
  opening_credit: number | string;
  period_debit: number | string;
  period_credit: number | string;
};

export type ReportEngineLine = {
  account_id: string;
  debit: number | string;
  credit: number | string;
  entry_date: string;
  entry_id?: string;
  source_kind?: string | null;
};

const EPOCH_START = "1970-01-01";

export async function fetchGlAccountTotals(
  supabase: SupabaseClient,
  organizationId: string,
  periodStart: string,
  periodEnd: string,
): Promise<GlAccountTotalRow[] | null> {
  const { data, error } = await supabase.rpc("teller_gl_account_totals", {
    p_organization_id: organizationId,
    p_period_start: periodStart.slice(0, 10),
    p_period_end: periodEnd.slice(0, 10),
  });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("does not exist") || msg.includes("schema cache")) return null;
    throw new Error(error.message);
  }

  return (data ?? []) as GlAccountTotalRow[];
}

export function balanceForAccountType(type: string, debit: number, credit: number): number {
  if (type === "asset") return roundMoney(debit - credit);
  if (type === "liability" || type === "equity") return roundMoney(credit - debit);
  if (type === "revenue") return roundMoney(credit - debit);
  if (type === "cogs" || type === "expense") return roundMoney(debit - credit);
  return roundMoney(debit - credit);
}

export function cumulativeBalanceFromTotals(
  row: GlAccountTotalRow,
  accountType: string,
): number {
  const debit = asNumber(row.opening_debit) + asNumber(row.period_debit);
  const credit = asNumber(row.opening_credit) + asNumber(row.period_credit);
  return balanceForAccountType(accountType, debit, credit);
}

export function periodActivityFromTotals(row: GlAccountTotalRow, accountType: string): number {
  return balanceForAccountType(
    accountType,
    asNumber(row.period_debit),
    asNumber(row.period_credit),
  );
}

/** Synthetic journal lines representing cumulative balances through periodEnd. */
export function synthesizeCumulativeLines(
  totals: GlAccountTotalRow[],
  accounts: AccountRow[],
  asOfDate: string,
): ReportEngineLine[] {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const lines: ReportEngineLine[] = [];

  for (const row of totals) {
    const account = accountMap.get(row.account_id);
    if (!account) continue;
    const balance = cumulativeBalanceFromTotals(row, account.type);
    if (Math.abs(balance) < 0.005) continue;

    if (account.type === "asset" || account.type === "expense" || account.type === "cogs") {
      if (balance >= 0) {
        lines.push({
          account_id: account.id,
          debit: balance,
          credit: 0,
          entry_date: asOfDate,
        });
      } else {
        lines.push({
          account_id: account.id,
          debit: 0,
          credit: Math.abs(balance),
          entry_date: asOfDate,
        });
      }
    } else {
      if (balance >= 0) {
        lines.push({
          account_id: account.id,
          debit: 0,
          credit: balance,
          entry_date: asOfDate,
        });
      } else {
        lines.push({
          account_id: account.id,
          debit: Math.abs(balance),
          credit: 0,
          entry_date: asOfDate,
        });
      }
    }
  }

  return lines;
}

/** Synthetic journal lines for P&L activity within a period. */
export function synthesizePeriodPlLines(
  totals: GlAccountTotalRow[],
  accounts: AccountRow[],
  entryDate: string,
): ReportEngineLine[] {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const lines: ReportEngineLine[] = [];

  for (const row of totals) {
    const account = accountMap.get(row.account_id);
    if (!account) continue;
    if (!["revenue", "cogs", "expense"].includes(account.type)) continue;

    const activity = periodActivityFromTotals(row, account.type);
    if (Math.abs(activity) < 0.005) continue;

    if (account.type === "revenue") {
      lines.push({
        account_id: account.id,
        debit: activity < 0 ? Math.abs(activity) : 0,
        credit: activity >= 0 ? activity : 0,
        entry_date: entryDate,
      });
    } else {
      lines.push({
        account_id: account.id,
        debit: activity >= 0 ? activity : 0,
        credit: activity < 0 ? Math.abs(activity) : 0,
        entry_date: entryDate,
      });
    }
  }

  return lines;
}

export function netIncomeFromTotals(totals: GlAccountTotalRow[], accounts: AccountRow[]): number {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  let revenue = 0;
  let cogs = 0;
  let expenses = 0;

  for (const row of totals) {
    const account = accountMap.get(row.account_id);
    if (!account) continue;
    const activity = periodActivityFromTotals(row, account.type);
    if (account.type === "revenue") revenue += activity;
    else if (account.type === "cogs") cogs += activity;
    else if (account.type === "expense") expenses += activity;
  }

  return roundMoney(revenue - cogs - expenses);
}

export function accountBalancesMapFromTotals(
  totals: GlAccountTotalRow[],
  accounts: AccountRow[],
): Map<string, number> {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const balances = new Map<string, number>();
  for (const row of totals) {
    const account = accountMap.get(row.account_id);
    if (!account) continue;
    balances.set(row.account_id, cumulativeBalanceFromTotals(row, account.type));
  }
  return balances;
}

export function depreciationInPeriodFromTotals(
  totals: GlAccountTotalRow[],
  accounts: AccountRow[],
): number {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  let total = 0;
  for (const row of totals) {
    const account = accountMap.get(row.account_id);
    if (!account) continue;
    if (
      account.subtype === "depreciation" ||
      account.name.toLowerCase().includes("depreciation")
    ) {
      total += periodActivityFromTotals(row, account.type);
    }
  }
  return roundMoney(total);
}

export function salesTaxPayableBalanceFromTotals(
  totals: GlAccountTotalRow[],
  accounts: AccountRow[],
): number {
  const taxAccount = accounts.find(
    (a) =>
      a.subtype === "tax" ||
      a.subtype === "sales_tax_payable" ||
      a.code === "2200" ||
      a.name.toLowerCase().includes("sales tax"),
  );
  if (!taxAccount) return 0;
  const row = totals.find((r) => r.account_id === taxAccount.id);
  if (!row) return 0;
  return cumulativeBalanceFromTotals(row, taxAccount.type);
}

export async function loadCumulativeTotalsThrough(
  supabase: SupabaseClient,
  organizationId: string,
  asOfDate: string,
): Promise<GlAccountTotalRow[] | null> {
  return fetchGlAccountTotals(supabase, organizationId, EPOCH_START, asOfDate.slice(0, 10));
}

export async function loadPeriodTotals(
  supabase: SupabaseClient,
  organizationId: string,
  periodStart: string | null,
  periodEnd: string,
): Promise<GlAccountTotalRow[] | null> {
  return fetchGlAccountTotals(
    supabase,
    organizationId,
    periodStart ?? EPOCH_START,
    periodEnd.slice(0, 10),
  );
}

function isCashAccount(account: AccountRow): boolean {
  return account.subtype === "bank" || account.code === "1000";
}

/** Bounded period fetch: entry-level lines in period for cash-flow movement classification. */
export async function loadCashFlowPeriodLines(
  supabase: SupabaseClient,
  organizationId: string,
  accounts: AccountRow[],
  periodStart: string | null,
  periodEnd: string,
  legalEntityId?: string | null,
): Promise<{ lines: ReportEngineLine[]; entrySourceKinds: Map<string, string | null> }> {
  const start = (periodStart ?? periodEnd).slice(0, 10);
  const end = periodEnd.slice(0, 10);
  const cashAccountIds = new Set(accounts.filter(isCashAccount).map((a) => a.id));

  let entriesQuery = supabase
    .from("teller_journal_entries")
    .select("id, entry_date, source_kind")
    .eq("organization_id", organizationId)
    .gte("entry_date", start)
    .lte("entry_date", end);
  if (legalEntityId?.trim()) {
    entriesQuery = entriesQuery.eq("legal_entity_id", legalEntityId.trim());
  }
  const { data: entries, error: entriesError } = await entriesQuery;
  if (entriesError) throw new Error(entriesError.message);

  const entryIds = (entries ?? []).map((e) => e.id as string);
  const entrySourceKinds = new Map(
    (entries ?? []).map((e) => [e.id as string, (e.source_kind as string | null) ?? null]),
  );
  if (!entryIds.length) {
    return { lines: [], entrySourceKinds };
  }

  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, account_id, debit, credit")
    .in("entry_id", entryIds);
  if (linesError) throw new Error(linesError.message);

  const entriesWithCash = new Set<string>();
  for (const line of lines ?? []) {
    if (cashAccountIds.has(line.account_id as string)) {
      entriesWithCash.add(line.entry_id as string);
    }
  }

  const entryDates = new Map((entries ?? []).map((e) => [e.id as string, e.entry_date as string]));
  const reportLines: ReportEngineLine[] = (lines ?? []).flatMap((line) => {
    const entryId = line.entry_id as string;
    if (!entriesWithCash.has(entryId)) return [];
    const entryDate = entryDates.get(entryId);
    if (!entryDate) return [];
    return [
      {
        entry_id: entryId,
        account_id: line.account_id as string,
        debit: line.debit,
        credit: line.credit,
        entry_date: entryDate,
        source_kind: entrySourceKinds.get(entryId) ?? null,
      },
    ];
  });

  return { lines: reportLines, entrySourceKinds };
}

/** Legacy fallback when migration 026 RPC is unavailable (local dev without 026). */
export async function loadLegacyDatedLines(
  supabase: SupabaseClient,
  organizationId: string,
  asOfDate: string,
  legalEntityId?: string | null,
): Promise<{
  datedLines: ReportEngineLine[];
  entrySourceKinds: Map<string, string | null>;
}> {
  let entriesQuery = supabase
    .from("teller_journal_entries")
    .select("id, entry_date, source_kind")
    .eq("organization_id", organizationId)
    .lte("entry_date", asOfDate);
  if (legalEntityId?.trim()) {
    entriesQuery = entriesQuery.eq("legal_entity_id", legalEntityId.trim());
  }
  const { data: entries } = await entriesQuery;

  const entryIds = (entries ?? []).map((e) => e.id as string);
  const entrySourceKinds = new Map(
    (entries ?? []).map((e) => [e.id as string, (e.source_kind as string | null) ?? null]),
  );

  if (!entryIds.length) {
    return { datedLines: [], entrySourceKinds };
  }

  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("entry_id, account_id, debit, credit")
    .in("entry_id", entryIds);

  const entryDates = new Map((entries ?? []).map((e) => [e.id as string, e.entry_date as string]));
  const datedLines = (lines ?? []).flatMap((line) => {
    const entryDate = entryDates.get(line.entry_id as string);
    if (!entryDate) return [];
    return [
      {
        entry_id: line.entry_id as string,
        account_id: line.account_id as string,
        debit: line.debit,
        credit: line.credit,
        entry_date: entryDate,
        source_kind: entrySourceKinds.get(line.entry_id as string) ?? null,
      },
    ];
  });

  return { datedLines, entrySourceKinds };
}

export function mergeCashFlowLines(
  cumulativeLines: ReportEngineLine[],
  cashFlowPeriodLines: ReportEngineLine[],
): ReportEngineLine[] {
  const byKey = new Map<string, ReportEngineLine>();
  for (const line of cumulativeLines) {
    byKey.set(`${line.account_id}:${line.entry_date}:${line.debit}:${line.credit}`, line);
  }
  for (const line of cashFlowPeriodLines) {
    byKey.set(`${line.entry_id}:${line.account_id}:${line.debit}:${line.credit}`, line);
  }
  return [...byKey.values()];
}
