#!/usr/bin/env node
/** Static deployment-order compatibility audit for migration 029. */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const M029 = resolve(ROOT, "supabase/migrations/029_phase12_payroll_labor.sql");
const M030 = resolve(ROOT, "supabase/migrations/030_phase12_payroll_atomic_rpc.sql");
const M028 = resolve(ROOT, "supabase/migrations/028_phase11_1_accrual_settlement.sql");

function auditMigration029(sql) {
  const issues = [];
  if (!existsSync(M029)) issues.push("Missing 029_phase12_payroll_labor.sql");
  if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push("029 must not replace teller_post_journal");
  }
  for (const table of [
    "teller_workers",
    "teller_payroll_runs",
    "teller_payroll_components",
    "teller_payroll_account_mappings",
    "teller_labor_entries",
    "teller_payroll_liability_settlements",
  ]) {
    if (!sql.includes(table)) issues.push(`029 must add ${table}`);
  }
  if (!sql.includes("enable row level security")) issues.push("029 must enable RLS");
  if (!sql.includes("unique (organization_id, idempotency_key)")) {
    issues.push("029 must enforce payroll run idempotency");
  }
  return issues;
}

function auditMigration030(sql) {
  const issues = [];
  if (!existsSync(M030)) issues.push("Missing 030_phase12_payroll_atomic_rpc.sql");
  if (/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql)) {
    issues.push("030 must not replace teller_post_journal");
  }
  if (/create table/i.test(sql)) issues.push("030 must be RPC-only (no table changes)");
  for (const rpc of [
    "teller_atomic_post_payroll_run",
    "teller_atomic_reverse_payroll_run",
    "teller_atomic_post_payroll_settlement",
  ]) {
    if (!sql.includes(rpc)) issues.push(`030 must define ${rpc}`);
  }
  return issues;
}

function main() {
  const sql = existsSync(M029) ? readFileSync(M029, "utf8") : "";
  const sql030 = existsSync(M030) ? readFileSync(M030, "utf8") : "";
  const migrationIssues = auditMigration029(sql);
  const migration030Issues = auditMigration030(sql030);
  const postTs = readFileSync(resolve(ROOT, "src/lib/accounting/post.ts"), "utf8");
  const postOk = postTs.includes('supabase.rpc("teller_post_journal"');
  const m028 = existsSync(M028) ? readFileSync(M028, "utf8") : "";
  const phase11_1Intact = m028.includes("teller_accrual_settlements");

  const OLD_PHASE11_1_APP_COMPATIBLE_WITH_029 =
    migrationIssues.length === 0 && migration030Issues.length === 0 && phase11_1Intact;
  const TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED =
    postOk && !/create\s+or\s+replace\s+function\s+public\.teller_post_journal/i.test(sql);

  console.log(
    JSON.stringify(
      {
        DEPLOYMENT_COMPAT_AUDIT:
          OLD_PHASE11_1_APP_COMPATIBLE_WITH_029 && TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED
            ? "PASS"
            : "FAIL",
        OLD_PHASE11_1_APP_COMPATIBLE_WITH_029,
        TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED,
        MIGRATION_029_REQUIRED: true,
        MIGRATION_029_CREATED: existsSync(M029),
        MIGRATION_030_CREATED: existsSync(M030),
        MIGRATION_029_APPLIED: false,
        MIGRATION_030_APPLIED: false,
        migrationIssues,
        migration030Issues,
        phase11_1Intact,
        phase12RunnerPresent: existsSync(resolve(ROOT, "scripts/controlled-phase12-demo-runner.ts")),
        phase12TestsPresent: existsSync(resolve(ROOT, "src/lib/accounting/phase12.test.ts")),
        PRODUCTION_SCHEDULER_ENABLED: false,
      },
      null,
      2,
    ),
  );

  process.exit(OLD_PHASE11_1_APP_COMPATIBLE_WITH_029 && TELLER_POST_JOURNAL_SIGNATURE_UNCHANGED ? 0 : 1);
}

main();
