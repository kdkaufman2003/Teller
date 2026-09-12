import type { SupabaseClient } from "@supabase/supabase-js";
import { getIntercompanyPairReconciliation } from "../intercompany/settlement";
import type { ConsolidationScope, ConsolidationScopeEntity } from "./types";

export async function buildIntercompanyWarnings(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entities: ConsolidationScopeEntity[];
    asOf: string;
  },
): Promise<string[]> {
  const warnings: string[] = [];
  const ids = input.entities.map((entity) => entity.legalEntityId);

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const report = await getIntercompanyPairReconciliation(supabase, {
        organizationId: input.organizationId,
        entityAId: ids[i]!,
        entityBId: ids[j]!,
        asOf: input.asOf,
      });
      if (report.status === "OUT_OF_BALANCE") {
        const aName = input.entities.find((e) => e.legalEntityId === ids[i])?.name ?? ids[i];
        const bName = input.entities.find((e) => e.legalEntityId === ids[j])?.name ?? ids[j];
        warnings.push(
          `Intercompany balances between ${aName} and ${bName} are out of balance and may affect consolidation.`,
        );
      }
    }
  }

  return warnings;
}

export function buildPeriodStatuses(
  scope: ConsolidationScope,
  reportDate: string,
): ConsolidationScope["entities"] extends never ? never : Array<{
  legalEntityId: string;
  entityName: string;
  booksClosedThrough: string | null;
  status: "open" | "closed_for_date";
}> {
  return scope.entities.map((entity) => ({
    legalEntityId: entity.legalEntityId,
    entityName: entity.name,
    booksClosedThrough: entity.booksClosedThrough,
    status:
      entity.booksClosedThrough && reportDate <= entity.booksClosedThrough
        ? "closed_for_date"
        : "open",
  }));
}

export function buildReportMeta(
  scope: ConsolidationScope,
  input: {
    intercompanyWarnings: string[];
    periodStatuses: ReturnType<typeof buildPeriodStatuses>;
  },
) {
  return {
    scope,
    generatedAt: new Date().toISOString(),
    preEliminationLabel: "Pre-elimination consolidated report",
    intercompanyWarnings: input.intercompanyWarnings,
    periodStatuses: input.periodStatuses,
  };
}
