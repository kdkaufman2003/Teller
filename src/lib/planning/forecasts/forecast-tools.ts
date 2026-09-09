import { roundMoney } from "@/lib/accounting/payment-fees";

export function applyPercentToAmounts(
  amounts: Map<string, number>,
  accountIds: string[],
  periodMonths: string[],
  percent: number,
): Map<string, number> {
  const factor = 1 + percent / 100;
  const next = new Map(amounts);
  for (const accountId of accountIds) {
    for (const periodMonth of periodMonths) {
      const key = `${accountId}::${periodMonth}`;
      const current = next.get(key) ?? 0;
      next.set(key, roundMoney(current * factor));
    }
  }
  return next;
}

export function setMonthlyAmount(
  amounts: Map<string, number>,
  accountId: string,
  periodMonths: string[],
  amount: number,
): Map<string, number> {
  const next = new Map(amounts);
  for (const periodMonth of periodMonths) {
    next.set(`${accountId}::${periodMonth}`, roundMoney(amount));
  }
  return next;
}

export function spreadTotalEvenly(
  totalAmount: number,
  periodMonths: string[],
): number[] {
  const totalCents = Math.round(roundMoney(totalAmount) * 100);
  const base = Math.floor(totalCents / periodMonths.length);
  const remainder = totalCents - base * periodMonths.length;
  return periodMonths.map((_, index) =>
    roundMoney((base + (index < remainder ? 1 : 0)) / 100),
  );
}

export function spreadTotalToAccount(
  amounts: Map<string, number>,
  accountId: string,
  periodMonths: string[],
  totalAmount: number,
): Map<string, number> {
  const monthly = spreadTotalEvenly(totalAmount, periodMonths);
  const next = new Map(amounts);
  periodMonths.forEach((periodMonth, index) => {
    next.set(`${accountId}::${periodMonth}`, monthly[index] ?? 0);
  });
  return next;
}

export function copyPeriodValues(
  amounts: Map<string, number>,
  accountId: string,
  sourcePeriodMonth: string,
  targetPeriodMonths: string[],
): Map<string, number> {
  const value = amounts.get(`${accountId}::${sourcePeriodMonth}`) ?? 0;
  const next = new Map(amounts);
  for (const periodMonth of targetPeriodMonths) {
    next.set(`${accountId}::${periodMonth}`, value);
  }
  return next;
}

export function mapToLineInputs(
  amounts: Map<string, number>,
  sourceKind: "manual" | "budget" | "clone" = "manual",
): Array<{ accountId: string; periodMonth: string; amount: number; sourceKind: typeof sourceKind }> {
  const lines: Array<{ accountId: string; periodMonth: string; amount: number; sourceKind: typeof sourceKind }> = [];
  for (const [key, amount] of amounts) {
    if (Math.abs(amount) < 0.005) continue;
    const [accountId, periodMonth] = key.split("::");
    if (!accountId || !periodMonth) continue;
    lines.push({ accountId, periodMonth, amount, sourceKind });
  }
  return lines;
}
