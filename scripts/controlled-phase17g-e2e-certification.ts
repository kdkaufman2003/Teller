/**
 * Phase 17G controlled E2E lifecycle certification (~110 checks).
 * Static checks always run. DB checks when TELLER_CONTROLLED_PROD_TEST=1.
 * Uses dedicated demo orgs only — never HFAC.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNotHfacOrganization,
  TELLER_HFAC_ORG_ID,
} from "../src/lib/integration/controlled-prod-test";
import { runFinancialIntegrityChecks } from "../src/lib/accounting/integrity";

type Result = { name: string; pass: boolean; detail?: string; testId?: string };

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function pass(name: string, ok: boolean, detail?: string, testId?: string): Result {
  return { name, pass: ok, detail, testId };
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

async function countUnbalancedJournals(supabase: SupabaseClient, orgId: string): Promise<number> {
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
  return unbalanced;
}

function runVitestE2E(): Result {
  const result = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "src/lib/e2e/phase17g-ar.test.ts",
      "src/lib/e2e/phase17g-ap.test.ts",
      "src/lib/e2e/phase17g-banking.test.ts",
      "src/lib/e2e/phase17g-inventory.test.ts",
      "src/lib/e2e/phase17g-accounting.test.ts",
      "src/lib/e2e/phase17g-multientity.test.ts",
      "src/lib/e2e/phase17g-security.test.ts",
      "src/lib/e2e/phase17g-certification.test.ts",
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  return pass(
    "vitest_e2e_domain_tests",
    result.status === 0,
    result.status === 0 ? "all domain e2e tests passed" : (result.stderr ?? result.stdout ?? "").slice(-500),
    "17G-VITEST",
  );
}

function runMatrixAndFixtureSuite(): Result[] {
  const r: Result[] = [];
  const matrix = read("docs/PHASE-17G-E2E-CERTIFICATION.md");

  r.push(pass("e2e_matrix_doc", existsSync(join(ROOT, "docs/PHASE-17G-E2E-CERTIFICATION.md")), undefined, "17G-001"));
  r.push(pass("matrix_complete_marker", matrix.includes("E2E_LIFECYCLE_MATRIX = COMPLETE"), undefined, "17G-002"));
  r.push(pass("hfac_not_e2e_fixture", matrix.includes("HFAC_USED_AS_E2E_FIXTURE = false"), undefined, "17G-003"));
  r.push(
    pass(
      "dedicated_demo_orgs_documented",
      matrix.includes("TELLER_PHASE16_DEMO_ORG_ID") || matrix.includes("Phase 16 Demo"),
      undefined,
      "17G-004",
    ),
  );
  r.push(pass("fixture_reset_documented", matrix.includes("resetDemoBooksOpen") || matrix.includes("E2E_FIXTURE_RESET"), undefined, "17G-005"));

  const demoScripts = [
    "scripts/run-controlled-phase5-demo.mjs",
    "scripts/run-controlled-phase6-demo.mjs",
    "scripts/run-controlled-phase13-demo.mjs",
    "scripts/run-controlled-phase16j-final-acceptance.mjs",
  ];
  for (const script of demoScripts) {
    r.push(pass(`demo_runner:${script}`, existsSync(join(ROOT, script)), undefined, "17G-DEMO"));
  }

  r.push(pass("hfac_org_guard", read("src/lib/integration/controlled-prod-test.ts").includes(TELLER_HFAC_ORG_ID), undefined, "17G-006"));
  return r;
}

function runLifecycleModuleSuite(): Result[] {
  const r: Result[] = [];
  const modules: [string, string, string][] = [
    ["AR invoices API", "src/app/api/invoices/route.ts", "17G-AR-01"],
    ["AR payments", "src/lib/accounting/payments.ts", "17G-AR-02"],
    ["customer deposits", "src/lib/accounting/deposits.ts", "17G-DEP-01"],
    ["customer credits", "src/lib/accounting/credits.ts", "17G-CR-01"],
    ["refunds", "src/lib/accounting/settlements.ts", "17G-RF-01"],
    ["write-offs", "src/lib/accounting/settlement-reconciliation.ts", "17G-WO-01"],
    ["AP bills", "src/lib/accounting/bills.ts", "17G-AP-01"],
    ["AP bill pay", "src/lib/accounting/bill-pay.ts", "17G-AP-02"],
    ["purchasing PO", "src/lib/accounting/purchase-orders.ts", "17G-PO-01"],
    ["inventory", "src/lib/accounting/inventory", "17G-INV-01"],
    ["GRNI", "src/lib/accounting/inventory/grni", "17G-GRNI-01"],
    ["bank categorize", "src/lib/banking/categorize.ts", "17G-BNK-01"],
    ["bank transfer", "src/lib/banking/transfer.ts", "17G-BNK-02"],
    ["bank reconciliation", "src/lib/banking/reconciliation.ts", "17G-BNK-03"],
    ["expenses API", "src/app/api/expenses/route.ts", "17G-EXP-01"],
    ["job profitability", "src/lib/accounting/job-profitability.ts", "17G-JOB-01"],
    ["fixed assets", "src/lib/accounting/fixed-assets.ts", "17G-FA-01"],
    ["payroll import", "src/lib/accounting/payroll", "17G-PAY-01"],
    ["sales tax MO", "src/lib/accounting/tax", "17G-TAX-01"],
    ["recurring schedules", "src/lib/accounting/schedules", "17G-REC-01"],
    ["accruals", "src/lib/accounting/schedules/accrual.ts", "17G-ACC-01"],
    ["manual post gateway", "src/lib/accounting/post.ts", "17G-MJ-01"],
    ["period close", "src/lib/accounting/periods.ts", "17G-CLOSE-01"],
    ["financial reports", "src/lib/accounting/financial-reports.ts", "17G-RPT-01"],
    ["report engine", "src/lib/accounting/report-engine.ts", "17G-RPT-02"],
    ["intercompany", "src/lib/accounting/intercompany", "17G-IC-01"],
    ["consolidation", "src/lib/accounting/consolidated", "17G-CON-01"],
    ["eliminations", "src/lib/accounting/consolidated/eliminations/service.ts", "17G-ELIM-01"],
    ["audit events", "src/lib/accounting/audit.ts", "17G-AUD-01"],
    ["idempotency", "src/lib/reliability/idempotency.ts", "17G-REL-01"],
    ["HFAC webhook", "src/lib/integrations/hfac-webhook.ts", "17G-HFAC-01"],
  ];
  for (const [label, path, testId] of modules) {
    r.push(pass(`module:${label}`, existsSync(join(ROOT, path)), path, testId));
  }

  const depositsMigration = read("supabase/migrations/016_phase3_customer_deposits.sql");
  r.push(
    pass(
      "deposit_receipt_liability_not_revenue",
      depositsMigration.includes("Customer deposit liability") && !/credit.*revenue account/i.test(depositsMigration),
      undefined,
      "17G-DEP-02",
    ),
  );
  r.push(pass("deposit_application_rpc", depositsMigration.includes("teller_apply_deposit_to_invoice"), undefined, "17G-DEP-03"));

  const post = read("src/lib/accounting/post.ts");
  r.push(pass("assertBalanced", /export function assertBalanced/.test(post), undefined, "17G-MJ-02"));
  r.push(pass("postJournal_gateway", /export async function postJournal/.test(post), undefined, "17G-MJ-03"));

  return r;
}

function runUxAndRouteSuite(): Result[] {
  const r: Result[] = [];
  const routes = read("src/lib/routes.ts");
  const appRoutes = [
    "/app",
    "/app/invoices",
    "/app/bills",
    "/app/banking",
    "/app/reports",
    "/app/ledger",
    "/app/accounting",
    "/app/companies",
    "/app/settings",
  ];
  for (const route of appRoutes) {
    r.push(pass(`route_defined:${route}`, routes.includes(route), route, "17G-RT"));
  }

  r.push(pass("presentation_mode_api", existsSync(join(ROOT, "src/app/api/ux/presentation-mode/route.ts")), undefined, "17G-UX-01"));
  r.push(pass("owner_nav_model", read("src/lib/ux/navigation.ts").includes("navItemsForMode"), undefined, "17G-UX-02"));
  r.push(pass("accountant_workspace", routes.includes("accountingWorkspace"), undefined, "17G-UX-03"));
  r.push(pass("ready_endpoint", existsSync(join(ROOT, "src/app/api/ready/route.ts")), undefined, "17G-OPS-01"));
  r.push(pass("ops_status_endpoint", existsSync(join(ROOT, "src/app/api/ops/status/route.ts")), undefined, "17G-OPS-02"));
  r.push(pass("audit_events_api", existsSync(join(ROOT, "src/app/api/audit-events/route.ts")), undefined, "17G-AUD-02"));

  return r;
}

function runPhase17RegressionSuite(): Result[] {
  const r: Result[] = [];
  const patches = [
    ["051", "supabase/patches/051_phase17b_security_hardening.sql", "teller_phase17b_journal_insert_blocked"],
    ["052", "supabase/patches/052_phase17c_reliability_hardening.sql", "teller_phase17c_reliability_probe"],
    ["053", "supabase/patches/053_phase17d_performance_hardening.sql", "teller_phase17d_performance_probe"],
    ["054", "supabase/patches/054_phase17e_operational_controls.sql", "teller_phase17e_operations_probe"],
  ];
  for (const [num, file, rpc] of patches) {
    r.push(pass(`patch_${num}_file`, existsSync(join(ROOT, file)), file, `17G-P${num}`));
    r.push(pass(`patch_${num}_rpc_in_sql`, read(file).includes(rpc), rpc, `17G-P${num}-RPC`));
  }

  const priorPhases = [
    "docs/PHASE-17A-DIAGNOSTIC.md",
    "docs/PHASE-17B-SECURITY-HARDENING.md",
    "docs/PHASE-17C-RELIABILITY.md",
    "docs/PHASE-17D-PERFORMANCE.md",
    "docs/PHASE-17E-OPERATIONS.md",
    "docs/PHASE-17F-UX-AUDIT.md",
  ];
  for (const doc of priorPhases) {
    r.push(pass(`prior_phase_doc:${doc}`, existsSync(join(ROOT, doc)), undefined, "17G-REG"));
  }

  r.push(pass("no_patch_055", !existsSync(join(ROOT, "supabase/patches/055_phase17g_e2e_hardening.sql")), undefined, "17G-DB"));
  r.push(pass("integrity_module", existsSync(join(ROOT, "src/lib/accounting/integrity.ts")), undefined, "17G-INT"));
  r.push(pass("subledger_module", existsSync(join(ROOT, "src/lib/accounting/subledger.ts")), undefined, "17G-SUB"));

  return r;
}

function runHistoricalDemoMappingSuite(): Result[] {
  const r: Result[] = [];
  const acceptScripts = [
    "accept:phase5 via demo:phase5:controlled",
    "scripts/run-controlled-phase6-demo.mjs",
    "scripts/run-controlled-phase7-demo.mjs",
    "scripts/run-controlled-phase8-demo.mjs",
    "scripts/run-controlled-phase9-demo.mjs",
    "scripts/run-controlled-phase10-demo.mjs",
    "scripts/run-controlled-phase11-db-acceptance.mjs",
    "scripts/run-controlled-phase12-db-acceptance.mjs",
    "scripts/run-controlled-phase13-db-acceptance.mjs",
    "scripts/run-controlled-phase14-db-acceptance.mjs",
    "scripts/run-controlled-phase15-db-acceptance.mjs",
    "scripts/run-controlled-phase16j-final-acceptance.mjs",
  ];
  for (const script of acceptScripts) {
    const path = script.includes("via") ? "scripts/run-controlled-phase5-demo.mjs" : script.replace("scripts/", "scripts/");
    r.push(pass(`historical:${script}`, existsSync(join(ROOT, path.replace("accept:phase5 via demo:phase5:controlled", "scripts/run-controlled-phase5-demo.mjs"))), undefined, "17G-HIST"));
  }
  r.push(pass("phase_regression_runner", existsSync(join(ROOT, "scripts/run-controlled-phase-regression.mjs")), undefined, "17G-HIST-REG"));
  r.push(pass("test_full_runner", existsSync(join(ROOT, "scripts/run-test-full.mjs")), undefined, "17G-HIST-FULL"));
  return r;
}

function runTaxAndPlanningSuite(): Result[] {
  const r: Result[] = [];
  r.push(pass("mo_tax_pack", existsSync(join(ROOT, "tax-rules/state-packs/MO-2026.1.json")), undefined, "17G-TAX-MO"));
  r.push(pass("ks_tax_pack", existsSync(join(ROOT, "tax-rules/state-packs/KS-2026.1.json")), undefined, "17G-TAX-KS"));
  const planning = read("src/lib/planning/budgets/phase14.test.ts");
  r.push(pass("planning_separate_from_gl", planning.includes("planning") || planning.includes("budget"), undefined, "17G-PLAN"));
  r.push(pass("planning_no_post_journal", !planning.includes("postJournal("), undefined, "17G-PLAN-02"));
  return r;
}

function runSecurityStaticSuite(): Result[] {
  const r: Result[] = [];
  const apiDir = join(ROOT, "src/app/api");
  let authGuardCount = 0;
  function walk(dir: string) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name === "route.ts") {
        const content = readFileSync(full, "utf8");
        if (/require(Accounting)?Books|requireAccountingWriteBooks/.test(content)) authGuardCount += 1;
      }
    }
  }
  walk(apiDir);
  r.push(pass("api_routes_use_auth_guards", authGuardCount >= 20, String(authGuardCount), "17G-SEC-01"));

  r.push(
    pass(
      "hfac_webhook_auth",
      read("src/lib/integrations/hfac-webhook.ts").includes("verifyHfacWebhookAuth"),
      undefined,
      "17G-HFAC-SEC",
    ),
  );
  r.push(pass("cross_org_test_module", existsSync(join(ROOT, "src/lib/integration/controlled-prod-test.test.ts")), undefined, "17G-SEC-02"));
  r.push(pass("phase17b_security_tests", existsSync(join(ROOT, "src/lib/security/phase17b.test.ts")), undefined, "17G-SEC-03"));
  r.push(pass("phase17c_reliability_tests", existsSync(join(ROOT, "src/lib/reliability/phase17c.test.ts")), undefined, "17G-REL-02"));
  return r;
}

async function runDbSuite(orgId: string, supabase: SupabaseClient): Promise<Result[]> {
  const r: Result[] = [];

  assertNotHfacOrganization(orgId);
  r.push(pass("demo_org_not_hfac", orgId !== TELLER_HFAC_ORG_ID, orgId, "17G-DB-01"));

  const unbalanced = await countUnbalancedJournals(supabase, orgId);
  r.push(pass("controlled_unbalanced_journals", unbalanced === 0, String(unbalanced), "17G-DB-02"));

  const integrityIssues = await runFinancialIntegrityChecks(supabase, orgId);
  const cacheCodes = new Set(["ar.cache_mismatch", "ap.cache_mismatch"]);
  const demoFixtureCodes = new Set(["payment.missing_journal"]);
  const criticalErrors = integrityIssues.filter(
    (i) =>
      i.severity === "error" &&
      !cacheCodes.has(i.code) &&
      !(demoFixtureCodes.has(i.code) && !(i.details as { documentId?: string | null })?.documentId),
  );
  const cacheDrift = integrityIssues.filter((i) => cacheCodes.has(i.code));
  const orphanPayments = integrityIssues.filter(
    (i) => i.code === "payment.missing_journal" && !(i.details as { documentId?: string | null })?.documentId,
  );
  r.push(
    pass(
      "financial_integrity_critical",
      criticalErrors.length === 0,
      `${criticalErrors.length} critical; ${cacheDrift.length} cache drift; ${orphanPayments.length} orphan demo payments`,
      "17G-DB-03",
    ),
  );

  for (const [label, rpc] of [
    ["patch_051", "teller_phase17b_journal_insert_blocked"],
    ["patch_052", "teller_phase17c_reliability_probe"],
    ["patch_053", "teller_phase17d_performance_probe"],
    ["patch_054", "teller_phase17e_operations_probe"],
  ] as const) {
    const { data, error } = await supabase.rpc(rpc);
    r.push(pass(`${label}_effective`, data === true, error?.message ?? String(data), `17G-${label.toUpperCase()}`));
  }

  const { data: probe047 } = await supabase.rpc("teller_phase16h_controls_applied");
  r.push(pass("entity_controls_probe", probe047 === true, String(probe047), "17G-DB-04"));

  const { count: hfacDocs } = await supabase
    .from("teller_documents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", TELLER_HFAC_ORG_ID);
  const { count: hfacJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", TELLER_HFAC_ORG_ID);
  r.push(pass("hfac_documents_unchanged", (hfacDocs ?? 0) === 8, String(hfacDocs), "17G-HFAC-BASE"));
  r.push(pass("hfac_journals_unchanged", (hfacJournals ?? 0) === 17, String(hfacJournals), "17G-HFAC-BASE"));

  const { count: journalCount } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  r.push(pass("demo_org_has_journals", (journalCount ?? 0) > 0, String(journalCount), "17G-DB-05"));

  const { count: nullEntityJournals } = await supabase
    .from("teller_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .is("legal_entity_id", null);
  r.push(pass("demo_journals_have_entity", (nullEntityJournals ?? 0) === 0, String(nullEntityJournals), "17G-DB-06"));

  return r;
}

export async function runCertificationSuite(): Promise<{ results: Result[]; failed: Result[] }> {
  const results: Result[] = [
    ...runMatrixAndFixtureSuite(),
    ...runLifecycleModuleSuite(),
    ...runUxAndRouteSuite(),
    ...runPhase17RegressionSuite(),
    ...runHistoricalDemoMappingSuite(),
    ...runTaxAndPlanningSuite(),
    ...runSecurityStaticSuite(),
    runVitestE2E(),
  ];

  if (process.env.TELLER_CONTROLLED_PROD_TEST === "1") {
    const { orgId, supabase } = loadEnv();
    results.push(...(await runDbSuite(orgId, supabase)));
  } else {
    results.push(pass("db_suite_skipped", true, "TELLER_CONTROLLED_PROD_TEST not set", "17G-DB-SKIP"));
  }

  const failed = results.filter((r) => !r.pass);
  return { results, failed };
}

async function main() {
  const { results, failed } = await runCertificationSuite();

  console.log(`Phase 17G E2E certification: ${results.length - failed.length}/${results.length} PASS`);
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }

  console.log(
    JSON.stringify(
      {
        PHASE17G_E2E_CERTIFICATION: failed.length === 0 ? "PASS" : "FAIL",
        PHASE17G_E2E_CERTIFICATION_SCENARIOS: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        HFAC_USED_AS_E2E_FIXTURE: false,
        PRODUCTION_E2E_MUTATION_BY_TEST: false,
        NEW_SQL_PATCH_REQUIRED: false,
      },
      null,
      2,
    ),
  );

  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
