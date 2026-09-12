import type { SupabaseClient } from "@supabase/supabase-js";
import { buildConsolidatedTrialBalance } from "../trial-balance";
import { resolveConsolidationScope } from "../scope";
import { isTrialBalanceBalanced } from "../../trial-balance";
import { roundMoney } from "../../payment-fees";
import { buildConsolidationScopeKey } from "./scope-key";
import { loadPostedEliminationAdjustments, sumEliminationAdjustmentsByGroupKey } from "./load-posted";
import type { EntityAuthContext } from "../../legal-entity/access";
import type { ConsolidationWorksheetReport } from "./types";

export async function buildConsolidationWorksheet(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    periodStart?: string | null;
    periodEnd: string;
    auth?: EntityAuthContext;
  },
): Promise<ConsolidationWorksheetReport> {
  const periodEnd = input.periodEnd.slice(0, 10);
  const periodStart = input.periodStart?.slice(0, 10) ?? null;
  const pre = await buildConsolidatedTrialBalance(supabase, {
    organizationId: input.organizationId,
    legalEntityIds: input.legalEntityIds,
    includeAllEntities: input.includeAllEntities,
    periodStart,
    periodEnd,
    auth: input.auth,
  });
  const scope = await resolveConsolidationScope(supabase, {
    organizationId: input.organizationId,
    legalEntityIds: input.legalEntityIds,
    includeAllEntities: input.includeAllEntities,
    auth: input.auth,
  });
  const scopeKey = buildConsolidationScopeKey(
    input.organizationId,
    scope.entities.map((entity) => entity.legalEntityId),
  );
  const adjustments = await loadPostedEliminationAdjustments(supabase, {
    organizationId: input.organizationId,
    scopeKey,
    asOf: periodEnd,
    periodStart,
    periodEnd,
  });
  const elimByGroup = sumEliminationAdjustmentsByGroupKey(adjustments);

  const groupKeys = new Set([
    ...pre.rows.map((row) => row.groupKey),
    ...elimByGroup.keys(),
  ]);

  const rows = [...groupKeys].map((groupKey) => {
    const preRow = pre.rows.find((row) => row.groupKey === groupKey);
    const entityAmounts: Record<string, number> = {};
    for (const contribution of preRow?.entityContributions ?? []) {
      entityAmounts[contribution.legalEntityId] = contribution.amount;
    }
    const preTotal = preRow?.netBalance ?? 0;
    const elim = elimByGroup.get(groupKey) ?? { debit: 0, credit: 0 };
    const postTotal = roundMoney(preTotal + elim.debit - elim.credit);
    return {
      groupKey,
      code: preRow?.code ?? "",
      name: preRow?.name ?? "",
      type: preRow?.type ?? "",
      subtype: preRow?.subtype ?? "",
      entityAmounts,
      preEliminationTotal: preTotal,
      eliminationDebit: elim.debit,
      eliminationCredit: elim.credit,
      postEliminationTotal: postTotal,
      isIntercompany: preRow?.isIntercompany ?? false,
    };
  }).sort((a, b) => a.code.localeCompare(b.code) || a.type.localeCompare(b.type));

  const totals = rows.reduce(
    (sum, row) => {
      const preDebit = row.preEliminationTotal > 0 ? row.preEliminationTotal : 0;
      const preCredit = row.preEliminationTotal < 0 ? Math.abs(row.preEliminationTotal) : 0;
      const postDebit = row.postEliminationTotal > 0 ? row.postEliminationTotal : 0;
      const postCredit = row.postEliminationTotal < 0 ? Math.abs(row.postEliminationTotal) : 0;
      return {
        preEliminationDebit: roundMoney(sum.preEliminationDebit + preDebit),
        preEliminationCredit: roundMoney(sum.preEliminationCredit + preCredit),
        eliminationDebit: roundMoney(sum.eliminationDebit + row.eliminationDebit),
        eliminationCredit: roundMoney(sum.eliminationCredit + row.eliminationCredit),
        postEliminationDebit: roundMoney(sum.postEliminationDebit + postDebit),
        postEliminationCredit: roundMoney(sum.postEliminationCredit + postCredit),
      };
    },
    {
      preEliminationDebit: 0,
      preEliminationCredit: 0,
      eliminationDebit: 0,
      eliminationCredit: 0,
      postEliminationDebit: 0,
      postEliminationCredit: 0,
    },
  );

  return {
    scopeKey,
    scopeLabel: pre.scope.scopeLabel,
    periodStart,
    periodEnd,
    entities: scope.entities.map((entity) => ({
      legalEntityId: entity.legalEntityId,
      entityName: entity.name,
      entityCode: entity.entityCode,
    })),
    rows,
    totals,
    balanced: isTrialBalanceBalanced(totals.postEliminationDebit, totals.postEliminationCredit),
  };
}
