import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCashFlowStatement } from "../financial-reports";
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
import type { ConsolidatedCashFlowReport } from "./types";

export async function buildConsolidatedCashFlow(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    periodStart: string;
    periodEnd: string;
    auth?: EntityAuthContext;
  },
): Promise<ConsolidatedCashFlowReport> {
  const periodEnd = input.periodEnd.slice(0, 10);
  const periodStart = input.periodStart.slice(0, 10);
  const scope = await resolveConsolidationScope(supabase, {
    organizationId: input.organizationId,
    legalEntityIds: input.legalEntityIds,
    includeAllEntities: input.includeAllEntities,
    auth: input.auth,
  });

  let netOperating = 0;
  let netInvesting = 0;
  let netFinancing = 0;
  let netChangeInCash = 0;
  let beginningCash = 0;
  let endingCash = 0;
  const entityNetChange: ConsolidatedCashFlowReport["entityNetChange"] = [];

  for (const entity of scope.entities) {
    const accounts = await loadEntityAccounts(supabase, input.organizationId, entity.legalEntityId);
    const lines = await loadEntityDatedLines(supabase, {
      organizationId: input.organizationId,
      legalEntityId: entity.legalEntityId,
      endDate: periodEnd,
    });
    const periodLines = lines.filter((line) => {
      if (line.entry_date > periodEnd) return false;
      if (line.entry_date < periodStart) return false;
      return true;
    });
    const pl = buildProfitAndLoss(periodLines, accounts);
    const cashFlow = buildCashFlowStatement(lines, accounts, { start: periodStart, end: periodEnd, label: "" }, pl);

    netOperating = roundMoney(netOperating + cashFlow.netOperating);
    netInvesting = roundMoney(netInvesting + cashFlow.netInvesting);
    netFinancing = roundMoney(netFinancing + cashFlow.netFinancing);
    netChangeInCash = roundMoney(netChangeInCash + cashFlow.netChangeInCash);
    beginningCash = roundMoney(beginningCash + cashFlow.beginningCash);
    endingCash = roundMoney(endingCash + cashFlow.endingCash);
    entityNetChange.push({
      legalEntityId: entity.legalEntityId,
      entityName: entity.name,
      entityCode: entity.entityCode,
      amount: cashFlow.netChangeInCash,
    });
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
    netOperating,
    netInvesting,
    netFinancing,
    netChangeInCash,
    beginningCash,
    endingCash,
    entityNetChange,
    limitation:
      scope.entities.length > 1
        ? "Consolidated cash flow sums entity-level indirect statements; intercompany cash transfers may appear in both entities until Phase 16G offset reporting."
        : null,
  };
}
