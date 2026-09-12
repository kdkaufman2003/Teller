import type { SupabaseClient } from "@supabase/supabase-js";
import { assertEntityAccess, type EntityAuthContext } from "./access";
import { assertSameOrganization } from "./validation";
import type { LegalEntitySummary } from "./types";

function mapRow(row: Record<string, unknown>): LegalEntitySummary {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    name: row.name as string,
    legalName: row.legal_name as string,
    entityCode: row.entity_code as string,
    entityType: row.entity_type as LegalEntitySummary["entityType"],
    baseCurrency: row.base_currency as string,
    isDefault: Boolean(row.is_default),
    isActive: Boolean(row.is_active),
    consolidationEnabled: Boolean(row.consolidation_enabled),
  };
}

export async function resolveDefaultLegalEntity(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<LegalEntitySummary | null> {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  return data ? mapRow(data) : null;
}

export async function requireDefaultLegalEntity(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<LegalEntitySummary> {
  const entity = await resolveDefaultLegalEntity(supabase, organizationId);
  if (!entity) {
    throw new Error("Default legal entity is not configured for this organization");
  }
  return entity;
}

export async function loadLegalEntityForOrg(
  supabase: SupabaseClient,
  organizationId: string,
  legalEntityId: string,
): Promise<LegalEntitySummary> {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("*")
    .eq("id", legalEntityId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Legal entity not found");
  assertSameOrganization(organizationId, data.organization_id as string);
  return mapRow(data);
}

/**
 * Resolve an authorized legal entity for the tenant.
 * When auth is provided, entity-level membership is enforced (16B).
 */
export async function resolveAuthorizedLegalEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    requestedLegalEntityId?: string | null;
    allowInactive?: boolean;
    auth?: EntityAuthContext;
  },
): Promise<LegalEntitySummary> {
  if (input.requestedLegalEntityId?.trim()) {
    const entity = await loadLegalEntityForOrg(
      supabase,
      input.organizationId,
      input.requestedLegalEntityId.trim(),
    );
    if (!entity.isActive && !input.allowInactive) {
      throw new Error("Legal entity is archived");
    }
    if (input.auth) {
      await assertEntityAccess(supabase, {
        organizationId: input.organizationId,
        legalEntityId: entity.id,
        auth: input.auth,
      });
    }
    return entity;
  }

  const defaultEntity = await requireDefaultLegalEntity(supabase, input.organizationId);
  if (input.auth) {
    await assertEntityAccess(supabase, {
      organizationId: input.organizationId,
      legalEntityId: defaultEntity.id,
      auth: input.auth,
    });
  }
  return defaultEntity;
}
