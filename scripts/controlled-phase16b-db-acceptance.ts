/**
 * Phase 16B controlled DB acceptance — requires manually applied migration 041.
 * Mutates dedicated Phase 16 demo org only. HFAC org is read-only baseline.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  canAccessLegalEntity,
  createLegalEntity,
  grantEntityAccess,
  listAccessibleLegalEntities,
  persistActiveLegalEntity,
  requireDefaultLegalEntity,
  resolveActiveLegalEntityContext,
  resolveAuthorizedLegalEntity,
  revokeEntityAccess,
  setDefaultLegalEntity,
} from "../src/lib/accounting/legal-entity";

type Result = { name: string; pass: boolean; detail?: string };

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const BRANCH_ENTITY_CODE = "BR16B";
const RESTRICTED_PROFILE_ID =
  process.env.TELLER_PHASE16_RESTRICTED_PROFILE_ID?.trim() ||
  "00000000-0000-4000-8160-000000000016";

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  const foreignOrgId = process.env.TELLER_PHASE16_FOREIGN_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing — run setup:phase16-demo-org");
  if (!foreignOrgId) throw new Error("TELLER_PHASE16_FOREIGN_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  assertNotHfacOrganization(foreignOrgId);
  return {
    orgId,
    foreignOrgId,
    supabase: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}

async function assertSchemaReady(supabase: SupabaseClient) {
  const { error } = await supabase.from("teller_legal_entity_memberships").select("id").limit(1);
  if (error?.message.match(/does not exist|schema cache/i)) {
    throw new Error("Migration 041 not applied — teller_legal_entity_memberships missing");
  }
}

async function tableCount(supabase: SupabaseClient, table: string, orgId: string) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function ensureRestrictedProfile(supabase: SupabaseClient, orgId: string) {
  const { data: profile, error } = await supabase
    .from("teller_profiles")
    .select("id, organization_id, role")
    .eq("id", RESTRICTED_PROFILE_ID)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!profile?.id || profile.organization_id !== orgId) {
    throw new Error(
      "Phase 16 restricted profile missing — run npm run setup:phase16-demo-org after migration 041",
    );
  }
  if (profile.role !== "bookkeeper") {
    throw new Error("Phase 16 restricted profile must be bookkeeper role");
  }
  return profile.id;
}

async function resetRestrictedAccessState(supabase: SupabaseClient, orgId: string, profileId: string) {
  const { error: membershipError } = await supabase
    .from("teller_legal_entity_memberships")
    .delete()
    .eq("organization_id", orgId)
    .eq("profile_id", profileId);
  if (membershipError) throw new Error(membershipError.message);

  const { error: profileError } = await supabase
    .from("teller_profiles")
    .update({ active_legal_entity_id: null, updated_at: new Date().toISOString() })
    .eq("id", profileId)
    .eq("organization_id", orgId);
  if (profileError) throw new Error(profileError.message);
}

async function requireEntityByCode(supabase: SupabaseClient, orgId: string, entityCode: string) {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("id, entity_code, is_default")
    .eq("organization_id", orgId)
    .eq("entity_code", entityCode)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.id) throw new Error(`entity ${entityCode} missing`);
  return data;
}

async function ensureBranchEntity(supabase: SupabaseClient, orgId: string) {
  const existing = await requireEntityByCode(supabase, orgId, BRANCH_ENTITY_CODE).catch(() => null);
  if (existing?.id) return existing.id;

  const created = await createLegalEntity(supabase, {
    organizationId: orgId,
    name: "Phase 16 Branch B",
    entityCode: BRANCH_ENTITY_CODE,
    entityType: "llc",
  });
  return created.id;
}

async function main() {
  const { orgId, foreignOrgId, supabase } = loadEnv();
  await assertSchemaReady(supabase);

  const restrictedProfileId = await ensureRestrictedProfile(supabase, orgId);
  await resetRestrictedAccessState(supabase, orgId, restrictedProfileId);

  const journalsBefore = await tableCount(supabase, "teller_journal_entries", orgId);
  const results: Result[] = [];
  let branchEntityId = "";
  let allowedEntityId = "";
  const restrictedAuth = { userId: restrictedProfileId, role: "bookkeeper" as const };

  async function run(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, pass: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, pass: false, detail });
      console.log(`✗ ${name} — ${detail}`);
    }
  }

  await run("16B_01 owner sees all entities", async () => {
    const entities = await listAccessibleLegalEntities(supabase, orgId, {
      userId: restrictedProfileId,
      role: "owner",
    });
    if (entities.length < 1) throw new Error("expected entities");
  });

  await run("16B_02 create second entity", async () => {
    branchEntityId = await ensureBranchEntity(supabase, orgId);
    const mainEntity = await requireEntityByCode(supabase, orgId, "MAIN");
    allowedEntityId = mainEntity.id;
    if (allowedEntityId === branchEntityId) {
      throw new Error("MAIN and branch entity must differ for restriction tests");
    }
  });

  await run("16B_02b zero membership backward compatibility", async () => {
    if (!branchEntityId) throw new Error("missing branch entity");
    const allowed = await canAccessLegalEntity(supabase, {
      organizationId: orgId,
      legalEntityId: branchEntityId,
      auth: restrictedAuth,
    });
    if (!allowed) throw new Error("zero membership rows should allow all entities");
  });

  await run("16B_03 grant restricted access to one entity", async () => {
    if (!allowedEntityId) throw new Error("missing allowed entity");
    await grantEntityAccess(supabase, {
      organizationId: orgId,
      profileId: restrictedProfileId,
      legalEntityId: allowedEntityId,
    });
  });

  await run("16B_04 same-org unauthorized entity denied", async () => {
    if (!branchEntityId) throw new Error("missing branch entity");
    const allowed = await canAccessLegalEntity(supabase, {
      organizationId: orgId,
      legalEntityId: branchEntityId,
      auth: restrictedAuth,
    });
    if (allowed) throw new Error("expected restricted denial after explicit membership");
  });

  await run("16B_05 cross-org entity denied", async () => {
    const foreignDefault = await requireDefaultLegalEntity(supabase, foreignOrgId);
    await resolveAuthorizedLegalEntity(supabase, {
      organizationId: orgId,
      requestedLegalEntityId: foreignDefault.id,
      auth: { userId: restrictedProfileId, role: "owner" },
    }).then(
      () => {
        throw new Error("expected cross-org rejection");
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "expected cross-org rejection") throw err;
        if (!/organization|not found|access/i.test(message)) throw err;
      },
    );
  });

  await run("16B_06 active context resolves", async () => {
    if (!allowedEntityId) throw new Error("missing allowed entity");
    const context = await persistActiveLegalEntity(supabase, {
      organizationId: orgId,
      userId: restrictedProfileId,
      role: "bookkeeper",
      legalEntityId: allowedEntityId,
    });
    if (context.legalEntityId !== allowedEntityId) throw new Error("active context mismatch");

    const resolved = await resolveActiveLegalEntityContext(supabase, {
      organizationId: orgId,
      auth: restrictedAuth,
      persistedLegalEntityId: context.legalEntityId,
    });
    if (resolved.legalEntityId !== allowedEntityId) {
      throw new Error("resolveActiveLegalEntityContext mismatch");
    }
  });

  await run("16B_07 revoke access takes effect", async () => {
    if (!allowedEntityId) throw new Error("missing allowed entity");
    await revokeEntityAccess(supabase, {
      organizationId: orgId,
      profileId: restrictedProfileId,
      legalEntityId: allowedEntityId,
    });

    const allowed = await canAccessLegalEntity(supabase, {
      organizationId: orgId,
      legalEntityId: allowedEntityId,
      auth: restrictedAuth,
    });
    if (!allowed) throw new Error("revoked user with no rows should regain full access");

    const resolved = await resolveActiveLegalEntityContext(supabase, {
      organizationId: orgId,
      auth: restrictedAuth,
      persistedLegalEntityId: allowedEntityId,
    });
    if (resolved.legalEntityId !== allowedEntityId) {
      throw new Error("expected safe re-resolution to authorized entity");
    }
  });

  await run("16B_08 default change preserves history", async () => {
    if (!branchEntityId) throw new Error("missing branch entity");
    await setDefaultLegalEntity(supabase, {
      organizationId: orgId,
      legalEntityId: branchEntityId,
    });
    const after = await tableCount(supabase, "teller_journal_entries", orgId);
    if (after !== journalsBefore) throw new Error(`journals changed ${journalsBefore} → ${after}`);
  });

  await run("16B_09 entity admin creates zero journals", async () => {
    const after = await tableCount(supabase, "teller_journal_entries", orgId);
    if (after !== journalsBefore) throw new Error(`journals changed ${journalsBefore} → ${after}`);
  });

  await run("16B_10 HFAC default handling safe", async () => {
    const hfacDefault = await requireDefaultLegalEntity(supabase, HFAC_ORG);
    if (!hfacDefault.isDefault) throw new Error("HFAC default entity missing");
  });

  const passed = results.filter((row) => row.pass).length;
  console.log(`\nPhase 16B acceptance: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
