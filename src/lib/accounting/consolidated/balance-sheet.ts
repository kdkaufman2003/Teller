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

export async function buildConsolidatedBalanceSheet(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    asOf: string;
    fiscalYearStartMonth?: number;
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

  const assets = [...assetsMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  const liabilities = [...liabilitiesMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  const equity = [...equityMap.values()].sort((a, b) => a.code.localeCompare(b.code));

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
