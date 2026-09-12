import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileRole } from "@/types";

export type EntityAuthContext = {
  userId: string;
  role: ProfileRole;
};

export function hasAllEntityAccess(role: ProfileRole): boolean {
  return role === "owner" || role === "admin";
}

export async function userHasRestrictedEntityAccess(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("teller_legal_entity_memberships")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("profile_id", userId);

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return false;
    throw new Error(error.message);
  }
  return (count ?? 0) > 0;
}

export async function canAccessLegalEntity(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    auth: EntityAuthContext;
  },
): Promise<boolean> {
  if (hasAllEntityAccess(input.auth.role)) return true;

  const restricted = await userHasRestrictedEntityAccess(
    supabase,
    input.organizationId,
    input.auth.userId,
  );
  if (!restricted) return true;

  const { data, error } = await supabase
    .from("teller_legal_entity_memberships")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("profile_id", input.auth.userId)
    .eq("legal_entity_id", input.legalEntityId)
    .maybeSingle();

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return false;
    throw new Error(error.message);
  }
  return Boolean(data?.id);
}

export async function assertEntityAccess(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    auth: EntityAuthContext;
  },
): Promise<void> {
  const allowed = await canAccessLegalEntity(supabase, input);
  if (!allowed) {
    throw new Error("You do not have access to this company");
  }
}

export type EntityMembershipSummary = {
  id: string;
  organizationId: string;
  legalEntityId: string;
  profileId: string;
};

export async function listEntityMembershipsForProfile(
  supabase: SupabaseClient,
  organizationId: string,
  profileId: string,
): Promise<EntityMembershipSummary[]> {
  const { data, error } = await supabase
    .from("teller_legal_entity_memberships")
    .select("id, organization_id, legal_entity_id, profile_id")
    .eq("organization_id", organizationId)
    .eq("profile_id", profileId);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    organizationId: row.organization_id as string,
    legalEntityId: row.legal_entity_id as string,
    profileId: row.profile_id as string,
  }));
}

export async function grantEntityAccess(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    profileId: string;
  },
): Promise<EntityMembershipSummary> {
  const { data, error } = await supabase
    .from("teller_legal_entity_memberships")
    .insert({
      organization_id: input.organizationId,
      legal_entity_id: input.legalEntityId,
      profile_id: input.profileId,
    })
    .select("id, organization_id, legal_entity_id, profile_id")
    .single();

  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      throw new Error("Entity access already granted");
    }
    throw new Error(error.message);
  }

  return {
    id: data.id as string,
    organizationId: data.organization_id as string,
    legalEntityId: data.legal_entity_id as string,
    profileId: data.profile_id as string,
  };
}

export async function revokeEntityAccess(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId: string;
    profileId: string;
  },
): Promise<void> {
  const { error } = await supabase
    .from("teller_legal_entity_memberships")
    .delete()
    .eq("organization_id", input.organizationId)
    .eq("legal_entity_id", input.legalEntityId)
    .eq("profile_id", input.profileId);

  if (error) throw new Error(error.message);
}
