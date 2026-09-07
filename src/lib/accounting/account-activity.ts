import { asNumber } from "@/lib/format";
import { computeRunningBalance } from "./gl-report";
import { resolveJournalSource } from "./source-resolver";
import type { AccountRow } from "./reports";

export type AccountActivityLine = {
  lineId: string;
  entryId: string;
  entryDate: string;
  memo: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
  sourceKind: string | null;
  sourceId: string | null;
  source: ReturnType<typeof resolveJournalSource>;
};

export type AccountActivityReport = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  startDate: string | null;
  endDate: string | null;
  openingBalance: number;
  closingBalance: number;
  lines: AccountActivityLine[];
};

type RawEntry = {
  id: string;
  entry_date: string;
  memo: string | null;
  source_kind: string | null;
  source_id: string | null;
  reverses_entry_id: string | null;
};

type RawLine = {
  id: string;
  entry_id: string;
  account_id: string;
  debit: number | string;
  credit: number | string;
  memo?: string | null;
};

function balanceDelta(accountType: string, debit: number, credit: number): number {
  const normalDebit = accountType === "asset" || accountType === "expense" || accountType === "cogs";
  return normalDebit ? debit - credit : credit - debit;
}

export function buildAccountActivityReport(input: {
  account: AccountRow;
  entries: RawEntry[];
  lines: RawLine[];
  startDate: string | null;
  endDate: string | null;
}): AccountActivityReport {
  const entryMap = new Map(input.entries.map((e) => [e.id, e]));
  const scoped = input.lines
    .filter((line) => line.account_id === input.account.id)
    .map((line) => {
      const entry = entryMap.get(line.entry_id);
      if (!entry) return null;
      return { line, entry };
    })
    .filter(Boolean) as Array<{ line: RawLine; entry: RawEntry }>;

  scoped.sort((a, b) => {
    const dateCmp = a.entry.entry_date.localeCompare(b.entry.entry_date);
    if (dateCmp !== 0) return dateCmp;
    return a.entry.id.localeCompare(b.entry.id);
  });

  let openingBalance = 0;
  const periodLines: Array<{
    entryDate: string;
    debit: number;
    credit: number;
    meta: { line: RawLine; entry: RawEntry };
  }> = [];

  for (const { line, entry } of scoped) {
    const debit = asNumber(line.debit);
    const credit = asNumber(line.credit);
    const delta = balanceDelta(input.account.type, debit, credit);
    const inOpening =
      input.startDate && entry.entry_date < input.startDate.slice(0, 10);
    const inPeriod =
      (!input.startDate || entry.entry_date >= input.startDate.slice(0, 10)) &&
      (!input.endDate || entry.entry_date <= input.endDate.slice(0, 10));

    if (inOpening) openingBalance += delta;
    if (inPeriod) {
      periodLines.push({ entryDate: entry.entry_date, debit, credit, meta: { line, entry } });
    }
  }

  openingBalance = Math.round(openingBalance * 100) / 100;
  const running = computeRunningBalance(
    periodLines.map((row) => ({ entryDate: row.entryDate, debit: row.debit, credit: row.credit })),
    input.account.type,
  );

  const activityLines: AccountActivityLine[] = periodLines.map((row, index) => {
    const { line, entry } = row.meta;
    const rb = Math.round((openingBalance + (running[index] ?? 0)) * 100) / 100;
    return {
      lineId: line.id,
      entryId: entry.id,
      entryDate: entry.entry_date,
      memo: entry.memo,
      debit: row.debit,
      credit: row.credit,
      runningBalance: rb,
      sourceKind: entry.source_kind,
      sourceId: entry.source_id,
      source: resolveJournalSource({
        sourceKind: entry.source_kind,
        sourceId: entry.source_id,
        memo: entry.memo,
        reversesEntryId: entry.reverses_entry_id,
      }),
    };
  });

  const periodDelta = periodLines.reduce(
    (sum, row) => sum + balanceDelta(input.account.type, row.debit, row.credit),
    0,
  );
  const closingBalance = Math.round((openingBalance + periodDelta) * 100) / 100;

  return {
    accountId: input.account.id,
    accountCode: input.account.code,
    accountName: input.account.name,
    accountType: input.account.type,
    startDate: input.startDate,
    endDate: input.endDate,
    openingBalance,
    closingBalance,
    lines: activityLines,
  };
}
