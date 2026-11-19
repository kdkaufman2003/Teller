import { openAiApiKey, openAiJson } from "@/lib/ai/openai";
import { extractPdfText } from "@/lib/expenses/receipt-analyze";
import {
  parseInvoiceSheet,
  sanitizeInvoiceSheetRows,
  type InvoiceSheetRow,
} from "./invoice-sheet";

const SHEET_PROMPT = `You read a vendor billing history. It lists many invoices from one vendor, like a billing page with a period, status (Paid or Upcoming), description, total due, and invoice date.
Return JSON only: {"rows":[{"period":"","description":"","amount":0,"issueDate":"YYYY-MM-DD","status":"paid"}]}
Rules:
- One object per invoice. Do not split an invoice into product lines.
- amount is the total due or estimated total for that invoice.
- status is "paid", "upcoming", "open", or "unknown".
- issueDate is the invoiced date when the sheet shows one. Use null when it does not.
- Keep invoice numbers and plan names in description.
- Do not invent a vendor name.`;

type SheetKind = "csv" | "pdf" | "image";

export function invoiceSheetKind(fileName: string, mimeType: string): SheetKind | null {
  const name = fileName.toLowerCase();
  if (
    mimeType === "text/csv" ||
    mimeType === "text/plain" ||
    mimeType === "application/vnd.ms-excel" ||
    name.endsWith(".csv") ||
    name.endsWith(".txt")
  ) {
    return "csv";
  }
  if (mimeType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp" ||
    /\.(jpe?g|png|webp)$/.test(name)
  ) {
    return "image";
  }
  return null;
}

async function readWithOpenAI(input: {
  text?: string;
  imageBase64?: string;
  mimeType?: string;
  pdfBase64?: string;
  fileName?: string;
}): Promise<InvoiceSheetRow[]> {
  const parsed = (await openAiJson({
    prompt: SHEET_PROMPT,
    text: input.text,
    imageBase64: input.imageBase64,
    imageMime: input.mimeType,
    pdfBase64: input.pdfBase64,
    fileName: input.fileName,
  })) as { rows?: unknown };
  return sanitizeInvoiceSheetRows(parsed.rows);
}

export async function readInvoiceSheet(input: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<{ rows: InvoiceSheetRow[]; notice?: string }> {
  const kind = invoiceSheetKind(input.fileName, input.mimeType);
  if (!kind) {
    throw new Error("Upload a CSV, PDF, or screenshot (PNG, JPEG, or WebP).");
  }

  if (kind === "csv") {
    const rows = parseInvoiceSheet(input.buffer.toString("utf8"));
    if (!rows.length) {
      throw new Error("No invoices found. Use columns for description, amount, and date.");
    }
    return { rows };
  }

  if (kind === "pdf") {
    const text = await extractPdfText(input.buffer);
    const parsed = text ? parseInvoiceSheet(text) : [];
    if (!openAiApiKey()) {
      if (parsed.length) {
        return {
          rows: parsed,
          notice: "OPENAI_API_KEY is not set, so this PDF was read from its text only.",
        };
      }
      throw new Error("OPENAI_API_KEY is not set, so this PDF was not sent to OpenAI.");
    }
    try {
      const rows = await readWithOpenAI({
        text,
        pdfBase64: input.buffer.toString("base64"),
        fileName: input.fileName,
      });
      if (rows.length) return { rows, notice: "Read with OpenAI." };
    } catch (error) {
      if (parsed.length) {
        return {
          rows: parsed,
          notice: error instanceof Error ? error.message : "OpenAI could not read this PDF.",
        };
      }
      throw error;
    }
    if (parsed.length) return { rows: parsed, notice: "OpenAI found no invoice rows. Showing the text reading." };
    throw new Error("OpenAI found no invoices in this PDF.");
  }

  if (!openAiApiKey()) {
    throw new Error("OPENAI_API_KEY is not set, so this screenshot was not sent to OpenAI.");
  }
  const rows = await readWithOpenAI({
    imageBase64: input.buffer.toString("base64"),
    mimeType: input.mimeType || "image/png",
    fileName: input.fileName,
  });
  if (rows.length) return { rows, notice: "Read with OpenAI." };
  throw new Error("OpenAI found no invoices in this screenshot.");
}
