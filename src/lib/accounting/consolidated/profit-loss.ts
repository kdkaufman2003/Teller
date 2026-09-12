import type { SupabaseClient } from "@supabase/supabase-js";
import { buildProfitAndLoss } from "../reports";
import { roundMoney } from "../payment-fees";
import { resolveConsolidationScope } from "./scope";
import type { EntityAuthContext } from "../legal-entity/access";
import {
  buildIntercompanyWarnings,
  buildPeriodStatuses,
  buildReportMeta,
} from "./warnings";
import { loadEntityAccounts, loadEntityDatedLines } from "./entity-data";
import { mergeFinancialSection } from "./merge-lines";
import type { ConsolidatedFinancialLine, ConsolidatedProfitAndLossReport } from "./types";

export async function buildConsolidatedProfitAndLoss(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    periodStart?: string | null;
    periodEnd: string;
    auth?: EntityAuthContext;
  },
): Promise<ConsolidatedProfitAndLossReport> {
  const periodEnd = input.periodEnd.slice(0, 10);
  const periodStart = input.periodStart?.slice(0, 10) ?? null;
  const scope = await resolveConsolidationScope(supabase, {
    organizationId: input.organizationId,
    legalEntityIds: input.legalEntityIds,
    includeAllEntities: input.includeAllEntities,
    auth: input.auth,
  });

  const revenueMap = new Map<string, ConsolidatedFinancialLine>();
  const cogsMap = new Map<string, ConsolidatedFinancialLine>();
  const expenseMap = new Map<string, ConsolidatedFinancialLine>();
  const entityNetIncome: ConsolidatedProfitAndLossReport["entityNetIncome"] = [];

  for (const entity of scope.entities) {
    const accounts = await loadEntityAccounts(supabase, input.organizationId, entity.legalEntityId);
    const lines = await loadEntityDatedLines(supabase, {
      organizationId: input.organizationId,
      legalEntityId: entity.legalEntityId,
      endDate: periodEnd,
    });
    const periodLines = lines.filter((line) => {
      if (line.entry_date > periodEnd) return false;
      if (periodStart && line.entry_date < periodStart) return false;
      return true;
    });
    const pl = buildProfitAndLoss(periodLines, accounts);
    mergeFinancialSection(revenueMap, entity, pl.revenue, accounts);
    mergeFinancialSection(cogsMap, entity, pl.cogs, accounts);
    mergeFinancialSection(expenseMap, entity, pl.expenses, accounts);
    entityNetIncome.push({
      legalEntityId: entity.legalEntityId,
      entityName: entity.name,
      entityCode: entity.entityCode,
      amount: pl.netIncome,
    });
  }

  const revenue = [...revenueMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  const cogs = [...cogsMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  const expenses = [...expenseMap.values()].sort((a, b) => a.code.localeCompare(b.code));

  const totalRevenueSum = roundMoney(revenue.reduce((sum, row) => sum + row.amount, 0));
  const totalCogs = roundMoney(cogs.reduce((sum, row) => sum + row.amount, 0));
  const totalExpenses = roundMoney(expenses.reduce((sum, row) => sum + row.amount, 0));
  const grossProfit = roundMoney(totalRevenueSum - totalCogs);
  const netIncome = roundMoney(grossProfit - totalExpenses);
  const entityNetSum = roundMoney(entityNetIncome.reduce((sum, row) => sum + row.amount, 0));

  if (Math.abs(netIncome - entityNetSum) > 0.05) {
    throw new Error("Consolidated net income must equal sum of entity net income (pre-adjustment)");
  }

  const intercompanyWarnings = await buildIntercompanyWarnings(supabase, {
    organizationId: input.organizationId,
    entities: scope.entities,
    asOf: periodEnd,
  });

  return {
    ...buildReportMeta(scope, {
      intercompanyWarnings,
      periodStatuses: buildPeriodStatuses(scope, periodEnd),
    }),
    periodStart,
    periodEnd,
    revenue,
    cogs,
    expenses,
    totalRevenue: totalRevenueSum,
    totalCogs,
    grossProfit,
    totalExpenses,
    netIncome,
    entityNetIncome,
  };
}
