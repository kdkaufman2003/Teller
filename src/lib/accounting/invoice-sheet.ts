export type InvoiceSheetStatus = "paid" | "upcoming" | "open" | "unknown";

export type InvoiceSheetRow = {
  period: string;
  description: string;
  amount: number;
  issueDate: string | null;
  status: InvoiceSheetStatus;
  reference: string;
  include: boolean;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MONTH_PATTERN =
  "January|February|March|April|May|June|July|August|September|October|November|December";

const MAX_ROWS = 100;

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseSheetAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return roundMoney(value);
  }
  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const amount = Number(match[0]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return roundMoney(amount);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatYmd(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseSheetDate(value: string, fallbackYear?: number): string | null {
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return formatYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const us = value.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (us) {
    const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    return formatYmd(year, Number(us[1]), Number(us[2]));
  }

  const named = value.match(
    new RegExp(
      `\\b(${MONTH_PATTERN}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`,
      "i",
    ),
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase().replace(".", "")];
    if (month) return formatYmd(Number(named[3]), month, Number(named[2]));
  }

  if (fallbackYear) {
    const namedNoYear = value.match(
      new RegExp(
        `\\b(${MONTH_PATTERN}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?\\s+(\\d{1,2})\\b`,
        "i",
      ),
    );
    if (namedNoYear) {
      const month = MONTHS[namedNoYear[1].toLowerCase().replace(".", "")];
      if (month) return formatYmd(fallbackYear, month, Number(namedNoYear[2]));
    }
  }

  return null;
}

function parseStatus(value: string): InvoiceSheetStatus {
  if (/\bupcoming\b|\bestimated\b/i.test(value)) return "upcoming";
  if (/\bpaid\b/i.test(value)) return "paid";
  if (/\b(open|unpaid|due|past due)\b/i.test(value)) return "open";
  return "unknown";
}

function titleCaseMonth(value: string): string {
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function invoiceSheetReference(row: {
  period?: string;
  description: string;
  issueDate: string | null;
}): string {
  return [row.issueDate, row.period, row.description].filter(Boolean).join(" · ").slice(0, 80);
}

function finishRow(input: {
  period: string;
  description: string;
  amount: number;
  issueDate: string | null;
  status: InvoiceSheetStatus;
}): InvoiceSheetRow | null {
  const description = input.description.trim().slice(0, 200);
  const period = input.period.trim().slice(0, 80);
  if (!description && !period) return null;
  const label = description || period;
  return {
    period,
    description: label,
    amount: input.amount,
    issueDate: input.issueDate,
    status: input.status,
    reference: invoiceSheetReference({
      period,
      description: label,
      issueDate: input.issueDate,
    }),
    include: input.amount > 0 && input.amount <= 10_000_000,
  };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function looksLikeCsv(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || !lines[0].includes(",")) return false;
  const counts = lines.slice(0, 5).map((line) => (line.match(/,/g) ?? []).length);
  return counts.every((count) => count >= 1) && Math.max(...counts) - Math.min(...counts) <= 2;
}

const HEADER_FIELDS: Record<string, "period" | "status" | "description" | "amount" | "date"> = {
  period: "period",
  month: "period",
  "billing period": "period",
  status: "status",
  description: "description",
  memo: "description",
  item: "description",
  product: "description",
  details: "description",
  invoice: "description",
  "invoice description": "description",
  amount: "amount",
  total: "amount",
  "total due": "amount",
  "estimated total": "amount",
  date: "date",
  "invoice date": "date",
  invoiced: "date",
  "issue date": "date",
  "issue_date": "date",
};

function headerKey(value: string): "period" | "status" | "description" | "amount" | "date" | null {
  return HEADER_FIELDS[value.trim().toLowerCase()] ?? null;
}

function rowsFromCsv(text: string, fallbackYear?: number): InvoiceSheetRow[] {
  const table = parseCsv(text);
  if (!table.length) return [];
  const headerMap = table[0].map((cell) => headerKey(cell));
  const hasHeader = headerMap.filter(Boolean).length >= 2;
  const data = hasHeader ? table.slice(1) : table;
  const rows: InvoiceSheetRow[] = [];

  for (const cells of data) {
    if (rows.length >= MAX_ROWS) break;
    let period = "";
    let statusText = "";
    let description = "";
    let amount: number | null = null;
    let issueDate: string | null = null;

    if (hasHeader) {
      cells.forEach((cell, index) => {
        const key = headerMap[index];
        if (key === "period") period = cell;
        else if (key === "status") statusText = cell;
        else if (key === "description") description = cell;
        else if (key === "amount" && amount == null) amount = parseSheetAmount(cell);
        else if (key === "date" && !issueDate) issueDate = parseSheetDate(cell, fallbackYear);
      });
    } else {
      for (const cell of cells) {
        const date = /[-/]|[A-Za-z]/.test(cell) ? parseSheetDate(cell, fallbackYear) : null;
        const money = /^\$?\s*\d[\d,]*(\.\d{1,2})?$/.test(cell.trim())
          ? parseSheetAmount(cell)
          : null;
        if (/^(paid|upcoming|open|unpaid)$/i.test(cell)) statusText = cell;
        else if (new RegExp(`^(${MONTH_PATTERN})\\s+20\\d{2}$`, "i").test(cell)) period = cell;
        else if (date && !issueDate) issueDate = date;
        else if (money != null && amount == null) amount = money;
        else if (!description) description = cell;
      }
    }

    if (amount == null) continue;
    const status = parseStatus(`${statusText} ${period} ${description}`);
    const row = finishRow({
      period,
      description,
      amount,
      issueDate,
      status: statusText ? parseStatus(statusText) : status,
    });
    if (row) rows.push(row);
  }

  return rows;
}

function documentYear(text: string): number | undefined {
  const match = text.match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function splitInvoiceBlocks(text: string): string[] {
  if (/\n\s*\n/.test(text)) {
    return text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean);
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const start = new RegExp(`^(upcoming invoice|${MONTH_PATTERN})\\b`, "i");
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (current.length && start.test(line)) {
      blocks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function isMetaLine(line: string): boolean {
  if (/^(total due|estimated total|amount due|status)\b/i.test(line)) return true;
  if (/^invoiced\b/i.test(line)) return true;
  if (/^(paid|upcoming|open|unpaid)$/i.test(line)) return true;
  if (new RegExp(`^(${MONTH_PATTERN})\\s+20\\d{2}(\\s+(paid|upcoming|open))?$`, "i").test(line)) {
    return true;
  }
  if (/^upcoming invoice(\s+upcoming)?$/i.test(line)) return true;
  return false;
}

function rowFromBlock(block: string, fallbackYear?: number): InvoiceSheetRow | null {
  const amounts = [...block.matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g)];
  const amount = amounts.length ? parseSheetAmount(amounts[amounts.length - 1][1]) : null;
  if (amount == null) return null;

  const invoiced = block.match(/invoiced\s+([^\n]+)/i);
  const issueDate =
    parseSheetDate(invoiced?.[1] ?? "", fallbackYear) ?? parseSheetDate(block, fallbackYear);

  const month = block.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(20\\d{2})\\b`, "i"));
  let period = "";
  if (month) period = `${titleCaseMonth(month[1])} ${month[2]}`;
  else if (/upcoming invoice/i.test(block)) period = "Upcoming invoice";

  const description = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isMetaLine(line))
    .join(" · ");

  return finishRow({
    period,
    description,
    amount,
    issueDate,
    status: parseStatus(block),
  });
}

export function parseInvoiceSheet(text: string): InvoiceSheetRow[] {
  const normalized = text.includes("\t") && !text.includes(",") ? text.replaceAll("\t", ",") : text;
  const year = documentYear(normalized);
  if (looksLikeCsv(normalized)) {
    const csvRows = rowsFromCsv(normalized, year);
    if (csvRows.length) return csvRows;
  }

  const rows: InvoiceSheetRow[] = [];
  for (const block of splitInvoiceBlocks(normalized)) {
    if (rows.length >= MAX_ROWS) break;
    const row = rowFromBlock(block, year);
    if (row) rows.push(row);
  }
  return rows;
}

export function sanitizeInvoiceSheetRows(value: unknown): InvoiceSheetRow[] {
  if (!Array.isArray(value)) return [];
  const rows: InvoiceSheetRow[] = [];
  for (const item of value) {
    if (rows.length >= MAX_ROWS) break;
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const amount = parseSheetAmount(raw.amount);
    if (amount == null) continue;
    const description = typeof raw.description === "string" ? raw.description.trim().slice(0, 200) : "";
    const period = typeof raw.period === "string" ? raw.period.trim().slice(0, 80) : "";
    const issueDate =
      typeof raw.issueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.issueDate)
        ? parseSheetDate(raw.issueDate)
        : null;
    const status = parseStatus(typeof raw.status === "string" ? raw.status : "");
    const row = finishRow({
      period,
      description,
      amount,
      issueDate,
      status: status === "unknown" && typeof raw.status === "string" ? parseStatus(raw.status) : status,
    });
    if (!row) continue;
    row.include = raw.include === false ? false : row.include;
    rows.push(row);
  }
  return rows;
}

export function invoiceSheetMemo(row: Pick<InvoiceSheetRow, "status" | "period">): string {
  const source =
    row.status === "paid"
      ? "Marked paid on the vendor invoice sheet. Saved as a draft and not posted."
      : row.status === "upcoming"
        ? "Upcoming estimate from the vendor invoice sheet. Saved as a draft and not posted."
        : "Imported from a vendor invoice sheet. Saved as a draft and not posted.";
  return row.period ? `${row.period}. ${source}` : source;
}
