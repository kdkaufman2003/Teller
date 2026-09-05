import { asNumber } from "@/lib/format";

export type CsvRow = Record<string, string | number | null | undefined>;

export function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function rowsToCsv(rows: CsvRow[], columns: { key: string; header: string }[]): string {
  const header = columns.map((column) => escapeCsvValue(column.header)).join(",");
  const body = rows.map((row) =>
    columns.map((column) => escapeCsvValue(row[column.key])).join(","),
  );
  return [header, ...body].join("\n");
}

export type ExportJournalEntry = {
  entry_date: string;
  memo: string;
  source_kind: string | null;
  account_code: string;
  account_name: string;
  debit: number | string;
  credit: number | string;
  line_memo: string;
};

export function buildJournalCsv(entries: ExportJournalEntry[]): string {
  return rowsToCsv(entries, [
    { key: "entry_date", header: "Entry Date" },
    { key: "source_kind", header: "Source" },
    { key: "memo", header: "Entry Memo" },
    { key: "account_code", header: "Account Code" },
    { key: "account_name", header: "Account Name" },
    { key: "debit", header: "Debit" },
    { key: "credit", header: "Credit" },
    { key: "line_memo", header: "Line Memo" },
  ]);
}

export type ExportTrialBalanceRow = {
  code: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
  net: number;
};

export function buildTrialBalanceCsv(rows: ExportTrialBalanceRow[]): string {
  return rowsToCsv(rows, [
    { key: "code", header: "Account Code" },
    { key: "name", header: "Account Name" },
    { key: "type", header: "Type" },
    { key: "debit", header: "Debit" },
    { key: "credit", header: "Credit" },
    { key: "net", header: "Net" },
  ]);
}

export type ExportPartyRow = {
  name: string;
  kind: string;
  email: string;
  phone: string;
};

export function buildPartiesCsv(rows: ExportPartyRow[]): string {
  return rowsToCsv(rows, [
    { key: "name", header: "Name" },
    { key: "kind", header: "Kind" },
    { key: "email", header: "Email" },
    { key: "phone", header: "Phone" },
  ]);
}

export function summarizeTrialBalance(
  lines: { account_id: string; debit: number | string; credit: number | string }[],
  accounts: { id: string; code: string; name: string; type: string }[],
): ExportTrialBalanceRow[] {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const current = totals.get(line.account_id) ?? { debit: 0, credit: 0 };
    current.debit += asNumber(line.debit);
    current.credit += asNumber(line.credit);
    totals.set(line.account_id, current);
  }

  return accounts
    .map((account) => {
      const balance = totals.get(account.id) ?? { debit: 0, credit: 0 };
      return {
        code: account.code,
        name: account.name,
        type: account.type,
        debit: Math.round(balance.debit * 100) / 100,
        credit: Math.round(balance.credit * 100) / 100,
        net: Math.round((balance.debit - balance.credit) * 100) / 100,
      };
    })
    .filter((row) => row.debit !== 0 || row.credit !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function exportFilename(kind: string, asOf: string): string {
  return `teller-${kind}-${asOf}.csv`;
}
