import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTrialBalance, isTrialBalanceBalanced } from "../trial-balance";
import { roundMoney } from "../payment-fees";
import { consolidationAccountKey, isIntercompanyAccount, mergeContributions } from "./grouping";
import { resolveConsolidationScope } from "./scope";
import type { EntityAuthContext } from "../legal-entity/access";
import {
  buildIntercompanyWarnings,
  buildPeriodStatuses,
  buildReportMeta,
} from "./warnings";
import type { ConsolidatedTrialBalanceReport, ConsolidatedTrialBalanceRow } from "./types";
import { buildConsolidationScopeKey } from "./eliminations/scope-key";
import { loadPostedEliminationAdjustments } from "./eliminations/load-posted";
import { applyEliminationsToTrialBalanceRows } from "./eliminations/apply";

export async function buildConsolidatedTrialBalance(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    periodStart?: string | null;
    periodEnd: string;
    reportMode?: "pre" | "post";
    auth?: EntityAuthContext;
  },
): Promise<ConsolidatedTrialBalanceReport> {
  const periodEnd = input.periodEnd.slice(0, 10);
  const periodStart = input.periodStart?.slice(0, 10) ?? null;
  const scope = await resolveConsolidationScope(supabase, {
    organizationId: input.organizationId,
    legalEntityIds: input.legalEntityIds,
    includeAllEntities: input.includeAllEntities,
    auth: input.auth,
  });

  const rowMap = new Map<string, ConsolidatedTrialBalanceRow>();

  for (const entity of scope.entities) {
    const entityTb = await buildTrialBalance(supabase, input.organizationId, {
      legalEntityId: entity.legalEntityId,
      periodStart,
      periodEnd,
    });

    const { data: accounts } = await supabase
      .from("teller_accounts")
      .select("id, subtype")
      .eq("organization_id", input.organizationId)
      .eq("legal_entity_id", entity.legalEntityId);
    const subtypeById = new Map((accounts ?? []).map((row) => [row.id as string, (row.subtype as string) ?? ""]));

    for (const row of entityTb.rows) {
      const subtype = subtypeById.get(row.accountId) ?? "";
      const groupKey = consolidationAccountKey({
        type: row.type,
        subtype,
        code: row.code,
        name: row.name,
      });
      const net = roundMoney(row.adjustedDebit - row.adjustedCredit);
      const existing = rowMap.get(groupKey);
      const contribution = {
        legalEntityId: entity.legalEntityId,
        entityName: entity.name,
        entityCode: entity.entityCode,
        amount: net,
        accountId: row.accountId,
      };

      if (existing) {
        existing.adjustedDebit = roundMoney(existing.adjustedDebit + row.adjustedDebit);
        existing.adjustedCredit = roundMoney(existing.adjustedCredit + row.adjustedCredit);
        existing.netBalance = roundMoney(existing.netBalance + net);
        existing.entityContributions = mergeContributions(existing.entityContributions, contribution);
        existing.isIntercompany = existing.isIntercompany || isIntercompanyAccount({ subtype });
      } else {
        rowMap.set(groupKey, {
          groupKey,
          code: row.code,
          name: row.name,
          type: row.type,
          subtype,
          adjustedDebit: row.adjustedDebit,
          adjustedCredit: row.adjustedCredit,
          netBalance: net,
          isIntercompany: isIntercompanyAccount({ subtype }),
          entityContributions: [contribution],
        });
      }
    }
  }

  let rows = [...rowMap.values()]
    .filter((row) => row.adjustedDebit !== 0 || row.adjustedCredit !== 0)
    .sort((a, b) => a.code.localeCompare(b.code) || a.type.localeCompare(b.type));

  let eliminationAdjustments: ConsolidatedTrialBalanceReport["eliminationAdjustments"];
  if (input.reportMode === "post") {
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
    const applied = applyEliminationsToTrialBalanceRows(rows, adjustments);
    rows = applied.rows;
    eliminationAdjustments = applied.eliminationRows;
  }

  const totals = rows.reduce(
    (sum, row) => ({
      adjustedDebit: roundMoney(sum.adjustedDebit + row.adjustedDebit),
      adjustedCredit: roundMoney(sum.adjustedCredit + row.adjustedCredit),
    }),
    { adjustedDebit: 0, adjustedCredit: 0 },
  );

  const intercompanyWarnings = await buildIntercompanyWarnings(supabase, {
    organizationId: input.organizationId,
    entities: scope.entities,
    asOf: periodEnd,
  });

  return {
    ...buildReportMeta(scope, {
      intercompanyWarnings,
      periodStatuses: buildPeriodStatuses(scope, periodEnd),
      reportMode: input.reportMode ?? "pre",
    }),
    periodStart,
    periodEnd,
    rows,
    eliminationAdjustments,
    totals,
    balanced: isTrialBalanceBalanced(totals.adjustedDebit, totals.adjustedCredit),
  };
}
