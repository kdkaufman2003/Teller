/**
 * Phase 17E controlled operations acceptance (~45 checks).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { evaluateRecoveryIntegrity } from "../src/lib/operations/recovery-integrity";
import { parseListPagination, MAX_LIST_PAGE_SIZE } from "../src/lib/performance/pagination";

type Result = { name: string; pass: boolean; detail?: string };
const ROOT = process.cwd();
const HFAC_ORG = TELLER_HFAC_ORG_ID;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function pass(name: string, ok: boolean, detail?: string): Result {
  return { name, pass: ok, detail };
}

function runStaticSuite(): Result[] {
  const r: Result[] = [];
  const patch054 = read("supabase/patches/054_phase17e_operational_controls.sql");
  const opsDoc = read("docs/PHASE-17E-OPERATIONS.md");
  const releaseDoc = read("docs/PRODUCTION-RELEASE-RUNBOOK.md");
  const incidentDoc = read("docs/INCIDENT-RESPONSE.md");
  const manualDbDoc = read("docs/MANUAL-DATABASE-CHANGE-RUNBOOK.md");

  r.push(pass("patch_054_exists", existsSync(join(ROOT, "supabase/patches/054_phase17e_operational_controls.sql"))));
  r.push(pass("patch_054_immutability", patch054.includes("teller_audit_append_only_guard")));
  r.push(pass("patch_054_probe", patch054.includes("teller_phase17e_operations_probe")));
  r.push(pass("patch_054_no_audit_delete", !/delete from public.teller_audit_events/i.test(patch054)));
  r.push(pass("patch_054_static_verifier", existsSync(join(ROOT, "scripts/verify-migration-054-static.mjs"))));

  r.push(pass("operations_doc", opsDoc.includes("OPERATIONAL_CONTROL_INVENTORY")));
  r.push(pass("release_runbook", /pre-deploy/i.test(releaseDoc)));
  r.push(pass("incident_response", incidentDoc.includes("SEV-1")));
  r.push(pass("manual_db_runbook", manualDbDoc.includes("WRONG PROJECT")));
  r.push(pass("recovery_verifier", existsSync(join(ROOT, "scripts/verify-recovery-integrity.mjs"))));
  r.push(pass("phase17e_tests", existsSync(join(ROOT, "src/lib/operations/phase17e.test.ts"))));
  r.push(pass("production_verify_script", existsSync(join(ROOT, "scripts/verify-phase17e-production.mjs"))));

  r.push(pass("ready_route", existsSync(join(ROOT, "src/app/api/ready/route.ts"))));
  r.push(pass("ops_status_route", existsSync(join(ROOT, "src/app/api/ops/status/route.ts"))));
  r.push(pass("audit_events_api", existsSync(join(ROOT, "src/app/api/audit-events/route.ts"))));
  r.push(pass("ready_no_secrets", !read("src/app/api/ready/route.ts").includes("process.env.SUPABASE_SERVICE_ROLE_KEY")));
  r.push(pass("ops_status_token_gate", read("src/app/api/ops/status/route.ts").includes("TELLER_OPS_STATUS_TOKEN")));

  r.push(pass("audit_query_pagination", read("src/lib/operations/audit-query.ts").includes("parseListPagination")));
  r.push(pass("audit_api_bounded", read("src/app/api/audit-events/route.ts").includes("fetchPaginatedAuditEvents")));
  r.push(pass("banking_match_audit_dedicated", read("src/lib/banking/audit.ts").includes('"banking.match.confirmed": "banking.match.confirmed"')));

  r.push(pass("period_reopen_audited", read("src/lib/accounting/period-close.ts").includes('"period.reopened"')));
  r.push(pass("period_close_audited", read("src/lib/accounting/period-close.ts").includes('"period.closed"')));
  r.push(pass("actor_rls_enforced", read("supabase/migrations/005_accounting_foundation.sql").includes("actor_id = auth.uid()")));

  r.push(pass("recovery_logic", evaluateRecoveryIntegrity({
    journalCount: 100,
    unbalancedJournals: 0,
    documentCount: 50,
    paymentCount: 10,
    legalEntityCount: 3,
  }).ok));
  r.push(pass("recovery_detects_imbalance", !evaluateRecoveryIntegrity({
    journalCount: 100,
    unbalancedJournals: 2,
    documentCount: 50,
    paymentCount: 10,
    legalEntityCount: 3,
  }).ok));

  r.push(pass("pagination_max_cap", parseListPagination(new URLSearchParams("pageSize=9999")).pageSize === MAX_LIST_PAGE_SIZE));
  r.push(pass("hfac_lifecycle_columns", read("supabase/patches/052_phase17c_reliability_hardening.sql").includes("processing_status")));
  r.push(pass("no_rls_disable_in_patch", !/disable row level security/i.test(patch054)));
  r.push(pass("17b_posting_intact", read("supabase/patches/051_phase17b_security_hardening.sql").includes("journal_insert_blocked")));
  r.push(pass("17c_idempotency_intact", read("src/lib/reliability/idempotency.ts").includes("normalizeUuidEventId")));

  r.push(pass("rpo_documented", opsDoc.includes("RPO_TARGET")));
  r.push(pass("rto_documented", opsDoc.includes("RTO_TARGET")));
  r.push(pass("audit_retention_documented", opsDoc.includes("AUDIT_RETENTION_POLICY")));
  r.push(pass("db_change_ledger", opsDoc.includes("PRODUCTION_DB_CHANGE_LEDGER")));
  r.push(pass("vendor_inventory", opsDoc.includes("VENDOR_DEPENDENCY_INVENTORY")));

  return r;
}

async function runDbSuite(supabase: SupabaseClient): Promise<Result[]> {
  const r: Result[] = [];
  const { data: probe054, error: err054 } = await supabase.rpc("teller_phase17e_operations_probe");
  if (err054?.message?.includes("Could not find")) {
    r.push(pass("patch_054_applied", false, "Manual apply required"));
  } else {
    r.push(pass("patch_054_probe", probe054 === true, String(probe054)));
  }

  const { data: hfacOps, error: hfacOpsErr } = await supabase.rpc("teller_hfac_webhook_ops_snapshot");
  if (hfacOpsErr?.message?.includes("Could not find")) {
    r.push(pass("hfac_failed_count_query", false, "patch 054 required"));
  } else {
    r.push(pass("hfac_failed_count_query", hfacOps != null, String(hfacOps?.failed ?? "null")));
  }

  const { count: hfacDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  r.push(pass("hfac_documents", hfacDocs === 8, String(hfacDocs)));

  const { count: hfacJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", HFAC_ORG);
  r.push(pass("hfac_journals", hfacJournals === 17, String(hfacJournals)));

  return r;
}

async function main() {
  const staticResults = runStaticSuite();
  let dbResults: Result[] = [];

  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    const orgId = process.env.TELLER_PHASE16_DEMO_ORG_ID?.trim();
    if (orgId) assertNotHfacOrganization(orgId);
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    dbResults = await runDbSuite(supabase);
  } else {
    dbResults.push(pass("patch_054_applied", false, "Set TELLER_CONTROLLED_PROD_TEST=1 for DB checks"));
  }

  const all = [...staticResults, ...dbResults];
  const failed = all.filter((row) => !row.pass);
  console.log(`Phase 17E operations acceptance: ${all.length - failed.length}/${all.length} PASS`);
  for (const row of all) {
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.name}${row.detail ? ` (${row.detail})` : ""}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
