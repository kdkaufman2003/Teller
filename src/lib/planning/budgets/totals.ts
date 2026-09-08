import { roundMoney } from "@/lib/accounting/payment-fees";

export type BudgetLineAmount = {
  accountId: string;
  periodMonth: string;
  amount: number;
};

export function accountAnnualTotal(lines: BudgetLineAmount[], accountId: string): number {
  return roundMoney(
    lines
      .filter((line) => line.accountId === accountId)
      .reduce((sum, line) => sum + line.amount, 0),
  );
}

export function monthlyTotal(lines: BudgetLineAmount[], periodMonth: string): number {
  return roundMoney(
    lines
      .filter((line) => line.periodMonth === periodMonth)
      .reduce((sum, line) => sum + line.amount, 0),
  );
}

export function budgetAnnualTotal(lines: BudgetLineAmount[]): number {
  return roundMoney(lines.reduce((sum, line) => sum + line.amount, 0));
}

export function groupLinesByAccount<T extends BudgetLineAmount>(
  lines: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const line of lines) {
    const bucket = map.get(line.accountId) ?? [];
    bucket.push(line);
    map.set(line.accountId, bucket);
  }
  return map;
}
