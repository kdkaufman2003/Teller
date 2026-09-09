import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchGlAccountTotals,
  periodActivityFromTotals,
} from "@/lib/accounting/gl-account-totals";
import { roundMoney } from "@/lib/accounting/payment-fees";
import { listBudgetLines } from "@/lib/planning/budgets/budget-crud";
import { fiscalYearCalendarMonths, monthLabel } from "@/lib/planning/budgets/periods";
import { isBudgetPnlAccount } from "@/lib/planning/budgets/pnl-scope";
import {
  getForecastVersion,
  listForecastLines,
  loadPlanningAccountsForForecast,
} from "@/lib/planning/forecasts/forecast-crud";
import {
  isActualizedPeriod,
  resolveActualCutoffMonth,
  rollingForwardMonths,
  ytdActualMonths,
} from "@/lib/planning/forecasts/periods";
import { isImmutableForecastVersion } from "@/lib/planning/forecasts/lifecycle";
import type { ForecastVersionStatus } from "@/lib/planning/forecasts/types";
import {
  computeVarianceAmounts,
  normalizeOwnerFacingAmount,
  sumAmounts,
  type VarianceAmounts,
} from "@/lib/planning/reports/variance";
import type { PlanningAccount } from "@/lib/planning/reports/budget-vs-actual";

export type ForecastPeriodValue = {
  periodMonth: string;
  amount: number;
  kind: "actual" | "forecast";
};

export type RollingForecastAccountRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  category: "revenue" | "cogs" | "expense";
  ytdActual: number;
  periods: ForecastPeriodValue[];
  rollingTotal: number;
  budgetTotal?: number;
  forecastVsBudget?: VarianceAmounts;
};

export type RollingForecastCategoryRollup = {
  category: "revenue" | "cogs" | "gross_profit" | "expense" | "operating_income";
  label: string;
  ytdActual: number;
  rollingTotal: number;
  budgetTotal?: number;
  forecastVsBudget?: VarianceAmounts;
};

export type RollingForecastSummary = {
  revenue: { ytdActual: number; rollingTotal: number; budgetTotal?: number };
  grossProfit: { ytdActual: number; rollingTotal: number; budgetTotal?: number };
  expenses: { ytdActual: number; rollingTotal: number; budgetTotal?: number };
  operatingIncome: { ytdActual: number; rollingTotal: number; budgetTotal?: number };
};

export type RollingForecastReport = {
  forecastId: string;
  forecastName: string;
  anchorMonth: string;
  anchorMonthLabel: string;
  horizonMonths: number;
  actualCutoffMonth: string;
  forwardMonths: string[];
  ytdMonths: string[];
  version: {
    id: string;
    versionNumber: number;
    label: string;
    status: ForecastVersionStatus;
    isDraft: boolean;
    isImmutable: boolean;
    publishedAt?: string | null;
    sourceBudgetVersionId?: string | null;
  };
  summary: RollingForecastSummary;
  categories: RollingForecastCategoryRollup[];
  accounts: RollingForecastAccountRow[];
  staleForecast: boolean;
  staleMessage?: string;
};

function monthEnd(periodMonth: string): string {
  const year = Number(periodMonth.slice(0, 4));
  const month = Number(periodMonth.slice(5, 7));
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function categoryForType(type: string): "revenue" | "cogs" | "expense" | null {
  if (type === "revenue") return "revenue";
  if (type === "cogs") return "cogs";
  if (type === "expense") return "expense";
  return null;
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
      const totals = await fetchGlAccountTotals(
        supabase,
        organizationId,
        periodMonth,
        monthEnd(periodMonth),
      );
      if (!totals) return;
      const accountById = new Map(accounts.map((account) => [account.id, account]));
      for (const row of totals) {
        const account = accountById.get(row.account_id);
        if (!account || !isBudgetPnlAccount(account)) continue;
        const activity = periodActivityFromTotals(row, account.type);
        const amount = normalizeOwnerFacingAmount(activity, account.type);
        const bucket = byAccount.get(account.id) ?? new Map<string, number>();
        bucket.set(periodMonth, amount);
        byAccount.set(account.id, bucket);
      }
    }),
  );
  return byAccount;
}

function buildForecastLineMap(
  lines: Array<{ account_id: string; period_month: string; amount: number }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) {
    map.set(`${line.account_id}::${line.period_month}`, roundMoney(Number(line.amount)));
  }
  return map;
}

export function buildRollingForecastReport(input: {
  forecast: {
    id: string;
    name: string;
    anchor_month: string;
    horizon_months: number;
  };
  version: {
    id: string;
    version_number: number;
    label: string;
    status: string;
    is_immutable: boolean;
    published_at?: string | null;
    actual_cutoff_month?: string | null;
    source_budget_version_id?: string | null;
  };
  accounts: PlanningAccount[];
  forecastLineMap: Map<string, number>;
  monthlyActuals: Map<string, Map<string, number>>;
  budgetLineMap?: Map<string, number>;
  useStoredLinesOnly: boolean;
  latestGlMonth?: string | null;
}): RollingForecastReport {
  const anchorMonth = input.forecast.anchor_month as string;
  const horizonMonths = Number(input.forecast.horizon_months);
  const cutoffMonth = resolveActualCutoffMonth(
    input.version.actual_cutoff_month as string | null,
    anchorMonth,
  );
  const ytdMonths = ytdActualMonths(anchorMonth, cutoffMonth);
  const forwardMonths = rollingForwardMonths(anchorMonth, horizonMonths);
  const status = input.version.status as ForecastVersionStatus;
  const isImmutable = isImmutableForecastVersion(status, Boolean(input.version.is_immutable));

  const accountIds = new Set<string>();
  for (const account of input.accounts.filter(isBudgetPnlAccount)) accountIds.add(account.id);
  for (const key of input.forecastLineMap.keys()) {
    accountIds.add(key.split("::")[0]!);
  }
  for (const accountId of input.monthlyActuals.keys()) accountIds.add(accountId);

  const accountRows: RollingForecastAccountRow[] = [];

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

    const ytdActual = input.useStoredLinesOnly
      ? sumAmounts(
          ytdMonths.map(
            (periodMonth) => input.forecastLineMap.get(`${accountId}::${periodMonth}`) ?? 0,
          ),
        )
      : sumAmounts(
          ytdMonths.map(
            (periodMonth) => input.monthlyActuals.get(accountId)?.get(periodMonth) ?? 0,
          ),
        );

    const periods: ForecastPeriodValue[] = forwardMonths.map((periodMonth) => {
      const lineKey = `${accountId}::${periodMonth}`;
      const stored = input.forecastLineMap.get(lineKey) ?? 0;

      if (input.useStoredLinesOnly) {
        return {
          periodMonth,
          amount: stored,
          kind: "forecast" as const,
        };
      }

      if (isActualizedPeriod(periodMonth, cutoffMonth)) {
        const actual = input.monthlyActuals.get(accountId)?.get(periodMonth) ?? 0;
        return { periodMonth, amount: actual, kind: "actual" as const };
      }

      return { periodMonth, amount: stored, kind: "forecast" as const };
    });

    const rollingTotal = sumAmounts(periods.map((period) => period.amount));
    let budgetTotal: number | undefined;
    let forecastVsBudget: VarianceAmounts | undefined;
    if (input.budgetLineMap) {
      budgetTotal = sumAmounts(
        forwardMonths.map((periodMonth) => input.budgetLineMap!.get(`${accountId}::${periodMonth}`) ?? 0),
      );
      forecastVsBudget = computeVarianceAmounts(rollingTotal, budgetTotal, account.type);
    }

    if (Math.abs(ytdActual) < 0.005 && Math.abs(rollingTotal) < 0.005) continue;

    accountRows.push({
      accountId,
      code: account.code,
      name: account.name,
      type: account.type,
      category,
      ytdActual,
      periods,
      rollingTotal,
      budgetTotal,
      forecastVsBudget,
    });
  }

  accountRows.sort((a, b) => a.code.localeCompare(b.code));

  function rollup(
    category: RollingForecastCategoryRollup["category"],
    label: string,
    filter: (row: RollingForecastAccountRow) => boolean,
  ): RollingForecastCategoryRollup {
    const filtered = accountRows.filter(filter);
    const ytd = sumAmounts(filtered.map((row) => row.ytdActual));
    const rolling = sumAmounts(filtered.map((row) => row.rollingTotal));
    const budget = input.budgetLineMap
      ? sumAmounts(filtered.map((row) => row.budgetTotal ?? 0))
      : undefined;
    const rollupType =
      category === "gross_profit" || category === "operating_income" ? "revenue" : category;
    return {
      category,
      label,
      ytdActual: ytd,
      rollingTotal: rolling,
      budgetTotal: budget,
      forecastVsBudget:
        budget != null ? computeVarianceAmounts(rolling, budget, rollupType) : undefined,
    };
  }

  const revenue = rollup("revenue", "Expected Revenue", (row) => row.category === "revenue");
  const cogs = rollup("cogs", "Expected COGS", (row) => row.category === "cogs");
  const expenses = rollup("expense", "Expected Expenses", (row) => row.category === "expense");

  const grossProfit: RollingForecastCategoryRollup = {
    category: "gross_profit",
    label: "Expected Gross Profit",
    ytdActual: roundMoney(revenue.ytdActual - cogs.ytdActual),
    rollingTotal: roundMoney(revenue.rollingTotal - cogs.rollingTotal),
    budgetTotal:
      revenue.budgetTotal != null && cogs.budgetTotal != null
        ? roundMoney(revenue.budgetTotal - cogs.budgetTotal)
        : undefined,
    forecastVsBudget:
      revenue.budgetTotal != null && cogs.budgetTotal != null
        ? computeVarianceAmounts(
            revenue.rollingTotal - cogs.rollingTotal,
            revenue.budgetTotal - cogs.budgetTotal,
            "revenue",
          )
        : undefined,
  };

  const operatingIncome: RollingForecastCategoryRollup = {
    category: "operating_income",
    label: "Expected Operating Income",
    ytdActual: roundMoney(grossProfit.ytdActual - expenses.ytdActual),
    rollingTotal: roundMoney(grossProfit.rollingTotal - expenses.rollingTotal),
    budgetTotal:
      grossProfit.budgetTotal != null && expenses.budgetTotal != null
        ? roundMoney(grossProfit.budgetTotal - expenses.budgetTotal)
        : undefined,
    forecastVsBudget:
      grossProfit.budgetTotal != null && expenses.budgetTotal != null
        ? computeVarianceAmounts(
            grossProfit.rollingTotal - expenses.rollingTotal,
            grossProfit.budgetTotal - expenses.budgetTotal,
            "revenue",
          )
        : undefined,
  };

  const staleForecast =
    isImmutable &&
    input.latestGlMonth != null &&
    input.latestGlMonth > cutoffMonth;

  return {
    forecastId: input.forecast.id,
    forecastName: input.forecast.name as string,
    anchorMonth,
    anchorMonthLabel: monthLabel(anchorMonth),
    horizonMonths,
    actualCutoffMonth: cutoffMonth,
    forwardMonths,
    ytdMonths,
    version: {
      id: input.version.id,
      versionNumber: Number(input.version.version_number),
      label: (input.version.label as string) || `Version ${input.version.version_number}`,
      status,
      isDraft: status === "draft",
      isImmutable,
      publishedAt: input.version.published_at as string | null,
      sourceBudgetVersionId: input.version.source_budget_version_id as string | null,
    },
    summary: {
      revenue: {
        ytdActual: revenue.ytdActual,
        rollingTotal: revenue.rollingTotal,
        budgetTotal: revenue.budgetTotal,
      },
      grossProfit: {
        ytdActual: grossProfit.ytdActual,
        rollingTotal: grossProfit.rollingTotal,
        budgetTotal: grossProfit.budgetTotal,
      },
      expenses: {
        ytdActual: expenses.ytdActual,
        rollingTotal: expenses.rollingTotal,
        budgetTotal: expenses.budgetTotal,
      },
      operatingIncome: {
        ytdActual: operatingIncome.ytdActual,
        rollingTotal: operatingIncome.rollingTotal,
        budgetTotal: operatingIncome.budgetTotal,
      },
    },
    categories: [revenue, cogs, grossProfit, expenses, operatingIncome],
    accounts: accountRows,
    staleForecast,
    staleMessage: staleForecast
      ? "New actuals are available since this forecast was published. Create an updated forecast to incorporate them."
      : undefined,
  };
}

export async function loadRollingForecastReport(
  supabase: SupabaseClient,
  organizationId: string,
  input: { forecastId: string; versionId?: string | null; budgetVersionId?: string | null },
): Promise<RollingForecastReport> {
  const { data: forecast, error: forecastError } = await supabase
    .from("teller_forecasts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", input.forecastId)
    .single();
  if (forecastError || !forecast) {
    throw new Error(forecastError?.message || "Forecast not found");
  }

  let version;
  if (input.versionId) {
    version = await getForecastVersion(supabase, organizationId, input.versionId);
    if ((version.teller_forecasts as { id: string }).id !== input.forecastId) {
      throw new Error("Version does not belong to this forecast");
    }
  } else {
    const { data: versions, error } = await supabase
      .from("teller_forecast_versions")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("forecast_id", input.forecastId)
      .order("version_number", { ascending: false });
    if (error) throw new Error(error.message);
    version =
      versions?.find((entry) => entry.status === "draft") ??
      versions?.find((entry) => entry.status === "published") ??
      versions?.[0];
    if (!version) throw new Error("No forecast versions available");
    version = { ...version, teller_forecasts: forecast };
  }

  const anchorMonth = forecast.anchor_month as string;
  const horizonMonths = Number(forecast.horizon_months);
  const cutoffMonth = resolveActualCutoffMonth(
    version.actual_cutoff_month as string | null,
    anchorMonth,
  );
  const ytdMonths = ytdActualMonths(anchorMonth, cutoffMonth);
  const forwardMonths = rollingForwardMonths(anchorMonth, horizonMonths);
  const allMonths = [...new Set([...ytdMonths, ...forwardMonths])];

  const accounts = await loadPlanningAccountsForForecast(supabase, organizationId);
  const rawLines = await listForecastLines(supabase, organizationId, version.id as string);
  const forecastLineMap = buildForecastLineMap(
    rawLines.map((line) => ({
      account_id: line.account_id as string,
      period_month: line.period_month as string,
      amount: Number(line.amount),
    })),
  );

  const status = version.status as ForecastVersionStatus;
  const useStoredLinesOnly = isImmutableForecastVersion(
    status,
    Boolean(version.is_immutable),
  );

  const monthlyActuals = useStoredLinesOnly
    ? new Map<string, Map<string, number>>()
    : await loadMonthlyActuals(supabase, organizationId, allMonths, accounts);

  let budgetLineMap: Map<string, number> | undefined;
  const budgetVersionId =
    input.budgetVersionId ?? (version.source_budget_version_id as string | null);
  if (budgetVersionId) {
    const budgetLines = await listBudgetLines(supabase, organizationId, budgetVersionId);
    budgetLineMap = buildForecastLineMap(
      budgetLines.map((line) => ({
        account_id: line.account_id as string,
        period_month: line.period_month as string,
        amount: Number(line.amount),
      })),
    );
  }

  const fiscalYear = Number(cutoffMonth.slice(0, 4));
  const latestGlMonth = useStoredLinesOnly
    ? cutoffMonth
    : fiscalYearCalendarMonths(fiscalYear)
        .filter((month) => {
          for (const accountMap of monthlyActuals.values()) {
            if (Math.abs(accountMap.get(month) ?? 0) >= 0.005) return true;
          }
          return false;
        })
        .pop() ?? cutoffMonth;

  return buildRollingForecastReport({
    forecast: {
      id: forecast.id as string,
      name: forecast.name as string,
      anchor_month: anchorMonth,
      horizon_months: horizonMonths,
    },
    version: {
      id: version.id as string,
      version_number: version.version_number as number,
      label: (version.label as string) ?? "",
      status: version.status as string,
      is_immutable: Boolean(version.is_immutable),
      published_at: version.published_at as string | null,
      actual_cutoff_month: version.actual_cutoff_month as string | null,
      source_budget_version_id: version.source_budget_version_id as string | null,
    },
    accounts,
    forecastLineMap,
    monthlyActuals,
    budgetLineMap,
    useStoredLinesOnly,
    latestGlMonth,
  });
}

export async function buildPublishSnapshotFromReport(
  supabase: SupabaseClient,
  organizationId: string,
  report: RollingForecastReport,
): Promise<Array<{ accountId: string; periodMonth: string; amount: number; sourceKind: "actual" | "manual" }>> {
  const lines: Array<{
    accountId: string;
    periodMonth: string;
    amount: number;
    sourceKind: "actual" | "manual";
  }> = [];

  const ytdActuals = await loadMonthlyActuals(
    supabase,
    organizationId,
    report.ytdMonths,
    report.accounts.map((row) => ({
      id: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      archived: false,
    })),
  );

  for (const account of report.accounts) {
    for (const periodMonth of report.ytdMonths) {
      const amount = ytdActuals.get(account.accountId)?.get(periodMonth) ?? 0;
      if (Math.abs(amount) >= 0.005) {
        lines.push({
          accountId: account.accountId,
          periodMonth,
          amount,
          sourceKind: "actual",
        });
      }
    }
    for (const period of account.periods) {
      if (period.kind === "forecast" && Math.abs(period.amount) >= 0.005) {
        lines.push({
          accountId: account.accountId,
          periodMonth: period.periodMonth,
          amount: period.amount,
          sourceKind: "manual",
        });
      }
    }
  }

  return lines;
}
