import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileRole } from "@/types";
import { accountingContext, type AccountingContext } from "./context";
import { resolveAuthorizedLegalEntity } from "./resolver";
import type { LegalEntitySummary } from "./types";
import { listLegalEntities } from "./service";
import type { EntityAuthContext } from "./access";

export type ActiveLegalEntityContext = AccountingContext & {
  legalEntity: LegalEntitySummary;
  accessibleEntities: LegalEntitySummary[];
  showEntitySwitcher: boolean;
};

export async function listAccessibleLegalEntities(
  supabase: SupabaseClient,
  organizationId: string,
  auth: EntityAuthContext,
): Promise<LegalEntitySummary[]> {
  const entities = await listLegalEntities(supabase, organizationId, { includeInactive: false });
  if (auth.role === "owner" || auth.role === "admin") return entities;

  const { data: memberships, error } = await supabase
    .from("teller_legal_entity_memberships")
    .select("legal_entity_id")
    .eq("organization_id", organizationId)
    .eq("profile_id", auth.userId);

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return entities;
    throw new Error(error.message);
  }

  if (!memberships?.length) return entities;

  const allowed = new Set(memberships.map((row) => row.legal_entity_id as string));
  return entities.filter((entity) => allowed.has(entity.id));
}

export async function resolveActiveLegalEntityContext(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    auth: EntityAuthContext;
    persistedLegalEntityId?: string | null;
    requestedLegalEntityId?: string | null;
  },
): Promise<ActiveLegalEntityContext> {
  const accessibleEntities = await listAccessibleLegalEntities(
    supabase,
    input.organizationId,
    input.auth,
  );

  const activeCandidates = [
    input.requestedLegalEntityId?.trim(),
    input.persistedLegalEntityId?.trim(),
  ].filter(Boolean) as string[];

  let legalEntity: LegalEntitySummary | null = null;
  for (const candidate of activeCandidates) {
    try {
      legalEntity = await resolveAuthorizedLegalEntity(supabase, {
        organizationId: input.organizationId,
        requestedLegalEntityId: candidate,
        auth: input.auth,
      });
      break;
    } catch {
      legalEntity = null;
    }
  }

  if (!legalEntity) {
    if (accessibleEntities.length === 1) {
      legalEntity = accessibleEntities[0]!;
    } else {
      legalEntity = await resolveAuthorizedLegalEntity(supabase, {
        organizationId: input.organizationId,
        auth: input.auth,
      });
    }
  }

  return {
    ...accountingContext(input.organizationId, legalEntity.id),
    legalEntity,
    accessibleEntities,
    showEntitySwitcher: accessibleEntities.length > 1,
  };
}

export async function persistActiveLegalEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    userId: string;
    role: ProfileRole;
    legalEntityId: string;
  },
): Promise<ActiveLegalEntityContext> {
  const context = await resolveActiveLegalEntityContext(supabase, {
    organizationId: input.organizationId,
    auth: { userId: input.userId, role: input.role },
    requestedLegalEntityId: input.legalEntityId,
  });

  const { error } = await supabase
    .from("teller_profiles")
    .update({ active_legal_entity_id: context.legalEntityId, updated_at: new Date().toISOString() })
    .eq("id", input.userId)
    .eq("organization_id", input.organizationId);

  if (error) throw new Error(error.message);
  return context;
}
