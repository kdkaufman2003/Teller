import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertEntityAccess,
  hasAllEntityAccess,
  type EntityAuthContext,
} from "../legal-entity/access";
import type { ConsolidationScope, ConsolidationScopeEntity } from "./types";

export async function resolveConsolidationScope(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityIds?: string[] | null;
    includeAllEntities?: boolean;
    auth?: EntityAuthContext;
  },
): Promise<ConsolidationScope> {
  const { data: allEntities, error } = await supabase
    .from("teller_legal_entities")
    .select("id, entity_code, name, is_active")
    .eq("organization_id", input.organizationId)
    .eq("is_active", true)
    .order("name");

  if (error) throw new Error(error.message);

  let selectedIds: string[];
  if (input.includeAllEntities) {
    selectedIds = (allEntities ?? []).map((row) => row.id as string);
  } else {
    selectedIds = (input.legalEntityIds ?? []).filter(Boolean);
  }

  if (!selectedIds.length) {
    throw new Error("Select at least one company for consolidated reporting");
  }

  const selectedSet = new Set(selectedIds);
  const entities: ConsolidationScopeEntity[] = [];

  for (const row of allEntities ?? []) {
    if (!selectedSet.has(row.id as string)) continue;
    if (input.auth) {
      await assertEntityAccess(supabase, {
        organizationId: input.organizationId,
        legalEntityId: row.id as string,
        auth: input.auth,
      });
    }
    const { data: closedThrough } = await supabase.rpc("teller_books_closed_through", {
      p_org: input.organizationId,
      p_legal_entity_id: row.id,
    });
    entities.push({
      legalEntityId: row.id as string,
      entityCode: row.entity_code as string,
      name: row.name as string,
      booksClosedThrough: (closedThrough as string | null) ?? null,
    });
  }

  if (entities.length !== selectedIds.length) {
    throw new Error("One or more selected companies are invalid for this organization");
  }

  if (input.auth && !hasAllEntityAccess(input.auth.role)) {
    for (const entity of entities) {
      await assertEntityAccess(supabase, {
        organizationId: input.organizationId,
        legalEntityId: entity.legalEntityId,
        auth: input.auth,
      });
    }
  }

  const scopeLabel =
    input.includeAllEntities && entities.length === (allEntities?.length ?? 0)
      ? "All Companies"
      : entities.map((entity) => entity.name).join(", ");

  return {
    organizationId: input.organizationId,
    entities,
    scopeLabel,
    preElimination: true,
    currency: "USD",
  };
}
