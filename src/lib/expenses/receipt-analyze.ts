import { openAiApiKey, openAiJson } from "@/lib/ai/openai";
import {
  accountChoicesForPrompt,
  classifyExpenseText,
  pickAccountFromCode,
  type ExpenseAccountOption,
  type ReceiptClassification,
} from "./classify";
import { resolveVendorSuggestion, type VendorChoice, type VendorMatch } from "./vendor-match";

type VisionPayload = {
  vendorName?: string;
  partyId?: string | null;
  amount?: number | string | null;
  issueDate?: string | null;
  description?: string;
  memo?: string;
  accountCode?: string | null;
  confidence?: string;
  reason?: string;
};

const RECEIPT_PROMPT = `You extract bookkeeping fields from a receipt. The attached photo or PDF is the source of truth. Extracted text, when present, can be incomplete.
Return JSON only with these keys:
- vendorName: merchant/store name (not a payment processor, card brand, phone number, receipt number, or file name)
- partyId: id of an existing vendor when this receipt is that same business, otherwise null
- amount: final total PAID by the customer (number). Prefer GRAND TOTAL, TOTAL, or AMOUNT PAID — not subtotal before tax unless that is the only total shown
- issueDate: transaction date as YYYY-MM-DD, or null
- description: one short line summarizing what was purchased (not the vendor name repeated)
- accountCode: exactly one code from the chart of accounts below
- confidence: "high", "medium", or "low"
- reason: brief note on vendor/category choice

Chart of accounts:
`;

export function parseReceiptAmount(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value * 100) / 100;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").match(/-?\d+(?:\.\d{2})?/);
    if (!normalized) return null;
    const amount = Number(normalized[0]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return Math.round(amount * 100) / 100;
  }
  return null;
}

/** Pull likely total from raw receipt OCR/PDF text when AI is unavailable. */
export function extractTotalFromReceiptText(text: string): number | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const prioritized = [...lines].reverse();

  const labeledPatterns = [
    /\b(?:grand\s*)?total(?:\s*paid)?\b[^0-9-$]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/i,
    /\bamount\s*(?:due|paid|charged)\b[^0-9-$]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/i,
    /\bbalance\s*due\b[^0-9-$]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/i,
  ];

  for (const line of prioritized) {
    for (const pattern of labeledPatterns) {
      const match = line.match(pattern);
      if (match) {
        const amount = parseReceiptAmount(match[1]);
        if (amount != null) return amount;
      }
    }
  }

  const amounts: number[] = [];
  const amountPattern =
    /\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g;
  for (const line of lines) {
    if (/\bsub\s*total\b/i.test(line)) continue;
    for (const match of line.matchAll(amountPattern)) {
      const amount = parseReceiptAmount(match[1]);
      if (amount != null && amount <= 100_000) amounts.push(amount);
    }
  }

  if (!amounts.length) return null;
  return Math.max(...amounts);
}

/** Guess vendor from receipt text — usually an early prominent line. */
export function extractVendorFromReceiptText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 2);

  for (const line of lines.slice(0, 8)) {
    if (/^(receipt|invoice|order|transaction|thank you|sales)/i.test(line)) continue;
    if (/^\d{1,2}[\/-]\d{1,2}/.test(line)) continue;
    if (/^(tel|phone|www\.|http|@)/i.test(line)) continue;
    if (/^[0-9#*\s-]+$/.test(line)) continue;
    if (line.length > 60) continue;
    return line;
  }

  return "";
}

export function extractDescriptionFromReceiptText(text: string): string {
  const vendor = extractVendorFromReceiptText(text);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 4);

  const productLine = lines.find(
    (line) =>
      line !== vendor &&
      /\b(workspace|subscription|business standard|google workspace|email|license|monthly|annual plan)\b/i.test(
        line,
      ),
  );
  if (productLine) return productLine.slice(0, 120);

  const itemLine = lines.find(
    (line) =>
      line !== vendor &&
      !/^(total|subtotal|tax|amount|balance|change|cash|visa|mastercard|amex)/i.test(line) &&
      !/^\d{1,2}[\/-]\d{1,2}/.test(line),
  );
  return itemLine?.slice(0, 120) ?? "";
}

/** Avoid using opaque numeric upload filenames as vendor names. */
export function vendorFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim();
  if (!base || /^\d+$/.test(base)) return "";
  return base;
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return typeof result.text === "string" ? result.text.trim() : "";
    } finally {
      await parser.destroy();
    }
  } catch {
    return "";
  }
}

function buildPrompt(accounts: ExpenseAccountOption[], vendors: VendorChoice[]): string {
  const vendorList = vendors
    .slice(0, 80)
    .map((vendor) => `${vendor.id} | ${vendor.name}`)
    .join("\n");
  return `${RECEIPT_PROMPT}${accountChoicesForPrompt(accounts)}${
    vendorList
      ? `\n\nExisting vendors. Set partyId only when the receipt is that same business:\n${vendorList}`
      : ""
  }`;
}

function normalizePayload(
  accounts: ExpenseAccountOption[],
  parsed: VisionPayload,
  fallbackText?: string,
): ReceiptClassification {
  const rulesFallback = classifyExpenseText(accounts, {
    vendorName: parsed.vendorName || (fallbackText ? extractVendorFromReceiptText(fallbackText) : ""),
    description: parsed.description || parsed.memo,
    memo: parsed.description || parsed.memo || (fallbackText ? extractDescriptionFromReceiptText(fallbackText) : ""),
  });

  const account = pickAccountFromCode(accounts, parsed.accountCode);
  const confidence =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "medium";

  const description =
    parsed.description?.trim() ||
    parsed.memo?.trim() ||
    (fallbackText ? extractDescriptionFromReceiptText(fallbackText) : "") ||
    rulesFallback.memo;

  const amount =
    parseReceiptAmount(parsed.amount) ??
    (fallbackText ? extractTotalFromReceiptText(fallbackText) : null);

  return {
    vendorName:
      parsed.vendorName?.trim() ||
      (fallbackText ? extractVendorFromReceiptText(fallbackText) : "") ||
      rulesFallback.vendorName,
    amount,
    issueDate: parsed.issueDate?.slice(0, 10) || null,
    memo: description,
    accountId: account?.id ?? rulesFallback.accountId,
    accountCode: account?.code ?? rulesFallback.accountCode,
    confidence: account && amount != null ? confidence : account ? "medium" : "low",
    reason: parsed.reason?.trim() || rulesFallback.reason,
    source: "ai",
  };
}

async function classifyWithOpenAI(
  accounts: ExpenseAccountOption[],
  vendors: VendorChoice[],
  input: {
    text?: string;
    imageBase64?: string;
    mimeType?: string;
    pdfBase64?: string;
    fileName?: string;
  },
): Promise<{ classification: ReceiptClassification; partyId: string | null }> {
  const parsed = (await openAiJson({
    prompt: buildPrompt(accounts, vendors),
    text: input.text ? `Text extracted from the file:\n${input.text}` : undefined,
    imageBase64: input.imageBase64,
    imageMime: input.mimeType,
    pdfBase64: input.pdfBase64,
    fileName: input.fileName,
  })) as VisionPayload;
  const partyId = vendors.some((vendor) => vendor.id === parsed.partyId) ? parsed.partyId ?? null : null;
  return { classification: normalizePayload(accounts, parsed, input.text), partyId };
}

function classifyFromTextRules(
  accounts: ExpenseAccountOption[],
  text: string,
  fileName: string,
): ReceiptClassification {
  const vendorName =
    extractVendorFromReceiptText(text) || vendorFromFileName(fileName);
  const amount = extractTotalFromReceiptText(text);
  const description = extractDescriptionFromReceiptText(text);
  const base = classifyExpenseText(accounts, {
    vendorName,
    description,
    memo: description,
  });

  return {
    ...base,
    vendorName: vendorName || base.vendorName,
    amount,
    memo: description || base.memo,
    source: "rules",
    reason: amount != null ? "Read from receipt text" : base.reason,
    confidence: amount != null && base.confidence !== "low" ? "medium" : base.confidence,
  };
}

function unreadableReceiptFallback(
  accounts: ExpenseAccountOption[],
  aiEnabled: boolean,
  kind: "pdf" | "image" | "unsupported",
): { classification: ReceiptClassification; notice: string } {
  const classification = classifyExpenseText(accounts, {});
  const notice =
    kind === "unsupported"
      ? "Unsupported receipt format — enter details manually."
      : aiEnabled
        ? `Could not read this ${kind === "pdf" ? "PDF" : "photo"} automatically — enter vendor, amount, and description manually.`
        : "Could not read this receipt automatically. Enter vendor, amount, and description manually. Add OPENAI_API_KEY on Vercel for smarter reading.";

  return {
    classification: {
      ...classification,
      vendorName: "",
      memo: "",
      amount: null,
      issueDate: null,
      confidence: "low",
      reason: "Review the category",
      source: "rules",
    },
    notice,
  };
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/heic";
}

export function isAllowedReceiptMime(mime: string): boolean {
  return [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "application/pdf",
  ].includes(mime);
}

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

export type ReceiptReadMethod = "vision" | "pdf-text" | "rules";

function withVendorMatch(
  classification: ReceiptClassification,
  vendors: VendorChoice[],
  partyId: string | null,
): { classification: ReceiptClassification; vendorMatch: VendorMatch | null } {
  const vendorMatch = resolveVendorSuggestion(classification.vendorName, vendors, partyId);
  if (!vendorMatch) return { classification, vendorMatch: null };
  return {
    classification: { ...classification, vendorName: vendorMatch.name },
    vendorMatch,
  };
}

export async function classifyReceipt(
  accounts: ExpenseAccountOption[],
  input: { buffer: Buffer; mimeType: string; fileName: string; vendors?: VendorChoice[] },
): Promise<{
  classification: ReceiptClassification;
  vendorMatch: VendorMatch | null;
  readMethod: ReceiptReadMethod;
  aiEnabled: boolean;
  notice?: string;
}> {
  const aiEnabled = Boolean(openAiApiKey());
  const fileName = input.fileName || "receipt";
  const vendors = input.vendors ?? [];

  if (input.mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) {
    const text = await extractPdfText(input.buffer);
    if (aiEnabled) {
      try {
        const read = await classifyWithOpenAI(accounts, vendors, {
          text,
          pdfBase64: input.buffer.toString("base64"),
          fileName,
        });
        return { ...withVendorMatch(read.classification, vendors, read.partyId), readMethod: "vision", aiEnabled: true };
      } catch (error) {
        const notice = error instanceof Error ? error.message : "OpenAI could not read this PDF";
        if (text) {
          const classification = classifyFromTextRules(accounts, text, fileName);
          return {
            ...withVendorMatch(classification, vendors, null),
            readMethod: "pdf-text",
            aiEnabled: true,
            notice,
          };
        }
        const fallback = unreadableReceiptFallback(accounts, true, "pdf");
        return {
          ...withVendorMatch(fallback.classification, vendors, null),
          readMethod: "rules",
          aiEnabled: true,
          notice,
        };
      }
    }
    if (text) {
      const classification = classifyFromTextRules(accounts, text, fileName);
      return {
        ...withVendorMatch(classification, vendors, null),
        readMethod: "pdf-text",
        aiEnabled: false,
        notice: "OPENAI_API_KEY is not set, so this PDF was not sent to OpenAI.",
      };
    }
    const fallback = unreadableReceiptFallback(accounts, false, "pdf");
    return {
      ...withVendorMatch(fallback.classification, vendors, null),
      readMethod: "rules",
      aiEnabled: false,
      notice: "OPENAI_API_KEY is not set, so this PDF was not sent to OpenAI.",
    };
  }

  if (input.mimeType === "image/heic" || input.mimeType === "image/heif") {
    const fallback = unreadableReceiptFallback(accounts, aiEnabled, "image");
    return {
      ...withVendorMatch(fallback.classification, vendors, null),
      readMethod: "rules",
      aiEnabled,
      notice: "HEIC photos are not sent to OpenAI. Save the receipt as a JPEG or PDF and upload that.",
    };
  }

  if (isImageMime(input.mimeType)) {
    if (aiEnabled) {
      try {
        const read = await classifyWithOpenAI(accounts, vendors, {
          imageBase64: input.buffer.toString("base64"),
          mimeType: input.mimeType,
          fileName,
        });
        return { ...withVendorMatch(read.classification, vendors, read.partyId), readMethod: "vision", aiEnabled: true };
      } catch (error) {
        const fallback = unreadableReceiptFallback(accounts, true, "image");
        return {
          ...withVendorMatch(fallback.classification, vendors, null),
          readMethod: "rules",
          aiEnabled: true,
          notice: error instanceof Error ? error.message : fallback.notice,
        };
      }
    }
    const fallback = unreadableReceiptFallback(accounts, false, "image");
    return {
      ...withVendorMatch(fallback.classification, vendors, null),
      readMethod: "rules",
      aiEnabled: false,
      notice: "OPENAI_API_KEY is not set, so this photo was not sent to OpenAI.",
    };
  }

  const fallback = unreadableReceiptFallback(accounts, aiEnabled, "unsupported");
  return {
    ...withVendorMatch(fallback.classification, vendors, null),
    readMethod: "rules",
    aiEnabled,
    notice: fallback.notice,
  };
}
