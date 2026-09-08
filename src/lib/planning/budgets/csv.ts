import { roundMoney } from "@/lib/accounting/payment-fees";
import { accountAnnualTotal } from "./totals";
import type { BudgetLineInput } from "./types";
import { fiscalYearCalendarMonths, monthLabel } from "./periods";

const FORMULA_PREFIX_RE = /^[=+\-@]/;

export const BUDGET_CSV_MAX_BYTES = 512 * 1024;
export const BUDGET_CSV_MAX_ROWS = 500;

export const BUDGET_CSV_MONTH_HEADERS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export type BudgetCsvAccountRef = {
  id: string;
  code: string;
  name: string;
  organizationId: string;
  type: string;
  archived: boolean;
};

export type BudgetCsvParseRow = {
  rowNumber: number;
  accountCode: string;
  accountName: string;
  amounts: number[];
  annualTotal: number;
};

export type BudgetCsvRowIssue = {
  rowNumber: number;
  message: string;
};

export type BudgetCsvPreview = {
  matched: Array<{ rowNumber: number; accountId: string; accountCode: string; accountName: string }>;
  unmatched: BudgetCsvRowIssue[];
  errors: BudgetCsvRowIssue[];
  warnings: BudgetCsvRowIssue[];
  lines: BudgetLineInput[];
  lineCount: number;
  annualTotal: number;
  accountsMatched: number;
  accountsUnmatched: number;
};

export function sanitizeCsvExportCell(value: string): string {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d{1,2})?$/.test(trimmed) || /^\(\d+(\.\d{1,2})?\)$/.test(trimmed)) {
    return trimmed;
  }
  if (FORMULA_PREFIX_RE.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
}

export function escapeCsvField(value: string): string {
  const safe = sanitizeCsvExportCell(value);
  if (/[",\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function parseBudgetMoney(raw: string, rowNumber: number, column: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  let negative = false;
  let normalized = trimmed;
  if (/^\(.+\)$/.test(normalized)) {
    negative = true;
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/[$,\s]/g, "");
  if (normalized.startsWith("-")) {
    negative = true;
    normalized = normalized.slice(1);
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(negative ? normalized : normalized)) {
    throw new Error(`Row ${rowNumber}: invalid amount in ${column}`);
  }
  const parts = normalized.split(".");
  if (parts[1] && parts[1].length > 2) {
    throw new Error(`Row ${rowNumber}: too many decimal places in ${column}`);
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    throw new Error(`Row ${rowNumber}: malformed amount in ${column}`);
  }
  return roundMoney(negative ? -amount : amount);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function parseBudgetCsvText(content: string): { headers: string[]; rows: string[][] } {
  if (content.length > BUDGET_CSV_MAX_BYTES) {
    throw new Error(`CSV exceeds maximum size of ${BUDGET_CSV_MAX_BYTES} bytes`);
  }
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) throw new Error("CSV file is empty");
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV must include a header row and at least one data row");
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  if (lines.length - 1 > BUDGET_CSV_MAX_ROWS) {
    throw new Error(`CSV exceeds maximum of ${BUDGET_CSV_MAX_ROWS} rows`);
  }
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function findColumnIndex(headers: string[], candidates: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate);
    if (index >= 0) return index;
  }
  return -1;
}

export function parseBudgetCsvRows(content: string): BudgetCsvParseRow[] {
  const { headers, rows } = parseBudgetCsvText(content);
  const codeIndex = findColumnIndex(headers, [
    "account number",
    "account code",
    "account #",
    "acct number",
    "acct code",
  ]);
  const nameIndex = findColumnIndex(headers, ["account name", "name"]);
  if (codeIndex < 0 && nameIndex < 0) {
    throw new Error("CSV must include Account Number or Account Name column");
  }

  const monthIndexes = BUDGET_CSV_MONTH_HEADERS.map((label) => headers.findIndex((header) => normalizeHeader(header) === label.toLowerCase()));
  if (monthIndexes.every((index) => index < 0)) {
    throw new Error("CSV must include at least one month column (Jan–Dec)");
  }

  const annualIndex = findColumnIndex(headers, ["annual total", "annual", "year total"]);

  return rows.map((cells, offset) => {
    const rowNumber = offset + 2;
    const accountCode = codeIndex >= 0 ? cells[codeIndex]?.trim() ?? "" : "";
    const accountName = nameIndex >= 0 ? cells[nameIndex]?.trim() ?? "" : "";
    if (!accountCode && !accountName) {
      throw new Error(`Row ${rowNumber}: account number or name is required`);
    }
    const amounts = monthIndexes.map((index, monthIdx) => {
      if (index < 0) return 0;
      return parseBudgetMoney(cells[index] ?? "", rowNumber, BUDGET_CSV_MONTH_HEADERS[monthIdx]);
    });
    const computedAnnual = roundMoney(amounts.reduce((sum, amount) => sum + amount, 0));
    let annualTotal = computedAnnual;
    if (annualIndex >= 0 && (cells[annualIndex] ?? "").trim()) {
      annualTotal = parseBudgetMoney(cells[annualIndex] ?? "", rowNumber, "Annual Total");
    }
    return { rowNumber, accountCode, accountName, amounts, annualTotal };
  });
}

function matchAccount(
  row: BudgetCsvParseRow,
  accounts: BudgetCsvAccountRef[],
): BudgetCsvAccountRef | null {
  const byCode = row.accountCode
    ? accounts.filter((account) => account.code.toLowerCase() === row.accountCode.toLowerCase())
    : [];
  if (byCode.length === 1) return byCode[0]!;
  if (byCode.length > 1) return null;

  if (row.accountName) {
    const normalizedName = row.accountName.trim().toLowerCase();
    const byName = accounts.filter((account) => account.name.trim().toLowerCase() === normalizedName);
    if (byName.length === 1) return byName[0]!;
  }
  return null;
}

export function buildBudgetCsvPreview(input: {
  content: string;
  fiscalYear: number;
  organizationId: string;
  accounts: BudgetCsvAccountRef[];
}): BudgetCsvPreview {
  const parsedRows = parseBudgetCsvRows(input.content);
  const orgAccounts = input.accounts.filter((account) => account.organizationId === input.organizationId);
  const months = fiscalYearCalendarMonths(input.fiscalYear);
  const matched: BudgetCsvPreview["matched"] = [];
  const unmatched: BudgetCsvRowIssue[] = [];
  const errors: BudgetCsvRowIssue[] = [];
  const warnings: BudgetCsvRowIssue[] = [];
  const lines: BudgetLineInput[] = [];
  const seenAccounts = new Set<string>();

  for (const row of parsedRows) {
    const account = matchAccount(row, orgAccounts);
    if (!account) {
      const label = row.accountCode || row.accountName;
      if (row.accountCode) {
        const ambiguous = orgAccounts.filter(
          (candidate) => candidate.code.toLowerCase() === row.accountCode.toLowerCase(),
        );
        if (ambiguous.length > 1) {
          errors.push({ rowNumber: row.rowNumber, message: `Account ${row.accountCode} is ambiguous` });
          continue;
        }
      }
      unmatched.push({ rowNumber: row.rowNumber, message: `Account ${label} not found in this company` });
      continue;
    }
    if (account.archived) {
      errors.push({ rowNumber: row.rowNumber, message: `Account ${account.code} is archived` });
      continue;
    }
    if (seenAccounts.has(account.id)) {
      errors.push({ rowNumber: row.rowNumber, message: `Duplicate account row for ${account.code}` });
      continue;
    }
    seenAccounts.add(account.id);
    matched.push({
      rowNumber: row.rowNumber,
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
    });

    row.amounts.forEach((amount, index) => {
      if (Math.abs(amount) < 0.005) return;
      lines.push({
        accountId: account.id,
        periodMonth: months[index]!,
        amount,
      });
    });

    const rowAnnual = roundMoney(
      row.amounts.reduce((sum, amount) => sum + amount, 0),
    );
    if (Math.abs(rowAnnual - row.annualTotal) > 0.01) {
      warnings.push({
        rowNumber: row.rowNumber,
        message: `Annual total column differs from sum of months for ${account.code}`,
      });
    }
  }

  return {
    matched,
    unmatched,
    errors,
    warnings,
    lines,
    lineCount: lines.length,
    annualTotal: roundMoney(lines.reduce((sum, line) => sum + line.amount, 0)),
    accountsMatched: matched.length,
    accountsUnmatched: unmatched.length,
  };
}

export function exportBudgetCsv(input: {
  fiscalYear: number;
  accounts: Array<{ id: string; code: string; name: string }>;
  lines: BudgetLineInput[];
}): string {
  const months = fiscalYearCalendarMonths(input.fiscalYear);
  const header = ["Account Number", "Account Name", ...BUDGET_CSV_MONTH_HEADERS, "Annual Total"];
  const linesByAccount = new Map<string, BudgetLineInput[]>();
  for (const line of input.lines) {
    const bucket = linesByAccount.get(line.accountId) ?? [];
    bucket.push(line);
    linesByAccount.set(line.accountId, bucket);
  }

  const rows: string[] = [header.join(",")];
  for (const account of input.accounts) {
    const accountLines = linesByAccount.get(account.id) ?? [];
    if (!accountLines.length) continue;
    const monthAmounts = months.map((periodMonth) => {
      const line = accountLines.find((entry) => entry.periodMonth === periodMonth);
      return line ? line.amount.toFixed(2) : "";
    });
    const annual = accountAnnualTotal(
      accountLines.map((line) => ({
        accountId: line.accountId,
        periodMonth: line.periodMonth,
        amount: line.amount,
      })),
      account.id,
    );
    rows.push(
      [
        escapeCsvField(account.code),
        escapeCsvField(account.name),
        ...monthAmounts.map((amount) => (amount ? escapeCsvField(amount) : "")),
        escapeCsvField(annual.toFixed(2)),
      ].join(","),
    );
  }
  return rows.join("\n");
}

export function sanitizeImportFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop()?.trim() ?? "import.csv";
  return base.replace(/[^\w.\-()+\s]/g, "_").slice(0, 120);
}
