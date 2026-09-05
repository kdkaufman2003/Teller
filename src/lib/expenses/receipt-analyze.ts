import {
  accountChoicesForPrompt,
  classifyExpenseText,
  pickAccountFromCode,
  type ExpenseAccountOption,
  type ReceiptClassification,
} from "./classify";

type VisionPayload = {
  vendorName?: string;
  amount?: number | string | null;
  issueDate?: string | null;
  description?: string;
  memo?: string;
  accountCode?: string | null;
  confidence?: string;
  reason?: string;
};

const RECEIPT_PROMPT = `You extract bookkeeping fields from a receipt (photo or PDF text).
Return JSON only with these keys:
- vendorName: merchant/store name (not payment processor or card brand)
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
  const itemLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 4 &&
        line !== vendor &&
        !/^(total|subtotal|tax|amount|balance|change|cash|visa|mastercard|amex)/i.test(line) &&
        !/^\d{1,2}[\/-]\d{1,2}/.test(line),
    );
  return itemLine?.slice(0, 120) ?? "";
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

function buildPrompt(accounts: ExpenseAccountOption[]): string {
  return RECEIPT_PROMPT + accountChoicesForPrompt(accounts);
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
  input: {
    text?: string;
    imageBase64?: string;
    mimeType?: string;
    fileName?: string;
  },
): Promise<ReceiptClassification | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "high" } }
  > = [{ type: "text", text: buildPrompt(accounts) }];

  if (input.text?.trim()) {
    content.push({
      type: "text",
      text: `Receipt text extracted from PDF:\n${input.text.slice(0, 14_000)}`,
    });
  }

  if (input.imageBase64 && input.mimeType) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${input.mimeType};base64,${input.imageBase64}`,
        detail: "high",
      },
    });
  }

  if (content.length === 1) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Receipt reading failed (${response.status})`);
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Empty receipt reading response");

  const parsed = JSON.parse(raw) as VisionPayload;
  return normalizePayload(accounts, parsed, input.text);
}

function classifyFromTextRules(
  accounts: ExpenseAccountOption[],
  text: string,
  fileName: string,
): ReceiptClassification {
  const vendorName = extractVendorFromReceiptText(text) || fileName.replace(/\.[^.]+$/, "");
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

export async function classifyReceipt(
  accounts: ExpenseAccountOption[],
  input: { buffer: Buffer; mimeType: string; fileName: string },
): Promise<{ classification: ReceiptClassification; readMethod: ReceiptReadMethod; aiEnabled: boolean }> {
  const aiEnabled = Boolean(process.env.OPENAI_API_KEY?.trim());
  const fileName = input.fileName || "receipt";

  if (input.mimeType === "application/pdf") {
    const text = await extractPdfText(input.buffer);
    if (aiEnabled && text) {
      try {
        const classification = await classifyWithOpenAI(accounts, { text, fileName });
        if (classification) {
          return { classification, readMethod: "pdf-text", aiEnabled: true };
        }
      } catch {
        /* fall through to rules */
      }
    }
    if (text) {
      return {
        classification: classifyFromTextRules(accounts, text, fileName),
        readMethod: "pdf-text",
        aiEnabled,
      };
    }
    return {
      classification: classifyExpenseText(accounts, {
        vendorName: fileName.replace(/\.[^.]+$/, ""),
        memo: aiEnabled
          ? "Could not read this PDF — enter amount and vendor manually"
          : "Set OPENAI_API_KEY to read PDF receipts automatically",
      }),
      readMethod: "rules",
      aiEnabled,
    };
  }

  if (isImageMime(input.mimeType)) {
    if (aiEnabled) {
      try {
        const classification = await classifyWithOpenAI(accounts, {
          imageBase64: input.buffer.toString("base64"),
          mimeType: input.mimeType,
          fileName,
        });
        if (classification) {
          return { classification, readMethod: "vision", aiEnabled: true };
        }
      } catch {
        /* fall through */
      }
    }
    return {
      classification: classifyExpenseText(accounts, {
        vendorName: fileName.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
        memo: aiEnabled
          ? "Could not read this image — enter details manually"
          : "Set OPENAI_API_KEY on Vercel to read receipt photos automatically",
      }),
      readMethod: "rules",
      aiEnabled,
    };
  }

  return {
    classification: classifyExpenseText(accounts, {
      vendorName: fileName,
      memo: "Unsupported receipt format",
    }),
    readMethod: "rules",
    aiEnabled,
  };
}
