import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";
import { inReportDateRange } from "./report-context";
import { resolveJournalSource } from "./source-resolver";
import type { AccountRow, JournalLineRow } from "./reports";

export type GlReportEntry = {
  id: string;
  entryDate: string;
  memo: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  reversesEntryId: string | null;
  lines: GlReportLine[];
  source: ReturnType<typeof resolveJournalSource>;
};

export type GlReportLine = {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  memo: string | null;
  jobId: string | null;
};

export type GlReportResult = {
  entries: GlReportEntry[];
  totalCount: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type GlReportFilters = {
  startDate?: string | null;
  endDate?: string | null;
  accountId?: string | null;
  sourceKind?: string | null;
  search?: string | null;
  jobId?: string | null;
  page?: number;
  pageSize?: number;
};

type RawEntry = {
  id: string;
  entry_date: string;
  memo: string | null;
  source_kind: string | null;
  source_id: string | null;
  reverses_entry_id: string | null;
};

type RawLine = JournalLineRow & {
  id: string;
  entry_id: string;
  memo?: string | null;
  job_id?: string | null;
};

export function filterGlEntries(
  entries: RawEntry[],
  lines: RawLine[],
  accounts: AccountRow[],
  filters: GlReportFilters,
): GlReportEntry[] {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const linesByEntry = new Map<string, RawLine[]>();
  for (const line of lines) {
    const bucket = linesByEntry.get(line.entry_id) ?? [];
    bucket.push(line);
    linesByEntry.set(line.entry_id, bucket);
  }

  const search = filters.search?.trim().toLowerCase() ?? "";

  let filtered = entries.filter((entry) => {
    if (filters.startDate && entry.entry_date < filters.startDate) return false;
    if (filters.endDate && entry.entry_date > filters.endDate) return false;
    if (filters.sourceKind && entry.source_kind !== filters.sourceKind) return false;
    if (search) {
      const memoMatch = entry.memo?.toLowerCase().includes(search);
      const entryLines = linesByEntry.get(entry.id) ?? [];
      const lineMatch = entryLines.some((l) => l.memo?.toLowerCase().includes(search));
      if (!memoMatch && !lineMatch) return false;
    }
    return true;
  });

  if (filters.accountId || filters.jobId) {
    filtered = filtered.filter((entry) => {
      const entryLines = linesByEntry.get(entry.id) ?? [];
      if (filters.accountId && !entryLines.some((l) => l.account_id === filters.accountId)) {
        return false;
      }
      if (filters.jobId && !entryLines.some((l) => l.job_id === filters.jobId)) {
        return false;
      }
      return true;
    });
  }

  return filtered
    .sort((a, b) => {
      const dateCmp = b.entry_date.localeCompare(a.entry_date);
      if (dateCmp !== 0) return dateCmp;
      return b.id.localeCompare(a.id);
    })
    .map((entry) => {
      const entryLines = (linesByEntry.get(entry.id) ?? []).map((line) => {
        const account = accountMap.get(line.account_id);
        return {
          id: line.id,
          accountId: line.account_id,
          accountCode: account?.code ?? "",
          accountName: account?.name ?? "Account",
          debit: asNumber(line.debit),
          credit: asNumber(line.credit),
          memo: line.memo ?? null,
          jobId: line.job_id ?? null,
        };
      });

      return {
        id: entry.id,
        entryDate: entry.entry_date,
        memo: entry.memo,
        sourceKind: entry.source_kind,
        sourceId: entry.source_id,
        reversesEntryId: entry.reverses_entry_id,
        lines: entryLines,
        source: resolveJournalSource({
          sourceKind: entry.source_kind,
          sourceId: entry.source_id,
          memo: entry.memo,
          reversesEntryId: entry.reverses_entry_id,
        }),
      };
    });
}

export function paginateGlReport(
  entries: GlReportEntry[],
  page = 1,
  pageSize = 50,
): GlReportResult {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(200, Math.max(10, pageSize));
  const start = (safePage - 1) * safeSize;
  const slice = entries.slice(start, start + safeSize);
  return {
    entries: slice,
    totalCount: entries.length,
    page: safePage,
    pageSize: safeSize,
    hasMore: start + safeSize < entries.length,
  };
}

export function computeRunningBalance(
  lines: Array<{ entryDate: string; debit: number; credit: number }>,
  accountType: string,
): number[] {
  let balance = 0;
  const normalDebit = accountType === "asset" || accountType === "expense" || accountType === "cogs";
  return lines.map((line) => {
    const delta = normalDebit
      ? roundMoney(line.debit - line.credit)
      : roundMoney(line.credit - line.debit);
    balance = roundMoney(balance + delta);
    return balance;
  });
}

export function sumJournalLinesInRange(
  lines: Array<JournalLineRow & { entry_date: string }>,
  accounts: AccountRow[],
  startDate: string | null,
  endDate: string | null,
  accountTypes?: string[],
): Map<string, number> {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const totals = new Map<string, number>();

  for (const line of lines) {
    if (!inReportDateRange(line.entry_date, startDate, endDate)) continue;
    const account = accountMap.get(line.account_id);
    if (!account) continue;
    if (accountTypes && !accountTypes.includes(account.type)) continue;

    let delta = 0;
    if (account.type === "revenue") delta = asNumber(line.credit) - asNumber(line.debit);
    else if (account.type === "cogs" || account.type === "expense") {
      delta = asNumber(line.debit) - asNumber(line.credit);
    } else if (account.type === "asset") {
      delta = asNumber(line.debit) - asNumber(line.credit);
    } else if (account.type === "liability" || account.type === "equity") {
      delta = asNumber(line.credit) - asNumber(line.debit);
    }

    totals.set(account.id, roundMoney((totals.get(account.id) ?? 0) + delta));
  }

  return totals;
}
