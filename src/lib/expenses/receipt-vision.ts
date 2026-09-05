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
  memo?: string;
  accountCode?: string | null;
  confidence?: string;
  reason?: string;
};

const RECEIPT_PROMPT = `You classify business receipt images for bookkeeping.
Return JSON only with keys:
vendorName (string),
amount (number or null),
issueDate (ISO date YYYY-MM-DD or null),
memo (short string),
accountCode (pick exactly one code from the list),
confidence ("high"|"medium"|"low"),
reason (short string why this account)

Chart of accounts:
`;

export async function classifyReceiptImage(
  accounts: ExpenseAccountOption[],
  input: { base64: string; mimeType: string; fileName?: string },
): Promise<ReceiptClassification> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return classifyExpenseText(accounts, {
      vendorName: input.fileName?.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
      memo: "Receipt upload — add OPENAI_API_KEY for automatic reading",
    });
  }

  try {
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
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: RECEIPT_PROMPT + accountChoicesForPrompt(accounts),
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${input.mimeType};base64,${input.base64}`,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Vision API failed (${response.status})`);
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty vision response");

    const parsed = JSON.parse(content) as VisionPayload;
    const account = pickAccountFromCode(accounts, parsed.accountCode);
    const rulesFallback = classifyExpenseText(accounts, {
      vendorName: parsed.vendorName,
      memo: parsed.memo,
    });

    const confidence =
      parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
        ? parsed.confidence
        : "medium";

    return {
      vendorName: parsed.vendorName?.trim() || rulesFallback.vendorName,
      amount:
        parsed.amount == null || parsed.amount === ""
          ? null
          : Number(parsed.amount),
      issueDate: parsed.issueDate?.slice(0, 10) || null,
      memo: parsed.memo?.trim() || rulesFallback.memo,
      accountId: account?.id ?? rulesFallback.accountId,
      accountCode: account?.code ?? rulesFallback.accountCode,
      confidence: account ? confidence : "low",
      reason: parsed.reason?.trim() || "AI classification",
      source: "ai",
    };
  } catch {
    return classifyExpenseText(accounts, {
      vendorName: input.fileName,
      memo: "Could not read receipt automatically — please confirm details",
    });
  }
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
