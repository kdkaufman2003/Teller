/** P&L account types eligible for operating budget baseline and CSV import. */
export const BUDGET_PNL_ACCOUNT_TYPES = ["revenue", "cogs", "expense"] as const;

export type BudgetPnlAccountType = (typeof BUDGET_PNL_ACCOUNT_TYPES)[number];

export function isBudgetPnlAccountType(type: string): type is BudgetPnlAccountType {
  return (BUDGET_PNL_ACCOUNT_TYPES as readonly string[]).includes(type);
}

export function isBudgetPnlAccount(account: { type: string; archived?: boolean }): boolean {
  return !account.archived && isBudgetPnlAccountType(account.type);
}
