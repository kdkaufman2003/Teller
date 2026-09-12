/** Shared Phase 16 controlled demo identity fixture (never HFAC, never real users). */
import { randomUUID } from "node:crypto";

export const PHASE16_RESTRICTED_PROFILE_ID = "00000000-0000-4000-8160-000000000016";
export const PHASE16_RESTRICTED_EMAIL = "phase16-restricted@controlled.teller.invalid";
export const PHASE16_BRANCH_ENTITY_CODE = "BR16B";

/**
 * Ensure isolated bookkeeper profile for entity-access acceptance.
 * Uses fixed auth user id for idempotent reruns; requires service role.
 */
export async function ensurePhase16RestrictedProfile(supabase, organizationId) {
  const { data: existingUser, error: getUserError } =
    await supabase.auth.admin.getUserById(PHASE16_RESTRICTED_PROFILE_ID);

  if (getUserError && !/not found|User not found/i.test(getUserError.message)) {
    throw new Error(getUserError.message);
  }

  if (!existingUser?.user) {
    const { error: createError } = await supabase.auth.admin.createUser({
      id: PHASE16_RESTRICTED_PROFILE_ID,
      email: PHASE16_RESTRICTED_EMAIL,
      email_confirm: true,
      password: randomUUID(),
      user_metadata: {
        controlled_test: "phase16-restricted",
        full_name: "Phase 16 Restricted Test",
      },
    });
    if (createError) throw new Error(createError.message);
  }

  const { data: existingProfile } = await supabase
    .from("teller_profiles")
    .select("id, organization_id")
    .eq("id", PHASE16_RESTRICTED_PROFILE_ID)
    .maybeSingle();

  if (!existingProfile) {
    const { error: insertError } = await supabase.from("teller_profiles").insert({
      id: PHASE16_RESTRICTED_PROFILE_ID,
      organization_id: organizationId,
      email: PHASE16_RESTRICTED_EMAIL,
      full_name: "Phase 16 Restricted Test",
      role: "bookkeeper",
    });
    if (insertError) throw new Error(insertError.message);
  } else {
    const { error: updateError } = await supabase
      .from("teller_profiles")
      .update({
        organization_id: organizationId,
        email: PHASE16_RESTRICTED_EMAIL,
        full_name: "Phase 16 Restricted Test",
        role: "bookkeeper",
        active_legal_entity_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", PHASE16_RESTRICTED_PROFILE_ID);
    if (updateError) throw new Error(updateError.message);
  }

  return PHASE16_RESTRICTED_PROFILE_ID;
}

/** Reset restricted-user entity access state between acceptance runs. */
export async function resetPhase16RestrictedAccessState(supabase, organizationId, profileId) {
  const { error: membershipError } = await supabase
    .from("teller_legal_entity_memberships")
    .delete()
    .eq("organization_id", organizationId)
    .eq("profile_id", profileId);
  if (membershipError) throw new Error(membershipError.message);

  const { error: profileError } = await supabase
    .from("teller_profiles")
    .update({ active_legal_entity_id: null, updated_at: new Date().toISOString() })
    .eq("id", profileId)
    .eq("organization_id", organizationId);
  if (profileError) throw new Error(profileError.message);
}
