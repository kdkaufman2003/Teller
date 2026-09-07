import { roundMoney } from "./payment-fees";
import type { DepreciationConvention, DepreciationScheduleLine } from "./fixed-asset-types";

export function computeDepreciableBasis(originalCost: number, salvageValue: number): number {
  return Math.max(0, roundMoney(originalCost - salvageValue));
}

export function firstDepreciationPeriod(
  placedInServiceDate: string,
  convention: DepreciationConvention,
): { year: number; month: number } {
  const [year, month] = placedInServiceDate.slice(0, 10).split("-").map(Number);
  if (convention === "full_month") {
    return { year, month };
  }
  let nextMonth = month + 1;
  let nextYear = year;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  return { year: nextYear, month: nextMonth };
}

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function addMonths(year: number, month: number, count: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + count;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function comparePeriod(a: { year: number; month: number }, b: { year: number; month: number }) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

export function buildStraightLineSchedule(input: {
  originalCost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  placedInServiceDate: string;
  convention: DepreciationConvention;
  stopThrough?: { year: number; month: number } | null;
}): DepreciationScheduleLine[] {
  const basis = computeDepreciableBasis(input.originalCost, input.salvageValue);
  if (basis <= 0 || input.usefulLifeMonths <= 0) return [];

  const baseMonthly = roundMoney(basis / input.usefulLifeMonths);
  const first = firstDepreciationPeriod(input.placedInServiceDate, input.convention);
  const lines: DepreciationScheduleLine[] = [];
  let accumulated = 0;
  let bookValue = roundMoney(input.originalCost);

  for (let i = 0; i < input.usefulLifeMonths; i += 1) {
    const period = addMonths(first.year, first.month, i);
    if (input.stopThrough && comparePeriod(period, input.stopThrough) > 0) break;

    const beginningBookValue = bookValue;
    const remainingDepreciable = roundMoney(basis - accumulated);
    const isFinalPeriod =
      i === input.usefulLifeMonths - 1 || remainingDepreciable <= baseMonthly + 0.009;
    const depreciationAmount = isFinalPeriod ? remainingDepreciable : baseMonthly;
    if (depreciationAmount <= 0) break;

    accumulated = roundMoney(accumulated + depreciationAmount);
    bookValue = roundMoney(input.originalCost - accumulated);
    if (bookValue < input.salvageValue - 0.009) {
      bookValue = roundMoney(input.salvageValue);
    }

    lines.push({
      periodYear: period.year,
      periodMonth: period.month,
      periodStartDate: `${periodKey(period.year, period.month)}-01`,
      beginningBookValue,
      depreciationAmount,
      accumulatedDepreciation: accumulated,
      endingBookValue: bookValue,
      isFinalPeriod,
    });

    if (bookValue <= input.salvageValue + 0.009) break;
  }

  return lines;
}

export function isFullyDepreciated(originalCost: number, salvageValue: number, postedAccumDepr: number): boolean {
  const basis = computeDepreciableBasis(originalCost, salvageValue);
  return basis > 0 && postedAccumDepr >= basis - 0.009;
}

export function netBookValue(originalCost: number, postedAccumDepr: number): number {
  return roundMoney(originalCost - postedAccumDepr);
}
