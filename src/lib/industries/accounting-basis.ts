import type { IndustryQuestion, QuestionOption } from "./types";

export const ACCOUNTING_BASIS_OPTIONS: QuestionOption[] = [
  {
    value: "accrual",
    label: "Accrual (recommended)",
    description:
      "Income and expenses hit the P&L when you earn or owe them — e.g. when you send an invoice or receive a bill — even if cash moves later. Standard for businesses tracking receivables, payables, and deferred subscription revenue.",
  },
  {
    value: "cash",
    label: "Cash",
    description:
      "Income and expenses only appear when money actually comes in or goes out. Simpler day-to-day, but your P&L won't reflect unpaid invoices or bills you've received but not paid yet.",
  },
];

export function accountingBasisQuestion(
  overrides: Partial<Omit<IndustryQuestion, "id" | "type">> = {},
): IndustryQuestion {
  return {
    id: "basis",
    prompt: "Accounting basis",
    help: "This controls when activity shows up on your profit & loss — when you earn or owe it (accrual), or when cash actually moves (cash).",
    type: "select",
    section: "accounting",
    default: "accrual",
    options: ACCOUNTING_BASIS_OPTIONS,
    ...overrides,
  };
}
