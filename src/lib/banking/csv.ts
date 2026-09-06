import { createHash } from "crypto";
import { asNumber } from "@/lib/format";
import { normalizeProviderAmount, inferBankGlKind } from "./normalize";
import type { CsvColumnMapping, CsvParseResult, NormalizedBankTransaction } from "./types";
import { toNormalizedBankTransaction } from "./types";

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 5000;

const FORMULA_PREFIX_RE = /^[=+\-@]/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function sanitizeCsvCell(value: string): string {
  const trimmed = value.trim();
  if (FORMULA_PREFIX_RE.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
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
      cells.push(sanitizeCsvCell(current));
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(sanitizeCsvCell(current));
  return cells;
}

export function parseCsvText(content: string): { headers: string[]; rows: string[][] } {
  if (content.length > CSV_MAX_BYTES) {
    throw new Error(`CSV exceeds maximum size of ${CSV_MAX_BYTES} bytes`);
  }

  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    throw new Error("CSV file is empty");
  }

  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV must include a header row and at least one data row");
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  if (headers.some((header) => !header)) {
    throw new Error("CSV header row contains empty column names");
  }

  const duplicateHeaders = headers.filter(
    (header, index) => headers.indexOf(header) !== index,
  );
  if (duplicateHeaders.length) {
    throw new Error(`Duplicate CSV headers: ${duplicateHeaders.join(", ")}`);
  }

  const rows = lines.slice(1, CSV_MAX_ROWS + 1).map(parseCsvLine);
  if (lines.length - 1 > CSV_MAX_ROWS) {
    throw new Error(`CSV exceeds maximum of ${CSV_MAX_ROWS} rows`);
  }

  return { headers, rows };
}

function cellValue(row: string[], headers: string[], column?: string): string {
  if (!column) return "";
  const index = headers.indexOf(column);
  if (index < 0) return "";
  return row[index]?.trim() ?? "";
}

function parseDate(value: string, rowNumber: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Row ${rowNumber}: date is required`);
  if (ISO_DATE_RE.test(trimmed)) return trimmed;

  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const month = slash[1].padStart(2, "0");
    const day = slash[2].padStart(2, "0");
    let year = slash[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Row ${rowNumber}: invalid date "${value}"`);
  }
  return parsed.toISOString().slice(0, 10);
}

function parseAmount(value: string, rowNumber: number): number {
  const cleaned = value.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!cleaned) throw new Error(`Row ${rowNumber}: amount is required`);
  const amount = asNumber(cleaned);
  if (!Number.isFinite(amount)) {
    throw new Error(`Row ${rowNumber}: invalid amount "${value}"`);
  }
  if (Math.abs(amount) > 1_000_000_000) {
    throw new Error(`Row ${rowNumber}: amount exceeds allowed range`);
  }
  return amount;
}

function resolveRawAmount(
  row: string[],
  headers: string[],
  mapping: CsvColumnMapping,
  rowNumber: number,
): number {
  if (mapping.amount) {
    return parseAmount(cellValue(row, headers, mapping.amount), rowNumber);
  }

  const debit = mapping.debit ? cellValue(row, headers, mapping.debit) : "";
  const credit = mapping.credit ? cellValue(row, headers, mapping.credit) : "";

  if (debit || credit) {
    const debitAmount = debit ? parseAmount(debit, rowNumber) : 0;
    const creditAmount = credit ? parseAmount(credit, rowNumber) : 0;
    if (debitAmount > 0 && creditAmount > 0) {
      throw new Error(`Row ${rowNumber}: debit and credit cannot both be set`);
    }
    if (debitAmount <= 0 && creditAmount <= 0) {
      throw new Error(`Row ${rowNumber}: debit or credit is required`);
    }
    return debitAmount > 0 ? debitAmount : -creditAmount;
  }

  throw new Error("Column mapping must include amount or debit/credit columns");
}

function buildDescription(
  row: string[],
  headers: string[],
  mapping: CsvColumnMapping,
): string {
  const parts = [
    mapping.description ? cellValue(row, headers, mapping.description) : "",
    mapping.payee ? cellValue(row, headers, mapping.payee) : "",
    mapping.memo ? cellValue(row, headers, mapping.memo) : "",
  ].filter(Boolean);
  return parts.join(" · ") || "Imported transaction";
}

export function normalizeDescription(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ");
}

export function csvImportFingerprint(input: {
  organizationId: string;
  bankAccountId: string;
  postedDate: string;
  normalizedAmount: number;
  description: string;
}): string {
  const payload = [
    input.organizationId,
    input.bankAccountId,
    input.postedDate,
    asNumber(input.normalizedAmount).toFixed(2),
    normalizeDescription(input.description),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

export function mapCsvRowsToTransactions(input: {
  organizationId: string;
  bankAccountId: string;
  headers: string[];
  rows: string[][];
  mapping: CsvColumnMapping;
  bankAccountType?: string | null;
  bankAccountSubtype?: string | null;
}): CsvParseResult {
  const glKind = inferBankGlKind({
    bankAccountType: input.bankAccountType,
    bankAccountSubtype: input.bankAccountSubtype,
  });

  const errors: Array<{ row: number; message: string }> = [];
  const fingerprints = new Map<string, number>();
  const duplicates: string[] = [];
  const transactions: NormalizedBankTransaction[] = [];
  const skipped = 0;

  input.rows.forEach((row, index) => {
    const rowNumber = index + 2;
    try {
      const postedDate = parseDate(cellValue(row, input.headers, input.mapping.date), rowNumber);
      const rawAmount = resolveRawAmount(row, input.headers, input.mapping, rowNumber);
      const normalizedAmount = normalizeProviderAmount(rawAmount, glKind);
      const description = buildDescription(row, input.headers, input.mapping);
      const fingerprint = csvImportFingerprint({
        organizationId: input.organizationId,
        bankAccountId: input.bankAccountId,
        postedDate,
        normalizedAmount,
        description,
      });

      const priorRow = fingerprints.get(fingerprint);
      if (priorRow !== undefined) {
        duplicates.push(`${fingerprint}:row${rowNumber}:dup-of-row${priorRow}`);
      } else {
        fingerprints.set(fingerprint, rowNumber);
      }

      const providerTransactionId = `csv:r${rowNumber}:${fingerprint}`;

      transactions.push(
        toNormalizedBankTransaction({
          providerTransactionId,
          externalTransactionId: providerTransactionId,
          providerAccountId: input.bankAccountId,
          externalAccountId: input.bankAccountId,
          postedDate,
          rawAmount,
          amount: rawAmount,
          normalizedAmount,
          description,
          name: description,
          pending: false,
          importFingerprint: fingerprint,
          rawProviderMetadata: { source: "manual_csv", row: rowNumber, fingerprint },
        }),
      );
    } catch (error) {
      errors.push({
        row: rowNumber,
        message: error instanceof Error ? error.message : "Invalid row",
      });
    }
  });

  return { rows: transactions, errors, duplicates, skipped };
}

export function parseBankCsv(input: {
  organizationId: string;
  bankAccountId: string;
  content: string;
  mapping: CsvColumnMapping;
  bankAccountType?: string | null;
  bankAccountSubtype?: string | null;
}): CsvParseResult & { headers: string[] } {
  const { headers, rows } = parseCsvText(input.content);
  const mapped = mapCsvRowsToTransactions({
    organizationId: input.organizationId,
    bankAccountId: input.bankAccountId,
    headers,
    rows,
    mapping: input.mapping,
    bankAccountType: input.bankAccountType,
    bankAccountSubtype: input.bankAccountSubtype,
  });
  return { headers, ...mapped };
}
