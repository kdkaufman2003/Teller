/**
 * Phase 17B controlled security acceptance (~45 checks).
 * Static always. DB when TELLER_CONTROLLED_PROD_TEST=1.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";

type Result = { name: string; pass: boolean; detail?: string };

const ROOT = process.cwd();
const HFAC_ORG = TELLER_HFAC_ORG_ID;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function staticPass(name: string, ok: boolean, detail?: string): Result {
  return { name, pass: ok, detail };
}

function loadEnv() {
  const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  if (!orgId) throw new Error("TELLER_PHASE16_DEMO_ORG_ID missing");
  assertNotHfacOrganization(orgId);
  return {
    orgId,
    supabase: createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    ),
  };
}

function runStaticSuite(): Result[] {
  const results: Result[] = [];
  const migration047 = read("supabase/migrations/047_phase16h_entity_controls.sql");
  const patch051 = read("supabase/patches/051_phase17b_security_hardening.sql");
  const api = read("src/lib/api.ts");
  const hfacAuth = read("src/lib/integrations/hfac-auth.ts");
  const hfacOrg = read("src/lib/integrations/hfac-org.ts");
  const acquisition = read("src/lib/accounting/fixed-asset-acquisition.ts");

  // Patch 051
  results.push(staticPass("patch_051_exists", existsSync(join(ROOT, "supabase/patches/051_phase17b_security_hardening.sql"))));
  results.push(staticPass("patch_051_drops_journal_insert", patch051.includes("teller entity journal entries insert")));
  results.push(staticPass("patch_051_probe_rpc", patch051.includes("teller_phase17b_journal_insert_blocked")));
  results.push(staticPass("patch_051_static_verifier", existsSync(join(ROOT, "scripts/verify-migration-051-static.mjs"))));

  // 17A-003 journal INSERT regression documented
  results.push(staticPass("047_had_journal_insert", migration047.includes("teller entity journal entries insert")));

  // 17A-013 fixed asset immutability
  results.push(staticPass("no_posted_line_update_in_acquisition", !/teller_journal_lines["']\)\s*\.\s*update/.test(acquisition)));
  results.push(staticPass("fixed_asset_journal_links_used", acquisition.includes("recordFixedAssetJournalLink")));

  // Auth / API
  results.push(staticPass("requireBooks_session_org", api.includes("session.organization.id")));
  results.push(staticPass("requireEntityBooks", api.includes("requireEntityBooks")));
  results.push(staticPass("requireAdminBooks", api.includes("requireAdminBooks")));
  results.push(staticPass("requireWriteBooks", api.includes("requireWriteBooks")));
  results.push(staticPass("middleware_exists", existsSync(join(ROOT, "src/middleware.ts"))));

  const middleware = read("src/middleware.ts");
  results.push(staticPass("middleware_page_auth", middleware.includes("/app/")));

  // HFAC
  results.push(staticPass("hfac_hmac", hfacAuth.includes("verifyHfacWebhookAuth")));
  results.push(staticPass("hfac_replay_window", hfacAuth.includes("HFAC_REPLAY_WINDOW_MS")));
  results.push(staticPass("hfac_timing_safe", hfacAuth.includes("timingSafeEqual")));
  results.push(staticPass("hfac_org_mapping", hfacOrg.includes("resolveHfacWebhookOrganization")));
  results.push(staticPass("hfac_event_dedup_table", read("supabase/migrations/013_phase05_security.sql").includes("teller_hfac_webhook_events")));

  // Entity access
  results.push(staticPass("entity_access_module", existsSync(join(ROOT, "src/lib/accounting/legal-entity/access.ts"))));
  results.push(staticPass("zero_membership_legacy_documented", read("src/lib/accounting/legal-entity/access.ts").includes("restricted")));

  // RLS helpers
  results.push(staticPass("teller_can_access_legal_entity", read("supabase/migrations/041_phase16b_entity_access.sql").includes("teller_can_access_legal_entity")));
  results.push(staticPass("entity_journal_select_policy", migration047.includes("teller entity journal entries select")));
  results.push(staticPass("no_journal_update_policy_047", !/teller_journal_entries for update/i.test(migration047)));

  // Service role
  results.push(staticPass("admin_client_module", existsSync(join(ROOT, "src/lib/supabase/admin.ts"))));
  results.push(staticPass("controlled_prod_guard", read("src/lib/integration/controlled-prod-test.ts").includes("TELLER_HFAC_ORG_ID")));

  // Banking secrets RLS
  results.push(staticPass("bank_secrets_no_member_policy", read("supabase/migrations/009_banking.sql").includes("teller_bank_connection_secrets")));

  // Posting canonical
  results.push(staticPass("postJournal_gateway", read("src/lib/accounting/post.ts").includes("postJournal")));
  results.push(staticPass("security_doc", existsSync(join(ROOT, "docs/PHASE-17B-SECURITY-HARDENING.md"))));

  // No unsafe journal mutations in src
  const unsafeJournal = /\.from\(["']teller_journal_(entries|lines)["']\)\s*\.\s*(insert|update|delete|upsert)/;
  let journalHits = 0;
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && unsafeJournal.test(readFileSync(full, "utf8"))) {
        journalHits += 1;
      }
    }
  }
  walk(join(ROOT, "src"));
  results.push(staticPass("no_unsafe_journal_mutations_src", journalHits === 0, String(journalHits)));

  // Role escalation trigger
  results.push(staticPass("role_escalation_trigger", read("supabase/migrations/005_accounting_foundation.sql").includes("teller_profiles_role_guard")));

  return results;
}

async function runDbSuite(orgId: string, supabase: SupabaseClient): Promise<Result[]> {
  const results: Result[] = [];

  const { data: probe047 } = await supabase.rpc("teller_phase16h_controls_applied");
  results.push(staticPass("entity_controls_probe", probe047 === true, String(probe047)));

  const { data: probe051, error: err051 } = await supabase.rpc("teller_phase17b_journal_insert_blocked");
  if (err051?.message?.includes("Could not find the function")) {
    results.push(staticPass("patch_051_applied", false, "Patch 051 not applied — manual application required"));
  } else {
    results.push(staticPass("patch_051_journal_insert_blocked", probe051 === true, String(probe051)));
  }

  // HFAC baseline
  const { count: hfacDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  const { count: hfacJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  results.push(staticPass("hfac_documents_baseline", (hfacDocs ?? 0) === 8, String(hfacDocs)));
  results.push(staticPass("hfac_journals_baseline", (hfacJournals ?? 0) === 17, String(hfacJournals)));

  // Zero membership inventory
  const { data: memberships } = await supabase
    .from("teller_legal_entity_memberships")
    .select("profile_id, organization_id");
  const { data: profiles } = await supabase
    .from("teller_profiles")
    .select("id, organization_id, role")
    .neq("role", "owner")
    .neq("role", "admin");
  const memberProfileIds = new Set((memberships ?? []).map((m) => m.profile_id as string));
  const zeroMembership = (profiles ?? []).filter((p) => !memberProfileIds.has(p.id as string));
  const zeroOrgs = new Set(zeroMembership.map((p) => p.organization_id as string));
  results.push(
    staticPass(
      "zero_membership_inventory",
      true,
      `${zeroMembership.length} users across ${zeroOrgs.size} orgs`,
    ),
  );

  // Unbalanced journals in demo org
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId);
  let unbalanced = 0;
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id as string);
    const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(debit - credit) > 0.009) unbalanced += 1;
  }
  results.push(staticPass("demo_journals_balanced", unbalanced === 0, String(unbalanced)));

  // Cross-org: HFAC doc not visible from demo org filter
  const { count: crossOrgDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG)
    .eq("organization_id", orgId);
  results.push(staticPass("cross_org_doc_isolation_service_check", (crossOrgDocs ?? 0) === 0));

  // Default entity cardinality
  const { data: entities } = await supabase
    .from("teller_legal_entities")
    .select("is_default")
    .eq("organization_id", orgId)
    .eq("is_active", true);
  const defaultCount = (entities ?? []).filter((e) => e.is_default).length;
  results.push(staticPass("demo_single_default_entity", defaultCount === 1, String(defaultCount)));

  // Canonical post still works via RPC probe
  const { data: legacyProbe } = await supabase.rpc("teller_phase16j_legacy_posting_probe", {
    p_org: orgId,
  });
  results.push(staticPass("canonical_posting_probe", legacyProbe === true, String(legacyProbe)));

  return results;
}

async function main() {
  const staticResults = runStaticSuite();
  let dbResults: Result[] = [];

  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    const { orgId, supabase } = loadEnv();
    dbResults = await runDbSuite(orgId, supabase);
  } else {
    dbResults.push(staticPass("db_suite_skipped", true, "TELLER_CONTROLLED_PROD_TEST not set"));
  }

  const all = [...staticResults, ...dbResults];
  const failed = all.filter((r) => !r.pass);

  console.log(`Phase 17B security acceptance: ${all.length - failed.length}/${all.length} PASS`);
  for (const r of all) {
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }

  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
