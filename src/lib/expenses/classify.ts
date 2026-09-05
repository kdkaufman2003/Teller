export type ExpenseAccountOption = {
  id: string;
  code: string;
  name: string;
};

export type ReceiptClassification = {
  vendorName: string;
  amount: number | null;
  issueDate: string | null;
  memo: string;
  accountId: string | null;
  accountCode: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  source: "ai" | "rules";
};

/** IRS standard mileage rate — update annually; user can override in the form. */
export const DEFAULT_MILEAGE_RATE = 0.7;

const KEYWORD_RULES: { pattern: RegExp; code: string; reason: string }[] = [
  { pattern: /\b(shell|chevron|exxon|bp|fuel|gas station|petro)\b/i, code: "6100", reason: "Fuel vendor" },
  { pattern: /\b(vehicle|auto|truck|mileage|car wash)\b/i, code: "6100", reason: "Vehicle expense" },
  { pattern: /\b(home depot|lowe'?s|supply|hardware|tools?)\b/i, code: "6200", reason: "Tools & supplies" },
  { pattern: /\b(staples|office depot|amazon business office)\b/i, code: "6600", reason: "Office supplies" },
  { pattern: /\b(rent|lease)\b/i, code: "6300", reason: "Rent" },
  { pattern: /\b(insurance|progressive|state farm|allstate)\b/i, code: "6400", reason: "Insurance" },
  { pattern: /\b(google ads|facebook ads|marketing|advertis)\b/i, code: "6500", reason: "Marketing" },
  { pattern: /\b(google workspace|google cloud|google llc|gmail)\b/i, code: "6100", reason: "Google software/services" },
  { pattern: /\b(google)\b/i, code: "6100", reason: "Google services" },
  { pattern: /\b(payroll|gusto|adp|paychex)\b/i, code: "6000", reason: "Payroll" },
  { pattern: /\b(restaurant|coffee|starbucks|lunch|meal|doordash|uber eats)\b/i, code: "6600", reason: "Meals & office" },
  { pattern: /\b(software|saas|subscription|hosting|vercel|aws)\b/i, code: "6100", reason: "Software/tools" },
];

export function findAccountByCode(
  accounts: ExpenseAccountOption[],
  code: string,
): ExpenseAccountOption | null {
  return accounts.find((row) => row.code === code) ?? null;
}

export function findMileageAccount(accounts: ExpenseAccountOption[]): ExpenseAccountOption | null {
  return (
    findAccountByCode(accounts, "6100") ??
    accounts.find((row) => /vehicle|fuel|mileage/i.test(row.name)) ??
    accounts[0] ??
    null
  );
}

export function findFallbackAccount(accounts: ExpenseAccountOption[]): ExpenseAccountOption | null {
  return (
    findAccountByCode(accounts, "6900") ??
    accounts.find((row) => /other/i.test(row.name)) ??
    accounts[0] ??
    null
  );
}

export function classifyExpenseText(
  accounts: ExpenseAccountOption[],
  input: { vendorName?: string; description?: string; memo?: string },
): ReceiptClassification {
  const haystack = [input.vendorName, input.description, input.memo].filter(Boolean).join(" ");
  const fallback = findFallbackAccount(accounts);

  for (const rule of KEYWORD_RULES) {
    if (!rule.pattern.test(haystack)) continue;
    const account = findAccountByCode(accounts, rule.code) ?? fallback;
    if (!account) break;
    return {
      vendorName: input.vendorName?.trim() || "",
      amount: null,
      issueDate: null,
      memo: input.memo?.trim() || input.description?.trim() || "",
      accountId: account.id,
      accountCode: account.code,
      confidence: "medium",
      reason: rule.reason,
      source: "rules",
    };
  }

  return {
    vendorName: input.vendorName?.trim() || "",
    amount: null,
    issueDate: null,
    memo: input.memo?.trim() || input.description?.trim() || "",
    accountId: fallback?.id ?? null,
    accountCode: fallback?.code ?? null,
    confidence: "low",
    reason: "No strong match — review the category",
    source: "rules",
  };
}

export function pickAccountFromCode(
  accounts: ExpenseAccountOption[],
  code: string | null | undefined,
): ExpenseAccountOption | null {
  if (!code) return null;
  return findAccountByCode(accounts, code) ?? findFallbackAccount(accounts);
}

export function accountChoicesForPrompt(accounts: ExpenseAccountOption[]): string {
  return accounts.map((row) => `${row.code} ${row.name}`).join("\n");
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function mileageAmount(miles: number, ratePerMile: number): number {
  return roundMoney(Math.max(0, miles) * Math.max(0, ratePerMile));
}
