import { rowsToCsv, type CsvRow } from "@/lib/accounting/exports";

const FORMULA_PREFIX_RE = /^[=+@-]/;

/** Neutralizes spreadsheet formula injection prefixes before CSV escaping. */
export function neutralizeTaxCsvFormula(value: string): string {
  const text = value.trim().length ? value : String(value);
  return FORMULA_PREFIX_RE.test(text) ? `'${text}` : text;
}

/** Escapes CSV values and neutralizes spreadsheet formula injection. */
export function sanitizeTaxCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const safe = neutralizeTaxCsvFormula(String(value));
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function taxRowsToCsv(rows: CsvRow[], columns: { key: string; header: string }[]): string {
  const header = columns.map((column) => sanitizeTaxCsvCell(column.header)).join(",");
  const body = rows.map((row) =>
    columns.map((column) => sanitizeTaxCsvCell(row[column.key])).join(","),
  );
  return [header, ...body].join("\n");
}

export function moneyCsv(value: number): string {
  return value.toFixed(2);
}

/** Legacy helper — prefer taxRowsToCsv for tax exports. */
export function taxReportToCsv(rows: CsvRow[], columns: { key: string; header: string }[]): string {
  return taxRowsToCsv(rows, columns);
}

export { rowsToCsv };
