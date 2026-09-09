import { roundMoney } from "@/lib/accounting/payment-fees";
import { isActualizedPeriod } from "./periods";
import type {
  AssumptionEngineResult,
  AssumptionPreviewSummary,
  AssumptionTargetScope,
  ForecastAssumptionRecord,
  ForecastCellMeta,
  ForecastCellSource,
  ForecastLineInput,
} from "./types";

export type PlanningAccountRef = {
  id: string;
  code: string;
  name: string;
  type: string;
};

function cellKey(accountId: string, periodMonth: string): string {
  return `${accountId}::${periodMonth}`;
}

function periodInRange(
  periodMonth: string,
  start: string | null,
  end: string | null,
): boolean {
  if (start && periodMonth < start) return false;
  if (end && periodMonth > end) return false;
  return true;
}

function accountsForScope(
  accounts: PlanningAccountRef[],
  scope: AssumptionTargetScope,
  targetAccountId: string | null,
): PlanningAccountRef[] {
  if (scope === "account" && targetAccountId) {
    const account = accounts.find((entry) => entry.id === targetAccountId);
    return account ? [account] : [];
  }
  if (scope === "all_revenue") return accounts.filter((account) => account.type === "revenue");
  if (scope === "all_cogs") return accounts.filter((account) => account.type === "cogs");
  if (scope === "all_expense") return accounts.filter((account) => account.type === "expense");
  return [];
}

function assumptionAppliesToAccount(
  assumption: ForecastAssumptionRecord,
  account: PlanningAccountRef,
): boolean {
  const scoped = accountsForScope(
    [account],
    assumption.targetScope,
    assumption.targetAccountId,
  );
  return scoped.length === 1;
}

function sumCategory(
  values: Map<string, number>,
  accounts: PlanningAccountRef[],
  type: string,
  forwardMonths: string[],
): number {
  return roundMoney(
    accounts
      .filter((account) => account.type === type)
      .reduce(
        (sum, account) =>
          sum +
          forwardMonths.reduce(
            (monthSum, periodMonth) => monthSum + (values.get(cellKey(account.id, periodMonth)) ?? 0),
            0,
          ),
        0,
      ),
  );
}

function buildSummary(
  values: Map<string, number>,
  accounts: PlanningAccountRef[],
  forwardMonths: string[],
): AssumptionPreviewSummary {
  const revenue = sumCategory(values, accounts, "revenue", forwardMonths);
  const cogs = sumCategory(values, accounts, "cogs", forwardMonths);
  const expenses = sumCategory(values, accounts, "expense", forwardMonths);
  const grossProfit = roundMoney(revenue - cogs);
  const operatingIncome = roundMoney(grossProfit - expenses);
  return {
    revenue: { before: revenue, after: revenue, change: 0 },
    cogs: { before: cogs, after: cogs, change: 0 },
    expenses: { before: expenses, after: expenses, change: 0 },
    grossProfit: { before: grossProfit, after: grossProfit, change: 0 },
    operatingIncome: { before: operatingIncome, after: operatingIncome, change: 0 },
  };
}

function applyPercentageChange(
  amount: number,
  percent: number,
): number {
  return roundMoney(amount * (1 + percent / 100));
}

function applyTargetMarginForMonth(
  values: Map<string, number>,
  accounts: PlanningAccountRef[],
  periodMonth: string,
  marginPercent: number,
  meta: Map<string, ForecastCellMeta>,
  assumption: ForecastAssumptionRecord,
): void {
  const revenueAccounts = accounts.filter((account) => account.type === "revenue");
  const cogsAccounts = accounts.filter((account) => account.type === "cogs");
  const totalRevenue = roundMoney(
    revenueAccounts.reduce((sum, account) => sum + (values.get(cellKey(account.id, periodMonth)) ?? 0), 0),
  );
  if (totalRevenue <= 0) return;

  const targetCogs = roundMoney(totalRevenue * (1 - marginPercent / 100));
  const baselineCogsTotal = roundMoney(
    cogsAccounts.reduce(
      (sum, account) => sum + (values.get(cellKey(account.id, periodMonth)) ?? 0),
      0,
    ),
  );

  if (baselineCogsTotal <= 0) {
    if (cogsAccounts.length === 1) {
      const account = cogsAccounts[0]!;
      values.set(cellKey(account.id, periodMonth), targetCogs);
      meta.set(cellKey(account.id, periodMonth), {
        source: "assumption",
        explanation: `${assumption.name} (target margin ${marginPercent}%)`,
        assumptionId: assumption.id,
      });
    }
    return;
  }

  let allocated = 0;
  cogsAccounts.forEach((account, index) => {
    const key = cellKey(account.id, periodMonth);
    const baseline = values.get(key) ?? 0;
    const share = baseline / baselineCogsTotal;
    const amount =
      index === cogsAccounts.length - 1
        ? roundMoney(targetCogs - allocated)
        : roundMoney(targetCogs * share);
    allocated = roundMoney(allocated + amount);
    values.set(key, amount);
    meta.set(key, {
      source: "assumption",
      explanation: `${assumption.name} (target margin ${marginPercent}%)`,
      assumptionId: assumption.id,
    });
  });
}

export function applyForecastAssumptions(input: {
  accounts: PlanningAccountRef[];
  forwardMonths: string[];
  actualCutoffMonth: string;
  baseline: Map<string, number>;
  manualOverrides: Map<string, number>;
  assumptions: ForecastAssumptionRecord[];
}): AssumptionEngineResult {
  const sortedAssumptions = [...input.assumptions]
    .filter((assumption) => assumption.assumptionType !== "note")
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const beforeValues = new Map<string, number>();
  const effectiveValues = new Map<string, number>();
  const cellMeta = new Map<string, ForecastCellMeta>();

  for (const account of input.accounts) {
    for (const periodMonth of input.forwardMonths) {
      const key = cellKey(account.id, periodMonth);
      if (isActualizedPeriod(periodMonth, input.actualCutoffMonth)) continue;

      const baselineAmount = roundMoney(input.baseline.get(key) ?? 0);
      beforeValues.set(key, baselineAmount);
      effectiveValues.set(key, baselineAmount);
      cellMeta.set(key, {
        source: "baseline",
        explanation: baselineAmount !== 0 ? "Baseline forecast" : "No baseline value",
      });
    }
  }

  for (const assumption of sortedAssumptions) {
    if (assumption.assumptionType === "target_margin") {
      for (const periodMonth of input.forwardMonths) {
        if (isActualizedPeriod(periodMonth, input.actualCutoffMonth)) continue;
        if (!periodInRange(periodMonth, assumption.effectiveStartMonth, assumption.effectiveEndMonth)) {
          continue;
        }
        applyTargetMarginForMonth(
          effectiveValues,
          input.accounts,
          periodMonth,
          assumption.valueNumeric ?? 0,
          cellMeta,
          assumption,
        );
      }
      continue;
    }

    for (const account of input.accounts) {
      if (!assumptionAppliesToAccount(assumption, account)) continue;

      for (const periodMonth of input.forwardMonths) {
        if (isActualizedPeriod(periodMonth, input.actualCutoffMonth)) continue;
        if (!periodInRange(periodMonth, assumption.effectiveStartMonth, assumption.effectiveEndMonth)) {
          continue;
        }

        const key = cellKey(account.id, periodMonth);
        const baselineAmount = roundMoney(input.baseline.get(key) ?? 0);
        let nextAmount = baselineAmount;
        let explanation = assumption.name;

        switch (assumption.assumptionType) {
          case "percentage_change":
            nextAmount = applyPercentageChange(baselineAmount, assumption.valueNumeric ?? 0);
            explanation = `${assumption.name} (${assumption.valueNumeric ?? 0 >= 0 ? "+" : ""}${assumption.valueNumeric ?? 0}%)`;
            break;
          case "fixed_monthly_amount":
            nextAmount = roundMoney(assumption.valueNumeric ?? 0);
            explanation = `${assumption.name} (fixed ${nextAmount})`;
            break;
          case "month_multiplier": {
            const month = Number(periodMonth.slice(5, 7));
            const targetMonth = Number(
              (assumption.parameters.month as number | undefined) ??
                assumption.effectiveStartMonth?.slice(5, 7) ??
                month,
            );
            if (month !== targetMonth) continue;
            nextAmount = applyPercentageChange(baselineAmount, assumption.valueNumeric ?? 0);
            explanation = `${assumption.name} (${assumption.valueNumeric ?? 0 >= 0 ? "+" : ""}${assumption.valueNumeric ?? 0}% in ${periodMonth.slice(0, 7)})`;
            break;
          }
          default:
            continue;
        }

        effectiveValues.set(key, nextAmount);
        cellMeta.set(key, {
          source: "assumption",
          explanation,
          assumptionId: assumption.id,
        });
      }
    }
  }

  for (const [key, amount] of input.manualOverrides) {
    if (!input.forwardMonths.some((periodMonth) => key.endsWith(`::${periodMonth}`))) continue;
    const periodMonth = key.split("::")[1]!;
    if (isActualizedPeriod(periodMonth, input.actualCutoffMonth)) continue;
    effectiveValues.set(key, roundMoney(amount));
    cellMeta.set(key, {
      source: "manual",
      explanation: "Manual override",
    });
  }

  const beforeSummary = buildSummary(beforeValues, input.accounts, input.forwardMonths);
  const afterSummary = buildSummary(effectiveValues, input.accounts, input.forwardMonths);

  const summary: AssumptionPreviewSummary = {
    revenue: {
      before: beforeSummary.revenue.before,
      after: afterSummary.revenue.after,
      change: roundMoney(afterSummary.revenue.after - beforeSummary.revenue.before),
    },
    cogs: {
      before: beforeSummary.cogs.before,
      after: afterSummary.cogs.after,
      change: roundMoney(afterSummary.cogs.after - beforeSummary.cogs.before),
    },
    expenses: {
      before: beforeSummary.expenses.before,
      after: afterSummary.expenses.after,
      change: roundMoney(afterSummary.expenses.after - beforeSummary.expenses.before),
    },
    grossProfit: {
      before: beforeSummary.grossProfit.before,
      after: afterSummary.grossProfit.after,
      change: roundMoney(afterSummary.grossProfit.after - beforeSummary.grossProfit.before),
    },
    operatingIncome: {
      before: beforeSummary.operatingIncome.before,
      after: afterSummary.operatingIncome.after,
      change: roundMoney(afterSummary.operatingIncome.after - beforeSummary.operatingIncome.before),
    },
  };

  const linesToPersist: ForecastLineInput[] = [];
  for (const [key, amount] of effectiveValues) {
    if (Math.abs(amount) < 0.005) continue;
    const [accountId, periodMonth] = key.split("::");
    if (!accountId || !periodMonth) continue;
    const meta = cellMeta.get(key);
    const sourceKind: ForecastCellSource = meta?.source ?? "baseline";
    if (sourceKind === "actual") continue;
    linesToPersist.push({
      accountId,
      periodMonth,
      amount,
      sourceKind: sourceKind === "manual" ? "manual" : sourceKind === "assumption" ? "assumption" : "budget",
      notes: meta?.explanation ?? "",
      metadata:
        sourceKind === "assumption"
          ? { baselineAmount: roundMoney(input.baseline.get(key) ?? 0) }
          : undefined,
    });
  }

  return {
    effectiveValues,
    cellMeta,
    summary,
    linesToPersist,
  };
}

export function serializeAssumptionPreview(result: AssumptionEngineResult): {
  summary: AssumptionPreviewSummary;
  cells: Array<{
    accountId: string;
    periodMonth: string;
    amount: number;
    source: ForecastCellSource;
    explanation: string;
  }>;
} {
  const cells: Array<{
    accountId: string;
    periodMonth: string;
    amount: number;
    source: ForecastCellSource;
    explanation: string;
  }> = [];

  for (const [key, amount] of result.effectiveValues) {
    const [accountId, periodMonth] = key.split("::");
    if (!accountId || !periodMonth) continue;
    const meta = result.cellMeta.get(key);
    cells.push({
      accountId,
      periodMonth,
      amount,
      source: meta?.source ?? "baseline",
      explanation: meta?.explanation ?? "",
    });
  }

  return { summary: result.summary, cells };
}
