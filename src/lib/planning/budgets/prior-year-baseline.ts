import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchGlAccountTotals, periodActivityFromTotals } from "@/lib/accounting/gl-account-totals";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { fiscalYearCalendarMonths } from "./periods";
import { isBudgetPnlAccount } from "./pnl-scope";
import type { BudgetLineInput } from "./types";

export type PlanningAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  archived: boolean;
};

function monthBounds(periodMonth: string): { start: string; end: string } {
  const year = Number(periodMonth.slice(0, 4));
  const month = Number(periodMonth.slice(5, 7));
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: periodMonth,
    end: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * Maps prior calendar-year GL actuals to target fiscal-year budget months.
 * Jan N-1 actual → Jan N budget (calendar fiscal year per Phase 14A).
 */
export async function buildPriorYearActualBaselineLines(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    targetFiscalYear: number;
    accounts: PlanningAccount[];
  },
): Promise<BudgetLineInput[]> {
  const priorYear = input.targetFiscalYear - 1;
  const targetMonths = fiscalYearCalendarMonths(input.targetFiscalYear);
  const priorMonths = fiscalYearCalendarMonths(priorYear);
  const pnlAccounts = input.accounts.filter(isBudgetPnlAccount);
  const accountById = new Map(pnlAccounts.map((account) => [account.id, account]));
  const lines: BudgetLineInput[] = [];

  for (let index = 0; index < targetMonths.length; index += 1) {
    const priorMonth = priorMonths[index];
    const targetMonth = targetMonths[index];
    const { start, end } = monthBounds(priorMonth);
    const totals = await fetchGlAccountTotals(supabase, input.organizationId, start, end);
    if (!totals) {
      throw new Error("GL account totals unavailable — apply migration 026 for prior-year baseline");
    }
    for (const row of totals) {
      const account = accountById.get(row.account_id);
      if (!account) continue;
      const amount = periodActivityFromTotals(row, account.type);
      if (Math.abs(amount) < 0.005) continue;
      lines.push({
        accountId: account.id,
        periodMonth: targetMonth,
        amount: roundMoney(amount),
        notes: `Prior-year actual ${priorMonth.slice(0, 7)}`,
      });
    }
  }

  return lines;
}

export function shiftPeriodMonth(periodMonth: string, yearDelta: number): string {
  const year = Number(periodMonth.slice(0, 4)) + yearDelta;
  const month = periodMonth.slice(4, 7);
  return `${year}${month}-01`;
}
