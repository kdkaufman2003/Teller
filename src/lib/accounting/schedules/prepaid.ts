import { roundMoney } from "../payment-fees";
import type { RecognitionMethod } from "./types";

export type PrepaidPeriod = {
  occurrenceDate: string;
  periodEnd: string;
  amount: number;
  isFinal: boolean;
};

function monthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function addMonths(date: string, count: number): string {
  const d = new Date(date.slice(0, 10) + "T12:00:00");
  d.setMonth(d.getMonth() + count);
  return d.toISOString().slice(0, 10);
}

/** Build straight-line monthly prepaid recognition periods with final-period cent absorption. */
export function buildPrepaidRecognitionPeriods(input: {
  startDate: string;
  endDate: string;
  originalAmount: number;
  method?: RecognitionMethod;
}): PrepaidPeriod[] {
  const start = input.startDate.slice(0, 10);
  const end = input.endDate.slice(0, 10);
  const total = roundMoney(input.originalAmount);
  if (total <= 0) return [];
  if (end < start) throw new Error("End date must be on or after start date");

  const method = input.method ?? "straight_line_monthly";
  const periods: PrepaidPeriod[] = [];

  if (method === "full_month" || method === "next_full_month") {
    let cursor =
      method === "next_full_month"
        ? monthEnd(
            new Date(addMonths(start, 1) + "T12:00:00").getFullYear(),
            new Date(addMonths(start, 1) + "T12:00:00").getMonth() + 1,
          )
        : monthEnd(
            new Date(start + "T12:00:00").getFullYear(),
            new Date(start + "T12:00:00").getMonth() + 1,
          );
    const monthKeys = new Set<string>();
    while (cursor <= end) {
      monthKeys.add(cursor.slice(0, 7));
      const d = new Date(cursor + "T12:00:00");
      cursor = monthEnd(d.getFullYear(), d.getMonth() + 1);
      const next = new Date(cursor + "T12:00:00");
      next.setMonth(next.getMonth() + 1);
      cursor = monthEnd(next.getFullYear(), next.getMonth() + 1);
    }
    // Recompute month list cleanly
    const months: string[] = [];
    let walk = start;
    while (walk <= end) {
      const d = new Date(walk + "T12:00:00");
      const pe = monthEnd(d.getFullYear(), d.getMonth() + 1);
      if (!months.includes(pe)) months.push(pe);
      walk = addMonths(walk, 1);
    }
    const count = months.length || 1;
    let allocated = 0;
    for (let i = 0; i < months.length; i += 1) {
      const isFinal = i === months.length - 1;
      const amount = isFinal ? roundMoney(total - allocated) : roundMoney(total / count);
      allocated = roundMoney(allocated + amount);
      periods.push({
        occurrenceDate: months[i]!,
        periodEnd: months[i]!,
        amount,
        isFinal,
      });
    }
    return periods;
  }

  // straight_line_monthly (default)
  const months: string[] = [];
  let walk = start;
  while (walk <= end) {
    const d = new Date(walk + "T12:00:00");
    const pe = monthEnd(d.getFullYear(), d.getMonth() + 1);
    if (!months.includes(pe)) months.push(pe);
    walk = addMonths(walk, 1);
  }
  const count = months.length || 1;
  let allocated = 0;
  for (let i = 0; i < months.length; i += 1) {
    const isFinal = i === months.length - 1;
    const amount = isFinal ? roundMoney(total - allocated) : roundMoney(total / count);
    allocated = roundMoney(allocated + amount);
    periods.push({
      occurrenceDate: months[i]!,
      periodEnd: months[i]!,
      amount,
      isFinal,
    });
  }
  return periods;
}

export function prepaidJournalLines(input: {
  amount: number;
  expenseAccountId: string;
  prepaidAccountId: string;
  jobId?: string | null;
}) {
  const amount = roundMoney(input.amount);
  return [
    { account_id: input.expenseAccountId, debit: amount, job_id: input.jobId ?? null },
    { account_id: input.prepaidAccountId, credit: amount, job_id: input.jobId ?? null },
  ];
}

export function validatePrepaidRecognition(
  schedule: { originalAmount: number; remainingAmount: number },
  amount: number,
): void {
  const next = roundMoney(schedule.remainingAmount - amount);
  if (amount <= 0) throw new Error("Recognition amount must be positive");
  if (next < -0.009) throw new Error("Recognition exceeds remaining prepaid balance");
}

export function nextRemainingAfterRecognition(remaining: number, amount: number): number {
  return roundMoney(Math.max(0, roundMoney(remaining) - roundMoney(amount)));
}
