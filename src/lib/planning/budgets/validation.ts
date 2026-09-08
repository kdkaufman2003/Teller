import { roundMoney } from "@/lib/accounting/payment-fees";
import { assertLinesEditable } from "./lifecycle";
import { assertPeriodMonthInFiscalYear } from "./periods";
import { MAX_BULK_LINES, type BudgetLineInput, type BudgetVersionStatus } from "./types";

export type AccountRef = {
  id: string;
  organizationId: string;
  code: string;
  archived: boolean;
};

export function validateBudgetName(name: string): void {
  if (!name.trim()) throw new Error("Budget name is required");
  if (name.trim().length > 200) throw new Error("Budget name is too long");
}

export function validateFiscalYear(fiscalYear: number): void {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
    throw new Error("Fiscal year must be a whole number between 1900 and 2200");
  }
}

export function parseBudgetAmount(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error("Amount must be a valid number");
  return roundMoney(amount);
}

export function validateLineAmount(amount: number): void {
  if (!Number.isFinite(amount)) throw new Error("Amount must be a valid number");
  roundMoney(amount);
}

export function lineKey(accountId: string, periodMonth: string): string {
  return `${accountId}::${periodMonth}`;
}

export function detectDuplicateLines(lines: BudgetLineInput[]): string | null {
  const seen = new Set<string>();
  for (const line of lines) {
    const key = lineKey(line.accountId, line.periodMonth);
    if (seen.has(key)) {
      return key;
    }
    seen.add(key);
  }
  return null;
}

export function validateAccountForBudgetLine(
  account: AccountRef | undefined,
  organizationId: string,
): void {
  if (!account) throw new Error("GL account not found");
  if (account.organizationId !== organizationId) {
    throw new Error("GL account must belong to your organization");
  }
  if (account.archived) throw new Error(`Account ${account.code} is archived and cannot be budgeted`);
}

export function validateBulkLines(input: {
  lines: BudgetLineInput[];
  fiscalYear: number;
  organizationId: string;
  versionStatus: BudgetVersionStatus;
  accountsById: Map<string, AccountRef>;
}): BudgetLineInput[] {
  assertLinesEditable(input.versionStatus);

  if (input.lines.length > MAX_BULK_LINES) {
    throw new Error(`Too many lines (max ${MAX_BULK_LINES})`);
  }

  const duplicate = detectDuplicateLines(input.lines);
  if (duplicate) {
    throw new Error(`Duplicate budget line for ${duplicate}`);
  }

  const normalized: BudgetLineInput[] = [];
  for (const raw of input.lines) {
    if (!raw.accountId?.trim()) throw new Error("Account is required for each line");
    assertPeriodMonthInFiscalYear(raw.periodMonth, input.fiscalYear);
    const account = input.accountsById.get(raw.accountId);
    validateAccountForBudgetLine(account, input.organizationId);
    const amount = parseBudgetAmount(raw.amount);
    validateLineAmount(amount);
    normalized.push({
      accountId: raw.accountId,
      periodMonth: raw.periodMonth,
      amount,
      notes: raw.notes?.trim() ?? "",
    });
  }

  return normalized;
}

export function buildCloneLinePayload(
  sourceLines: BudgetLineInput[],
  targetVersionId: string,
): Array<BudgetLineInput & { budgetVersionId: string; sourceKind: "clone" }> {
  return sourceLines.map((line) => ({
    ...line,
    budgetVersionId: targetVersionId,
    sourceKind: "clone" as const,
  }));
}
