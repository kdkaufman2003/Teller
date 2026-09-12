#!/usr/bin/env node
/**
 * Phase 16J production-safe read-only verification.
 * Requires TELLER_CONTROLLED_PROD_TEST=1 and service role (via loadControlledProdEnv).
 */
import { createClient } from "@supabase/supabase-js";
import { loadControlledProdEnv } from "./load-controlled-prod-env.mjs";

const HFAC_ORG = "812be00d-3084-4227-ac71-ccbd22e4172c";
const issues = [];

function record(ok, label, detail) {
  if (!ok) issues.push({ label, detail });
  return ok;
}

async function countUnbalancedJournals(supabase, orgId, limit = 5000) {
  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", orgId)
    .limit(limit);
  let unbalanced = 0;
  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id);
    const debit = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credit = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(debit - credit) > 0.009) unbalanced += 1;
  }
  return unbalanced;
}

async function auditDefaultEntities(supabase) {
  const { data, error } = await supabase
    .from("teller_legal_entities")
    .select("organization_id, is_default, is_active")
    .eq("is_active", true);
  if (error) throw new Error(error.message);

  const byOrg = new Map();
  for (const row of data ?? []) {
    const orgId = row.organization_id;
    const bucket = byOrg.get(orgId) ?? { defaults: 0, active: 0 };
    bucket.active += 1;
    if (row.is_default) bucket.defaults += 1;
    byOrg.set(orgId, bucket);
  }

  let withoutDefault = 0;
  let multipleDefaults = 0;
  for (const bucket of byOrg.values()) {
    if (bucket.active > 0 && bucket.defaults === 0) withoutDefault += 1;
    if (bucket.defaults > 1) multipleDefaults += 1;
  }
  return { withoutDefault, multipleDefaults, orgCount: byOrg.size };
}

async function main() {
  loadControlledProdEnv();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: migration047, error: rpcError } = await supabase.rpc(
    "teller_phase16h_controls_applied",
  );
  record(
    !rpcError && migration047 === true,
    "migration_047_probe",
    rpcError?.message ?? String(migration047),
  );

  const probeOrg = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim() || HFAC_ORG;
  const { data: patch048Probe, error: patch048Error } = await supabase.rpc(
    "teller_phase16j_books_closed_probe",
    { p_org: probeOrg },
  );
  if (patch048Error?.message?.includes("Could not find the function")) {
    record(false, "patch_048_books_closed_probe", "Patch 048 not applied (probe RPC missing)");
  } else {
    record(!patch048Error && patch048Probe === true, "patch_048_books_closed_probe", patch048Error?.message ?? String(patch048Probe));
  }

  const { error: booksClosedAmbiguity } = await supabase.rpc("teller_books_closed_through", {
    p_org: probeOrg,
  });
  record(
    !booksClosedAmbiguity?.message?.includes("is not unique"),
    "books_closed_through_no_overload_ambiguity",
    booksClosedAmbiguity?.message ?? "callable",
  );

  const { data: patch049Probe, error: patch049Error } = await supabase.rpc(
    "teller_phase16j_legacy_posting_probe",
    { p_org: probeOrg },
  );
  if (patch049Error?.message?.includes("Could not find the function")) {
    record(false, "patch_049_legacy_posting_probe", "Patch 049 not applied (probe RPC missing)");
  } else {
    record(
      !patch049Error && patch049Probe === true,
      "patch_049_legacy_posting_probe",
      patch049Error?.message ?? String(patch049Probe),
    );
  }

  const tables = [
    "teller_legal_entities",
    "teller_legal_entity_memberships",
    "teller_entity_accounting_settings",
    "teller_intercompany_transactions",
    "teller_consolidation_elimination_entries",
  ];
  for (const table of tables) {
    const { error } = await supabase.from(table).select("organization_id").limit(1);
    record(!error, `table_${table}`, error?.message ?? "query failed");
  }

  const defaults = await auditDefaultEntities(supabase);
  record(defaults.withoutDefault === 0, "orgs_without_default_entity", String(defaults.withoutDefault));
  record(defaults.multipleDefaults === 0, "orgs_multiple_default_entities", String(defaults.multipleDefaults));

  const hfacDocs = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  const hfacJournals = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);

  record(!hfacDocs.error, "hfac_documents_readable", hfacDocs.error?.message);
  record(!hfacJournals.error, "hfac_journals_readable", hfacJournals.error?.message);

  const demoOrg = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
  let unbalancedDemo = null;
  if (demoOrg) {
    unbalancedDemo = await countUnbalancedJournals(supabase, demoOrg);
    record(unbalancedDemo === 0, "demo_org_balanced_journals", String(unbalancedDemo));
  }

  console.log(
    JSON.stringify(
      {
        PHASE16J_PRODUCTION_VERIFY: issues.length ? "FAIL" : "PASS",
        PHASE16_MIGRATION_STATE: migration047 === true ? "PASS" : "FAIL",
        PHASE16_PRODUCTION_SCHEMA: issues.length ? "FAIL" : "PASS",
        PHASE16_ENTITY_RLS: migration047 === true ? "PASS" : "FAIL",
        ORGS_WITHOUT_DEFAULT_ENTITY: defaults.withoutDefault,
        ORGS_WITH_MULTIPLE_DEFAULT_ENTITIES: defaults.multipleDefaults,
        HFAC_DOCUMENTS: hfacDocs.count ?? null,
        HFAC_JOURNALS: hfacJournals.count ?? null,
        UNBALANCED_DEMO_JOURNALS: unbalancedDemo,
        issues,
        migrationsAutoApplied: false,
        sqlPatchesAutoApplied: false,
      },
      null,
      2,
    ),
  );

  process.exit(issues.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
