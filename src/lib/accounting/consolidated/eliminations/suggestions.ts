import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveConsolidationScope } from "../scope";
import type { EntityAuthContext } from "../../legal-entity/access";
import { suggestDueToFromEliminations } from "./suggestions-due-to-from";
import { suggestIntercompanyPlEliminations } from "./suggestions-pl";

export async function buildConsolidationEliminationSuggestions(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    asOf: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    auth?: EntityAuthContext;
  },
) {
  const asOf = input.asOf.slice(0, 10);
  const periodEnd = input.periodEnd?.slice(0, 10) ?? asOf;
  const periodStart = input.periodStart?.slice(0, 10) ?? `${periodEnd.slice(0, 4)}-01-01`;
  const scope = await resolveConsolidationScope(supabase, {
    organizationId: input.organizationId,
    legalEntityIds: input.legalEntityIds,
    includeAllEntities: input.includeAllEntities,
    auth: input.auth,
  });

  const [dueToFrom, intercompanyPl] = await Promise.all([
    suggestDueToFromEliminations(supabase, {
      organizationId: input.organizationId,
      entities: scope.entities,
      asOf,
    }),
    suggestIntercompanyPlEliminations(supabase, {
      organizationId: input.organizationId,
      entities: scope.entities,
      periodStart,
      periodEnd,
    }),
  ]);

  return {
    scope,
    asOf,
    periodStart,
    periodEnd,
    dueToFrom,
    intercompanyPl,
  };
}
