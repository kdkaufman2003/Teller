import type { SupabaseClient } from "@supabase/supabase-js";
import { getIntercompanyPairReconciliation } from "../../intercompany/settlement";
import { consolidationAccountKey } from "../grouping";
import { roundMoney } from "../../payment-fees";
import type { ConsolidationScopeEntity } from "../types";
import type { DueToFromEliminationSuggestion, EliminationLineInput } from "./types";

async function icAccountForEntity(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId: string,
  subtype: "due_from" | "due_to",
) {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", legalEntityId)
    .eq("subtype", subtype)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function suggestDueToFromEliminations(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entities: ConsolidationScopeEntity[];
    asOf: string;
  },
): Promise<DueToFromEliminationSuggestion[]> {
  const suggestions: DueToFromEliminationSuggestion[] = [];
  const asOf = input.asOf.slice(0, 10);
  const ids = input.entities.map((entity) => entity.legalEntityId);

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const entityAId = ids[i]!;
      const entityBId = ids[j]!;
      const entityA = input.entities.find((e) => e.legalEntityId === entityAId);
      const entityB = input.entities.find((e) => e.legalEntityId === entityBId);
      const report = await getIntercompanyPairReconciliation(supabase, {
        organizationId: input.organizationId,
        entityAId,
        entityBId,
        asOf,
      });

      const aDueFromB = roundMoney(report.aDueFromB);
      const bDueToA = roundMoney(report.bDueToA);
      const matched = roundMoney(Math.min(Math.abs(aDueFromB), Math.abs(bDueToA)));
      const difference = roundMoney(Math.abs(aDueFromB - bDueToA));
      if (matched < 0.005) continue;

      const dueFromA = await icAccountForEntity(supabase, input.organizationId, entityAId, "due_from");
      const dueToB = await icAccountForEntity(supabase, input.organizationId, entityBId, "due_to");
      if (!dueFromA?.id || !dueToB?.id) continue;

      const proposedLines: EliminationLineInput[] = [
        {
          groupKey: consolidationAccountKey({
            type: dueFromA.type as string,
            subtype: dueFromA.subtype as string,
            code: dueFromA.code as string,
            name: dueFromA.name as string,
          }),
          accountType: dueFromA.type as string,
          accountSubtype: (dueFromA.subtype as string) ?? "",
          accountCode: dueFromA.code as string,
          accountName: dueFromA.name as string,
          sourceLegalEntityId: entityAId,
          sourceAccountId: dueFromA.id as string,
          credit: matched,
        },
        {
          groupKey: consolidationAccountKey({
            type: dueToB.type as string,
            subtype: dueToB.subtype as string,
            code: dueToB.code as string,
            name: dueToB.name as string,
          }),
          accountType: dueToB.type as string,
          accountSubtype: (dueToB.subtype as string) ?? "",
          accountCode: dueToB.code as string,
          accountName: dueToB.name as string,
          sourceLegalEntityId: entityBId,
          sourceAccountId: dueToB.id as string,
          debit: matched,
        },
      ];

      suggestions.push({
        entityAId,
        entityBId,
        entityAName: entityA?.name ?? entityAId,
        entityBName: entityB?.name ?? entityBId,
        aDueFromB,
        bDueToA,
        matchedEliminableAmount: matched,
        difference,
        warning: difference >= 0.01 || report.status === "OUT_OF_BALANCE",
        status: report.status,
        proposedLines,
        sources: [
          {
            sourceKind: "intercompany_pair",
            metadata: {
              entityAId,
              entityBId,
              asOf,
              aDueFromB,
              bDueToA,
              receivablePayableDifference: report.receivablePayableDifference,
              payableReceivableDifference: report.payableReceivableDifference,
            },
          },
        ],
      });
    }
  }

  return suggestions;
}
