import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { listBudgetLines } from "@/lib/planning/budgets/budget-crud";
import { isBudgetPnlAccount } from "@/lib/planning/budgets/pnl-scope";
import type { PlanningAccount } from "@/lib/planning/reports/budget-vs-actual";
import { rollingForwardMonths } from "./periods";
import type { ForecastLineInput } from "./types";

export async function buildForecastLinesFromBudget(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    budgetVersionId: string;
    anchorMonth: string;
    horizonMonths: number;
    accounts: PlanningAccount[];
  },
): Promise<ForecastLineInput[]> {
  const { data: version, error: versionError } = await supabase
    .from("teller_budget_versions")
    .select("id, organization_id, budget_id, teller_budgets!inner(fiscal_year)")
    .eq("organization_id", input.organizationId)
    .eq("id", input.budgetVersionId)
    .single();

  if (versionError || !version) {
    throw new Error("Budget version not found or not in your organization");
  }

  const budgetRow = version.teller_budgets;
  const budget = (Array.isArray(budgetRow) ? budgetRow[0] : budgetRow) as { fiscal_year: number };
  const budgetLines = await listBudgetLines(supabase, input.organizationId, input.budgetVersionId);
  const budgetByAccountMonth = new Map<string, number>();
  for (const line of budgetLines) {
    budgetByAccountMonth.set(
      `${line.account_id as string}::${line.period_month as string}`,
      roundMoney(Number(line.amount)),
    );
  }

  const forwardMonths = rollingForwardMonths(input.anchorMonth, input.horizonMonths);
  const lines: ForecastLineInput[] = [];

  for (const account of input.accounts) {
    if (!isBudgetPnlAccount(account)) continue;
    for (const periodMonth of forwardMonths) {
      const budgetYear = Number(periodMonth.slice(0, 4));
      const budgetMonth = `${budgetYear}-${periodMonth.slice(5, 7)}-01`;
      const budgetKey = `${account.id}::${budgetMonth}`;
      let amount = budgetByAccountMonth.get(budgetKey) ?? 0;

      if (amount === 0 && budgetYear !== Number(budget.fiscal_year)) {
        const sameMonthPriorYear = `${budgetYear - 1}-${periodMonth.slice(5, 7)}-01`;
        amount = budgetByAccountMonth.get(`${account.id}::${sameMonthPriorYear}`) ?? 0;
      }

      if (Math.abs(amount) >= 0.005) {
        lines.push({
          accountId: account.id,
          periodMonth,
          amount,
          sourceKind: "budget",
          notes: "",
        });
      }
    }
  }

  return lines;
}
