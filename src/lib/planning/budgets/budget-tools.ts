import { roundMoney } from "@/lib/accounting/payment-fees";
import { fiscalYearCalendarMonths } from "./periods";

export function spreadAnnualEvenly(annualAmount: number): number[] {
  const totalCents = Math.round(roundMoney(annualAmount) * 100);
  const base = Math.floor(totalCents / 12);
  const remainder = totalCents - base * 12;
  return Array.from({ length: 12 }, (_, index) =>
    roundMoney((base + (index < remainder ? 1 : 0)) / 100),
  );
}

export function applyMonthlyAmountsToAccount(
  amounts: Record<string, number>,
  accountId: string,
  fiscalYear: number,
  monthAmounts: number[],
  cellKey: (accountId: string, periodMonth: string) => string,
): Record<string, number> {
  const months = fiscalYearCalendarMonths(fiscalYear);
  const next = { ...amounts };
  months.forEach((periodMonth, index) => {
    next[cellKey(accountId, periodMonth)] = monthAmounts[index] ?? 0;
  });
  return next;
}

export function copyMonthForward(
  amounts: Record<string, number>,
  accountId: string,
  sourcePeriodMonth: string,
  fiscalYear: number,
  cellKey: (accountId: string, periodMonth: string) => string,
): Record<string, number> {
  const months = fiscalYearCalendarMonths(fiscalYear);
  const sourceIndex = months.indexOf(sourcePeriodMonth);
  if (sourceIndex < 0) return amounts;
  const value = amounts[cellKey(accountId, sourcePeriodMonth)] ?? 0;
  const next = { ...amounts };
  for (let index = sourceIndex + 1; index < months.length; index += 1) {
    next[cellKey(accountId, months[index]!)] = value;
  }
  return next;
}

export function applyPercentChange(
  amounts: Record<string, number>,
  accountId: string,
  fiscalYear: number,
  percent: number,
  cellKey: (accountId: string, periodMonth: string) => string,
): Record<string, number> {
  const months = fiscalYearCalendarMonths(fiscalYear);
  const factor = 1 + percent / 100;
  const next = { ...amounts };
  for (const periodMonth of months) {
    const key = cellKey(accountId, periodMonth);
    const current = amounts[key] ?? 0;
    next[key] = roundMoney(current * factor);
  }
  return next;
}

export function clearAccountAmounts(
  amounts: Record<string, number>,
  accountId: string,
  fiscalYear: number,
  cellKey: (accountId: string, periodMonth: string) => string,
): Record<string, number> {
  const next = { ...amounts };
  for (const periodMonth of fiscalYearCalendarMonths(fiscalYear)) {
    next[cellKey(accountId, periodMonth)] = 0;
  }
  return next;
}
