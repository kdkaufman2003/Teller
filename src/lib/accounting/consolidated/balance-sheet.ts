import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBalanceSheet } from "../financial-reports";
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
import type { ConsolidatedBalanceSheetReport } from "./types";
import { buildConsolidationScopeKey } from "./eliminations/scope-key";
import { loadPostedEliminationAdjustments } from "./eliminations/load-posted";
import { applyEliminationsToFinancialLines } from "./eliminations/apply";

export async function buildConsolidatedBalanceSheet(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    asOf: string;
    fiscalYearStartMonth?: number;
    reportMode?: "pre" | "post";
    auth?: EntityAuthContext;
  },
): Promise<ConsolidatedBalanceSheetReport> {
  const asOf = input.asOf.slice(0, 10);
  const scope = await resolveConsolidationScope(supabase, {
    organizationId: input.organizationId,
    legalEntityIds: input.legalEntityIds,
    includeAllEntities: input.includeAllEntities,
    auth: input.auth,
  });

  const assetsMap = new Map<string, import("./types").ConsolidatedFinancialLine>();
  const liabilitiesMap = new Map<string, import("./types").ConsolidatedFinancialLine>();
  const equityMap = new Map<string, import("./types").ConsolidatedFinancialLine>();

  for (const entity of scope.entities) {
    const accounts = await loadEntityAccounts(supabase, input.organizationId, entity.legalEntityId);
    const lines = await loadEntityDatedLines(supabase, {
      organizationId: input.organizationId,
      legalEntityId: entity.legalEntityId,
      endDate: asOf,
    });
    const sheet = buildBalanceSheet(
      lines,
      accounts,
      asOf,
      input.fiscalYearStartMonth ?? 1,
    );
    mergeFinancialSection(assetsMap, entity, sheet.assets, accounts);
    mergeFinancialSection(liabilitiesMap, entity, sheet.liabilities, accounts);
    mergeFinancialSection(equityMap, entity, sheet.equity, accounts);
  }

  let assets = [...assetsMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  let liabilities = [...liabilitiesMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  let equity = [...equityMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  const reportMode = input.reportMode ?? "pre";

  if (reportMode === "post") {
    const scopeKey = buildConsolidationScopeKey(
      input.organizationId,
      scope.entities.map((entity) => entity.legalEntityId),
    );
    const adjustments = await loadPostedEliminationAdjustments(supabase, {
      organizationId: input.organizationId,
      scopeKey,
      asOf,
      periodEnd: asOf,
    });
    assets = applyEliminationsToFinancialLines(assets, adjustments);
    liabilities = applyEliminationsToFinancialLines(liabilities, adjustments);
    equity = applyEliminationsToFinancialLines(equity, adjustments);
  }

  const totalAssets = roundMoney(assets.reduce((sum, row) => sum + row.amount, 0));
  const totalLiabilities = roundMoney(liabilities.reduce((sum, row) => sum + row.amount, 0));
  const totalEquity = roundMoney(equity.reduce((sum, row) => sum + row.amount, 0));
  const intercompanyDueFromTotal = roundMoney(
    assets.filter((row) => row.isIntercompany).reduce((sum, row) => sum + row.amount, 0),
  );
  const intercompanyDueToTotal = roundMoney(
    liabilities.filter((row) => row.isIntercompany).reduce((sum, row) => sum + row.amount, 0),
  );

  const intercompanyWarnings = await buildIntercompanyWarnings(supabase, {
    organizationId: input.organizationId,
    entities: scope.entities,
    asOf,
  });

  return {
    ...buildReportMeta(scope, {
      intercompanyWarnings,
      periodStatuses: buildPeriodStatuses(scope, asOf),
      reportMode,
    }),
    asOf,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.05,
    intercompanyDueFromTotal,
    intercompanyDueToTotal,
  };
}
