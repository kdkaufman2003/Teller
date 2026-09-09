import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchGlAccountTotals,
  periodActivityFromTotals,
} from "@/lib/accounting/gl-account-totals";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { getBudgetVersion, listBudgetLines } from "@/lib/planning/budgets/budget-crud";
import { fiscalYearCalendarMonths, monthLabel } from "@/lib/planning/budgets/periods";
import { isBudgetPnlAccount } from "@/lib/planning/budgets/pnl-scope";
import { groupLinesByAccount } from "@/lib/planning/budgets/totals";
import {
  computeVarianceAmounts,
  normalizeOwnerFacingAmount,
  sumAmounts,
  type VarianceAmounts,
  type VarianceStatus,
} from "./variance";

export type BudgetVsActualAccountRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  category: "revenue" | "cogs" | "expense";
  month: VarianceAmounts;
  ytd: VarianceAmounts;
  annual: {
    budget: number;
    actualYtd: number;
    remainingBudget: number;
    ytdVariance: VarianceAmounts;
  };
  isUnbudgeted: boolean;
  hasBudgetWithoutActual: boolean;
};

export type BudgetVsActualCategoryRollup = {
  category: "revenue" | "cogs" | "gross_profit" | "expense" | "operating_income";
  label: string;
  month: VarianceAmounts;
  ytd: VarianceAmounts;
  annualBudget: number;
  actualYtd: number;
};

export type BudgetVsActualSummary = {
  revenue: VarianceAmounts;
  grossProfit: VarianceAmounts;
  expenses: VarianceAmounts;
  operatingIncome: VarianceAmounts;
  largestUnfavorable?: { code: string; name: string; varianceAmount: number };
};

export type BudgetVsActualReport = {
  fiscalYear: number;
  throughMonth: string;
  throughMonthLabel: string;
  version: {
    id: string;
    versionNumber: number;
    label: string;
    status: string;
    budgetId: string;
    budgetName: string;
    isDraft: boolean;
  };
  summary: BudgetVsActualSummary;
  categories: BudgetVsActualCategoryRollup[];
  accounts: BudgetVsActualAccountRow[];
};

export type PlanningAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  archived: boolean;
};

function monthEnd(periodMonth: string): string {
  const year = Number(periodMonth.slice(0, 4));
  const month = Number(periodMonth.slice(5, 7));
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function budgetAmountForLines(
  lines: Array<{ periodMonth: string; amount: number }>,
  periodMonth?: string,
): number {
  const filtered = periodMonth
    ? lines.filter((line) => line.periodMonth === periodMonth)
    : lines;
  return roundMoney(filtered.reduce((sum, line) => sum + line.amount, 0));
}

async function loadActualsForRange(
  supabase: SupabaseClient,
  organizationId: string,
  periodStart: string,
  periodEnd: string,
  accounts: PlanningAccount[],
): Promise<Map<string, number>> {
  const totals = await fetchGlAccountTotals(supabase, organizationId, periodStart, periodEnd);
  if (!totals) {
    throw new Error("GL account totals unavailable — apply migration 026 for budget vs actual");
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const amounts = new Map<string, number>();
  for (const row of totals) {
    const account = accountById.get(row.account_id);
    if (!account || !isBudgetPnlAccount(account)) continue;
    const activity = periodActivityFromTotals(row, account.type);
    amounts.set(
      account.id,
      normalizeOwnerFacingAmount(activity, account.type),
    );
  }
  return amounts;
}

async function loadMonthlyActuals(
  supabase: SupabaseClient,
  organizationId: string,
  months: string[],
  accounts: PlanningAccount[],
): Promise<Map<string, Map<string, number>>> {
  const byAccount = new Map<string, Map<string, number>>();
  await Promise.all(
    months.map(async (periodMonth) => {
      const actuals = await loadActualsForRange(
        supabase,
        organizationId,
        periodMonth,
        monthEnd(periodMonth),
        accounts,
      );
      for (const [accountId, amount] of actuals) {
        const bucket = byAccount.get(accountId) ?? new Map<string, number>();
        bucket.set(periodMonth, amount);
        byAccount.set(accountId, bucket);
      }
    }),
  );
  return byAccount;
}

function categoryForType(type: string): "revenue" | "cogs" | "expense" | null {
  if (type === "revenue") return "revenue";
  if (type === "cogs") return "cogs";
  if (type === "expense") return "expense";
  return null;
}

function rollupCategory(
  category: BudgetVsActualCategoryRollup["category"],
  label: string,
  rows: BudgetVsActualAccountRow[],
  filter: (row: BudgetVsActualAccountRow) => boolean,
): BudgetVsActualCategoryRollup {
  const filtered = rows.filter(filter);
  const monthBudget = sumAmounts(filtered.map((row) => row.month.budget));
  const monthActual = sumAmounts(filtered.map((row) => row.month.actual));
  const ytdBudget = sumAmounts(filtered.map((row) => row.ytd.budget));
  const ytdActual = sumAmounts(filtered.map((row) => row.ytd.actual));
  const annualBudget = sumAmounts(filtered.map((row) => row.annual.budget));
  const rollupType =
    category === "gross_profit" || category === "operating_income" ? "revenue" : category;
  return {
    category,
    label,
    month: computeVarianceAmounts(monthActual, monthBudget, rollupType),
    ytd: computeVarianceAmounts(ytdActual, ytdBudget, rollupType),
    annualBudget,
    actualYtd: ytdActual,
  };
}

function deriveGrossProfitRollup(
  revenue: BudgetVsActualCategoryRollup,
  cogs: BudgetVsActualCategoryRollup,
): BudgetVsActualCategoryRollup {
  return {
    category: "gross_profit",
    label: "Gross Profit",
    month: computeVarianceAmounts(
      revenue.month.actual - cogs.month.actual,
      revenue.month.budget - cogs.month.budget,
      "revenue",
    ),
    ytd: computeVarianceAmounts(
      revenue.ytd.actual - cogs.ytd.actual,
      revenue.ytd.budget - cogs.ytd.budget,
      "revenue",
    ),
    annualBudget: roundMoney(revenue.annualBudget - cogs.annualBudget),
    actualYtd: roundMoney(revenue.actualYtd - cogs.actualYtd),
  };
}

function deriveOperatingIncomeRollup(
  grossProfit: BudgetVsActualCategoryRollup,
  expenses: BudgetVsActualCategoryRollup,
): BudgetVsActualCategoryRollup {
  return {
    category: "operating_income",
    label: "Operating Income",
    month: computeVarianceAmounts(
      grossProfit.month.actual - expenses.month.actual,
      grossProfit.month.budget - expenses.month.budget,
      "revenue",
    ),
    ytd: computeVarianceAmounts(
      grossProfit.ytd.actual - expenses.ytd.actual,
      grossProfit.ytd.budget - expenses.ytd.budget,
      "revenue",
    ),
    annualBudget: roundMoney(grossProfit.annualBudget - expenses.annualBudget),
    actualYtd: roundMoney(grossProfit.actualYtd - expenses.actualYtd),
  };
}

export async function resolveBudgetVersionForReport(
  supabase: SupabaseClient,
  organizationId: string,
  input: { fiscalYear: number; versionId?: string | null },
) {
  if (input.versionId) {
    const version = await getBudgetVersion(supabase, organizationId, input.versionId);
    const budget = version.teller_budgets as {
      id: string;
      name: string;
      fiscal_year: number;
    };
    if (Number(budget.fiscal_year) !== input.fiscalYear) {
      throw new Error("Budget version fiscal year mismatch");
    }
    return { budget, version };
  }

  const { data: budget, error } = await supabase
    .from("teller_budgets")
    .select("*, teller_budget_versions(*)")
    .eq("organization_id", organizationId)
    .eq("fiscal_year", input.fiscalYear)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!budget) throw new Error(`No active budget for fiscal year ${input.fiscalYear}`);

  const versions = (budget.teller_budget_versions ?? []) as Array<{
    id: string;
    version_number: number;
    label: string;
    status: string;
  }>;
  const preferred = versions
    .filter((version) => version.status === "approved" || version.status === "locked")
    .sort((a, b) => b.version_number - a.version_number)[0];
  const fallback = versions
    .filter((version) => version.status === "draft" || version.status === "submitted")
    .sort((a, b) => b.version_number - a.version_number)[0];
  const chosen = preferred ?? fallback;
  if (!chosen) throw new Error("No budget versions available");

  return {
    budget,
    version: chosen,
  };
}

export function buildBudgetVsActualReport(input: {
  fiscalYear: number;
  throughMonth: string;
  version: {
    id: string;
    versionNumber: number;
    label: string;
    status: string;
    budgetId: string;
    budgetName: string;
  };
  accounts: PlanningAccount[];
  budgetLines: Array<{ accountId: string; periodMonth: string; amount: number }>;
  monthlyActuals: Map<string, Map<string, number>>;
}): BudgetVsActualReport {
  const months = fiscalYearCalendarMonths(input.fiscalYear);
  const throughIndex = months.indexOf(input.throughMonth);
  if (throughIndex < 0) throw new Error("Through month must belong to fiscal year");
  const ytdMonths = months.slice(0, throughIndex + 1);
  const budgetByAccount = groupLinesByAccount(input.budgetLines);

  const accountIds = new Set<string>();
  for (const account of input.accounts.filter(isBudgetPnlAccount)) accountIds.add(account.id);
  for (const line of input.budgetLines) accountIds.add(line.accountId);
  for (const accountId of input.monthlyActuals.keys()) accountIds.add(accountId);

  const accountRows: BudgetVsActualAccountRow[] = [];
  for (const accountId of accountIds) {
    const account =
      input.accounts.find((entry) => entry.id === accountId) ??
      ({
        id: accountId,
        code: "—",
        name: "Unknown account",
        type: "expense",
        archived: false,
      } as PlanningAccount);
    const category = categoryForType(account.type);
    if (!category) continue;

    const lines = (budgetByAccount.get(accountId) ?? []).map((line) => ({
      periodMonth: line.periodMonth,
      amount: line.amount,
    }));
    const monthActual = input.monthlyActuals.get(accountId)?.get(input.throughMonth) ?? 0;
    const monthBudget = budgetAmountForLines(lines, input.throughMonth);
    const ytdActual = sumAmounts(
      ytdMonths.map((periodMonth) => input.monthlyActuals.get(accountId)?.get(periodMonth) ?? 0),
    );
    const ytdBudget = budgetAmountForLines(
      lines.filter((line) => ytdMonths.includes(line.periodMonth)),
    );
    const annualBudget = budgetAmountForLines(lines);
    const monthVariance = computeVarianceAmounts(monthActual, monthBudget, account.type);
    const ytdVariance = computeVarianceAmounts(ytdActual, ytdBudget, account.type);
    const isUnbudgeted =
      (Math.abs(ytdActual) >= 0.005 && Math.abs(ytdBudget) < 0.005) ||
      monthVariance.status === "unbudgeted";
    const hasBudgetWithoutActual =
      Math.abs(ytdBudget) >= 0.005 && Math.abs(ytdActual) < 0.005;

    if (
      monthVariance.status === "no_activity" &&
      ytdVariance.status === "no_activity" &&
      annualBudget === 0
    ) {
      continue;
    }

    accountRows.push({
      accountId,
      code: account.code,
      name: account.name,
      type: account.type,
      category,
      month: monthVariance,
      ytd: ytdVariance,
      annual: {
        budget: annualBudget,
        actualYtd: ytdActual,
        remainingBudget: roundMoney(annualBudget - ytdActual),
        ytdVariance,
      },
      isUnbudgeted,
      hasBudgetWithoutActual,
    });
  }

  accountRows.sort((a, b) => a.code.localeCompare(b.code));

  const revenue = rollupCategory("revenue", "Revenue", accountRows, (row) => row.category === "revenue");
  const cogs = rollupCategory("cogs", "COGS", accountRows, (row) => row.category === "cogs");
  const expenses = rollupCategory(
    "expense",
    "Operating Expenses",
    accountRows,
    (row) => row.category === "expense",
  );
  const grossProfit = deriveGrossProfitRollup(revenue, cogs);
  const operatingIncome = deriveOperatingIncomeRollup(grossProfit, expenses);

  const unfavorable = accountRows
    .filter((row) => row.ytd.status === "unfavorable" || row.ytd.status === "unbudgeted")
    .sort((a, b) => Math.abs(b.ytd.varianceAmount) - Math.abs(a.ytd.varianceAmount))[0];

  return {
    fiscalYear: input.fiscalYear,
    throughMonth: input.throughMonth,
    throughMonthLabel: monthLabel(input.throughMonth),
    version: {
      ...input.version,
      isDraft: input.version.status === "draft" || input.version.status === "submitted",
    },
    summary: {
      revenue: revenue.ytd,
      grossProfit: grossProfit.ytd,
      expenses: expenses.ytd,
      operatingIncome: operatingIncome.ytd,
      largestUnfavorable: unfavorable
        ? {
            code: unfavorable.code,
            name: unfavorable.name,
            varianceAmount: unfavorable.ytd.varianceAmount,
          }
        : undefined,
    },
    categories: [revenue, cogs, grossProfit, expenses, operatingIncome],
    accounts: accountRows,
  };
}

export async function loadBudgetVsActualReport(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    fiscalYear: number;
    throughMonth: string;
    versionId?: string | null;
  },
): Promise<BudgetVsActualReport> {
  const { budget, version } = await resolveBudgetVersionForReport(supabase, organizationId, input);

  const { data: accountsRaw, error: accountsError } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, archived")
    .eq("organization_id", organizationId)
    .order("code");
  if (accountsError) throw new Error(accountsError.message);

  const accounts = (accountsRaw ?? []) as PlanningAccount[];
  const linesRaw = await listBudgetLines(supabase, organizationId, version.id as string);
  const budgetLines = linesRaw.map((line) => ({
    accountId: line.account_id as string,
    periodMonth: line.period_month as string,
    amount: Number(line.amount),
  }));

  const months = fiscalYearCalendarMonths(input.fiscalYear);
  const throughIndex = months.indexOf(input.throughMonth);
  if (throughIndex < 0) throw new Error("Through month must belong to fiscal year");
  const monthlyActuals = await loadMonthlyActuals(
    supabase,
    organizationId,
    months.slice(0, throughIndex + 1),
    accounts,
  );

  return buildBudgetVsActualReport({
    fiscalYear: input.fiscalYear,
    throughMonth: input.throughMonth,
    version: {
      id: version.id as string,
      versionNumber: Number(version.version_number),
      label: (version.label as string) ?? "",
      status: version.status as string,
      budgetId: budget.id as string,
      budgetName: budget.name as string,
    },
    accounts,
    budgetLines,
    monthlyActuals,
  });
}

export function exportBudgetVsActualCsv(report: BudgetVsActualReport): string {
  const header = [
    "Account Number",
    "Account Name",
    "Category",
    "Month Budget",
    "Month Actual",
    "Month Variance",
    "Month Variance %",
    "Month Status",
    "YTD Budget",
    "YTD Actual",
    "YTD Variance",
    "YTD Variance %",
    "YTD Status",
    "Annual Budget",
    "Actual YTD",
    "Remaining Budget",
  ].join(",");

  const rows = report.accounts.map((row) =>
    [
      row.code,
      `"${row.name.replace(/"/g, '""')}"`,
      row.category,
      row.month.budget.toFixed(2),
      row.month.actual.toFixed(2),
      row.month.varianceAmount.toFixed(2),
      row.month.variancePercent == null ? "N/M" : row.month.variancePercent.toFixed(1),
      row.month.status,
      row.ytd.budget.toFixed(2),
      row.ytd.actual.toFixed(2),
      row.ytd.varianceAmount.toFixed(2),
      row.ytd.variancePercent == null ? "N/M" : row.ytd.variancePercent.toFixed(1),
      row.ytd.status,
      row.annual.budget.toFixed(2),
      row.annual.actualYtd.toFixed(2),
      row.annual.remainingBudget.toFixed(2),
    ].join(","),
  );

  return [`FY${report.fiscalYear} through ${report.throughMonthLabel}`, header, ...rows].join("\n");
}
