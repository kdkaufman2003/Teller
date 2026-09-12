/**
 * Phase 16A controlled DB acceptance — requires manually applied migration 040.
 * Mutates dedicated Phase 16 demo org only. HFAC org is read-only baseline.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import {
  archiveLegalEntity,
  createLegalEntity,
  listLegalEntities,
  requireDefaultLegalEntity,
  resolveAuthorizedLegalEntity,
  seedDefaultLegalEntityViaRpc,
} from "../src/lib/accounting/legal-entity";
import { accountingContext } from "../src/lib/accounting/legal-entity/context";

type Result = { name: string; pass: boolean; detail?: string };

const HFAC_ORG = TELLER_HFAC_ORG_ID;
const HFAC_EXPECTED_DOCS = 8;
const HFAC_EXPECTED_JOURNALS = 17;

function loadEnv() {
  if (process.env.TELLER_CONTROLLED_PROD_TEST !== "1") {
    throw new Error("TELLER_CONTROLLED_PROD_TEST=1 required");
  }
  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  const foreignOrgId = process.env.TELLER_PHASE16_FOREIGN_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing — run setup:phase16-demo-org after migration 040");
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
  const { error } = await supabase.from("teller_legal_entities").select("id").limit(1);
  if (error?.message.match(/does not exist|schema cache/i)) {
    throw new Error("Migration 040 not applied — teller_legal_entities missing");
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

async function hfacBaseline(supabase: SupabaseClient) {
  return {
    documents: await tableCount(supabase, "teller_documents", HFAC_ORG),
    journals: await tableCount(supabase, "teller_journal_entries", HFAC_ORG),
    tax: await tableCount(supabase, "teller_tax_transactions", HFAC_ORG),
  };
}

async function main() {
  const { orgId, foreignOrgId, supabase } = loadEnv();
  await assertSchemaReady(supabase);

  const hfacBefore = await hfacBaseline(supabase);
  const journalsBefore = await tableCount(supabase, "teller_journal_entries", orgId);
  const results: Result[] = [];

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

  await run("16A_01 existing org default entity", async () => {
    const entity = await requireDefaultLegalEntity(supabase, orgId);
    if (!entity.isDefault) throw new Error("expected default entity");
  });

  await run("16A_02 seed default idempotent", async () => {
    const first = await seedDefaultLegalEntityViaRpc(supabase, orgId);
    const second = await seedDefaultLegalEntityViaRpc(supabase, orgId);
    if (first !== second) throw new Error("seed RPC not idempotent");
  });

  let secondEntityId = "";
  await run("16A_03 second legal entity", async () => {
    const created = await createLegalEntity(supabase, {
      organizationId: orgId,
      name: "Phase 16 Branch",
      entityCode: "BR01",
      entityType: "llc",
    });
    secondEntityId = created.id;
    if (created.isDefault) throw new Error("second entity must not be default");
  });

  await run("16A_04 exactly one default", async () => {
    const entities = await listLegalEntities(supabase, orgId);
    const defaults = entities.filter((row) => row.isDefault);
    if (defaults.length !== 1) throw new Error(`expected 1 default, got ${defaults.length}`);
  });

  await run("16A_05 duplicate default blocked", async () => {
    try {
      await createLegalEntity(supabase, {
        organizationId: orgId,
        name: "Another Default",
        entityCode: "DUP",
        isDefault: true,
      });
      throw new Error("expected duplicate default rejection");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "expected duplicate default rejection") throw err;
      if (!/default/i.test(message)) throw err;
    }
  });

  await run("16A_06 foreign-org entity blocked", async () => {
    const foreignDefault = await requireDefaultLegalEntity(supabase, foreignOrgId);
    try {
      await resolveAuthorizedLegalEntity(supabase, {
        organizationId: orgId,
        requestedLegalEntityId: foreignDefault.id,
      });
      throw new Error("expected cross-org rejection");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "expected cross-org rejection") throw err;
      if (!/organization|not found/i.test(message)) throw err;
    }
  });

  await run("16A_07 inactive entity archive", async () => {
    if (!secondEntityId) throw new Error("missing second entity");
    const archived = await archiveLegalEntity(supabase, {
      organizationId: orgId,
      legalEntityId: secondEntityId,
    });
    if (archived.isActive) throw new Error("entity still active");
  });

  await run("16A_08 default resolver", async () => {
    const entity = await resolveAuthorizedLegalEntity(supabase, { organizationId: orgId });
    accountingContext(orgId, entity.id);
  });

  await run("16A_09 entity creation zero journals", async () => {
    const after = await tableCount(supabase, "teller_journal_entries", orgId);
    if (after !== journalsBefore) throw new Error(`journals changed ${journalsBefore} → ${after}`);
  });

  await run("16A_10 HFAC default entity compatibility", async () => {
    const hfacEntity = await requireDefaultLegalEntity(supabase, HFAC_ORG);
    if (!hfacEntity.isDefault) throw new Error("HFAC missing default entity");
  });

  await run("16A_11 HFAC baseline unchanged", async () => {
    const hfacAfter = await hfacBaseline(supabase);
    if (JSON.stringify(hfacBefore) !== JSON.stringify(hfacAfter)) {
      throw new Error(`HFAC changed: ${JSON.stringify(hfacAfter)}`);
    }
    if (hfacAfter.documents !== HFAC_EXPECTED_DOCS || hfacAfter.journals !== HFAC_EXPECTED_JOURNALS) {
      throw new Error(`HFAC baseline mismatch docs=${hfacAfter.documents} journals=${hfacAfter.journals}`);
    }
  });

  const passed = results.filter((row) => row.pass).length;
  console.log(`\nPhase 16A acceptance: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
